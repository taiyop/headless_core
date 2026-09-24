import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { resolveDevinModel } from "./devinModel.js";
import { parseRequestedEffort, unsupportedEffort } from "./effort.js";
import { EffortError, HeadlessSessionError } from "./errors.js";
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  type PersistentRuntime,
  type SessionContext
} from "./runtimeManager.js";
import { emitSessionProgress, sessionErrorKind, startTurn, type TurnSettlement } from "./turnTracker.js";
import {
  DEFAULT_MODEL_ID,
  type AgentSpec,
  type Effort,
  type HeadlessSession,
  type HeadlessSessionRunOptions,
  type ModelCandidate
} from "./types.js";

const RUNTIME_KEY_PREFIX = "devin:acp";
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_LIMIT = 8192;

type AcpModule = typeof acp;

type SessionUpdateHandler = (update: acp.SessionUpdate) => void;

/**
 * One `devin acp` process plus its ACP connection. Shared by every
 * devin/acp session; each session owns an ACP session on this runtime.
 */
export class DevinAcpRuntime implements PersistentRuntime {
  private readonly exitHandlers = new Set<(error: HeadlessSessionError) => void>();
  private exitError: HeadlessSessionError | undefined;
  private closePromise: Promise<void> | undefined;
  private stderrTail = "";

  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: acp.ClientConnection,
    private readonly sessionHandlers: Map<string, SessionUpdateHandler>
  ) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.on("error", (cause) =>
      this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", `devin acp process error: ${cause.message}`, { cause }))
    );
    child.on("close", (code, signal) => {
      const detail = this.stderrTail.trim().split(/\r?\n/).at(-1);
      this.handleExit(
        new HeadlessSessionError(
          "PROTOCOL_ERROR",
          `devin acp exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail ? `: ${detail}` : ""}`
        )
      );
    });
    void conn.closed.then(
      () => this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", "devin acp connection closed")),
      (cause: unknown) =>
        this.handleExit(
          new HeadlessSessionError(
            "PROTOCOL_ERROR",
            `devin acp connection closed: ${cause instanceof Error ? cause.message : String(cause)}`
          )
        )
    );
  }

  get agent(): acp.ClientContext {
    return this.conn.agent;
  }

  static async start(ctx: SessionContext): Promise<DevinAcpRuntime> {
    let acpModule: AcpModule;
    try {
      acpModule = await import("@agentclientprotocol/sdk");
    } catch (cause) {
      throw new HeadlessSessionError(
        "RUNTIME_START_FAILED",
        "The devin ACP transport requires @agentclientprotocol/sdk",
        { cause }
      );
    }

    const command = ctx.env.DEVIN_BIN || "devin";
    let child: ChildProcess;
    try {
      child = spawn(command, ["acp"], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      throw new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to spawn ${command} acp`, { cause });
    }

    let runtime: DevinAcpRuntime;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (cause) =>
          reject(new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to start ${command} acp: ${cause.message}`, { cause }))
        );
      });

      const stream = acpModule.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      );
      const app = acpModule.client({ name: "headless-core" });
      const sessionHandlers = new Map<string, SessionUpdateHandler>();
      app.onNotification("session/update", ({ params }) => {
        sessionHandlers.get(params.sessionId)?.(params.update);
      });
      app.onRequest("session/request_permission", ({ params }) => denyPermission(params));

      const conn = app.connect(stream);
      await conn.agent.request(
        "initialize",
        {
          protocolVersion: acpModule.PROTOCOL_VERSION,
          // Read-only posture, matching `devin --print --permission-mode auto`:
          // the agent may not ask this client to read/write files or run
          // terminal commands.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "headless-core", title: "headless_core", version: "0" }
        },
        { cancellationSignal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS) }
      );

      runtime = new DevinAcpRuntime(child, conn, sessionHandlers);
      return runtime;
    } catch (cause) {
      child.kill("SIGKILL");
      if (cause instanceof HeadlessSessionError) {
        throw cause;
      }
      throw new HeadlessSessionError("RUNTIME_START_FAILED", "devin acp initialization failed", { cause });
    }
  }

  get alive(): boolean {
    return (
      this.exitError === undefined &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  onExit(handler: (error: HeadlessSessionError) => void): void {
    if (this.exitError) {
      handler(this.exitError);
      return;
    }
    this.exitHandlers.add(handler);
  }

  attachSession(sessionId: string, handler: SessionUpdateHandler): void {
    this.sessionHandlers.set(sessionId, handler);
  }

  detachSession(sessionId: string): void {
    this.sessionHandlers.delete(sessionId);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return this.conn.agent.request<T>(method, params, {
      cancellationSignal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS)
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.kill();
    return this.closePromise;
  }

  private async kill(): Promise<void> {
    try {
      this.conn.close();
    } catch {
      // Closing a dead connection throws inside the SDK; the process kill is
      // what matters.
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  private handleExit(error: HeadlessSessionError): void {
    if (this.exitError) {
      return;
    }
    this.exitError = error;
    for (const handler of this.exitHandlers) {
      handler(error);
    }
    this.exitHandlers.clear();
  }
}

export function devinAcpRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `${RUNTIME_KEY_PREFIX}:${env.DEVIN_BIN || "devin"}`;
}

/**
 * One ACP session on a shared `devin acp` runtime.
 */
export class DevinAcpSession implements HeadlessSession {
  readonly provider = "devin";
  readonly transport = "acp" as const;

  private sessionId: string | null = null;
  private configOptions: acp.SessionConfigOption[] = [];
  // Session-start defaults, restored when setModel() is called with "default".
  private defaultModelValue: string | undefined;
  private defaultThoughtLevel: string | undefined;
  private closed = false;
  private runtimeDead = false;
  private busy: Promise<void> = Promise.resolve();
  private activeTurn: TurnSettlement | undefined;
  private activeTurnOptions: HeadlessSessionRunOptions | undefined;
  private accumulated = "";
  private model: string | undefined;
  private effort: string | undefined;
  private released = false;

  private constructor(
    private readonly runtime: DevinAcpRuntime,
    private readonly ctx: SessionContext,
    private agent: AgentSpec,
    private readonly releaseLease: () => void
  ) {
    this.model = normalize(agent.model, DEFAULT_MODEL_ID);
    this.effort = parseRequestedEffort(agent.reasoningEffort);
    runtime.onExit(() => {
      this.runtimeDead = true;
      this.activeTurn?.fail(
        new HeadlessSessionError("PROTOCOL_ERROR", "devin acp exited while a turn was in progress")
      );
    });
  }

  static async create(
    runtime: DevinAcpRuntime,
    ctx: SessionContext,
    agent: AgentSpec,
    releaseLease: () => void
  ): Promise<DevinAcpSession> {
    try {
      const session = new DevinAcpSession(runtime, ctx, agent, releaseLease);
      await session.startAcpSession();
      return session;
    } catch (cause) {
      releaseLease();
      throw cause;
    }
  }

  get id(): string | null {
    return this.sessionId;
  }

  run(options: HeadlessSessionRunOptions): Promise<string> {
    const handle = this.busy.then(() => this.beginTurn(options));
    this.busy = handle.then(
      (settlement) => settlement.done,
      () => undefined
    );
    return handle.then(
      (settlement) => settlement.result,
      (error: unknown) => {
        emitSessionProgress(options, this.agent, { state: "failed", error: toHeadlessError(error) });
        throw error;
      }
    );
  }

  reset(): Promise<void> {
    const op = this.busy.then(() => this.resetConversation());
    this.busy = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  }

  async setModel(model: string, reasoningEffort?: Effort | (string & {})): Promise<void> {
    this.assertUsable();
    // An effort set earlier stays active across setModel calls; re-apply (and
    // re-validate) it against the new model.
    const effectiveEffort = reasoningEffort === undefined ? this.effort : reasoningEffort;
    await this.applyModelConfig(model, effectiveEffort);
    this.model = normalize(model, DEFAULT_MODEL_ID);
    if (reasoningEffort !== undefined) {
      this.effort = parseRequestedEffort(reasoningEffort);
    }
    this.agent = { ...this.agent, model, reasoningEffort };
  }

  async getAvailableModels(): Promise<ModelCandidate[]> {
    this.assertUsable();
    const option = this.findConfigOption("model");
    if (!option) {
      return [];
    }
    return flattenConfigOptionValues(option).map((entry) => ({
      id: entry.value,
      name: entry.name,
      description: entry.description ?? undefined
    }));
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    const op = this.busy.then(() => this.releaseAcpSession());
    this.busy = op.then(
      () => undefined,
      () => undefined
    );
    return op.finally(() => this.releaseLeaseOnce());
  }

  private async beginTurn(options: HeadlessSessionRunOptions): Promise<TurnSettlement> {
    this.assertUsable();
    if (!options.prompt.trim()) {
      throw new Error("prompt is required");
    }
    if (options.signal?.aborted) {
      throw new HeadlessSessionError("REQUEST_ABORTED", "Run aborted before start");
    }
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new HeadlessSessionError("SESSION_CLOSED", "devin session has no ACP session id");
    }

    emitSessionProgress(options, this.agent, { state: "starting", message: `Starting ${this.provider} turn` });

    this.accumulated = "";
    this.activeTurnOptions = options;
    const settlement = startTurn({
      timeoutMs: options.timeoutMs ?? this.ctx.timeoutMs,
      signal: options.signal,
      interrupt: () => {
        void this.runtime.agent.notify("session/cancel", { sessionId }).catch(() => undefined);
      }
    });
    this.activeTurn = settlement;

    const prompt = this.runtime.agent.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: options.prompt }]
    });

    prompt.then(
      (response) => this.settlePrompt(settlement, response),
      (cause: unknown) =>
        settlement.fail(
          cause instanceof HeadlessSessionError
            ? cause
            : new HeadlessSessionError("PROTOCOL_ERROR", cause instanceof Error ? cause.message : String(cause), { cause })
        )
    );
    // Consume the prompt promise so an interrupt-path settle never surfaces as
    // an unhandled rejection.
    void settlement.done.finally(() => void prompt.catch(() => undefined));

    settlement.done.finally(() => {
      if (this.activeTurn === settlement) {
        this.activeTurn = undefined;
        this.activeTurnOptions = undefined;
      }
    });

    void settlement.result.then(
      (output) => emitSessionProgress(options, this.agent, { state: "completed", partialOutput: output }),
      (error: unknown) =>
        emitSessionProgress(options, this.agent, {
          state: "failed",
          error: toHeadlessError(error),
          partialOutput: this.accumulated || undefined
        })
    );

    return settlement;
  }

  private settlePrompt(settlement: TurnSettlement, response: { stopReason?: string }): void {
    if (this.activeTurn !== settlement) {
      return;
    }
    switch (response.stopReason) {
      case "cancelled":
        settlement.fail(new HeadlessSessionError("REQUEST_ABORTED", "Prompt cancelled"));
        return;
      case "refusal":
        settlement.fail(new HeadlessSessionError("PROTOCOL_ERROR", "devin acp refused the prompt"));
        return;
      default:
        // end_turn / max_tokens / max_turn_requests: accumulated chunks are
        // the answer.
        settlement.complete(this.accumulated);
    }
  }

  private readonly updateHandler: SessionUpdateHandler = (update) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text && this.activeTurn && this.activeTurnOptions) {
        this.accumulated += text;
        emitSessionProgress(this.activeTurnOptions, this.agent, { state: "running", partialOutput: text });
      }
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.configOptions = update.configOptions ?? this.configOptions;
    }
  };

  private async startAcpSession(): Promise<void> {
    const res = await this.runtime.request<{
      sessionId?: string;
      configOptions?: acp.SessionConfigOption[] | null;
    }>("session/new", { cwd: this.ctx.cwd, mcpServers: [] });
    if (!res.sessionId) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "devin acp returned no session id");
    }
    this.sessionId = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    this.defaultModelValue = configOptionCurrentValue(this.findConfigOption("model"));
    this.defaultThoughtLevel = configOptionCurrentValue(this.findConfigOption("thought_level"));
    this.runtime.attachSession(this.sessionId, this.updateHandler);
    await this.enforceReadOnlyMode();
    if (this.model || this.effort) {
      await this.applyModelConfig(this.model, this.effort);
    }
  }

  /**
   * `devin acp` defaults to the write-capable "Code" (accept-edits) mode. The
   * one-shot CLI path runs read-only (`--permission-mode auto`), so sessions
   * select "ask" — Devin's answer-only mode — when the mode option offers it.
   * Permission requests are still denied by default regardless.
   */
  private async enforceReadOnlyMode(): Promise<void> {
    const mode = this.configOptions.find(
      (option) => (option.category === "mode" || option.id === "mode") && option.type === "select"
    );
    if (!mode) {
      return;
    }
    const values = flattenConfigOptionValues(mode).map((entry) => entry.value);
    if (!values.includes("ask")) {
      return;
    }
    await this.setConfigOption(mode.id, "ask");
  }

  /**
   * Applies a (model, effort) pair through the ACP session config options.
   * Devin model uids embed the thinking level (claude-opus-5-high) while
   * callers may hold a family slug (swe-2, claude-opus-5.5); resolveDevinModel
   * maps them to a real advertised uid and decides whether thought_level must
   * carry the effort — never silently converting a level the model cannot
   * express. "none" only selects an explicit non-reasoning variant.
   */
  private async applyModelConfig(model: string | undefined, effort: string | undefined): Promise<void> {
    const modelOption = this.findConfigOption("model");
    const thoughtLevel = this.findConfigOption("thought_level");
    const thoughtValues = thoughtLevel
      ? flattenConfigOptionValues(thoughtLevel).map((entry) => entry.value)
      : [];
    const modelId = model && model !== DEFAULT_MODEL_ID ? model : undefined;
    const effortId = parseRequestedEffort(effort);

    if (modelId) {
      if (!modelOption) {
        throw new HeadlessSessionError("PROTOCOL_ERROR", "devin acp session exposes no model config option");
      }
      const values = flattenConfigOptionValues(modelOption).map((entry) => entry.value);
      let resolution;
      try {
        resolution = resolveDevinModel(modelId, effortId, values, thoughtValues);
      } catch (cause) {
        if (cause instanceof EffortError) {
          throw cause;
        }
        throw new HeadlessSessionError(
          "PROTOCOL_ERROR",
          cause instanceof Error ? cause.message : String(cause),
          { cause }
        );
      }
      await this.setConfigOption(modelOption.id, resolution.modelUid);
      if (resolution.thoughtLevel && thoughtLevel) {
        await this.setConfigOption(thoughtLevel.id, resolution.thoughtLevel);
      }
    } else {
      if (model !== undefined && modelOption && this.defaultModelValue) {
        // An explicit "default" model restores what the session started with.
        await this.setConfigOption(modelOption.id, this.defaultModelValue);
      }
      if (effortId) {
        // With no variant-bearing model selected, thought_level is the only
        // effort channel; it cannot express levels it does not offer.
        if (!thoughtLevel || !thoughtValues.includes(effortId)) {
          throw unsupportedEffort("devin", undefined, effortId, thoughtValues);
        }
        await this.setConfigOption(thoughtLevel.id, effortId);
      }
    }

    if (effort !== undefined && !effortId && thoughtLevel && this.defaultThoughtLevel) {
      // An explicit "default" effort restores the session's initial level.
      await this.setConfigOption(thoughtLevel.id, this.defaultThoughtLevel);
    }
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new HeadlessSessionError("SESSION_CLOSED", "devin session has no ACP session id");
    }
    const res = await this.runtime.request<{ configOptions?: acp.SessionConfigOption[] }>(
      "session/set_config_option",
      { sessionId, configId, value }
    );
    if (res.configOptions) {
      this.configOptions = res.configOptions;
    }
  }

  private findConfigOption(categoryOrId: string): acp.SessionConfigOption | undefined {
    return this.configOptions.find(
      (option) => (option.category === categoryOrId || option.id === categoryOrId) && option.type === "select"
    );
  }

  private async resetConversation(): Promise<void> {
    this.assertUsable();
    await this.releaseAcpSession();
    await this.startAcpSession();
  }

  private async releaseAcpSession(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (!sessionId || !this.runtime.alive) {
      return;
    }
    this.runtime.detachSession(sessionId);
    // Devin does not implement session/close; it advertises session/delete.
    // Try close first for other ACP agents, then fall back to delete.
    try {
      await this.runtime.request("session/close", { sessionId });
      return;
    } catch {
      // fall through to session/delete
    }
    try {
      await this.runtime.request("session/delete", { sessionId });
    } catch {
      // Releasing must not fail; the session may already be gone.
    }
  }

  private releaseLeaseOnce(): void {
    if (!this.released) {
      this.released = true;
      this.releaseLease();
    }
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new HeadlessSessionError("SESSION_CLOSED", "Session is closed");
    }
    if (this.runtimeDead || !this.runtime.alive) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "devin acp runtime is not running");
    }
  }
}

