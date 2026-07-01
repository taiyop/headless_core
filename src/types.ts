export const AGENT_IDS = ["codex", "claude", "agy", "grok"] as const;
export const DEFAULT_MODEL_ID = "default";
export const DEFAULT_REASONING_EFFORT_ID = "default";
export const CLAUDE_MODEL_IDS = ["sonnet", "opus", "haiku", "fable"] as const;

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

export type AgentSpec = {
  provider: string;
  model?: string;
  reasoningEffort?: string;
};

export type HeadlessCoreConfig = {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type HeadlessCore = {
  run(options: HeadlessRunOptions): Promise<string>;
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
