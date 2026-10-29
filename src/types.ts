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
 * - `sdk`: persistent Claude Agent SDK query (`@anthropic-ai/claude-agent-sdk`,
 *   claude only). The SDK is an optional peer dependency.
 */
export type AgentTransport = "cli" | "app-server" | "acp" | "sdk";

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
  /**
   * Opt-in tool use (agent execution). claude only — any other provider
   * rejects it with a ToolsError (UNSUPPORTED_TOOLS). When omitted (or when
   * `allow` is empty) the run stays text-in/text-out with every tool
   * disabled, exactly as before.
   */
  tools?: ToolsSpec;
};

/**
 * Permission modes accepted for tool runs. None of them ever waits for an
 * approval: anything not allowed is denied immediately and reported as a
 * `denied` ToolUseEvent, so a headless run cannot stall on a prompt.
 *
 * - `dontAsk`: only tools/rules that are pre-approved run; everything else is denied.
 * - `acceptEdits`: like `dontAsk`, but file edits in the working directory are also accepted.
 * - `bypassPermissions`: every allowed tool runs without permission checks.
 */
export const TOOL_PERMISSION_MODES = ["dontAsk", "acceptEdits", "bypassPermissions"] as const;
export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];

export type ToolsSpec = {
  /** Built-in tools to make available, e.g. ["Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]. */
  allow: string[];
  /** Defaults to `dontAsk`. */
  permissionMode?: ToolPermissionMode;
  /**
   * Pre-approved permission rules (claude `--allowedTools`), e.g.
   * ["Bash(git clone:*)", "WebFetch(domain:github.com)"].
   */
  allowedRules?: string[];
};

export type HeadlessCoreConfig = {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type HeadlessCore = {
  run(options: HeadlessRunOptions): Promise<string>;
  /**
   * Opens a persistent session when `agent.transport` is `app-server`, `acp` or `sdk`,
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
  /**
   * Working directory for this session, overriding HeadlessCoreConfig.cwd.
   * With tools enabled this is where the agent reads, writes and clones.
   */
  cwd?: string;
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
  /** Remote conversation id (codex thread id / ACP session id / Agent SDK session id), or null. */
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
  /**
   * Working directory for this run, overriding HeadlessCoreConfig.cwd.
   * With tools enabled this is where the agent reads, writes and clones.
   */
  cwd?: string;
};

export type RunState = "starting" | "running" | "fallback" | "completed" | "failed";

export type ProgressEvent = {
  state: RunState;
  message?: string;
  /**
   * - `running`: an incremental chunk (delta) of output. Concatenate the
   *   chunks to rebuild the text streamed so far.
   * - `completed`: the full final output.
   * - `failed`: whatever output was collected before the failure.
   */
  partialOutput?: string;
  /** Set on `running` events that report a tool call (claude with `agent.tools`). */
  toolUse?: ToolUseEvent;
  error?: HeadlessError;
  agent?: AgentSpec;
};

/**
 * Lifecycle of a tool call:
 * `started` -> `completed` | `failed` (the tool ran and reported an error) | `denied`
 * (blocked by the permission mode or rules; the run continues).
 */
export type ToolUseStatus = "started" | "completed" | "failed" | "denied";

export type ToolUseEvent = {
  /** Tool use id, shared by every event of one call. */
  id: string;
  name: string;
  status: ToolUseStatus;
  /** Tool input, on `started`. */
  input?: unknown;
  /** Tool result text (`completed`/`failed`) or the denial reason (`denied`). */
  output?: string;
  /** Set when the call ran inside a subagent. */
  parentToolUseId?: string;
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
