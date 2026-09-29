export const AGENT_IDS = ["codex", "claude", "agy", "grok", "devin"] as const;
export const DEFAULT_MODEL_ID = "default";
export const DEFAULT_REASONING_EFFORT_ID = "default";
export const CLAUDE_MODEL_IDS = ["sonnet", "opus", "haiku", "fable"] as const;

/**
 * Reasoning/thinking effort levels understood by headless_core, excluding the
 * "use the provider default" sentinel. The same vocabulary is used by every
 * provider; each provider adapter maps a level to its native mechanism and
 * rejects levels the selected model cannot express.
 *
 * - `none`: fully disable reasoning/thinking. Distinct from `minimal` — it is
 *   never silently converted to a higher level. Models without an explicit
 *   off switch reject it.
 * - `minimal`: the smallest non-zero thinking level, not "off".
 * - `low`/`medium`/`high`/`xhigh`/`max`: increasing effort as supported.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * A reasoning effort selection: a concrete level or "default", which means
 * "do not specify an effort" — the provider/CLI/model default applies.
 * Omitting reasoningEffort and passing "default" are equivalent.
 */
export type Effort = "default" | EffortLevel;

export type AgentId = (typeof AGENT_IDS)[number];

export type ModelsConfig = {
  models: Partial<Record<AgentId, string[]>>;
};

export type GetAvailableModelsOptions = {
  agent: string;
};

export type GetAvailableReasoningEffortOptionsOptions = {
  agent: string;
};

/**
 * How an agent is executed.
 *
 * - `cli`: spawn a one-shot CLI process per run (the default, unchanged behavior).
 * - `app-server`: persistent `codex app-server` process (codex only).
 * - `acp`: persistent Agent Client Protocol process — `devin acp` for devin,
 *   `agy_acp_server` for agy, `grok agent --always-approve stdio` for grok.
 */
export type AgentTransport = "cli" | "app-server" | "acp";

export type AgentSpec = {
  provider: string;
  model?: string;
  /**
   * Reasoning/thinking effort. Accepts the common Effort vocabulary
   * ("default" or an EffortLevel); unknown strings are rejected with an
   * INVALID_EFFORT error before the provider is contacted, and levels the
   * model cannot express are rejected with UNSUPPORTED_EFFORT — never
   * silently converted to a different level.
   */
  reasoningEffort?: Effort | (string & {});
  /**
   * Execution transport. When omitted, `cli` is used so existing callers keep
   * the current one-shot behavior. `run()` honors persistent transports by
   * opening a short-lived session; `createSession()` reuses them across runs.
   */
  transport?: AgentTransport;
};

export type HeadlessCoreConfig = {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type HeadlessCore = {
  run(options: HeadlessRunOptions): Promise<string>;
  /**
   * Opens a persistent session when `agent.transport` is `app-server` or `acp`,
   * or a stateless CLI-backed session when `transport` is `cli`/omitted.
   */
  createSession(options: CreateSessionOptions): Promise<HeadlessSession>;
  /**
   * Closes all sessions and persistent agent processes owned by this core.
   * Subsequent calls to run()/createSession() still work; persistent
   * transports simply spawn fresh processes.
   */
  shutdown(): Promise<void>;
};

export type CreateSessionOptions = {
  agent: AgentSpec;
};

export type HeadlessSessionRunOptions = {
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
};

/**
 * A model that a persistent session can select.
 */
export type ModelCandidate = {
  id: string;
  name?: string;
  description?: string;
  /** Reasoning effort levels this model accepts, when reported. */
  reasoningEfforts?: string[];
};

/**
 * A persistent conversation with an agent runtime.
 *
 * Sessions serialize turns: concurrent run() calls on the same session are
 * queued. Sessions sharing a provider/transport binary share one OS process.
 */
export type HeadlessSession = {
  readonly provider: string;
  readonly transport: AgentTransport;
  /** Remote conversation id (codex thread id / ACP session id), or null. */
  readonly id: string | null;
  run(options: HeadlessSessionRunOptions): Promise<string>;
  /** Starts a fresh conversation on the same runtime, dropping prior history. */
  reset(): Promise<void>;
  /**
   * Changes the model without restarting the runtime. The new model applies
   * from the next run(). `reasoningEffort` is applied when the provider
   * supports it separately (codex turn effort / ACP session effort option).
   */
  setModel(model: string, reasoningEffort?: Effort | (string & {})): Promise<void>;
  getAvailableModels(): Promise<ModelCandidate[]>;
  /** Releases this conversation. The shared runtime exits once the last session closes. */
  close(): Promise<void>;
};

export type HeadlessRunOptions = {
  agent: AgentSpec;
  prompt: string;
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
  onFallback?: FallbackHook;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RunState = "starting" | "running" | "fallback" | "completed" | "failed";

export type ProgressEvent = {
  state: RunState;
  message?: string;
  partialOutput?: string;
  error?: HeadlessError;
  agent?: AgentSpec;
};

export type ProgressSnapshot = {
  state: RunState;
  partialOutput?: string;
  lastMessage?: string;
  agent?: AgentSpec;
};

export type HeadlessErrorKind = "network" | "rate_limit" | "agent_stopped" | "unknown";

export type HeadlessError = {
  kind: HeadlessErrorKind;
  message: string;
  cause?: unknown;
};

export type FallbackContext = {
  runId: string;
  prompt: string;
  failedAgent: AgentSpec;
  error: HeadlessError;
  progress: ProgressSnapshot;
  log: (message: string) => void;
};

export type FallbackResult =
  | { type: "final"; output: string }
  | { type: "rerun"; agent: AgentSpec; prompt?: string }
  | { type: "fail"; error?: Error };

export type FallbackHook = (context: FallbackContext) => Promise<FallbackResult> | FallbackResult;
