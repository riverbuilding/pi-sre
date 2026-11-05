import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplicationPaths, type SreConfig } from "../../../src/config/config.js";
import { createSreRuntime } from "../../../src/runtime/pi-runtime.js";
import { SreRuntime } from "../../../src/runtime/sre-runtime.js";
import { createSreSystemPrompt } from "../../../src/runtime/system-prompt.js";

describe("Pi SRE runtime", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("starts with no coding tools and keeps runtime paths under the application home", async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-runtime-"));
    const config = runtimeConfig(home);

    const runtime = await createSreRuntime(config);
    try {
      expect(runtime).toBeInstanceOf(SreRuntime);
      expect(Object.hasOwn(runtime, "dispose")).toBe(false);
      expect(runtime.cwd).toBe(home);
      expect(runtime.services.agentDir).toBe(home);
      expect(runtime.session.sessionManager.getCwd()).toBe(home);
      expect(runtime.session.getActiveToolNames()).toEqual([]);
      expect(runtime.services.resourceLoader.getSystemPrompt()).toBe(createSreSystemPrompt());
      expect(runtime.session.systemPrompt).toContain(createSreSystemPrompt());
      expect(runtime.session.systemPrompt).not.toContain("expert coding assistant");
      runtime.session.setActiveToolsByName([
        "bash",
        "read",
        "write",
        "edit",
        "powershell",
        "grep",
        "find",
        "ls",
      ]);
      expect(runtime.session.getActiveToolNames()).toEqual([]);

      const shell = await runtime.session.extensionRunner.emitUserBash({
        type: "user_bash",
        command: "echo unsafe",
        excludeFromContext: false,
        cwd: home,
      });
      expect(shell?.result?.output).toContain("unavailable");
      expect(shell?.result?.exitCode).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
  it("separates application shutdown from idempotent session disposal", async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-runtime-"));
    const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue();
    const runtime = await createSreRuntime(runtimeConfig(home), undefined, shutdown);
    const session = runtime.session;
    const dispose = vi.spyOn(session, "dispose");
    try {
      await runtime.dispose();
      expect(shutdown).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      const first = runtime.disposeSession();
      expect(runtime.disposeSession()).toBe(first);
      await first;
      expect(dispose).toHaveBeenCalledOnce();
      expect(runtime.session).toBe(session);
    } finally {
      await runtime.disposeSession();
    }
  });
});

function runtimeConfig(home: string): SreConfig {
  const paths = createApplicationPaths(home);
  return {
    paths,
    kubernetes: {
      mcp: {
        transport: "stdio",
        command: "kubernetes-mcp-server",
        args: [],
        cwd: home,
        startupTimeoutMs: 15_000,
        toolCallTimeoutMs: 30_000,
      },
    },
    execution: { maxToolCalls: 40, maxModelIterations: 80 },
    safety: { mode: "read-only" },
    results: DEFAULT_RESULT_POLICY,
  };
}
