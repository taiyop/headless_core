import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { parseRequestedEffort, unsupportedEffort } from "./effort.js";
import { HeadlessSessionError } from "./errors.js";
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

const RUNTIME_KEY_PREFIX = "grok:acp";
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_LIMIT = 8192;

/**
 * Config option ids/categories that can carry a reasoning effort on an ACP
 * session. Grok's own id is `reasoning_effort` (category `thought_level`);
 * the rest are the generic ACP spellings. Checked in order — the first
 * advertised select wins.
 */
const EFFORT_OPTION_IDS = [
  "reasoning_effort",
  "thought_level",
  "effort",
  "reasoningEffort",
  "thinking_level",
  "thinking"
] as const;

type AcpModule = typeof acp;

type SessionUpdateHandler = (update: acp.SessionUpdate) => void;

/**
 * The `models` block in grok's session/new response (and in the
 * `_x.ai/models/update` notifications): a model catalog where each entry's
 * _meta carries the reasoning effort levels that model accepts.
 */
type GrokModelEntry = {
  modelId: string;
  name?: string;
  description?: string;
  supportsReasoningEffort?: boolean;
  reasoningEfforts?: string[];
};

type GrokModelsState = {
  currentModelId?: string;
  availableModels: GrokModelEntry[];
};

/**
 * One `grok agent --always-approve stdio` process plus its ACP connection.
 * Shared by every grok/acp session; each session owns an ACP session on this
 * runtime.
 */
export class GrokAcpRuntime implements PersistentRuntime {
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
      this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", `grok agent stdio process error: ${cause.message}`, { cause }))
    );
    child.on("close", (code, signal) => {
      const detail = this.stderrTail.trim().split(/\r?\n/).at(-1);
      this.handleExit(
        new HeadlessSessionError(
          "PROTOCOL_ERROR",
          `grok agent stdio exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail ? `: ${detail}` : ""}`
        )
      );
    });
    void conn.closed.then(
      () => this.handleExit(new HeadlessSessionError("PROTOCOL_ERROR", "grok agent stdio connection closed")),
      (cause: unknown) =>
        this.handleExit(
          new HeadlessSessionError(
            "PROTOCOL_ERROR",
            `grok agent stdio connection closed: ${cause instanceof Error ? cause.message : String(cause)}`
          )
        )
    );
  }

  get agent(): acp.ClientContext {
    return this.conn.agent;
  }

  static async start(ctx: SessionContext): Promise<GrokAcpRuntime> {
    let acpModule: AcpModule;
    try {
      acpModule = await import("@agentclientprotocol/sdk");
    } catch (cause) {
      throw new HeadlessSessionError(
        "RUNTIME_START_FAILED",
        "The grok ACP transport requires @agentclientprotocol/sdk",
        { cause }
      );
    }

    const command = ctx.env.GROK_BIN || "grok";
    let child: ChildProcess;
    try {
      // --always-approve matches the CLI transport: `grok --single` runs
      // headless turns without pausing for tool permission prompts.
      child = spawn(command, ["agent", "--always-approve", "stdio"], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      throw new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to spawn ${command} agent stdio`, { cause });
    }

    let runtime: GrokAcpRuntime;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (cause) =>
          reject(new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to start ${command} agent stdio: ${cause.message}`, { cause }))
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
      runtime = new GrokAcpRuntime(child, conn, sessionHandlers);
      runtime.authMethodId = advertisedAuthMethod(initRes);
      // Grok advertises `cached_token` (credentials from ~/.grok/auth.json)
      // as its default method; the eager authenticate is a best-effort
      // pre-flight for setups that are not signed in yet.
      await runtime.authenticate();
      return runtime;
    } catch (cause) {
      child.kill("SIGKILL");
      if (cause instanceof HeadlessSessionError) {
        throw cause;
      }
      throw new HeadlessSessionError("RUNTIME_START_FAILED", "grok agent stdio initialization failed", { cause });
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

export function grokAcpRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `${RUNTIME_KEY_PREFIX}:${env.GROK_BIN || "grok"}`;
}

/**
 * Grok advertises `_meta.defaultAuthMethodId` (`cached_token`); fall back to
 * the first non-terminal method — terminal-type methods need a TUI and are
 * never usable in headless runs.
 */
