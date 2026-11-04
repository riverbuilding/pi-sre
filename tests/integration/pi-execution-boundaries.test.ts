import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type AgentSession,
  type AgentBeforeSettleEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { installRequestExecution } from "../../src/runtime/request-execution-adapter.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { RequestMcpController } from "../../src/app/request-mcp-controller.js";
import {
  createRequestMcpToolBridge,
  RequestToolResultBoundary,
} from "../../src/mcp/request-tool-bridge.js";
import { scopedPodTool } from "../fixtures/scoped-tool.js";

type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type Message = Awaited<ReturnType<Stream["result"]>>;

// No provider/network calls: only the public stream surface consumed by real Pi.
function response(message: Message): Stream {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() {
      return message;
    },
  } as unknown as Stream;
}

async function fixture(
  run: (session: AgentSession, events: string[]) => Promise<void>,
  beforeSettle?: () => AgentBeforeSettleEventResult,
  register?: (pi: ExtensionAPI) => void,
) {
  const home = await mkdtemp(join(tmpdir(), "pi-sre-boundaries-"));
  const events: string[] = [];
  const services = await createAgentSessionServices({
    cwd: home,
    agentDir: home,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    }),
    resourceLoaderOptions: {
      ...createSreResourceLoaderOptions(),
      extensionFactories: [
        {
          name: "boundary-probe",
          factory: (pi: ExtensionAPI) => {
            register?.(pi);
            pi.on("input", (event) =>
              event.text === "consumed" ? { action: "handled" } : undefined,
            );
            pi.on("before_agent_start", () => {
              events.push("before_agent_start");
            });
            pi.on("context", (event) => {
              events.push("context");
              return {
                messages: [
                  ...event.messages,
                  {
                    role: "custom",
                    customType: "environment",
                    content: "CURRENT_ENVIRONMENT",
                    display: false,
                    timestamp: Date.now(),
                  },
                ],
              };
            });
            pi.on("session_before_compact", (event) => {
              events.push(`compact:${event.reason}`);
              return {
                compaction: {
                  summary: "fixture summary",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              };
            });
            pi.on("agent_before_settle", () => {
              events.push("before_settle");
              return beforeSettle?.();
            });
            pi.on("agent_settled", () => {
              events.push("settled");
            });
          },
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(home),
    noTools: register ? "builtin" : "all",
  });
  session.modelRuntime.registerProvider("boundary-fixture", {
    baseUrl: "http://unused.invalid",
    apiKey: "offline-fixture",
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
  const model = session.modelRuntime.getModel("boundary-fixture", "fixture");
  if (!model) throw new Error("Missing fixture model");
  await session.setModel(model);
  session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "user")
      events.push(`user:${JSON.stringify(event.message.content)}`);
    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "auto_retry_start"
    )
      events.push(event.type);
  });
  try {
    await run(session, events);
  } finally {
    await session.dispose();
    await rm(home, { recursive: true, force: true });
  }
}

function answer(
  model: NonNullable<AgentSession["model"]>,
  stopReason: Message["stopReason"] = "stop",
): Message {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content:
      stopReason === "toolUse"
        ? [{ type: "toolCall", id: "invalid", name: "missing_tool", arguments: {} }]
        : [{ type: "text", text: "done" }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "429 rate limit" } : {}),
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
}

