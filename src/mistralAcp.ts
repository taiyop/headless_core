import { SelectAcpRuntime, SelectAcpSession } from "./selectAcp.js";
import type { SessionContext } from "./runtimeManager.js";

export const MistralAcpRuntime = {
  start: (ctx: SessionContext) => SelectAcpRuntime.start(ctx, {
    provider: "mistral", command: ctx.env.VIBE_ACP_BIN || "vibe-acp",
    args: [], autoApprove: false, sessionMode: "ask", effortOffValue: "off", authenticate: false
  })
};
export const MistralAcpSession = SelectAcpSession;
export function mistralAcpRuntimeKey(env: NodeJS.ProcessEnv): string {
  return `mistral:acp:${env.VIBE_ACP_BIN || "vibe-acp"}`;
}
