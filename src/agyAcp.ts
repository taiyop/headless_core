import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { resolveAgyEffort } from "./agyModel.js";
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

const RUNTIME_KEY_PREFIX = "agy:acp";
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_LIMIT = 8192;

/**
 * Config option ids/categories that can carry a reasoning effort on an ACP
 * session. Agy's own flag is `--effort`; `thought_level` is the standard ACP
 * category. Checked in order — the first advertised select wins.
 */
const EFFORT_OPTION_IDS = [
  "effort",
  "thought_level",
  "reasoning_effort",
  "reasoningEffort",
  "thinking_level",
  "thinking"
] as const;

/**
 * Mode ids matching `agy --print --mode accept-edits
 * --dangerously-skip-permissions`: the CLI's own mode name, the ACP server's
 * file-edit auto-approve mode, then full auto-approve. Permission prompts are
 * client-side auto-approved regardless, so the choice only decides which
 * tool calls skip the round-trip server-side.
 */
const EDIT_MODE_IDS = ["accept-edits", "auto_edit", "yolo"] as const;

type AcpModule = typeof acp;

type SessionUpdateHandler = (update: acp.SessionUpdate) => void;

/**
 * One `agy_acp_server` process plus its ACP connection. Shared by every
 * agy/acp session; each session owns an ACP session on this runtime.
 *
 * The server binary ships as `agy_acp_server.par` (macOS/Linux) or
 * `agy_acp_server.exe` (Windows) in the ACP registry archive; AGY_ACP_BIN
 * overrides the lookup path.
 */
export class AgyAcpRuntime implements PersistentRuntime {
  private readonly exitHandlers = new Set<(error: HeadlessSessionError) => void>();
  private exitError: HeadlessSessionError | undefined;
  private closePromise: Promise<void> | undefined;
  private stderrTail = "";
  /** First advertised non-terminal auth method, when the server has any. */
  private authMethodId: string | undefined;

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
      this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", `agy_acp_server process error: ${cause.message}`, { cause }))
    );
    child.on("close", (code, signal) => {
      const detail = this.stderrTail.trim().split(/\r?\n/).at(-1);
      this.handleExit(
        new HeadlessSessionError(
          "PROTOCOL_ERROR",
          `agy_acp_server exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail ? `: ${detail}` : ""}`
        )
      );
    });
    void conn.closed.then(
      () => this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", "agy_acp_server connection closed")),
      (cause: unknown) =>
        this.handleExit(
          new HeadlessSessionError(
            "PROTOCOL_ERROR",
            `agy_acp_server connection closed: ${cause instanceof Error ? cause.message : String(cause)}`
          )
        )
    );
  }

  get agent(): acp.ClientContext {
    return this.conn.agent;
  }

  static async start(ctx: SessionContext): Promise<AgyAcpRuntime> {
    let acpModule: AcpModule;
    try {
      acpModule = await import("@agentclientprotocol/sdk");
    } catch (cause) {
      throw new HeadlessSessionError(
        "RUNTIME_START_FAILED",
        "The agy ACP transport requires @agentclientprotocol/sdk",
        { cause }
      );
    }

    const { child } = await spawnAcpServer(ctx);

    let runtime: AgyAcpRuntime;
    try {
      const stream = acpModule.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      );
      const app = acpModule.client({ name: "headless-core" });
      const sessionHandlers = new Map<string, SessionUpdateHandler>();
      app.onNotification("session/update", ({ params }) => {
        sessionHandlers.get(params.sessionId)?.(params.update);
      });
      app.onRequest("session/request_permission", ({ params }) => approvePermission(params));

      const conn = app.connect(stream);
      const initRes = await conn.agent.request(
        "initialize",
        {
          protocolVersion: acpModule.PROTOCOL_VERSION,
          // The agent keeps its own tools; this client answers permission
          // prompts but cannot serve fs/terminal requests on its behalf.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "headless-core", title: "headless_core", version: "0" }
        },
        { cancellationSignal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS) }
      );
      runtime = new AgyAcpRuntime(child, conn, sessionHandlers);
      runtime.authMethodId = advertisedAuthMethod(initRes);
      // Some builds select credentials from settings.json on their own; the
      // eager authenticate is a best-effort pre-flight for those that do not.
      await runtime.authenticate();
      return runtime;
    } catch (cause) {
      child.kill("SIGKILL");
      if (cause instanceof HeadlessSessionError) {
        throw cause;
      }
      throw new HeadlessSessionError("RUNTIME_START_FAILED", "agy_acp_server initialization failed", { cause });
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

  /**
   * Runs `authenticate` with the advertised method when one exists. Always
   * resolves false on failure — a server that actually requires auth fails
   * its next session/new with the real error.
   */
  async authenticate(): Promise<boolean> {
    if (!this.authMethodId || !this.alive) {
      return false;
    }
    try {
      await this.request("authenticate", { methodId: this.authMethodId });
      return true;
    } catch {
      return false;
    }
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

export function agyAcpRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `${RUNTIME_KEY_PREFIX}:${env.AGY_ACP_BIN || "agy_acp_server"}`;
}

/**
 * Resolves the server binary. The registry archive names it
 * `agy_acp_server.par` (a self-contained executable) on macOS/Linux and
 * `agy_acp_server.exe` on Windows, while manual installs may put an
 * `agy_acp_server` shim on PATH — try both names unless AGY_ACP_BIN pins one.
 * Linux builds additionally take the registry's `--uid=` argument.
 */
async function spawnAcpServer(ctx: SessionContext): Promise<{ child: ChildProcess; command: string }> {
  const configured = ctx.env.AGY_ACP_BIN?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? ["agy_acp_server.exe", "agy_acp_server"]
      : ["agy_acp_server", "agy_acp_server.par"];
  const args = process.platform === "linux" ? ["--uid="] : [];

  let lastCause: unknown;
  for (const command of candidates) {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      lastCause = cause;
      continue;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      return { child, command };
    } catch (cause) {
      lastCause = cause;
    }
  }

  const detail = lastCause instanceof Error ? `: ${lastCause.message}` : "";
  throw new HeadlessSessionError(
    "RUNTIME_START_FAILED",
    `Failed to start the agy ACP server (tried: ${candidates.join(", ")})${detail}. Set AGY_ACP_BIN to the agy_acp_server binary path.`,
    { cause: lastCause }
  );
}

