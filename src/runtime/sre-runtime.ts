import {
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";

/** Pi requests application shutdown; the application disposes the Pi session explicitly. */
export class SreRuntime extends AgentSessionRuntime {
  private sessionDisposal: Promise<void> | undefined;

  constructor(
    result: CreateAgentSessionRuntimeResult,
    createRuntime: CreateAgentSessionRuntimeFactory,
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
    this.sessionDisposal ??= Promise.resolve().then(() => super.dispose());
    return this.sessionDisposal;
  }
}
