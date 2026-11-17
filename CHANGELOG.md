# Changelog

## 0.7.0

### Added

- Every provider/transport now reports what the agent is doing through the same `ProgressEvent` fields, so one renderer covers claude, codex, agy, grok and devin (see the README support table):
  - `ProgressEvent.thought`: thinking deltas (including summarized reasoning). Never part of the final output and never on the same event as `partialOutput`.
  - `ToolUseEvent.kind` (`ToolKind`, aligned with ACP: `read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `other`), `title` (one line, at most `TOOL_TITLE_LIMIT` = 200 characters) and `locations` (`{ path, line? }[]`). Tool output is truncated to `TOOL_OUTPUT_LIMIT` (8192) characters. `started` may repeat for one id when the title or input becomes known; merge by `id`.
  - `ProgressEvent.plan` (`PlanEntry[]`): the full current plan on every update — claude TodoWrite, codex `todo_list` / `turn/plan/updated`, ACP `plan`.
- ACP (agy / grok / devin): `agent_thought_chunk`, `tool_call` / `tool_call_update` (merged per `toolCallId`, updates may precede the call) and `plan` updates are reported instead of dropped.
- codex `app-server`: `item/started` / `item/completed` (commands, file changes, web search, MCP and dynamic tools), reasoning deltas and `turn/plan/updated`.
- `HEADLESS_CORE_DEBUG_EVENTS=1` writes every raw transport event to stderr as one JSON line.

### Changed

- `cli` transports read structured output instead of plain text. The final output is unchanged (the stream's final result), and stderr is no longer streamed as `partialOutput` — it only explains failures:
  - claude: always `--output-format stream-json --verbose --include-partial-messages` (text-only runs keep `--tools ""`), so text arrives as deltas without tools too.
  - codex: `codex exec --json`; the last agent message is the output.
  - agy: `--output-format stream-json` (placed before `--print`).
  - grok: `--output-format streaming-messages-json --include-partial-messages`.
  - devin has no structured output and keeps `--print` text; use `transport: "acp"` for thinking and tool calls.
- `ProgressEvent.message` for tool events uses the tool title when there is one (`git status started`).

## 0.6.0

### Added

- `headless.getUsageLimits({ agent })` / `headless.getAllUsageLimits()` (`AgentUsageLimits`, `UsageWindow`, `UsagePeriod`): remaining plan usage per agent as 5-hour / daily / weekly / monthly windows. codex reads `account/rateLimits/read` from `codex app-server`; claude reads the Agent SDK `/usage` data (experimental SDK API). agy, grok and devin report `supported: false`.
- `headless-core usage [agent...] [--json]` CLI command.

## 0.5.0

### Added

- `agent.tools` (claude only): opt-in tool use with `{ allow, permissionMode?, allowedRules? }`. The `cli` transport maps it to `--tools`, `--permission-mode`, `--allowedTools` and `--permission-prompts none`; the `sdk` transport maps it to `tools`, `permissionMode`, `allowedTools` and `permissionPrompts: "none"`. Permission modes are `dontAsk` (default), `acceptEdits` and `bypassPermissions`; anything not allowed is denied instead of waiting for approval. Omitting `tools` keeps the text-only posture unchanged.
- `ToolsError` (`INVALID_TOOLS` / `UNSUPPORTED_TOOLS`): a malformed spec, or `agent.tools` on any other provider, is rejected instead of ignored and is never routed through `onFallback`.
- `ProgressEvent.toolUse` (`ToolUseEvent`, `ToolUseStatus`): tool calls are reported as `started` → `completed` / `failed` / `denied` on both claude transports.
- With tools enabled the claude `cli` transport runs `--output-format stream-json --verbose --include-partial-messages`, streaming top-level text deltas as `partialOutput` and using the `result` message as the final output.
- `cwd` option on `run()` and `createSession()` to override `HeadlessCoreConfig.cwd` per call.
- `CLAUDE_SDK_BIN`: run an installed `claude` from the `sdk` transport (`pathToClaudeCodeExecutable`) instead of the executable bundled with the SDK.

### Fixed

- claude `cli`: the prompt is now passed after `--`. claude 2.1.x parses `--tools` as variadic, so `--tools "" <prompt>` swallowed the prompt when no `--model`/`--effort` followed.
- claude `sdk`: the SDK is imported with a string literal so bundlers can include it.

### Documented

- `ProgressEvent.partialOutput` is an incremental chunk on `running` events, the full output on `completed`, and the collected output on `failed` (this matches every transport's existing behavior).
