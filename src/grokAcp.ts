import { SelectAcpRuntime, SelectAcpSession } from "./selectAcp.js";
import type { SessionContext } from "./runtimeManager.js";

export const GrokAcpRuntime = {
  start: (ctx: SessionContext) => SelectAcpRuntime.start(ctx, {
    provider: "grok", command: ctx.env.GROK_BIN || "grok",
    args: ["agent", "--always-approve", "stdio"], autoApprove: true
  })
};
export const GrokAcpSession = SelectAcpSession;
export function grokAcpRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `grok:acp:${env.GROK_BIN || "grok"}`;
}
