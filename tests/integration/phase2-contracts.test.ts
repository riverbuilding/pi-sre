import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import captured from "../fixtures/phase2-server-0.0.67.json" with { type: "json" };
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";

describe("Phase 2 frozen contracts", () => {
  it("accepts the real descriptors while keeping diagnostic candidates unavailable", async () => {
    const descriptors = captured.cases["multiple-default"].descriptors;
    const report = await discoverMcpTools({ listTools: async () => descriptors });
    expect(report.exposed.map((tool) => tool.name)).toEqual(["configuration_contexts_list"]);
    expect(report.decisions).not.toContainEqual(
      expect.objectContaining({ reason: "invalid-descriptor" }),
    );
    for (const descriptor of descriptors.filter(
      (tool) => tool.name !== "configuration_contexts_list",
    )) {
      expect(descriptor.inputSchema.properties).toHaveProperty("context.type", "string");
      expect(descriptor.annotations.readOnlyHint).toBe(true);
      expect(descriptor.annotations.destructiveHint).toBe(false);
    }
    for (const name of ["single-default", "single-no-default", "disabled"] as const) {
      expect(captured.cases[name].response).toBeNull();
      for (const descriptor of captured.cases[name].descriptors) {
        expect(descriptor.name).not.toBe("configuration_contexts_list");
        expect(descriptor.inputSchema.properties).not.toHaveProperty("context");
      }
    }
  });

  it("dispatches /context and /cluster through public Pi APIs without a model request", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sre-pi-contract-"));
    const notify = vi.fn();
    const setStatus = vi.fn();
    const select = vi.fn().mockResolvedValueOnce("beta").mockResolvedValueOnce(undefined);
    let selected = "alpha";
    const idle: boolean[] = [];
    const services = await createAgentSessionServices({
      cwd: home,
      agentDir: home,
      resourceLoaderOptions: {
        ...createSreResourceLoaderOptions(),
        extensionFactories: [
          {
            name: "phase2-contract-probe",
            hidden: true,
            factory: (pi) => {
              pi.registerCommand("context", {
                description: "Contract probe",
                handler: async (args, ctx) => {
                  idle.push(ctx.isIdle());
                  ctx.ui.notify(`${selected}:${args}`, "info");
                  ctx.ui.setStatus("scope", `${selected} | Namespace: * | READ ONLY`);
                },
              });
              pi.registerCommand("cluster", {
                description: "Contract probe",
                handler: async (_args, ctx) => {
                  const choice = await ctx.ui.select("Cluster", ["alpha", "beta"]);
                  if (choice !== undefined) selected = choice;
                },
              });
              pi.on("context", (event) => ({
                messages: [
                  ...event.messages,
                  { role: "user", content: `Current scope: ${selected}`, timestamp: 0 },
                ],
              }));
            },
          },
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(home),
      noTools: "builtin",
    });
    try {
      await session.bindExtensions({
        uiContext: { ...session.extensionRunner.getUIContext(), notify, setStatus, select },
      });
      await session.prompt("/context initial");
      expect(notify).toHaveBeenLastCalledWith("alpha:initial", "info");
      expect(setStatus).toHaveBeenLastCalledWith("scope", "alpha | Namespace: * | READ ONLY");
      expect(idle).toEqual([true]);
      expect(await session.extensionRunner.emitContext([])).toMatchObject([
        { content: "Current scope: alpha" },
      ]);
      await session.prompt("/cluster");
      await session.prompt("/context");
      expect(notify).toHaveBeenLastCalledWith("beta:", "info");
      expect(await session.extensionRunner.emitContext([])).toMatchObject([
        { content: "Current scope: beta" },
      ]);
      await session.prompt("/cluster");
      expect(selected).toBe("beta");
      expect(select).toHaveBeenCalledWith("Cluster", ["alpha", "beta"], undefined);
      expect(session.messages).toEqual([]);
      expect(session.extensionRunner.getCommandDiagnostics()).toEqual([]);
      // Check the installed interactive dispatch table as well as SDK dispatch:
      // /context must not be intercepted before session.prompt().
      const interactiveSource = await readFile(
        new URL(
          "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
          import.meta.url,
        ),
        "utf8",
      );
      expect(interactiveSource).not.toMatch(/text\s*===\s*["']\/context["']/);
    } finally {
      await session.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
