import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";
import { createRequestMcpToolBridge } from "../../src/mcp/request-tool-bridge.js";
import { scopedPodTool } from "../fixtures/scoped-tool.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { APPROVE_CALL, DENY_CALL } from "../../src/execution/controlled-approval.js";
import { createTerminalApprovalChannel } from "../../src/tui/controlled-approval-channel.js";
import { installRequestExecution } from "../../src/runtime/request-execution-adapter.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { approvalFixture } from "../fixtures/controlled-approval.js";

type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type Message = Awaited<ReturnType<Stream["result"]>>;

/** Real Pi sessions and public UI APIs, with synthetic policy, transport and selector.
 * This is automated boundary acceptance; no claim of visual terminal acceptance.
 */
async function fixture(
  run: (
    session: AgentSession,
    f: ReturnType<typeof approvalFixture>,
    tool: ToolDefinition,
  ) => Promise<void>,
  mutateHook = false,
  options: Parameters<typeof approvalFixture>[0] = {},
) {
  const home = await mkdtemp(join(tmpdir(), "pi-sre-approval-pi-"));
  const f = approvalFixture(options);
  let execution: ReturnType<typeof installRequestExecution> | undefined;
  const tool: ToolDefinition = {
    name: "approval_probe",
    label: "Approval boundary probe",
    description: "Synthetic approval test only.",
    parameters: Type.Object(
      {
        context: Type.String(),
        apiVersion: Type.String(),
        kind: Type.String(),
        namespace: Type.String(),
        name: Type.String(),
        scale: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    async execute(id, parameters, signal) {
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
        throw new Error("Invalid synthetic arguments.");
      }
      const args: Record<string, unknown> = { ...parameters };
      const receipt = await f.service.execute({
        ...f.input,
        request: execution?.current ?? f.request,
        toolCallId: id,
        parameters: args,
        ...(signal ? { signal } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: {} };
    },
  };
  const services = await createAgentSessionServices({
    cwd: home,
    agentDir: home,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    resourceLoaderOptions: {
      ...createSreResourceLoaderOptions(),
      extensionFactories: [
        {
          name: "approval-boundary-probe",
          factory: (pi) => {
            pi.registerTool(tool);
            if (mutateHook) {
              pi.on("tool_call", (event) => {
                if ("scale" in event.input) {
                  event.input.scale = 3;
                }
              });
            }
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
    session.modelRuntime.registerProvider("approval-fixture", {
      baseUrl: "http://unused.invalid",
      apiKey: "offline",
      api: "openai-completions",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const model = session.modelRuntime.getModel("approval-fixture", "fixture");
    if (!model) {
      throw new Error("Missing offline fixture model.");
    }
    await session.setModel(model);
    let streams = 0;
    session.agent.streamFunction = (_model, context) => {
      expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_SERVER_RESULT");
      const message: Message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content:
          ++streams === 1
            ? [{ type: "toolCall", id: "call-1", name: "approval_probe", arguments: { ...f.args } }]
            : [{ type: "text", text: "done" }],
        stopReason: streams === 1 ? "toolUse" : "stop",
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
      const stream = {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: message.stopReason, message };
        },
        async result() {
          return message;
        },
      };
      return stream as unknown as Stream;
    };
    execution = installRequestExecution(
      session,
      { maxToolCalls: 10, maxModelIterations: 5 },
      () => {},
    );
    f.service.setChannel(createTerminalApprovalChannel(session.extensionRunner.createContext()));
    await run(session, f, tool);
  } finally {
    f.service.close();
    await execution?.dispose();
    await session.dispose();
    await rm(home, { recursive: true, force: true });
  }
}

function bindSelector(
  session: AgentSession,
  select: ExtensionUIContext["select"],
  mode: "tui" | "rpc" = "tui",
) {
  session.extensionRunner.setUIContext({ ...session.extensionRunner.getUIContext(), select }, mode);
}

describe("Phase 5 Slice 4: real Pi approval boundary", () => {
  it("reviews final hook-modified arguments and keeps server output out of events, history and provider input", async () =>
    fixture(async (session, f) => {
      const select = vi.fn(async (_title: string, options: string[]) => {
        expect(options).toEqual([DENY_CALL, APPROVE_CALL]);
        return APPROVE_CALL;
      });
      bindSelector(session, select);
      f.service.enableInteractiveTerminal();
      const events: string[] = [];
      const off = session.subscribe((event) => events.push(JSON.stringify(event)));
      try {
        await session.prompt("exercise synthetic approval");
        expect(select.mock.calls[0]?.[0]).toContain('"scale":3');
        expect(f.callTool).toHaveBeenCalledOnce();
        expect(f.callTool.mock.calls[0]?.[1].scale).toBe(3);
        expect(JSON.stringify(session.messages)).not.toContain("PRIVATE_SERVER_RESULT");
        expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain(
          "PRIVATE_SERVER_RESULT",
        );
        expect(events.join("\n")).not.toContain("PRIVATE_SERVER_RESULT");
        expect(JSON.stringify(session.messages)).toContain("server-reported-success");
      } finally {
        off();
      }
    }, true));

  it.each(["no UI", "RPC", "unauthenticated UI", "read-only"])(
    "refuses %s and direct-handler invocation",
    async (mode) =>
      fixture(
        async (session, f, tool) => {
          const select = vi.fn(async () => APPROVE_CALL);
          if (mode !== "no UI") {
            bindSelector(session, select, mode === "RPC" ? "rpc" : "tui");
          }
          if (mode !== "unauthenticated UI") {
            f.service.enableInteractiveTerminal();
          }
          await session.prompt("exercise refusal");
          const direct = await tool.execute(
            "direct",
            { ...f.args },
            undefined,
            undefined,
            session.extensionRunner.createToolContext("direct", undefined),
          );
          expect(JSON.stringify(direct)).toContain("not-executed");
          expect(f.callTool).not.toHaveBeenCalled();
          expect(select).not.toHaveBeenCalled();
        },
        false,
        { profile: mode === "read-only" ? "read-only" : "controlled-operations" },
      ),
  );

  it("aborts a pending Pi selector, clears its prompt state and ignores late approval", async () =>
    fixture(async (session, f) => {
      const opened = Promise.withResolvers<AbortSignal>();
      const response = Promise.withResolvers<string | undefined>();
      const select: ExtensionUIContext["select"] = async (_title, _options, opts) => {
        if (!opts?.signal) {
          throw new Error("Missing dialog cancellation.");
        }
        opened.resolve(opts.signal);
        return new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          void response.promise.then(resolve);
        });
      };
      bindSelector(session, select);
      f.service.enableInteractiveTerminal();
      const prompt = session.prompt("pending approval");
      const signal = await opened.promise;
      await session.abort();
      await prompt;
      expect(signal.aborted).toBe(true);
      response.resolve(APPROVE_CALL);
      expect(f.callTool).not.toHaveBeenCalled();
      expect(f.service.receipts.at(-1)?.outcome).toBe("not-executed");
      // A new selector can run after cancellation; no retained active Pi UI prompt.
      bindSelector(session, async () => DENY_CALL);
      const next = await session.extensionRunner.getUIContext().select("next", [DENY_CALL]);
      expect(next).toBe(DENY_CALL);
    }));
  it("labels diagnostic successes and refusals with the actual controlled connection profile", async () =>
    fixture(async (session, f) => {
      for (const connected of [true, false]) {
        const tool = createRequestMcpToolBridge(
          scopedPodTool,
          {
            profile: "controlled-operations",
            ...(connected
              ? {
                  accept: async () => ({
                    status: "success" as const,
                    value: { content: [] },
                    dispatchedAt: Date.now(),
                    settledAt: Date.now(),
                  }),
                }
              : {}),
          },
          () => f.request,
          DEFAULT_RESULT_POLICY,
        );
        const result = await tool.execute(
          "read",
          { context: "A" },
          undefined,
          undefined,
          session.extensionRunner.createToolContext("read", undefined),
        );
        expect(JSON.stringify(result)).toContain("CONTROLLED OPERATIONS — APPROVAL REQUIRED");
        expect(JSON.stringify(result)).not.toContain("READ ONLY");
        expect(result.isError).toBe(!connected);
      }
    }));

  it("expires a pending real Pi dialog and rejects its late response", async () =>
    fixture(
      async (session, f) => {
        const opened = Promise.withResolvers<AbortSignal>();
        const late = Promise.withResolvers<string | undefined>();
        bindSelector(session, async (_title, _options, opts) => {
          if (!opts?.signal) {
            throw new Error("Missing dialog signal.");
          }
          opened.resolve(opts.signal);
          return new Promise((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            void late.promise.then(resolve);
          });
        });
        f.service.enableInteractiveTerminal();
        const prompt = session.prompt("expire approval");
        const signal = await opened.promise;
        await prompt;
        expect(signal.aborted).toBe(true);
        expect(f.service.receipts.at(-1)).toMatchObject({
          reason: "expired",
          outcome: "not-executed",
        });
        late.resolve(APPROVE_CALL);
        expect(f.callTool).not.toHaveBeenCalled();
        bindSelector(session, async () => DENY_CALL);
        expect(
          await session.extensionRunner.getUIContext().select("after timeout", [DENY_CALL]),
        ).toBe(DENY_CALL);
      },
      false,
      { approvalTimeoutMs: 25 },
    ));
});