describe("Slice 0: installed Pi execution boundaries", () => {
  it("consumes input without a run and drains follow-ups individually inside one loop", async () =>
    fixture(async (session, events) => {
      await session.prompt("consumed");
      expect(events).toEqual([]);
      session.setFollowUpMode("one-at-a-time");
      let calls = 0;
      session.agent.streamFunction = async (model, context) => {
        expect(JSON.stringify(context.messages)).toContain("CURRENT_ENVIRONMENT");
        events.push(`model:${++calls}`);
        if (calls === 1) {
          await session.steer("steering");
          await session.followUp("follow-1");
          await session.followUp("follow-2");
        }
        return response(answer(model));
      };
      await session.prompt("initial");
      expect(calls).toBe(4);
      expect(events.filter((e) => e === "before_agent_start")).toHaveLength(1);
      expect(events.filter((e) => e === "agent_start")).toHaveLength(1);
      expect(events.filter((e) => e.startsWith("user:"))).toHaveLength(4);
      expect(events.findIndex((e) => e.includes("follow-1"))).toBeLessThan(
        events.indexOf("model:3"),
      );
      expect(events.findIndex((e) => e.includes("follow-2"))).toBeGreaterThan(
        events.indexOf("model:3"),
      );
      expect(events.at(-1)).toBe("settled");
    }));

  it("retries without another user boundary and restores environment after manual compaction", async () =>
    fixture(async (session, events) => {
      let calls = 0;
      session.agent.streamFunction = (model, context) => {
        expect(JSON.stringify(context.messages)).toContain("CURRENT_ENVIRONMENT");
        return response(answer(model, ++calls === 1 ? "error" : "stop"));
      };
      await session.prompt("retry me " + "history ".repeat(1000));
      expect(calls).toBe(2);
      expect(events).toContain("auto_retry_start");
      expect(events.filter((e) => e.startsWith("user:"))).toHaveLength(1);
      expect(events.filter((e) => e === "before_agent_start")).toHaveLength(1);
      await session.prompt("second ".repeat(200));
      await session.compact();
      expect(events).toContain("compact:manual");
      await session.prompt("after compact");
      expect(calls).toBe(4);
    }));

  it("stops an invalid-tool loop through finishTurn, regardless of tool admission", async () =>
    fixture(async (session, events) => {
      let calls = 0;
      const previous = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        await previous?.(turn, signal);
        return calls >= 3 ? { action: "end" } : undefined;
      };
      session.agent.streamFunction = (model) => {
        calls++;
        return response(answer(model, "toolUse"));
      };
      await session.prompt("invalid loop");
      expect(calls).toBe(3);
      expect(session.messages.filter((m) => m.role === "toolResult")).toHaveLength(3);
      expect(events.at(-1)).toBe("settled");
    }));

  it("restores environment before automatic overflow retry without before_agent_start", async () =>
    fixture(async (session, events) => {
      session.agent.streamFunction = (model) => response(answer(model));
      await session.prompt("history ".repeat(1000));
      await session.prompt("second historical turn ".repeat(200));
      session.settingsManager.setCompactionEnabled(true);
      const before = events.filter((e) => e === "before_agent_start").length;
      let calls = 0;
      session.agent.streamFunction = (model, context) => {
        expect(JSON.stringify(context.messages)).toContain("CURRENT_ENVIRONMENT");
        const message = answer(model);
        if (++calls === 1) {
          message.stopReason = "error";
          message.errorMessage = "maximum context length exceeded";
        }
        return response(message);
      };
      await session.prompt("overflow recovery ".repeat(200));
      expect(calls).toBe(2);
      expect(events).toContain("compact:overflow");
      expect(events.filter((e) => e === "before_agent_start")).toHaveLength(before + 1);
      expect(events.at(-1)).toBe("settled");
    }));

  it("cancels and settles before a subsequent prompt", async () =>
    fixture(async (session, events) => {
      session.agent.streamFunction = async (model) => {
        void session.abort();
        return response(answer(model, "aborted"));
      };
      await session.prompt("cancel");
      expect(events.at(-1)).toBe("settled");
      session.agent.streamFunction = (model) => response(answer(model));
      await session.prompt("new request");
      expect(events.filter((e) => e === "settled")).toHaveLength(2);
    }));

  it("continues without a new user request and aborts at the model boundary", async () =>
    fixture(async (session, events) => {
      let calls = 0;
      const previous = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        await previous?.(turn, signal);
        return { action: "continue" };
      };
      session.agent.streamFunction = (model) => {
        calls++;
        if (calls === 3) {
          void session.abort();
          return response(answer(model, "aborted"));
        }
        return response(answer(model));
      };
      await session.prompt("continue automatically");
      expect(calls).toBe(3);
      expect(events.filter((e) => e.startsWith("user:"))).toHaveLength(1);
      expect(events.filter((e) => e === "before_agent_start")).toHaveLength(1);
      expect(events.at(-1)).toBe("settled");
    }));
});

