import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessCore, getAvailableModels, getAvailableReasoningEffortOptions,
  type HeadlessCore, type ProgressEvent } from "../src/index.js";
import { inspectAgentModels } from "../src/inspectors.js";
import { MistralStreamConverter } from "../src/mistralProgress.js";
import { expectConformance } from "./helpers/conformance.js";

let dir: string;
const cores: HeadlessCore[] = [];
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(tmpdir(), "headless-mistral-"))); });
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.shutdown()));
  await rm(dir, { force: true, recursive: true });
});
async function executable(name: string, source: string) {
  const file = path.join(dir, name);
  await writeFile(file, source); await chmod(file, 0o755); return file;
}
async function core(acp = false) {
  const bin = acp
    ? await executable("vibe-acp", await readFile(new URL("./fixtures/fake-mistral-acp.mjs", import.meta.url), "utf8"))
    : await executable("vibe", `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
if (prompt === 'NEVER') { setInterval(() => {}, 1000); }
else if (prompt === 'FAIL') { console.error('429 rate limit'); process.exit(2); }
else if (prompt === 'EMPTY') { console.log(JSON.stringify({type:'message',role:'user',content:[{type:'text',text:'input'}]})); }
else {
 const text = prompt === 'ARGS' ? JSON.stringify({args, cwd:process.cwd()}) : 'answer';
 console.log(JSON.stringify({type:'reasoning',text:'thinking'}));
 console.log(JSON.stringify({type:'message',role:'assistant',content:[{type:'text',text}]}));
}`);
  const value = createHeadlessCore({ cwd: dir, env: { ...process.env,
    [acp ? "VIBE_ACP_BIN" : "VIBE_BIN"]: bin, FAKE_LOG: path.join(dir, "log") } });
  cores.push(value); return value;
}
async function logs() {
  return (await readFile(path.join(dir, "log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
const agent = { provider: "mistral", transport: "acp" as const };

describe("Mistral CLI", () => {
  it("selects the model alias and emits clean answer/thought progress", async () => {
    const headless = await core();
    const events: ProgressEvent[] = [];
    const output = await headless.run({ agent: { provider: "mistral", model: "devstral" }, prompt: "ARGS",
      onProgress: (event) => void events.push(event) });
    expect(JSON.parse(output)).toEqual({ cwd: dir, args: ["--agent", "ask", "--output", "streaming",
      "--model", "devstral", "--prompt", "ARGS"] });
    expect(events.find((event) => event.thought)?.thought).toBe("thinking");
    expectConformance(events.filter((event) => event.state === "running"), output, { exact: true });
  });
  it("omits default model and effort flags", async () => {
    const output = await (await core()).run({ agent: { provider: "mistral", model: "default", reasoningEffort: "default" }, prompt: "ARGS" });
    expect(JSON.parse(output).args).toEqual(["--agent", "ask", "--output", "streaming", "--prompt", "ARGS"]);
  });
  it("rejects explicit CLI effort without invoking fallback", async () => {
    let fallback = false;
    await expect((await core()).run({ agent: { provider: "mistral", reasoningEffort: "high" }, prompt: "hello",
      onFallback: () => { fallback = true; return { type: "final", output: "wrong" }; }
    })).rejects.toMatchObject({ code: "UNSUPPORTED_EFFORT" });
    expect(fallback).toBe(false);
  });
  it("classifies failures and runs fallback", async () => {
    expect(await (await core()).run({ agent: { provider: "mistral" }, prompt: "FAIL", onFallback: ({ error }) => {
      expect(error.kind).toBe("rate_limit"); return { type: "final", output: "fallback" };
    } })).toBe("fallback");
  });
  it("rejects a stream without an assistant answer", async () => {
    await expect((await core()).run({ agent: { provider: "mistral" }, prompt: "EMPTY" })).rejects.toThrow("without a result");
  });
  it("times out a CLI run", async () => {
    await expect((await core()).run({ agent: { provider: "mistral" }, prompt: "NEVER", timeoutMs: 80 })).rejects.toThrow(/timed out/i);
  });
});

describe("Mistral streaming history", () => {
  it("separates history, discarded drafts, thoughts and tool results from the last answer", () => {
    const converter = new MistralStreamConverter();
    const entries = [
      { type: "message", role: "user", content: [{ type: "text", text: "prompt" }] },
      { type: "reasoning", text: "thinking" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "Checking." }] },
      { type: "effect", id: "tc", title: "bash", detail: { toolName: "bash", kind: "shell", input: { command: "pwd" } },
        state: { status: "completed", outputText: "/tmp" } },
      { type: "effect", id: "denied", detail: { toolName: "write_file" }, state: { error: { code: "tool_denied", message: "denied" } } },
      { type: "message", role: "assistant", content: [{ type: "text", text: "answer" }, { type: "text", text: "more" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "draft" }], outcome: { type: "discarded", cause: "retry" } }
    ];
    const events = entries.flatMap((entry) => converter.convert(entry));
    expect(converter.output()).toBe("answer\n\nmore");
    expectConformance(events, converter.output()!);
    expect(events.find((event) => event.toolUse?.id === "tc")?.toolUse?.kind).toBe("execute");
    expect(events.at(-2)?.toolUse?.status).toBe("denied");
  });
  it("maps Vibe's native effect categories", () => {
    const converter = new MistralStreamConverter();
    const kinds = ["file_read", "file_edit", "file_write", "web_search", "web_fetch", "subagent"];
    expect(kinds.map((kind) => converter.convert({ type: "effect", id: kind,
      detail: { kind, toolName: kind }, state: { status: "completed" }
    })[0].toolUse?.kind)).toEqual(["read", "edit", "edit", "search", "fetch", "think"]);
  });
});

describe("Mistral ACP", () => {
  it("shares a process, keeps separate sessions, selects ask, and streams thoughts", async () => {
    const headless = await core(true);
    const a = await headless.createSession({ agent });
    const b = await headless.createSession({ agent });
    const events: ProgressEvent[] = [];
    expect(a.provider).toBe("mistral"); expect(a.id).not.toBe(b.id);
    expect(await a.run({ prompt: "hello", onProgress: (event) => void events.push(event) })).toBe("echo:hello");
    expect(await a.run({ prompt: "again" })).toBe("echo:again");
    expectConformance(events.filter((event) => event.state === "running"), "echo:hello", { exact: true });
    const log = await logs();
    expect(log.filter((entry) => entry.method === "_spawn")).toHaveLength(1);
    expect(log[0].argv).toEqual([]);
    expect(log.find((entry) => entry.method === "session/new").params.cwd).toBe(dir);
    expect(log.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value)).toEqual(["ask", "ask"]);
    expect(log.some((entry) => entry.method === "authenticate")).toBe(false);
    await a.close(); expect(await b.run({ prompt: "still alive" })).toBe("echo:still alive"); await b.close();
  });
  it("uses advertised model aliases and translates none to off", async () => {
    const session = await (await core(true)).createSession({ agent: { ...agent, model: "devstral", reasoningEffort: "high" } });
    expect((await session.getAvailableModels()).map((model) => model.id)).toEqual(["devstral", "small"]);
    await session.setModel("small", "none");
    await expect(session.setModel("small", "high")).rejects.toMatchObject({
      code: "UNSUPPORTED_EFFORT", supportedEfforts: ["none"]
    });
    await session.setModel("default", "default");
    const sets = (await logs()).filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params);
    expect(sets).toContainEqual(expect.objectContaining({ configId: "thinking", value: "off" }));
    expect(sets.at(-2)).toMatchObject({ configId: "model", value: "devstral" });
    expect(sets.at(-1)).toMatchObject({ configId: "thinking", value: "off" });
  });
  it("denies permission requests without blocking", async () => {
    const session = await (await core(true)).createSession({ agent });
    expect(await session.run({ prompt: "PERM" })).toBe("permission answered");
    expect((await logs()).find((entry) => entry.method === "_permission").result).toEqual({ outcome: { outcome: "cancelled" } });
  });
  it("cancels on timeout and abort, then reuses and resets the session", async () => {
    const session = await (await core(true)).createSession({ agent });
    await expect(session.run({ prompt: "NEVER", timeoutMs: 30 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const abort = new AbortController();
    const run = session.run({ prompt: "NEVER", signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(run).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(await session.run({ prompt: "after" })).toBe("echo:after");
    const id = session.id; await session.reset(); expect(session.id).not.toBe(id);
    await session.close();
    await expect(session.run({ prompt: "closed" })).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
  it("supports one-shot ACP, reports refusal and recovers after process death", async () => {
    const headless = await core(true);
    expect(await headless.run({ agent, prompt: "one-shot" })).toBe("echo:one-shot");
    const session = await headless.createSession({ agent });
    await expect(session.run({ prompt: "FAIL" })).rejects.toThrow(/mistral.*refused/);
    await expect(session.run({ prompt: "KILL" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    const fresh = await headless.createSession({ agent });
    expect(await fresh.run({ prompt: "fresh" })).toBe("echo:fresh");
  });
  it("validates transport and returns unsupported plan usage", async () => {
    const headless = await core();
    await expect(headless.createSession({ agent: { provider: "mistral", transport: "sdk" } })).rejects.toMatchObject({ code: "UNSUPPORTED_TRANSPORT" });
    expect(await headless.getUsageLimits({ agent: "mistral" })).toMatchObject({ supported: false, available: false });
  });
  it("supports config model lists and inspects aliases through ACP without inference", async () => {
    await core(true);
    const originalBin = process.env.VIBE_ACP_BIN;
    const originalPath = process.env.HEADLESS_CORE_MODELS_PATH;
    process.env.VIBE_ACP_BIN = path.join(dir, "vibe-acp");
    process.env.HEADLESS_CORE_MODELS_PATH = path.join(dir, "models.json");
    try {
      await writeFile(process.env.HEADLESS_CORE_MODELS_PATH, JSON.stringify({ models: { mistral: ["devstral"] } }));
      expect(await getAvailableModels({ agent: "mistral" })).toEqual(["default", "devstral"]);
      expect(await inspectAgentModels("mistral")).toEqual({ agent: "mistral", models: ["devstral", "small"] });
      expect(getAvailableReasoningEffortOptions({ agent: "mistral" })).toContain("none");
    } finally {
      if (originalBin === undefined) delete process.env.VIBE_ACP_BIN; else process.env.VIBE_ACP_BIN = originalBin;
      if (originalPath === undefined) delete process.env.HEADLESS_CORE_MODELS_PATH; else process.env.HEADLESS_CORE_MODELS_PATH = originalPath;
    }
  });
});