/**
 * Picks the first non-terminal auth method the server advertised (e.g.
 * oauth-personal). Terminal-type methods need a TUI and are never usable in
 * headless runs.
 */
function advertisedAuthMethod(initRes: unknown): string | undefined {
  const methods = (initRes as { authMethods?: unknown } | undefined)?.authMethods;
  if (!Array.isArray(methods)) {
    return undefined;
  }
  return methods.find(
    (entry): entry is { id: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type !== "terminal" &&
      typeof (entry as { id?: unknown }).id === "string"
  )?.id;
}

/** Auth-looking failures from session/new: worth an authenticate+retry. */
function isAuthFailure(cause: unknown): boolean {
  return cause instanceof Error && /auth/i.test(cause.message);
}

/**
 * One ACP session on a shared `agy_acp_server` runtime.
 */
export class AgyAcpSession implements HeadlessSession {
  readonly provider = "agy";
  readonly transport = "acp" as const;

  private sessionId: string | null = null;
  private configOptions: acp.SessionConfigOption[] = [];
  private modes: acp.SessionModeState | null | undefined;
  // Session-start defaults, restored when setModel() is called with "default".
  private defaultModelValue: string | undefined;
  private defaultEffortValue: string | undefined;
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
    private readonly runtime: AgyAcpRuntime,
    private readonly ctx: SessionContext,
    private agent: AgentSpec,
    private readonly releaseLease: () => void
  ) {
    this.model = normalize(agent.model, DEFAULT_MODEL_ID);
    this.effort = parseRequestedEffort(agent.reasoningEffort);
    runtime.onExit(() => {
      this.runtimeDead = true;
      this.activeTurn?.fail(
        new HeadlessSessionError("PROTOCOL_ERROR", "agy_acp_server exited while a turn was in progress")
      );
    });
  }

  static async create(
    runtime: AgyAcpRuntime,
    ctx: SessionContext,
    agent: AgentSpec,
    releaseLease: () => void
  ): Promise<AgyAcpSession> {
    try {
      const session = new AgyAcpSession(runtime, ctx, agent, releaseLease);
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
      throw new HeadlessSessionError("SESSION_CLOSED", "agy session has no ACP session id");
    }

    emitSessionProgress(options, this.agent, { state: "starting", message: `Starting ${this.provider} turn` });

    this.accumulated = "";
    this.activeTurnOptions = options;
    const settlement = startTurn({
      timeoutMs: options.timeoutMs ?? this.ctx.timeoutMs,
      signal: options.signal,
      interrupt: () => {
        // session/cancel is a notification — builds that lack the method
        // simply ignore it and the interrupt grace unblocks the queue.
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
        settlement.fail(new HeadlessSessionError("PROTOCOL_ERROR", "agy_acp_server refused the prompt"));
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
    let res: {
      sessionId?: string;
      configOptions?: acp.SessionConfigOption[] | null;
      modes?: acp.SessionModeState | null;
    };
    try {
      res = await this.newSession();
    } catch (cause) {
      // A build that advertises authMethods may reject session/new until
      // authenticate runs; the start-time attempt is best-effort, so retry
      // once through an explicit authenticate here.
      if (!isAuthFailure(cause) || !(await this.runtime.authenticate())) {
        throw cause;
      }
      res = await this.newSession();
    }
    if (!res.sessionId) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "agy_acp_server returned no session id");
    }
    this.sessionId = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    this.modes = res.modes;
    this.defaultModelValue = configOptionCurrentValue(this.findConfigOption("model"));
    this.defaultEffortValue = configOptionCurrentValue(this.findEffortOption());
    this.runtime.attachSession(this.sessionId, this.updateHandler);
    await this.enforceEditMode();
    if (this.model || this.effort) {
      await this.applyModelConfig(this.model, this.effort);
    }
  }

  private async newSession(): Promise<{
    sessionId?: string;
    configOptions?: acp.SessionConfigOption[] | null;
    modes?: acp.SessionModeState | null;
  }> {
    return this.runtime.request("session/new", { cwd: this.ctx.cwd, mcpServers: [] });
  }

  /**
   * The agy CLI transport runs `agy --print --mode accept-edits
   * --dangerously-skip-permissions`: file-writing tools (e.g. image
   * generation) must work without an interactive prompt. Select the closest
   * advertised edit mode — via the `mode` config option when the session
   * offers one, or the legacy modes/`session/set_mode` channel.
   */
  private async enforceEditMode(): Promise<void> {
    const mode = this.configOptions.find(
      (option) => (option.category === "mode" || option.id === "mode") && option.type === "select"
    );
    if (mode) {
      const values = flattenConfigOptionValues(mode).map((entry) => entry.value);
      const target = EDIT_MODE_IDS.find((id) => values.includes(id));
      if (target) {
        await this.setConfigOption(mode.id, target);
      }
      return;
    }
    const modes = this.modes;
    const sessionId = this.sessionId;
    const target = modes ? EDIT_MODE_IDS.find((id) => modes.availableModes.some((entry) => entry.id === id)) : undefined;
    if (sessionId && modes && target && modes.currentModeId !== target) {
      try {
        await this.runtime.request("session/set_mode", { sessionId, modeId: target });
      } catch {
        // Older builds without session/set_mode keep the server default mode;
        // permission prompts are still auto-approved either way.
      }
    }
  }

  /**
   * Applies a (model, effort) pair through the ACP session config options,
   * reusing the agy CLI mapping: a level-embedded variant id wins when the
   * session advertises it (<model>-<level>, including an explicit -none),
   * otherwise in-range levels go to the effort-style config option
   * (effort/thought_level/...). Levels the session cannot express raise
   * UNSUPPORTED_EFFORT — never a silent conversion.
   */
  private async applyModelConfig(model: string | undefined, effort: string | undefined): Promise<void> {
    const modelOption = this.findConfigOption("model");
    const effortOption = this.findEffortOption();
    const effortValues = effortOption
      ? flattenConfigOptionValues(effortOption).map((entry) => entry.value)
      : [];
    const modelId = model && model !== DEFAULT_MODEL_ID ? model : undefined;
    const effortId = parseRequestedEffort(effort);

    if (modelId) {
      if (!modelOption) {
        throw new HeadlessSessionError("PROTOCOL_ERROR", "agy acp session exposes no model config option");
      }
      const values = flattenConfigOptionValues(modelOption).map((entry) => entry.value);
      if (!effortId) {
        await this.setConfigOption(modelOption.id, modelId);
      } else {
        let resolution;
        try {
          // An empty advertised list means "capabilities unknown" — degrade to
          // server-side validation rather than rejecting every model.
          resolution = resolveAgyEffort(modelId, effortId, values.length ? values : null);
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
        await this.setConfigOption(modelOption.id, resolution.model ?? modelId);
        if (resolution.flagEffort) {
          if (!effortOption || !effortValues.includes(resolution.flagEffort)) {
            throw unsupportedEffort("agy", modelId, resolution.flagEffort, effortValues);
          }
          await this.setConfigOption(effortOption.id, resolution.flagEffort);
        }
      }
    } else {
      if (model !== undefined && modelOption && this.defaultModelValue) {
        // An explicit "default" model restores what the session started with.
        await this.setConfigOption(modelOption.id, this.defaultModelValue);
      }
      if (effortId) {
        // With no model selected, the effort option is the only channel; it
        // cannot express levels it does not offer.
        if (!effortOption || !effortValues.includes(effortId)) {
          throw unsupportedEffort("agy", undefined, effortId, effortValues);
        }
        await this.setConfigOption(effortOption.id, effortId);
      }
    }

    if (effort !== undefined && !effortId && effortOption && this.defaultEffortValue) {
      // An explicit "default" effort restores the session's initial level.
      await this.setConfigOption(effortOption.id, this.defaultEffortValue);
    }
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new HeadlessSessionError("SESSION_CLOSED", "agy session has no ACP session id");
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

  private findEffortOption(): acp.SessionConfigOption | undefined {
    for (const id of EFFORT_OPTION_IDS) {
      const option = this.findConfigOption(id);
      if (option) {
        return option;
      }
    }
    return undefined;
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
    // agy_acp_server implements session/close; session/delete is the fallback
    // for ACP agents that only advertise delete.
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
      throw new HeadlessSessionError("PROTOCOL_ERROR", "agy_acp_server runtime is not running");
    }
  }
}

/**
 * Agy parity with `--dangerously-skip-permissions`: headless runs cannot
 * answer prompts, so tool calls are auto-approved. Pick the allow option the
 * agent offered, or cancel the request outright when it gave no allow choice.
 */
function approvePermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const options = params.options ?? [];
  const allow =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  if (allow) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
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