describe("Slice 1: request execution with installed Pi", () => {
  it("gives every delivered user message fresh budgets and locks both queue modes", async () =>
    fixture(async (session) => {
      const seen: { id: string; iterations: number }[] = [];
      let calls = 0;
      session.agent.streamFunction = async (model) => {
        const request = execution.current!;
        seen.push({ id: request.requestId, iterations: request.counts.modelIterations });
        if (++calls === 1) {
          session.setSteeringMode("all");
          session.settingsManager.setSteeringMode("all");
          session.agent.steeringMode = "all";
          expect(session.agent.steeringMode).toBe("one-at-a-time");
          expect(session.settingsManager.getSteeringMode()).toBe("one-at-a-time");
          session.setFollowUpMode("all");
          session.settingsManager.setFollowUpMode("all");
          session.agent.followUpMode = "all";
          expect(session.agent.followUpMode).toBe("one-at-a-time");
          expect(session.settingsManager.getFollowUpMode()).toBe("one-at-a-time");
          await session.steer("same");
          await session.steer("same");
          await session.followUp("same");
          await session.followUp("same");
          expect(execution.current?.requestId).toBe(request.requestId);
        }
        expect(request.counts.dispatches).toBe(0);
        const result = await request.accept(
          {
            toolCallId: "same-id",
            operation: "pods_list",
            context: "A",
            parameters: {},
            connection: {},
          },
          () => {},
          async () => "ok",
        );
        expect(result.status).toBe("success");
        expect(request.counts.dispatches).toBe(1);
        return response(answer(model));
      };
      const execution = installRequestExecution(
        session,
        { maxToolCalls: 1, maxModelIterations: 1 },
        () => {},
      );
      try {
        await session.prompt("consumed");
        expect(execution.current).toBeUndefined();
        await session.prompt("same");
        expect(seen.map((s) => s.iterations)).toEqual([1, 1, 1, 1, 1]);
        expect(new Set(seen.map((s) => s.id)).size).toBe(5);
        await session.prompt("follow-up question");
        await session.prompt("different topic");
        expect(new Set(seen.map((s) => s.id)).size).toBe(7);
      } finally {
        await execution.dispose();
      }
    }));

  it("stops invalid-tool loops at the stream boundary despite continuation hooks", async () =>
    fixture(async (session) => {
      let calls = 0;
      const notices: string[] = [];
      session.agent.finishTurn = () => ({ action: "continue" });
      session.agent.streamFunction = (model) => {
        calls++;
        return response(answer(model, "toolUse"));
      };
      const execution = installRequestExecution(
        session,
        { maxToolCalls: 1, maxModelIterations: 3 },
        (text) => notices.push(text),
      );
      try {
        await session.prompt("invalid loop");
        expect(calls).toBe(3);
        expect(execution.current?.counts.modelIterations).toBe(3);
        expect(session.messages.filter((m) => m.role === "toolResult")).toHaveLength(3);
        expect(notices).toHaveLength(1);
      } finally {
        await execution.dispose();
      }
    }));

  it("keeps counters across retry and compaction and creates fresh ownership after cancellation", async () =>
    fixture(async (session) => {
      let calls = 0;
      const ids: string[] = [];
      session.agent.streamFunction = (model) => {
        ids.push(execution.current!.requestId);
        return response(answer(model, ++calls === 1 ? "error" : "stop"));
      };
      const execution = installRequestExecution(
        session,
        { maxToolCalls: 2, maxModelIterations: 8 },
        () => {},
      );
      try {
        await session.prompt("retry " + "history ".repeat(1000));
        expect(ids[0]).toBe(ids[1]);
        expect(execution.current?.counts.modelIterations).toBe(2);
        await session.prompt("second ".repeat(200));
        const previous = execution.current!;
        await session.compact();
        expect(execution.current).toBe(previous);
        expect(previous.counts.modelIterations).toBe(1);
        await session.abort();
        expect(previous.signal.aborted).toBe(true);
        await session.prompt("next");
        expect(execution.current?.requestId).not.toBe(previous.requestId);
        expect(execution.current?.counts.modelIterations).toBe(1);
      } finally {
        await execution.dispose();
      }
    }));
});

