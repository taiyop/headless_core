import { describe, expect, it } from "vitest";
import {
  commandFailureReason,
  formatInspectWarning,
  inspectAgentModels,
  parseAgyModels,
  parseCodexModels,
  parseGrokModels
} from "../src/inspectors.js";

describe("parseCodexModels", () => {
  it("extracts visible model slugs", () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "list" },
        { slug: "hidden-model", visibility: "hidden" },
        { slug: "gpt-5.4", visibility: "list" }
      ]
    });

    expect(parseCodexModels(stdout)).toEqual(["gpt-5.5", "gpt-5.4"]);
  });
});

describe("parseAgyModels", () => {
  it("keeps non-empty lines as model ids", () => {
    expect(parseAgyModels("Gemini 3.5 Flash (Medium)\n\nClaude Opus 4.6 (Thinking)\n")).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Claude Opus 4.6 (Thinking)"
    ]);
  });
});

describe("parseGrokModels", () => {
  it("extracts available models and removes default marker", () => {
    const stdout = [
      "\u001b[31mERROR\u001b[0m Settings fetch failed after 3 attempts",
      "Available models:",
      "  - grok-build",
      "  * grok-composer-2.5-fast (default)"
    ].join("\n");

    expect(parseGrokModels(stdout)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });
});

describe("inspectAgentModels", () => {
  it("returns static claude model choices", async () => {
    await expect(inspectAgentModels("claude")).resolves.toEqual({
      agent: "claude",
      models: ["sonnet", "opus", "haiku", "fable"]
    });
  });
});

describe("formatInspectWarning", () => {
  it("includes agent, reason, and path", () => {
    expect(formatInspectWarning("claude", "No stable model-list command is available", "/tmp/models.json")).toBe(
      "Warning: failed to inspect models for claude. No stable model-list command is available. Add models manually in /tmp/models.json."
    );
  });
});

describe("commandFailureReason", () => {
  it("prefers stderr details over the generic command failure line", () => {
    expect(
      commandFailureReason("agy", {
        message: "Command failed: agy models",
        stderr: "Failed to redirect output for CLI: creating log file\n"
      })
    ).toBe("Command failed: agy models: Failed to redirect output for CLI: creating log file");
  });

  it("reports killed commands as timeouts when no output is available", () => {
    expect(commandFailureReason("agy", { message: "Command failed: agy models", killed: true, signal: "SIGTERM" })).toBe(
      "Command timed out: agy models"
    );
  });
});
