import { spawn, type ChildProcess } from "node:child_process";
import { parseRequestedEffort, unsupportedEffort } from "./effort.js";
import { HeadlessSessionError } from "./errors.js";
import { JsonRpcPeer } from "./jsonRpc.js";
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

const RUNTIME_KEY_PREFIX = "codex:app-server";

/** Kill grace before SIGKILL when a persistent process ignores SIGTERM. */
const KILL_GRACE_MS = 3_000;

type CodexThreadHandler = {
  agentMessageDelta(turnId: string, itemId: string, delta: string): void;
  turnCompleted(turn: CodexTurn): void;
  turnError(turnId: string | undefined, message: string, willRetry: boolean): void;
};

type CodexTurn = {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  items?: Array<{ type?: string; text?: string; phase?: string | null }>;
};

type CodexModelListEntry = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
};

type CodexModelListResponse = {
  data?: CodexModelListEntry[];
  nextCursor?: string | null;
};

/**
 * One `codex app-server` process plus its JSON-RPC connection. Shared by every
 * codex/app-server session; each session owns a thread on this runtime.
 */
export class CodexAppServerRuntime implements PersistentRuntime {
  private readonly peer: JsonRpcPeer;
  private readonly exitHandlers = new Set<(error: HeadlessSessionError) => void>();
  private readonly threadHandlers = new Map<string, CodexThreadHandler>();
  private exitError: HeadlessSessionError | undefined;
  private closePromise: Promise<void> | undefined;
  private modelsPromise: Promise<CodexModelListEntry[]> | undefined;

  private constructor(
    private readonly child: ChildProcess,
    command: string
  ) {
    this.peer = new JsonRpcPeer(`codex app-server (${command})`, {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr ?? undefined
    });
    this.peer.setNotificationHandler((method, params) => this.onNotification(method, params));
    this.peer.setRequestHandler((method, params) => this.onServerRequest(method, params));
    this.peer.onClose((error) => this.handleExit(error));
    child.on("error", (cause) => {
      this.peer.fail(
        new HeadlessSessionError("PROTOCOL_ERROR", `codex app-server process error: ${cause.message}`, { cause })
      );
    });
    child.on("close", (code, signal) => {
      const detail = this.peer.stderr.trim();
      this.peer.fail(
        new HeadlessSessionError(
          "PROTOCOL_ERROR",
          `codex app-server exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail ? `: ${detail}` : ""}`
        )
      );
    });
  }

