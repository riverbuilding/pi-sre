import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";
import { ManagedMcpConnection } from "../../src/mcp/connection.js";
import { discoverClusterContexts } from "../../src/mcp/context-discovery.js";
import { createMcpToolBridge } from "../../src/mcp/tool-bridge.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { registerClusterScope } from "../../src/tui/cluster-extension.js";
import { scopedPodTool } from "../fixtures/scoped-tool.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("Slice 4 scoped bridge over Pi and stdio MCP", () => {
  describe("agent-loop scope", () => {
    let home: string;
    let callsPath: string;
    let connection: ManagedMcpConnection | undefined;
    let session: AgentSession | undefined;
    let manager: ClusterContextManager;
    let generation: number;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "pi-sre-scoped-"));
      const pid = join(home, "mcp.pid");
      callsPath = `${pid}.calls`;
      connection = await ManagedMcpConnection.connect({
        transport: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fixture, "scoped-success", pid],
        cwd: process.cwd(),
        startupTimeoutMs: 2_000,
        toolCallTimeoutMs: 500,
      });
      const report = await discoverMcpTools(connection);
      expect(report.exposed.map((tool) => tool.name)).toEqual([
        "configuration_contexts_list",
        "pods_list",
      ]);
      expect(report.decisions).toContainEqual({
        name: "pods_list",
        status: "exposed",
      });
      manager = new ClusterContextManager({ rule: { kind: "exact", contexts: ["beta"] } });
      generation = manager.beginConnection();
      manager.acceptRegistry(generation, await discoverClusterContexts(connection, report));
      const managedConnection = connection;
      const services = await createAgentSessionServices({
        cwd: home,
        agentDir: home,
        resourceLoaderOptions: {
          ...createSreResourceLoaderOptions(),
          extensionFactories: [
            {
              name: "test-scoped-cluster",
              factory: (pi) => {
                registerClusterScope(pi, manager);
                const unsubscribe = manager.subscribe(() =>
                  pi.registerTool(
                    createMcpToolBridge(scopedPodTool, managedConnection, DEFAULT_RESULT_POLICY, {
                      manager,
                      connectionGeneration: generation,
                    }),
                  ),
                );
                pi.on("session_shutdown", () => {
                  unsubscribe();
                });
              },
            },
          ],
        },
      });
      ({ session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(home),
        noTools: "builtin",
        customTools: [],
      }));
      // The model stream is simulated; only credential preflight is bypassed.
      vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
    });

    afterEach(async () => {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session?.dispose();
      vi.restoreAllMocks();
      await connection?.close();
      await rm(home, { recursive: true, force: true });
      session = undefined;
      connection = undefined;
    });

    type StreamFunction = AgentSession["agent"]["streamFunction"];
    type ModelContext = Parameters<StreamFunction>[1];

    function simulatePodInvestigation(
      activeSession: AgentSession,
      args: Record<string, string> = { context: "beta" },
      onRequest?: (context: ModelContext) => void,
      targets?: readonly string[],
    ): void {
      let turns = 0;
      activeSession.agent.streamFunction = (model, context) => {
        onRequest?.(context);
        const first = turns++ === 0;
        type Stream = Awaited<ReturnType<StreamFunction>>;
        type Message = Awaited<ReturnType<Stream["result"]>>;
        const message: Message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: first
            ? (targets ?? [args.context ?? "beta"]).map((context, index) => ({
                type: "toolCall" as const,
                id: `pods-${index}`,
                name: "pods_list",
                arguments: { ...args, context },
              }))
            : [{ type: "text", text: "Observed pods in the selected context." }],
          stopReason: first ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            return message;
          },
        } as unknown as Stream;
      };
    }

    async function readCalls(): Promise<unknown[]> {
      return (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
    }

    it.each([{ context: "beta" }, { context: "beta", labelSelector: "app=api" }])(
      "preserves the exact model context in an agent-loop call with arguments %j",
      async (args) => {
        const activeSession = session!;
        simulatePodInvestigation(activeSession, args);
        await activeSession.prompt("Inspect pods in the selected cluster");

        const result = activeSession.messages.find((message) => message.role === "toolResult");
        expect(result).toMatchObject({
          toolName: "pods_list",
          isError: false,
          details: { scope: { context: "beta", connectionGeneration: generation, readOnly: true } },
        });
        expect(JSON.stringify(result)).toContain("beta-pod");
        expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
        expect(await readCalls()).toEqual([
          { name: "configuration_contexts_list", arguments: {} },
          {
            name: "pods_list",
            arguments: {
              context: "beta",
              ...("labelSelector" in args ? { labelSelector: args.labelSelector } : {}),
            },
          },
        ]);
      },
    );

    it("executes model-requested targets sequentially through Pi", async () => {
      const activeSession = session!;
      manager.selectRule({ kind: "all" });
      const firstResponse = Promise.withResolvers<void>();
      const calls: string[] = [];
      let firstFinished = false;
      let overlapped = false;
      const managedConnection = connection!;
      const callTool = managedConnection.callTool.bind(managedConnection);
      vi.spyOn(managedConnection, "callTool").mockImplementation(async (name, args, signal) => {
        calls.push(String(args.context));
        if (calls.length === 1) await firstResponse.promise;
        else overlapped = !firstFinished;
        const result = await callTool(name, args, signal);
        firstFinished = true;
        return result;
      });
      simulatePodInvestigation(activeSession, {}, undefined, ["beta", "alpha"]);
      const pending = activeSession.prompt("Inspect beta and alpha pods");
      try {
        await expect.poll(() => calls.length).toBe(1);
        expect(manager.isAgentActive).toBe(true);
      } finally {
        firstResponse.resolve();
        await pending;
      }
      expect(calls).toEqual(["beta", "alpha"]);
      expect(overlapped).toBe(false);
      expect(
        activeSession.messages.filter((message) => message.role === "toolResult"),
      ).toMatchObject([
        { isError: false, details: { scope: { context: "beta" } } },
        { isError: false, details: { scope: { context: "alpha" } } },
      ]);
      expect(manager.isAgentActive).toBe(false);
    });

    it("rejects cluster switching throughout an active agent turn", async () => {
      const activeSession = session!;
      const notify = vi.fn();
      await activeSession.bindExtensions({
        uiContext: { ...activeSession.extensionRunner.getUIContext(), notify },
      });
      const commands: Promise<void>[] = [];
      simulatePodInvestigation(activeSession, { context: "beta" }, () => {
        expect(manager.isAgentActive).toBe(true);
        commands.push(activeSession.prompt("/clusters alpha"));
      });
      await activeSession.prompt("Inspect pods in beta");
      await Promise.all(commands);

      expect(commands).toHaveLength(2);
      expect(notify.mock.calls).toEqual([
        [
          expect.stringMatching(
            /^\[\d{2}:\d{2}:\d{2} #1\] \/clusters: Wait for or cancel the active agent turn before selecting clusters\.$/,
          ),
          "warning",
        ],
        [
          expect.stringMatching(
            /^\[\d{2}:\d{2}:\d{2} #2\] \/clusters: Wait for or cancel the active agent turn before selecting clusters\.$/,
          ),
          "warning",
        ],
      ]);
      expect(manager.state.resolution).toMatchObject({
        status: "resolved",
        available: [{ name: "beta" }],
      });
      expect(manager.isAgentActive).toBe(false);
      expect(await readCalls()).toEqual([
        { name: "configuration_contexts_list", arguments: {} },
        { name: "pods_list", arguments: { context: "beta" } },
      ]);
    });

    it("routes subsequent calls to the newly selected cluster while preserving prior history", async () => {
      const activeSession = session!;
      const requests: ModelContext["messages"][] = [];
      const recordRequest = (context: ModelContext): void => {
        requests.push(structuredClone(context.messages));
      };
      simulatePodInvestigation(activeSession, { context: "beta" }, recordRequest);
      await activeSession.prompt("Inspect pods in beta");
      const transcript = structuredClone(activeSession.messages);

      await activeSession.prompt("/clusters alpha");
      expect(activeSession.messages.slice(0, transcript.length)).toEqual(transcript);
      expect(activeSession.messages).toHaveLength(transcript.length + 1);
      expect(manager.state).toMatchObject({
        status: "resolved",
        selection: { rule: { kind: "exact", contexts: ["alpha"] }, source: "user" },
        resolution: { status: "resolved", available: [{ name: "alpha" }] },
      });

      simulatePodInvestigation(activeSession, { context: "alpha" }, recordRequest);
      await activeSession.prompt("Inspect pods after switching");
      expect(requests).toHaveLength(4);
      for (let index = 1; index < requests.length; index += 1) {
        const previous = requests[index - 1]!;
        expect(requests[index]!.slice(0, previous.length)).toEqual(previous);
      }
      for (const [index, request] of requests.entries()) {
        const scopeUpdates = request
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          )
          .filter((content) => content.includes("Application Kubernetes scope update:"));
        expect(scopeUpdates).toHaveLength(index < 2 ? 1 : 2);
        expect(scopeUpdates.at(-1)).toContain(`Cluster: "${index < 2 ? "beta" : "alpha"}"`);
      }
      expect(activeSession.messages.slice(0, transcript.length)).toEqual(transcript);
      expect(
        activeSession.messages.findLast((message) => message.role === "toolResult"),
      ).toMatchObject({
        isError: false,
        details: { scope: { context: "alpha", connectionGeneration: generation, readOnly: true } },
      });
      expect(await readCalls()).toEqual([
        { name: "configuration_contexts_list", arguments: {} },
        { name: "pods_list", arguments: { context: "beta" } },
        { name: "pods_list", arguments: { context: "alpha" } },
      ]);
    });
  });

  it.each([
    ["scoped-empty", undefined],
    ["scoped-malformed", undefined],
    ["scoped-error", "authentication-failed"],
    ["scoped-timeout", "timeout"],
  ] as const)("preserves %s outcomes on the selected connection", async (scenario, category) => {
    const connection = await ManagedMcpConnection.connect({
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, scenario],
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
      toolCallTimeoutMs: 150,
    });
    try {
      const manager = new ClusterContextManager({ rule: { kind: "exact", contexts: ["beta"] } });
      const generation = manager.beginConnection();
      manager.acceptRegistry(
        generation,
        await discoverClusterContexts(connection, await discoverMcpTools(connection)),
      );
      const tool = createMcpToolBridge(scopedPodTool, connection, DEFAULT_RESULT_POLICY, {
        manager,
        connectionGeneration: generation,
      });
      const result = await tool.execute(
        "pods",
        { context: "beta" },
        undefined,
        undefined,
        {} as never,
      );
      expect(result).toMatchObject({
        isError: scenario !== "scoped-empty",
        details: {
          scope: { context: "beta" },
          ...(category ? { failureCategory: category } : {}),
          status:
            scenario === "scoped-empty"
              ? "success"
              : scenario === "scoped-malformed"
                ? "invalid-result"
                : "tool-error",
        },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
      expect(manager.isAgentActive).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("forwards cancellation through scoped stdio execution and releases the call guard", async () => {
    const connection = await ManagedMcpConnection.connect({
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, "scoped-timeout"],
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
      toolCallTimeoutMs: 2_000,
    });
    try {
      const manager = new ClusterContextManager({ rule: { kind: "exact", contexts: ["alpha"] } });
      const generation = manager.beginConnection();
      manager.acceptRegistry(
        generation,
        await discoverClusterContexts(connection, await discoverMcpTools(connection)),
      );
      const tool = createMcpToolBridge(scopedPodTool, connection, DEFAULT_RESULT_POLICY, {
        manager,
        connectionGeneration: generation,
      });
      const cancellation = new AbortController();
      const pending = tool.execute(
        "pods",
        { context: "alpha" },
        cancellation.signal,
        undefined,
        {} as never,
      );
      cancellation.abort();
      await expect(pending).rejects.toThrow(/abort/i);
      expect(manager.isAgentActive).toBe(false);
      expect(connection.state).toBe("ready");
    } finally {
      await connection.close();
    }
  });
});
