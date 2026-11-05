import {
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";

import type { RequestMcpPublication } from "../app/request-mcp-controller.js";

/** Pi requests application shutdown; the application disposes the Pi session explicitly. */
export class SreRuntime extends AgentSessionRuntime {
  private sessionDisposal: Promise<void> | undefined;

  constructor(
    result: CreateAgentSessionRuntimeResult,
    createRuntime: CreateAgentSessionRuntimeFactory,
    readonly publishMcp: (state: RequestMcpPublication) => void,
    private readonly cleanup: () => Promise<void>,
    private readonly requestApplicationShutdown?: () => Promise<void>,
  ) {
    super(
      result.session,
      result.services,
      createRuntime,
      result.diagnostics,
      result.modelFallbackMessage,
    );
  }

  override dispose(): Promise<void> {
    return this.requestApplicationShutdown
      ? this.requestApplicationShutdown()
      : this.disposeSession();
  }

  /** Release Pi's current session without requesting application shutdown again. */
  disposeSession(): Promise<void> {
    this.sessionDisposal ??= (async () => {
      try {
        await this.cleanup();
      } finally {
        await super.dispose();
      }
    })();
    return this.sessionDisposal;
  }
}