function advertisedAuthMethod(initRes: unknown): string | undefined {
  const meta = (initRes as { _meta?: unknown } | undefined)?._meta;
  const defaultMethod = (meta as { defaultAuthMethodId?: unknown } | undefined)?.defaultAuthMethodId;
  if (typeof defaultMethod === "string" && defaultMethod) {
    return defaultMethod;
  }
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
 * One ACP session on a shared `grok agent stdio` runtime.
 */
export class GrokAcpSession implements HeadlessSession {
  readonly provider = "grok";
  readonly transport = "acp" as const;

  private sessionId: string | null = null;
  private configOptions: acp.SessionConfigOption[] = [];
  private modelsState: GrokModelsState | null = null;
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
    private readonly runtime: GrokAcpRuntime,
    private readonly ctx: SessionContext,
    private agent: AgentSpec,
    private readonly releaseLease: () => void
  ) {
    this.model = normalize(agent.model, DEFAULT_MODEL_ID);
    this.effort = parseRequestedEffort(agent.reasoningEffort);
    runtime.onExit(() => {
      this.runtimeDead = true;
      this.activeTurn?.fail(
        new HeadlessSessionError("PROTOCOL_ERROR", "grok agent stdio exited while a turn was in progress")
      );
    });
  }

  static async create(
    runtime: GrokAcpRuntime,
    ctx: SessionContext,
    agent: AgentSpec,
    releaseLease: () => void
  ): Promise<GrokAcpSession> {
    try {
      const session = new GrokAcpSession(runtime, ctx, agent, releaseLease);
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
    if (this.modelsState?.availableModels.length) {
      return this.modelsState.availableModels.map((entry) => ({
        id: entry.modelId,
        name: entry.name,
        description: entry.description ?? undefined,
        reasoningEfforts: entry.reasoningEfforts
      }));
    }
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
      throw new HeadlessSessionError("SESSION_CLOSED", "grok session has no ACP session id");
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
        settlement.fail(new HeadlessSessionError("PROTOCOL_ERROR", "grok agent stdio refused the prompt"));
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
      models?: unknown;
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
      throw new HeadlessSessionError("PROTOCOL_ERROR", "grok agent stdio returned no session id");
    }
    this.sessionId = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    this.modelsState = parseModelsState(res.models);
    this.defaultModelValue =
      this.modelsState?.currentModelId ?? configOptionCurrentValue(this.findConfigOption("model"));
    this.defaultEffortValue = configOptionCurrentValue(this.findEffortOption());
    this.runtime.attachSession(this.sessionId, this.updateHandler);
    if (this.model || this.effort) {
      await this.applyModelConfig(this.model, this.effort);
    }
  }

  private async newSession(): Promise<{
    sessionId?: string;
    configOptions?: acp.SessionConfigOption[] | null;
    models?: unknown;
  }> {
    return this.runtime.request("session/new", { cwd: this.ctx.cwd, mcpServers: [] });
  }

  /**
   * Applies a (model, effort) pair through the ACP session config options.
   * Grok model ids never embed the level — the model option selects the model
   * and the session's effort option (`reasoning_effort`/`thought_level`/...)
   * carries the level. Levels the model cannot express raise
   * UNSUPPORTED_EFFORT — never a silent conversion.
   */
  private async applyModelConfig(model: string | undefined, effort: string | undefined): Promise<void> {
    const modelOption = this.findConfigOption("model");
    const modelId = model && model !== DEFAULT_MODEL_ID ? model : undefined;
    const effortId = parseRequestedEffort(effort);

    if (modelId) {
      if (!modelOption && !this.modelsState) {
        throw new HeadlessSessionError("PROTOCOL_ERROR", "grok acp session exposes no model config option");
      }
      const advertised = this.advertisedModelIds();
      if (advertised.length && !advertised.includes(modelId)) {
        throw new HeadlessSessionError(
          "PROTOCOL_ERROR",
          `grok acp session does not advertise model "${modelId}"`
        );
      }
      await this.applyModelSelection(modelId, modelOption);
    } else if (
      model !== undefined &&
      this.defaultModelValue &&
      (modelOption || this.modelsState)
    ) {
      // An explicit "default" model restores what the session started with.
      await this.applyModelSelection(this.defaultModelValue, modelOption);
    }

    if (effortId) {
      const effortOption = this.findEffortOption();
      // Per-model levels from the session's model catalog are authoritative;
      // the effort option's advertised values track the current model and
      // are the fallback when the catalog is absent.
      const supported = this.supportedEfforts(modelId ?? this.modelsState?.currentModelId, effortOption);
      if (supported && !supported.includes(effortId)) {
        throw unsupportedEffort("grok", modelId ?? this.defaultModelValue, effortId, supported);
      }
      if (!effortOption) {
        throw unsupportedEffort("grok", modelId ?? this.defaultModelValue, effortId, supported ?? []);
      }
      await this.setConfigOption(effortOption.id, effortId);
    } else if (effort !== undefined && this.defaultEffortValue) {
      // An explicit "default" effort restores the session's initial level.
      const effortOption = this.findEffortOption();
      if (effortOption) {
        await this.setConfigOption(effortOption.id, this.defaultEffortValue);
      }
    }
  }

  /**
   * The levels a model accepts: its `models` catalog entry when known (an
   * explicit empty list for non-reasoning models), else the effort option's
   * advertised values, else null = "capabilities unknown — let the server
   * validate".
   */
  private supportedEfforts(
    modelId: string | undefined,
    effortOption: acp.SessionConfigOption | undefined
  ): readonly string[] | null {
    const entry = modelId
      ? this.modelsState?.availableModels.find((candidate) => candidate.modelId === modelId)
      : undefined;
    if (entry) {
      return entry.reasoningEfforts ?? [];
    }
    const values = effortOption
      ? flattenConfigOptionValues(effortOption).map((option) => option.value)
      : [];
    return values.length ? values : null;
  }

  private advertisedModelIds(): string[] {
    if (this.modelsState?.availableModels.length) {
      return this.modelsState.availableModels.map((entry) => entry.modelId);
    }
    const option = this.findConfigOption("model");
    return option ? flattenConfigOptionValues(option).map((entry) => entry.value) : [];
  }

  /**
   * Selects a model through the `model` config option, or grok's
   * session/set_model extension when the session advertises a `models`
   * catalog without the option.
   */
  private async applyModelSelection(
    modelId: string,
    modelOption: acp.SessionConfigOption | undefined
  ): Promise<void> {
    if (modelOption) {
      await this.setConfigOption(modelOption.id, modelId);
    } else {
      const sessionId = this.sessionId;
      if (!sessionId) {
        throw new HeadlessSessionError("SESSION_CLOSED", "grok session has no ACP session id");
      }
      await this.runtime.request("session/set_model", { sessionId, modelId });
    }
    if (this.modelsState) {
      this.modelsState.currentModelId = modelId;
    }
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new HeadlessSessionError("SESSION_CLOSED", "grok session has no ACP session id");
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
    // Grok implements session/close; session/delete is the fallback for ACP
    // agents that only advertise delete.
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
      throw new HeadlessSessionError("PROTOCOL_ERROR", "grok agent stdio runtime is not running");
    }
  }
}

