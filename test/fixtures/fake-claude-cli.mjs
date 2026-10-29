#!/usr/bin/env node
// Minimal stand-in for claude 2.1.x `--print`. Parses argv like its CLI
// parser: variadic options (`--tools`, `--allowedTools`) consume every
// following argument that does not start with "-" (including ""), and `--`
// ends option parsing.

const VARIADIC = new Set(["--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--add-dir"]);
const VALUE = new Set(["--output-format", "--model", "--effort", "--permission-mode", "--permission-prompts"]);

const options = {};
const positionals = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--") {
    positionals.push(...argv.slice(i + 1));
    break;
  }
  if (VARIADIC.has(arg)) {
    const values = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      values.push(argv[(i += 1)]);
    }
    options[arg] = values;
  } else if (VALUE.has(arg)) {
    options[arg] = argv[(i += 1)];
  } else if (arg.startsWith("-")) {
    options[arg] = true;
  } else {
    positionals.push(arg);
  }
}

const prompt = positionals[0];
if (!prompt) {
  process.stderr.write("Error: Input must be provided either through stdin or as a prompt argument when using --print\n");
  process.exit(1);
}

const format = options["--output-format"] ?? "text";
if (format === "text") {
  process.stdout.write(`PROMPT:${prompt}\n`);
  process.exit(0);
}
if (format !== "stream-json" || !options["--verbose"]) {
  process.stderr.write("Error: When using --print, --output-format=stream-json requires --verbose\n");
  process.exit(1);
}

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = (options["--tools"] ?? []).join(",").split(",").filter(Boolean);
const config = {
  prompt,
  tools,
  permissionMode: options["--permission-mode"],
  permissionPrompts: options["--permission-prompts"],
  allowedTools: options["--allowedTools"] ?? [],
  partial: options["--include-partial-messages"] === true,
  cwd: process.cwd()
};
emit({ type: "system", subtype: "init", tools, permissionMode: config.permissionMode, cwd: config.cwd });

if (prompt === "hang") {
  setInterval(() => undefined, 1_000);
} else {
  if (prompt.includes("tool")) {
    emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git clone https://example.com/repo" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls /" } }
        ]
      }
    });
    emit({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t2", message: "Permission denied" });
    emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "Permission denied", is_error: true },
          { type: "tool_result", tool_use_id: "t1", content: "Cloning into 'repo'...", is_error: false }
        ]
      }
    });
  }
  const delta = (text, parent = null) =>
    emit({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
    });
  delta("sub-agent text", "t1");
  delta("Hel");
  delta("lo");
  if (prompt === "error") {
    emit({ type: "result", subtype: "success", is_error: true, result: "API Error: 429 rate limit" });
  } else if (prompt === "no-result") {
    // Exit without a result message.
  } else {
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(config) });
  }
}
