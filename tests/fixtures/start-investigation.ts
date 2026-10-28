import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Exercise registered eligible-input hooks without requiring a provider response. */
export async function startInvestigation(session: AgentSession): Promise<void> {
  await session.extensionRunner.emitInput("Investigate fixture scope", undefined, "interactive");
  await session.extensionRunner.emitBeforeAgentStart("Investigate fixture scope", undefined, {
    cwd: session.sessionManager.getCwd(),
  });
}