it("Slice 1: dispatch exhaustion and before-settle continuation cannot bypass the iteration cap", async () => {
  await fixture(
    async (session) => {
      let calls = 0;
      let dispatched = 0;
      session.agent.streamFunction = async (model) => {
        calls++;
        const result = await execution.current!.accept(
          {
            toolCallId: String(calls),
            operation: "pods_list",
            context: "A",
            parameters: {},
            connection: {},
          },
          () => {},
          async () => ++dispatched,
        );
        expect(result.status).toBe(calls === 1 ? "success" : "error");
        return response(answer(model));
      };
      const execution = installRequestExecution(
        session,
        { maxToolCalls: 1, maxModelIterations: 3 },
        () => {},
      );
      try {
        await session.prompt("continue after exhausted dispatch budget");
        expect(calls).toBe(3);
        expect(dispatched).toBe(1);
        expect(execution.current?.counts).toMatchObject({ dispatches: 1, modelIterations: 3 });
      } finally {
        await execution.dispose();
      }
    },
    () => ({
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "continuation",
          content: "Continue checking.",
          display: false,
        },
      ],
    }),
  );
});

it("Slice 1: automatic overflow retry preserves request and iteration counts", async () =>
  fixture(async (session) => {
    let overflow = false;
    const ids: string[] = [];
    session.agent.streamFunction = (model) => {
      ids.push(execution.current!.requestId);
      const message = answer(model);
      if (overflow) {
        overflow = false;
        message.stopReason = "error";
        message.errorMessage = "maximum context length exceeded";
      }
      return response(message);
    };
    const execution = installRequestExecution(
      session,
      { maxToolCalls: 2, maxModelIterations: 3 },
      () => {},
    );
    try {
      await session.prompt("history ".repeat(1000));
      await session.prompt("more history ".repeat(200));
      session.settingsManager.setCompactionEnabled(true);
      overflow = true;
      await session.prompt("overflow ".repeat(200));
      expect(ids.at(-1)).toBe(ids.at(-2));
      expect(execution.current?.counts.modelIterations).toBe(2);
    } finally {
      await execution.dispose();
    }
  }));

it("Slice 4: real Pi publishes bounded source content and guards pre-handler schema errors before model/history", async () => {
  const contextsTool = { name: "configuration_contexts_list", inputSchema: { type: "object" } };
  let dispatches = 0;
  const controller = new RequestMcpController({
    connect: async () => ({
      state: "ready",
      listTools: async () => [contextsTool, scopedPodTool],
      callTool: async (name) => {
        if (name === contextsTool.name)
          return { content: [], structuredContent: { contexts: [{ name: "A", default: false }] } };
        dispatches++;
        return { content: [{ type: "text", text: "pod web password=private-result" }] };
      },
      close: async () => {},
    }),
    publish: () => {},
  });
  await controller.restart();
  expect(controller.snapshot.status).toBe("ready");
  let execution: ReturnType<typeof installRequestExecution> | undefined;
  try {
    await fixture(
      async (session) => {
        session.setActiveToolsByName(["pods_list"]);
        let streams = 0;
        const modelResults: { id: string; content: unknown }[] = [];
        session.agent.streamFunction = (model, context) => {
          const message = answer(model);
          if (++streams === 1) {
            message.stopReason = "toolUse";
            message.content = [
              { type: "toolCall", id: "valid", name: "pods_list", arguments: { context: "A" } },
              {
                type: "toolCall",
                id: "invalid",
                name: "pods_list",
                arguments: { context: "A", labelSelector: { password: "private-argument" } },
              },
            ];
          } else {
            const results = context.messages.filter((m) => m.role === "toolResult");
            modelResults.push(...results.map((m) => ({ id: m.toolCallId, content: m.content })));
          }
          return response(message);
        };
        execution = installRequestExecution(
          session,
          { maxToolCalls: 2, maxModelIterations: 4 },
          () => {},
        );
        try {
          await session.prompt("inspect pods");
          expect(streams).toBe(2);
          expect(dispatches).toBe(1);
          expect(modelResults).toHaveLength(2);
          const valid = modelResults.find((m) => m.id === "valid")!;
          const invalid = modelResults.find((m) => m.id === "invalid")!;
          expect(JSON.stringify(valid.content)).toContain('\\"context\\":\\"A\\"');
          expect(JSON.stringify(valid.content)).toContain("dispatchedAt");
          expect(JSON.stringify(invalid.content)).toContain("not-executed");
          expect(JSON.stringify(invalid.content)).not.toContain("dispatchedAt");
          expect(JSON.stringify(modelResults)).not.toMatch(/private-result|private-argument/);
          expect(execution.current?.counts.dispatches).toBe(1);
          const results = session.messages.filter((m) => m.role === "toolResult");
          expect(JSON.stringify(results)).not.toMatch(/private-result|private-argument/);
          expect(results).toHaveLength(2);
          const stored = session.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
          expect(stored).toHaveLength(2);
          expect(JSON.stringify(stored)).not.toMatch(/private-result|private-argument/);
        } finally {
          await execution.dispose();
        }
      },
      undefined,
      (pi) => {
        const boundary = new RequestToolResultBoundary();
        const bridge = createRequestMcpToolBridge(
          scopedPodTool,
          controller.snapshot,
          () => execution?.current,
          boundary,
        );
        pi.registerTool(bridge);
        pi.on("message_end", (event) => boundary.protectMessage(event));
      },
    );
  } finally {
    await controller.close();
  }
});