/**
 * Deny-by-default permission policy: pick the reject option the agent offered,
 * or cancel the request outright when it gave no reject choice.
 */
function denyPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const options = params.options ?? [];
  const reject = options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind === "reject_always");
  if (reject) {
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function configOptionCurrentValue(option: acp.SessionConfigOption | undefined): string | undefined {
  const value = (option as { currentValue?: unknown } | undefined)?.currentValue;
  return typeof value === "string" ? value : undefined;
}

type ConfigOptionValue = { value: string; name?: string; description?: string | null };

function flattenConfigOptionValues(option: acp.SessionConfigOption): ConfigOptionValue[] {
  const options = (option as { options?: unknown }).options;
  if (!Array.isArray(options)) {
    return [];
  }
  const values: ConfigOptionValue[] = [];
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      for (const nested of entry.options as Array<Record<string, unknown>>) {
        if (typeof nested.value === "string") {
          values.push({ value: nested.value, name: nested.name as string, description: nested.description as string | null });
        }
      }
    } else if (typeof entry.value === "string") {
      values.push({ value: entry.value, name: entry.name as string, description: entry.description as string | null });
    }
  }
  return values;
}

function contentText(content: unknown): string {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

function normalize(value: string | undefined, defaultId: string): string | undefined {
  return value && value !== defaultId ? value : undefined;
}

function toHeadlessError(cause: unknown): { kind: "network" | "rate_limit" | "agent_stopped" | "unknown"; message: string } {
  if (cause instanceof HeadlessSessionError) {
    return { kind: sessionErrorKind(cause), message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "unknown", message };
}
