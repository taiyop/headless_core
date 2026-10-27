import { randomUUID } from "node:crypto";
import type {
  EffortLevel as SdkEffortLevel,
  ModelInfo,
  Options as ClaudeSdkOptions,
  Query,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { parseRequestedEffort, unsupportedEffort } from "./effort.js";
import { HeadlessSessionError } from "./errors.js";
import type { PersistentRuntime, SessionContext } from "./runtimeManager.js";
import { emitSessionProgress, sessionErrorKind, startTurn, type TurnSettlement } from "./turnTracker.js";
import {
  DEFAULT_MODEL_ID,
  type AgentSpec,
  type Effort,
  type EffortLevel,
  type HeadlessSession,
  type HeadlessSessionRunOptions,
  type ModelCandidate
} from "./types.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Levels the Agent SDK `effort` option / `effortLevel` setting accepts. */
export const CLAUDE_SDK_SUPPORTED_EFFORTS: readonly SdkEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

type ClaudeSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModule: Promise<ClaudeSdkModule> | undefined;

/**
 * Loads the Agent SDK lazily. It is an optional peer dependency, so callers
 * that never use the `sdk` transport do not need it installed.
 */
function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  sdkModule ??= import(SDK_PACKAGE).catch((cause: unknown) => {
    sdkModule = undefined;
    throw new HeadlessSessionError(
      "RUNTIME_START_FAILED",
      `The claude "sdk" transport requires ${SDK_PACKAGE}. Install it with: npm install ${SDK_PACKAGE}`,
      { cause }
    );
  }) as Promise<ClaudeSdkModule>;
  return sdkModule;
}

/** Key for RuntimeManager: every Agent SDK query owns its own process. */
export function claudeSdkRuntimeKey(): string {
  return `claude:sdk:${randomUUID()}`;
}