/**
 * Parity with `grok --single` headless runs (and `--always-approve`): tool
 * calls never pause for an interactive prompt. Pick the allow option the
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

function parseModelsState(value: unknown): GrokModelsState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const state = value as { currentModelId?: unknown; availableModels?: unknown };
  if (!Array.isArray(state.availableModels)) {
    return null;
  }
  const availableModels: GrokModelEntry[] = [];
  for (const entry of state.availableModels) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as {
      modelId?: unknown;
      name?: unknown;
      description?: unknown;
      _meta?: unknown;
    };
    if (typeof candidate.modelId !== "string" || !candidate.modelId) {
      continue;
    }
    const meta = candidate._meta as
      | { supportsReasoningEffort?: unknown; reasoningEfforts?: unknown }
      | undefined;
    const reasoningEfforts = Array.isArray(meta?.reasoningEfforts)
      ? meta.reasoningEfforts
          .map((effort) =>
            typeof effort === "string"
              ? effort
              : typeof effort === "object" && effort !== null
                ? ((effort as { id?: unknown; value?: unknown }).id ??
                  (effort as { value?: unknown }).value)
                : undefined
          )
          .filter((id): id is string => typeof id === "string")
      : undefined;
    availableModels.push({
      modelId: candidate.modelId,
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
      supportsReasoningEffort:
        typeof meta?.supportsReasoningEffort === "boolean" ? meta.supportsReasoningEffort : undefined,
      reasoningEfforts
    });
  }
  return {
    currentModelId: typeof state.currentModelId === "string" ? state.currentModelId : undefined,
    availableModels
  };
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
