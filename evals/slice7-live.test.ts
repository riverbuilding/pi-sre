import { DEFAULT_RESOURCE_READ_POLICY } from "../src/config/resource-policy.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RequestMcpController } from "../src/app/request-mcp-controller.js";
import { createApplicationPaths, type SreConfig } from "../src/config/config.js";
import { DEFAULT_RESULT_POLICY } from "../src/config/schema.js";
import { ManagedMcpConnection } from "../src/mcp/connection.js";
import { createSreRuntime } from "../src/runtime/pi-runtime.js";
import type { SreRuntime } from "../src/runtime/sre-runtime.js";
import { installOfflineProvider } from "../tests/fixtures/offline-provider.js";

// Explicit opt-in only. Never discover or use the developer's current context.
const kubeconfigPath = process.env.PI_SRE_SLICE7_KUBECONFIG;
const disposableConfig = z
  .object({
    apiVersion: z.literal("v1"),
    kind: z.literal("Config"),
    clusters: z
      .array(
        z.object({ name: z.literal("kind-pi-sre-slice7"), cluster: z.unknown() }).passthrough(),
      )
      .length(1),
    contexts: z
      .array(
        z.object({
          name: z.literal("kind-pi-sre-slice7"),
          context: z
            .object({ cluster: z.literal("kind-pi-sre-slice7"), user: z.string() })
            .passthrough(),
        }),
      )
      .length(1),
    users: z.array(z.unknown()),
  })
  .passthrough();

describe.skipIf(!kubeconfigPath)("Slice 7 disposable kind read-only acceptance", () => {
  it.each(["exact", "all"] as const)(
    "queries explicit contexts and recovers %s intent without changing the input kubeconfig",
    async (mode) => {
      if (!kubeconfigPath) {
        throw new Error("Explicit disposable kubeconfig required.");
      }
      const original = await readFile(kubeconfigPath, "utf8");
      const source = disposableConfig.parse(parse(original));
      const base = source.contexts[0];
      if (!base) {
        throw new Error("Disposable context missing.");
      }
      const home = await mkdtemp(join(tmpdir(), "pi-sre-slice7-live-"));
      const paths = createApplicationPaths(home);
      const aliases = join(home, "aliases.yaml");
      const setInventory = async (names: string[]) => {
        await writeFile(
          aliases,
          stringify({
            ...source,
            "current-context": names[0],
            contexts: names.map((name) => ({ name, context: base.context })),
          }),
          { mode: 0o600 },
        );
      };
      await setInventory(["alpha", "beta"]);
      await writeFile(paths.kubernetesMcpConfig, "read_only = true\n", { mode: 0o600 });
      const config: SreConfig = {
        paths,
        kubernetes: {
          mcp: {
            transport: "stdio",
            command: "kubernetes-mcp-server",
            args: [
              "--config",
              paths.kubernetesMcpConfig,
              "--kubeconfig",
              aliases,
              "--cluster-provider",
              "kubeconfig",
              "--list-output",
              "yaml",
            ],
            cwd: home,
            startupTimeoutMs: 15_000,
            toolCallTimeoutMs: 15_000,
          },
        },
        execution: { maxToolCalls: 4, maxModelIterations: 6 },
        results: DEFAULT_RESULT_POLICY,
        safety: { mode: "read-only", resources: DEFAULT_RESOURCE_READ_POLICY },
      };
      let runtime: SreRuntime | undefined;
      const controller = new RequestMcpController({
        connect: (signal) => ManagedMcpConnection.connect(config.kubernetes.mcp, signal),
        publish: (state) => runtime?.publishMcp(state),
        configuredRule:
          mode === "exact" ? { kind: "exact", contexts: ["alpha", "beta"] } : { kind: "all" },
      });
      try {
        await controller.restart();
        expect(controller.snapshot.status).toBe("ready");
        runtime = await createSreRuntime(config, controller);
        const session = runtime.session;
        await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
        let streams = 0;
        await installOfflineProvider(session, (_context, iteration) => {
          streams++;
          return iteration % 2 === 0
            ? ["alpha", "beta"].map((context) => ({
                type: "toolCall",
                id: `${context}-${iteration}`,
                name: "pods_list",
                arguments: { context, namespace: "kube-system" },
              }))
            : [{ type: "text", text: "Explicit context observations; no remediation." }];
        });
        await session.prompt("Compare the same system pods through alpha and beta");
        const results = session.messages.filter((message) => message.role === "toolResult");
        expect(results).toHaveLength(2);
        for (const [index, context] of ["alpha", "beta"].entries()) {
          expect(results[index]?.isError, JSON.stringify(results[index]?.content)).toBe(false);
          expect(JSON.stringify(results[index]?.content)).toContain(context);
          expect(JSON.stringify(results[index]?.content)).toContain("coredns");
          expect(JSON.stringify(results[index]?.content)).toContain("dispatchedAt");
        }
        const history = JSON.stringify(results);
        await setInventory(["alpha", "gamma"]);
        await controller.restart(true);
        expect(streams).toBe(2); // Idle recovery must not run the model.
        expect(controller.selection?.availability.available.slice().sort()).toEqual(
          mode === "exact" ? ["alpha"] : ["alpha", "gamma"],
        );
        expect(controller.selection?.availability.unavailable).toEqual(
          mode === "exact" ? ["beta"] : [],
        );
        await setInventory(["alpha", "beta", "gamma"]);
        await controller.restart(true);
        expect(controller.selection?.availability.available.slice().sort()).toEqual(
          mode === "exact" ? ["alpha", "beta"] : ["alpha", "beta", "gamma"],
        );
        await session.prompt("Continue after recovery");
        expect(streams).toBe(4);
        expect(
          session.messages
            .filter((message) => message.role === "toolResult")
            .slice(2)
            .every((result) => !result.isError),
        ).toBe(true);
        expect(
          JSON.stringify(
            session.messages.filter((message) => message.role === "toolResult").slice(0, 2),
          ),
        ).toBe(history);
        expect(await readFile(kubeconfigPath, "utf8")).toBe(original);
      } finally {
        await runtime?.disposeSession();
        await controller.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