/**
 * Push-based AsyncIterable used as the streaming-input prompt of one Agent SDK
 * query. Keeping it open keeps the Claude Code process (and conversation)
 * alive across turns.
 */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.queue.shift();
        if (message) {
          return Promise.resolve({ value: message, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}

/**
 * One streaming-input Agent SDK query: a Claude Code process holding a single
 * conversation. Messages from the query are pumped to the attached handler.
 */
export class ClaudeSdkRuntime implements PersistentRuntime {
  private readonly exitHandlers: Array<(error: HeadlessSessionError) => void> = [];
  private messageHandler: ((message: SDKMessage) => void) | undefined;
  private isAlive = true;
  private stderrTail = "";

  private constructor(
    readonly sessionId: string,
    private readonly input: InputChannel,
    private readonly query: Query
  ) {}

  static async start(ctx: SessionContext, options: ClaudeSdkOptions): Promise<ClaudeSdkRuntime> {
    const sdk = await loadClaudeSdk();
    const sessionId = randomUUID();
    let runtime: ClaudeSdkRuntime | undefined;
    const input = new InputChannel();
    let query: Query;
    try {
      query = sdk.query({
        prompt: input,
        options: {
          ...options,
          cwd: ctx.cwd,
          env: ctx.env,
          sessionId,
          stderr: (data) => runtime?.recordStderr(data)
        }
      });
    } catch (cause) {
      throw new HeadlessSessionError(
        "RUNTIME_START_FAILED",
        `Failed to start Claude Agent SDK query: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      );
    }
    runtime = new ClaudeSdkRuntime(sessionId, input, query);
    runtime.pump();
    return runtime;
  }

  get alive(): boolean {
    return this.isAlive;
  }

  onExit(handler: (error: HeadlessSessionError) => void): void {
    this.exitHandlers.push(handler);
  }

  attach(handler: (message: SDKMessage) => void): void {
    this.messageHandler = handler;
  }

  send(text: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null
    });
  }

  interrupt(): void {
    void this.query.interrupt().catch(() => undefined);
  }

  setModel(model: string | undefined): Promise<void> {
    return this.query.setModel(model);
  }

  setEffort(effort: SdkEffortLevel | undefined): Promise<void> {
    // null clears the session override and returns to the model default.
    return this.query.applyFlagSettings({ effortLevel: effort ?? null });
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.query.supportedModels();
  }

  close(): Promise<void> {
    if (this.isAlive) {
      this.input.end();
      try {
        this.query.close();
      } catch {
        // Already closed.
      }
      this.markExited(new HeadlessSessionError("SESSION_CLOSED", "Claude Agent SDK query closed"));
    }
    return Promise.resolve();
  }

  private recordStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-4_000);
  }

  private pump(): void {
    void (async () => {
      try {
        for await (const message of this.query) {
          this.messageHandler?.(message);
        }
        this.markExited(new HeadlessSessionError("PROTOCOL_ERROR", "Claude Agent SDK query ended"));
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const stderr = this.stderrTail.trim();
        this.markExited(
          new HeadlessSessionError(
            "PROTOCOL_ERROR",
            `Claude Agent SDK query failed: ${detail}${stderr ? `\n${stderr}` : ""}`,
            { cause }
          )
        );
      }
    })();
  }

  private markExited(error: HeadlessSessionError): void {
    if (!this.isAlive) {
      return;
    }
    this.isAlive = false;
    for (const handler of this.exitHandlers.splice(0)) {
      try {
        handler(error);
      } catch {
        // ignore
      }
    }
  }
}

type RuntimeLease = {
  runtime: ClaudeSdkRuntime;
  release: () => void;
};

/**
 * A HeadlessSession backed by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Each session owns one streaming-input query, i.e. one Claude Code process
 * holding one conversation. Model and effort changes are applied to the live
 * query (`setModel` / `applyFlagSettings`); reset() replaces the query.
 *
 * The headless posture matches the claude `cli` transport (`--tools ""`):
 * built-in tools are disabled and anything not pre-approved is denied, so the
 * session is text-in/text-out.
 */
export class ClaudeSdkSession implements HeadlessSession {
  readonly provider = "claude";
  readonly transport = "sdk" as const;

  private lease: RuntimeLease | undefined;
  private closed = false;
  private busy: Promise<void> = Promise.resolve();
  private activeTurn: TurnSettlement | undefined;
  private activeTurnOptions: HeadlessSessionRunOptions | undefined;
  private accumulated = "";
  private assistantError: string | undefined;
  // Results still owed by the runtime for turns already sent. A result only
  // settles the active turn when it is the last one outstanding, so a late
  // result from an interrupted turn is never mistaken for the next answer.
  private pendingResults = 0;
  private model: string | undefined;
  private effort: SdkEffortLevel | undefined;
  private models: ModelInfo[] | undefined;

  private constructor(
    private readonly ctx: SessionContext,
    private agent: AgentSpec
  ) {
    this.model = normalizeModel(agent.model);
    this.effort = toSdkEffort(this.model, parseRequestedEffort(agent.reasoningEffort));
  }

  static async create(ctx: SessionContext, agent: AgentSpec): Promise<ClaudeSdkSession> {
    const session = new ClaudeSdkSession(ctx, agent);
    await session.startRuntime();
    try {
      if (session.effort) {
        await session.validateModelEffort(session.model, session.effort);
      }
    } catch (cause) {
      await session.close();
      throw cause;
    }
    return session;
  }

  get id(): string | null {
    return this.lease?.runtime.sessionId ?? null;
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
    const op = this.busy.then(async () => {
      this.assertUsable();
      this.releaseRuntime();
      await this.startRuntime();
    });
    this.busy = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  }

  async setModel(model: string, reasoningEffort?: Effort | (string & {})): Promise<void> {
    this.assertUsable();
    const nextModel = normalizeModel(model);
    // An effort set earlier stays active across setModel calls; re-validate it
    // against the new model.
    const nextEffort =
      reasoningEffort === undefined ? this.effort : toSdkEffort(nextModel, parseRequestedEffort(reasoningEffort));
    if (nextEffort) {
      await this.validateModelEffort(nextModel, nextEffort);
    }
    const runtime = await this.liveRuntime();
    if (nextModel !== this.model) {
      await runtime.setModel(nextModel);
    }
    if (nextEffort !== this.effort) {
      await runtime.setEffort(nextEffort);
    }
    this.model = nextModel;
    this.effort = nextEffort;
    this.agent = { ...this.agent, model, reasoningEffort: reasoningEffort ?? this.agent.reasoningEffort };
  }

  async getAvailableModels(): Promise<ModelCandidate[]> {
    this.assertUsable();
    const models = await this.loadModels();
    return models.map((entry) => ({
      id: entry.value,
      name: entry.displayName,
      description: entry.description || undefined,
      reasoningEfforts: entry.supportsEffort === false ? [] : entry.supportedEffortLevels
    }));
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    const op = this.busy.then(() => this.releaseRuntime());
    this.busy = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  }

  private async startRuntime(): Promise<void> {
    const key = claudeSdkRuntimeKey();
    const options: ClaudeSdkOptions = {
      // Text-in/text-out like `claude --print --tools ""`: no built-in tools,
      // and anything not pre-approved is denied instead of prompting.
      tools: [],
      permissionMode: "dontAsk",
      includePartialMessages: true,
      // Conversations live only in the running process, like the other
      // persistent transports.
      persistSession: false,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {})
    };
    const runtime = await this.ctx.manager.acquire(key, () => ClaudeSdkRuntime.start(this.ctx, options));
    runtime.attach((message) => this.handleMessage(message));
    runtime.onExit((error) => {
      if (this.lease?.runtime === runtime) {
        this.activeTurn?.fail(error);
      }
    });
    this.pendingResults = 0;
    this.lease = { runtime, release: () => this.ctx.manager.release(key, runtime) };
  }

  private releaseRuntime(): void {
    const lease = this.lease;
    this.lease = undefined;
    lease?.release();
  }

  private async liveRuntime(): Promise<ClaudeSdkRuntime> {
    const runtime = this.lease?.runtime;
    if (!runtime?.alive) {
      throw new HeadlessSessionError("PROTOCOL_ERROR", "Claude Agent SDK query is no longer running");
    }
    return runtime;
  }

  private async beginTurn(options: HeadlessSessionRunOptions): Promise<TurnSettlement> {
    this.assertUsable();
    if (!options.prompt.trim()) {
      throw new Error("prompt is required");
    }
    if (options.signal?.aborted) {
      throw new HeadlessSessionError("REQUEST_ABORTED", "Run aborted before start");
    }
    const runtime = await this.liveRuntime();

    emitSessionProgress(options, this.agent, { state: "starting", message: `Starting ${this.provider} turn` });

    this.accumulated = "";
    this.assistantError = undefined;
    this.activeTurnOptions = options;
    const settlement = startTurn({
      timeoutMs: options.timeoutMs ?? this.ctx.timeoutMs,
      signal: options.signal,
      interrupt: () => runtime.interrupt()
    });
    this.activeTurn = settlement;

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

    this.pendingResults += 1;
    runtime.send(options.prompt);
    return settlement;
  }

  private handleMessage(message: SDKMessage): void {
    const current = this.pendingResults <= 1;
    if (message.type === "stream_event") {
      if (!current || message.parent_tool_use_id !== null || !this.activeTurn || !this.activeTurnOptions) {
        return;
      }
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        this.accumulated += event.delta.text;
        emitSessionProgress(this.activeTurnOptions, this.agent, {
          state: "running",
          partialOutput: event.delta.text
        });
      }
      return;
    }
    if (message.type === "assistant") {
      if (current && message.parent_tool_use_id === null && message.error) {
        this.assistantError = message.error;
      }
      return;
    }
    if (message.type !== "result") {
      return;
    }
    this.pendingResults = Math.max(0, this.pendingResults - 1);
    if (!current) {
      return;
    }
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (message.subtype === "success" && !message.is_error) {
      turn.complete((message.result || this.accumulated).trim());
      return;
    }
    if (turn.interrupted) {
      turn.fail(new HeadlessSessionError("REQUEST_ABORTED", "Turn interrupted"));
      return;
    }
    const details =
      message.subtype === "success"
        ? message.result
        : message.errors.join("\n") || message.subtype;
    const prefix = this.assistantError ? `${this.assistantError}: ` : "";
    turn.fail(new HeadlessSessionError("PROTOCOL_ERROR", `${prefix}${details || "Claude Agent SDK turn failed"}`));
  }

  private async loadModels(): Promise<ModelInfo[]> {
    if (!this.models) {
      const runtime = await this.liveRuntime();
      this.models = await runtime.supportedModels();
    }
    return this.models;
  }

  /**
   * Validates an effort against the per-model levels the SDK reports. Models
   * missing from the catalog (custom ids) are left to the SDK to validate.
   */
  private async validateModelEffort(model: string | undefined, effort: SdkEffortLevel): Promise<void> {
    let models: ModelInfo[];
    try {
      models = await this.loadModels();
    } catch {
      return;
    }
    const id = model ?? DEFAULT_MODEL_ID;
    const info = models.find((entry) => entry.value === id || entry.resolvedModel === id);
    if (!info) {
      return;
    }
    if (info.supportsEffort === false) {
      throw unsupportedEffort("claude", model, effort, []);
    }
    const levels = info.supportedEffortLevels;
    if (levels && !(levels as readonly string[]).includes(effort)) {
      throw unsupportedEffort("claude", model, effort, levels);
    }
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new HeadlessSessionError("SESSION_CLOSED", "Session is closed");
    }
  }
}

/** Narrows a common effort level to the SDK's vocabulary; none/minimal have no SDK equivalent. */
function toSdkEffort(model: string | undefined, effort: EffortLevel | undefined): SdkEffortLevel | undefined {
  if (effort === undefined) {
    return undefined;
  }
  if (!(CLAUDE_SDK_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw unsupportedEffort("claude", model, effort, CLAUDE_SDK_SUPPORTED_EFFORTS);
  }
  return effort as SdkEffortLevel;
}

function normalizeModel(model: string | undefined): string | undefined {
  return model && model !== DEFAULT_MODEL_ID ? model : undefined;
}

function toHeadlessError(cause: unknown): { kind: "network" | "rate_limit" | "agent_stopped" | "unknown"; message: string } {
  if (cause instanceof HeadlessSessionError) {
    return { kind: sessionErrorKind(cause), message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "unknown", message };
}
