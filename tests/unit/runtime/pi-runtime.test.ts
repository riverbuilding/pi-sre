import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplicationPaths, type SreConfig } from "../../../src/config/config.js";
import { createSreRuntime } from "../../../src/runtime/pi-runtime.js";
import { createSreSystemPrompt } from "../../../src/runtime/system-prompt.js";

describe("Pi SRE runtime", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("starts with no coding tools and keeps runtime paths under the application home", async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-runtime-"));
    const paths = createApplicationPaths(home);
    const config: SreConfig = {
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
      investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
      safety: { mode: "read-only" },
      results: DEFAULT_RESULT_POLICY,
    };

    const runtime = await createSreRuntime(config);
    try {
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
});
