import { mkdir } from "node:fs/promises";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";

import type { SreConfig } from "../config/config.js";
import type { StartupClusterIntent } from "../cluster/context-resolver.js";
import { McpController } from "./mcp-controller.js";
import type { ToolDiscoveryReport } from "../mcp/tool-discovery.js";
import { createSreRuntime, PI_AGENT_DIR_ENV } from "../runtime/pi-runtime.js";
import type { SreRuntime } from "../runtime/sre-runtime.js";

class SreApplicationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "SreApplicationError";
  }
}

export class SreApplication {
  private runtime: SreRuntime | undefined;
  private mode: InteractiveMode | undefined;
  private startup: Promise<void> | undefined;
  private readonly cancellation = new AbortController();
  private readonly stopped = Promise.withResolvers<void>();
  private readonly onSignal = (): void => {
    // run() observes cleanup failures; signal callbacks must not float rejections.
    void this.close().catch(() => undefined);
  };
  private readonly mcp: McpController;
  private closePromise: Promise<void> | undefined;
  private started = false;
  private previousPiAgentDir: string | undefined;
  readonly startupClusterIntent: StartupClusterIntent;

  constructor(
    private readonly config: SreConfig,
    intent: StartupClusterIntent = {},
  ) {
    // Selection intent is session-owned; Slice 3 resolves it after MCP enumeration.
    this.startupClusterIntent = Object.freeze(
      intent.cluster === undefined ? {} : { cluster: intent.cluster },
    );
    this.mcp = new McpController(config, this.cancellation.signal);
  }

  get toolDiscoveryReport(): ToolDiscoveryReport | undefined {
    return this.mcp.discoveryReport;
  }

  async run(): Promise<void> {
    if (this.started || this.closePromise) throw new Error("Pi SRE application has already run.");
    this.started = true;
    this.previousPiAgentDir = process.env[PI_AGENT_DIR_ENV];
    process.env[PI_AGENT_DIR_ENV] = this.config.paths.home;

    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);

    try {
      this.startup = this.initialize();
      await this.startup;
      if (this.cancellation.signal.aborted) return;
      await Promise.race([this.mode ? this.mode.run() : Promise.resolve(), this.stopped.promise]);
    } catch (error) {
      if (error instanceof SreApplicationError) throw error;
      throw new SreApplicationError("Pi SRE application failed.", error);
    } finally {
      await this.close();
    }
  }

  private readonly startupDiagnostics: { type: "info" | "warning"; message: string }[] = [];

  private async initialize(): Promise<void> {
    await mkdir(this.config.paths.home, { recursive: true, mode: 0o700 });
    if (this.cancellation.signal.aborted) return;
    const state = await this.mcp.restart(false, true);
    const startupDiagnostics = this.startupDiagnostics;
    const report = this.mcp.discoveryReport;
    if (report) {
      const counts = { exposed: 0, deferred: 0, rejected: 0 };
      for (const decision of report.decisions) counts[decision.status]++;
      startupDiagnostics.push({
        type: "info",
        message: `Kubernetes MCP discovery: ${counts.exposed} approved, ${counts.deferred} deferred, ${counts.rejected} rejected. ${state.tools.length} read-only tools registered.`,
      });
    } else {
      startupDiagnostics.push({ type: "warning", message: state.message });
    }
    if (this.cancellation.signal.aborted) return;
    try {
      this.runtime = await createSreRuntime(this.config, state.tools, () => this.close(), this.mcp);
    } catch (error) {
      throw new SreApplicationError("Pi SRE runtime startup failed.", error);
    }
    if (this.cancellation.signal.aborted) return;
    try {
      this.mode = new InteractiveMode(this.runtime, { startupDiagnostics });
      // Pi installs its SIGTERM handler synchronously at the start of init().
      // Its public runtime disposer routes back here; do not duplicate that handler.
      process.off("SIGTERM", this.onSignal);
      // Await public, idempotent initialization so shutdown cannot leave a late UI behind.
      await this.mode.init();
    } catch (error) {
      throw new SreApplicationError("Pi SRE terminal startup failed.", error);
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        const failures: unknown[] = [];
        // Initialization can still be acquiring resources. Wait before releasing them.
        try {
          await this.startup;
        } catch {
          // run() retains the startup error; cleanup still owns acquired resources.
        }
        try {
          await this.runtime?.session.abort();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.runtime?.disposeSession();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.mcp.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          this.mode?.stop();
        } catch (error) {
          failures.push(error);
        } finally {
          process.off("SIGINT", this.onSignal);
          process.off("SIGTERM", this.onSignal);
          if (this.started) {
            if (this.previousPiAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
            else process.env[PI_AGENT_DIR_ENV] = this.previousPiAgentDir;
          }
          this.stopped.resolve();
        }
        if (failures.length > 0) {
          throw new SreApplicationError(
            "Pi SRE shutdown failed.",
            failures.length === 1
              ? failures[0]
              : new AggregateError(failures, "Pi SRE cleanup failures."),
          );
        }
      })();
      // Publish the cleanup promise before abort dispatch can reenter close().
      this.cancellation.abort();
    }
    return this.closePromise;
  }
}
