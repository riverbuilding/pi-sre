import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { APPROVE_CALL, DENY_CALL, type ApprovalChannel } from "../execution/controlled-approval.js";

/** hasUI alone also admits RPC; application startup must separately authenticate the terminal. */
export function createTerminalApprovalChannel(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode">,
): ApprovalChannel {
  return {
    async requestApproval(preview, signal, timeout) {
      if (!ctx.hasUI || ctx.mode !== "tui" || signal.aborted) {
        return undefined;
      }
      const answer = await ctx.ui.select(preview, [DENY_CALL, APPROVE_CALL], { signal, timeout });
      if (!ctx.hasUI || ctx.mode !== "tui" || signal.aborted) {
        return undefined;
      }

      return answer;
    },
  };
}
