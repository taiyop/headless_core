# Changelog

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
