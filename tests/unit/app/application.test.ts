import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SreApplication } from "../../../src/app/application.js";
import { createApplicationPaths, type SreConfig } from "../../../src/config/config.js";
import { PI_AGENT_DIR_ENV } from "../../../src/runtime/pi-runtime.js";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>(),
  modeRun: vi.fn<() => Promise<void>>(),
  createRuntime: vi.fn(),
}));

vi.mock("../../../src/runtime/pi-runtime.js", () => ({
  PI_AGENT_DIR_ENV: "PI_CODING_AGENT_DIR",
  createSreRuntime: mocks.createRuntime,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  InteractiveMode: class {
    run = mocks.modeRun;
  },
}));

describe("SreApplication", () => {
  let home: string;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-app-"));
    previousAgentDir = process.env[PI_AGENT_DIR_ENV];
    mocks.dispose.mockReset().mockResolvedValue();
    mocks.modeRun.mockReset().mockResolvedValue();
    mocks.createRuntime.mockReset().mockResolvedValue({ dispose: mocks.dispose });
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
    else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
    await rm(home, { recursive: true, force: true });
  });

  function config(): SreConfig {
    return {
      paths: createApplicationPaths(home),
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
    };
  }

  it("allows close before startup without disposing a runtime", async () => {
    const app = new SreApplication(config());
    await app.close();
    await app.close();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("uses the Pi SRE home and disposes once when the mode returns", async () => {
    process.env[PI_AGENT_DIR_ENV] = "existing-pi-location";
    const app = new SreApplication(config());
    mocks.modeRun.mockImplementation(async () => {
      expect(process.env[PI_AGENT_DIR_ENV]).toBe(home);
    });

    await app.run();
    await app.close();
    await app.close();

    expect(mocks.createRuntime).toHaveBeenCalledWith(config());
    expect(mocks.modeRun).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(process.env[PI_AGENT_DIR_ENV]).toBe("existing-pi-location");
  });

  it("restores the prior Pi environment when startup fails", async () => {
    mocks.createRuntime.mockRejectedValue(new Error("runtime unavailable"));
    const app = new SreApplication(config());

    await expect(app.run()).rejects.toThrow("runtime unavailable");
    expect(process.env[PI_AGENT_DIR_ENV]).toBe(previousAgentDir);
    expect(mocks.dispose).not.toHaveBeenCalled();
  });
});
