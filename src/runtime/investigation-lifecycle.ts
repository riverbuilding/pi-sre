import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  InvestigationBinding,
  InvestigationController,
} from "../app/investigation-controller.js";
import { DomainError } from "../domain/errors.js";

/** Slice 4 hooks, deliberately absent from production factories until Slice 5 capture lands.
 * Register after SRE-owned input handlers; any later handler which handles input must clear
 * intent via the returned callback. Intent alone never authorizes creation or execution.
 */
export function registerInvestigationLifecycle(
  pi: ExtensionAPI,
  controller: InvestigationController,
): () => void {
  let binding: InvestigationBinding | undefined;
  let intent: InvestigationBinding | undefined;
  let releaseWork: (() => void) | undefined;
  const clearIntent = () => {
    intent = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    clearIntent();
    binding = controller.bind(ctx.sessionManager.getSessionId());
  });
  pi.on("input", (event, ctx) => {
    clearIntent();
    if (
      binding &&
      controller.isBound(binding) &&
      ctx.isIdle() &&
      event.source !== "extension" &&
      event.streamingBehavior === undefined &&
      event.text.trim() &&
      !event.text.trimStart().startsWith("/")
    )
      intent = binding;
  });
  pi.on("before_agent_start", (event, ctx) => {
    const candidate = intent;
    clearIntent();
    if (
      !candidate ||
      !controller.isBound(candidate) ||
      candidate.sessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    try {
      controller.continueOrStart(candidate, event.prompt);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // DomainError messages are safe application constants. Failed creation leaves no authority.
      ctx.ui.notify(error.message, "warning");
    }
  });
  pi.on("agent_start", () => {
    if (binding && controller.isBound(binding)) releaseWork ??= controller.beginAgentWork(binding);
  });
  pi.on("agent_end", () => {
    releaseWork?.();
    releaseWork = undefined;
  });
  pi.on("session_shutdown", () => {
    releaseWork?.();
    releaseWork = undefined;
    clearIntent();
    if (binding) controller.unbind(binding);
    binding = undefined;
  });
  return clearIntent;
}