it("Slice 1: cancel clears queued follow-ups and aborts calls before the next prompt", async () =>
  fixture(async (session) => {
    let calls = 0;
    let cancelPromise: Promise<void> | undefined;
    const late = Promise.withResolvers<string>();
    session.agent.streamFunction = async (model) => {
      if (++calls === 1) {
        await session.followUp("same");
        await session.followUp("same");
        const call = execution.current!.accept(
          {
            toolCallId: "reused",
            operation: "pods_list",
            context: "A",
            parameters: {},
            connection: {},
          },
          () => {},
          () => late.promise,
        );
        await Promise.resolve();
        cancelPromise = session.abort();
        expect((await call).status).toBe("cancelled");
        return response(answer(model, "aborted"));
      }
      return response(answer(model));
    };
    const execution = installRequestExecution(
      session,
      { maxToolCalls: 2, maxModelIterations: 4 },
      () => {},
    );
    try {
      await session.prompt("cancel");
      await cancelPromise;
      const old = execution.current!;
      expect(calls).toBe(1);
      expect(session.agent.hasQueuedMessages()).toBe(false);
      late.resolve("ignored success");
      await session.prompt("same");
      expect(execution.current?.requestId).not.toBe(old.requestId);
      expect(execution.current?.counts).toMatchObject({ dispatches: 0, modelIterations: 1 });
    } finally {
      await execution.dispose();
    }
  }));

it("Slice 1: application steering keeps the current budgets and idle environment updates do not run the model", async () =>
  fixture(async (session) => {
    const ids: string[] = [];
    const iterations: number[] = [];
    session.agent.streamFunction = async (model) => {
      ids.push(execution.current!.requestId);
      iterations.push(execution.current!.counts.modelIterations);
      if (ids.length === 1) {
        await session.sendCustomMessage(
          { customType: "environment", content: "targets changed", display: false },
          { deliverAs: "steer" },
        );
      }
      return response(answer(model));
    };
    const execution = installRequestExecution(
      session,
      { maxToolCalls: 1, maxModelIterations: 3 },
      () => {},
    );
    try {
      await session.sendCustomMessage({
        customType: "environment",
        content: "initial environment",
        display: false,
      });
      expect(execution.current).toBeUndefined();
      expect(ids).toHaveLength(0);
      await session.prompt("inspect");
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
      expect(iterations).toEqual([1, 2]);
      const request = execution.current!;
      await session.sendCustomMessage({
        customType: "environment",
        content: "reconnected",
        display: false,
      });
      expect(execution.current).toBe(request);
      expect(ids).toHaveLength(2);
      await session.prompt("continue");
      expect(ids[2]).not.toBe(ids[1]);
      expect(iterations[2]).toBe(1);
    } finally {
      await execution.dispose();
    }
  }));