  static async start(ctx: SessionContext): Promise<CodexAppServerRuntime> {
    const command = ctx.env.CODEX_BIN || "codex";
    let child: ChildProcess;
    try {
      child = spawn(command, ["app-server"], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      throw new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to spawn ${command} app-server`, { cause });
    }

    const runtime = new CodexAppServerRuntime(child, command);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (cause) =>
          reject(new HeadlessSessionError("RUNTIME_START_FAILED", `Failed to start ${command} app-server: ${cause.message}`, { cause }))
        );
      });
      // thread/* and turn/* are v2 methods gated behind the experimentalApi
      // capability opt-in.
      await runtime.peer.request(
        "initialize",
        {
          clientInfo: { name: "headless-core", title: "headless_core", version: "0" },
          capabilities: { experimentalApi: true, requestAttestation: false }
        },
        CONTROL_REQUEST_TIMEOUT_MS
      );
      runtime.peer.notify("initialized");
      return runtime;
    } catch (cause) {
      await runtime.close();
      if (cause instanceof HeadlessSessionError) {
        throw cause;
      }
      throw new HeadlessSessionError("RUNTIME_START_FAILED", `codex app-server initialization failed`, { cause });
    }
  }

  get alive(): boolean {
    return !this.peer.closed && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null;
  }

  onExit(handler: (error: HeadlessSessionError) => void): void {
    if (this.exitError) {
      handler(this.exitError);
      return;
    }
    this.exitHandlers.add(handler);
  }

  attachThread(threadId: string, handler: CodexThreadHandler): void {
    this.threadHandlers.set(threadId, handler);
  }

  detachThread(threadId: string): void {
    this.threadHandlers.delete(threadId);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.peer.request<T>(method, params, CONTROL_REQUEST_TIMEOUT_MS);
  }

  /**
   * model/list results are cached for the runtime lifetime — the model
   * catalog does not change while the process lives. An empty list means
   * "capabilities unknown"; callers degrade to provider-side validation.
   */
  listModels(): Promise<CodexModelListEntry[]> {
    if (!this.modelsPromise) {
      this.modelsPromise = this.fetchModels().catch(() => []);
    }
    return this.modelsPromise;
  }

  /** Model id -> reasoning effort levels the model advertises. */
  async modelEffortLevels(): Promise<Map<string, string[]>> {
    const levels = new Map<string, string[]>();
    for (const model of await this.listModels()) {
      const id = model.id ?? model.model;
      if (!id) {
        continue;
      }
      levels.set(
        id,
        (model.supportedReasoningEfforts ?? [])
          .map((option) => option.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string")
      );
    }
    return levels;
  }

  private async fetchModels(): Promise<CodexModelListEntry[]> {
    const entries: CodexModelListEntry[] = [];
    let cursor: string | null = null;
    do {
      const res: CodexModelListResponse = await this.request("model/list", {
        cursor,
        includeHidden: false
      });
      entries.push(...(res.data ?? []));
      cursor = res.nextCursor ?? null;
    } while (cursor);
    return entries;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.kill();
    return this.closePromise;
  }

  private async kill(): Promise<void> {
    this.peer.dispose();
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
    for (const handler of this.threadHandlers.values()) {
      handler.turnError(undefined, error.message, false);
    }
    this.threadHandlers.clear();
    for (const handler of this.exitHandlers) {
      handler(error);
    }
    this.exitHandlers.clear();
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof p.threadId === "string" ? p.threadId : undefined;
    const handler = threadId ? this.threadHandlers.get(threadId) : undefined;

    switch (method) {
      case "item/agentMessage/delta": {
        if (handler && typeof p.delta === "string" && typeof p.turnId === "string") {
          handler.agentMessageDelta(p.turnId, String(p.itemId ?? ""), p.delta);
        }
        return;
      }
      case "turn/completed": {
        handler?.turnCompleted((p.turn ?? {}) as CodexTurn);
        return;
      }
      case "error": {
        const error = (p.error ?? {}) as { message?: unknown };
        handler?.turnError(
          typeof p.turnId === "string" ? p.turnId : undefined,
          typeof error.message === "string" ? error.message : "codex app-server error",
          p.willRetry === true
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * Headless sessions run read-only with approvalPolicy "never". Any approval
   * or elicitation request that still arrives is declined so the agent never
   * blocks on a prompt nobody can answer.
   */
  private onServerRequest(method: string, _params: unknown): unknown {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: { denied: { rejection: "headless_core sessions are read-only" } } };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "item/tool/call":
        return { contentItems: [], success: false };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        throw new HeadlessSessionError("PROTOCOL_ERROR", `Unsupported codex server request: ${method}`);
    }
  }
}

export function codexAppServerRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `${RUNTIME_KEY_PREFIX}:${env.CODEX_BIN || "codex"}`;
}

/**
 * One codex app-server thread. Multiple sessions share the runtime process.
 */
export class CodexAppServerSession implements HeadlessSession {
  readonly provider = "codex";
  readonly transport = "app-server" as const;

  private threadId: string | null = null;
  private closed = false;
  private runtimeDead = false;
  private busy: Promise<void> = Promise.resolve();
  private activeTurn: TurnSettlement | undefined;
  private activeTurnId: string | undefined;
  private activeTurnOptions: HeadlessSessionRunOptions | undefined;
  private accumulated = "";
  private model: string | undefined;
  private effort: string | undefined;
  /** The model the thread actually runs (reported by thread/start). */
  private threadModel: string | undefined;
  private released = false;

  private constructor(
    private readonly runtime: CodexAppServerRuntime,
    private readonly ctx: SessionContext,
    private agent: AgentSpec,
    private readonly releaseLease: () => void
  ) {
    this.model = normalize(agent.model, DEFAULT_MODEL_ID);
    this.effort = parseRequestedEffort(agent.reasoningEffort);
    runtime.onExit(() => {
      this.runtimeDead = true;
      this.activeTurn?.fail(
        new HeadlessSessionError("PROTOCOL_ERROR", "codex app-server exited while a turn was in progress")
      );
    });
  }

  static async create(
    runtime: CodexAppServerRuntime,
    ctx: SessionContext,
    agent: AgentSpec,
    releaseLease: () => void
  ): Promise<CodexAppServerSession> {
    try {
      const session = new CodexAppServerSession(runtime, ctx, agent, releaseLease);
      await session.startThread();
      return session;
    } catch (cause) {
      releaseLease();
      throw cause;
    }
  }

  get id(): string | null {
    return this.threadId;
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
    const modelId = normalize(model, DEFAULT_MODEL_ID);
    const effort = reasoningEffort === undefined ? undefined : parseRequestedEffort(reasoningEffort);
    // A persisted effort stays active across setModel calls; re-validate it
    // against the new model before accepting the change.
    const effectiveEffort = reasoningEffort === undefined ? this.effort : effort;
    if (effectiveEffort) {
      await this.assertEffortSupported(modelId, effectiveEffort);
    }
    // Applied as turn/start overrides ("for this turn and subsequent turns")
    // on the next run(); no process restart needed.
    this.model = modelId;
    if (reasoningEffort !== undefined) {
      this.effort = effort;
    }
    this.agent = { ...this.agent, model, reasoningEffort };
  }

  async getAvailableModels(): Promise<ModelCandidate[]> {
    this.assertUsable();
    const models: ModelCandidate[] = [];
    for (const model of await this.runtime.listModels()) {
      const id = model.id ?? model.model;
      if (!id) {
        continue;
      }
      models.push({
        id,
        name: model.displayName,
        description: model.description,
        reasoningEfforts: model.supportedReasoningEfforts
          ?.map((option) => option.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string")
      });
    }
    return models;
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    const op = this.busy.then(() => this.releaseThread());
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
    const threadId = this.threadId;
    if (!threadId) {
      throw new HeadlessSessionError("SESSION_CLOSED", "codex session has no thread");
    }

    emitSessionProgress(options, this.agent, { state: "starting", message: `Starting ${this.provider} turn` });

    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }]
    };
    if (this.model) {
      params.model = this.model;
    }
    if (this.effort) {
      // Enforce the model's advertised levels before the turn starts; when
      // they are unknown the app-server remains the source of truth.
      await this.assertEffortSupported(this.model, this.effort);
      params.effort = this.effort;
    }

    const response = await this.runtime.request<{ turn?: CodexTurn }>("turn/start", params);
    const turnId = response.turn?.id;
    if (!turnId) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "codex app-server returned no turn id");
    }

    this.accumulated = "";
    const settlement = startTurn({
      timeoutMs: options.timeoutMs ?? this.ctx.timeoutMs,
      signal: options.signal,
      interrupt: () => {
        void this.runtime.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
    });
    this.activeTurn = settlement;
    this.activeTurnId = turnId;
    this.activeTurnOptions = options;

    settlement.done.finally(() => {
      if (this.activeTurn === settlement) {
        this.activeTurn = undefined;
        this.activeTurnId = undefined;
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

  private readonly threadHandler: CodexThreadHandler = {
    agentMessageDelta: (turnId, _itemId, delta) => {
      if (turnId !== this.activeTurnId || !this.activeTurnOptions) {
        return;
      }
      this.accumulated += delta;
      emitSessionProgress(this.activeTurnOptions, this.agent, { state: "running", partialOutput: delta });
    },
    turnCompleted: (turn) => {
      if (turn.id !== this.activeTurnId || !this.activeTurn) {
        return;
      }
      const settlement = this.activeTurn;
      if (turn.status === "completed") {
        settlement.complete(finalAgentMessage(turn) || this.accumulated);
      } else if (turn.status === "interrupted") {
        settlement.fail(new HeadlessSessionError("REQUEST_ABORTED", "Turn interrupted"));
      } else {
        const message = turn.error?.message || `Turn ${turn.status ?? "failed"}`;
        settlement.fail(new HeadlessSessionError("PROTOCOL_ERROR", message));
      }
    },
    turnError: (turnId, message, willRetry) => {
      if (turnId !== undefined && turnId !== this.activeTurnId) {
        return;
      }
      if (!willRetry && this.activeTurn) {
        // The caller sees the failure immediately; `done` still waits for
        // turn/completed (or the grace timeout) so the queue stays ordered.
        this.activeTurn.rejectSoon(new HeadlessSessionError("PROTOCOL_ERROR", message));
      }
    }
  };

  private async startThread(): Promise<void> {
    const params: Record<string, unknown> = {
      cwd: this.ctx.cwd,
      // Headless parity with `codex exec --sandbox read-only` +
      // approval_policy="never". Threads are ephemeral: headless
      // conversations are never resumed or listed.
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true
    };
    if (this.model) {
      params.model = this.model;
    }
    const res = await this.runtime.request<{ thread?: { id?: string }; model?: string }>(
      "thread/start",
      params
    );
    const threadId = res.thread?.id;
    if (!threadId) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "codex app-server returned no thread id");
    }
    this.threadId = threadId;
    this.threadModel = typeof res.model === "string" ? res.model : undefined;
    this.runtime.attachThread(threadId, this.threadHandler);
  }

  private async resetConversation(): Promise<void> {
    this.assertUsable();
    await this.releaseThread();
    await this.startThread();
  }

  private async releaseThread(): Promise<void> {
    const threadId = this.threadId;
    this.threadId = null;
    if (!threadId || !this.runtime.alive) {
      return;
    }
    this.runtime.detachThread(threadId);
    try {
      await this.runtime.request("thread/unsubscribe", { threadId });
    } catch {
      // The thread may already be gone; releasing must not fail.
    }
  }

  /**
   * Enforces the model's advertised effort levels when the runtime's
   * model/list catalog knows the effective model; unknown capabilities
   * degrade to provider-side validation rather than blocking the request.
   */
  private async assertEffortSupported(modelId: string | undefined, effort: string): Promise<void> {
    const effectiveModel = modelId ?? this.threadModel;
    const levels = effectiveModel ? (await this.runtime.modelEffortLevels()).get(effectiveModel) : undefined;
    if (levels && !levels.includes(effort)) {
      throw unsupportedEffort("codex", effectiveModel, effort, levels);
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
      throw new HeadlessSessionError("PROTOCOL_ERROR", "codex app-server runtime is not running");
    }
  }
}

function normalize(value: string | undefined, defaultId: string): string | undefined {
  return value && value !== defaultId ? value : undefined;
}

function finalAgentMessage(turn: CodexTurn): string {
  const items = (turn.items ?? []).filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  let final = items.at(-1);
  for (const item of items) {
    if (item.phase === "final_answer") {
      final = item;
    }
  }
  return final?.text ?? "";
}

function toHeadlessError(cause: unknown): { kind: "network" | "rate_limit" | "agent_stopped" | "unknown"; message: string } {
  if (cause instanceof HeadlessSessionError) {
    return { kind: sessionErrorKind(cause), message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "unknown", message };
}
