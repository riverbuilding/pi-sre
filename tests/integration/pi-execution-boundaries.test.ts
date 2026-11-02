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
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";

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

async function fixture(run: (session: AgentSession, events: string[]) => Promise<void>) {
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
    noTools: "all",
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
      // The public queue methods preserve object identity at delivery. Text cannot
      // identify origin: a steering message and a follow-up can be identical.
      const origins = new WeakMap<object, string>();
      const delivered: string[] = [];
      const steer = session.agent.steer.bind(session.agent);
      const followUp = session.agent.followUp.bind(session.agent);
      session.agent.steer = (message) => {
        origins.set(message, "steer");
        steer(message);
      };
      session.agent.followUp = (message) => {
        origins.set(message, "followUp");
        followUp(message);
      };
      session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "user") {
          delivered.push(origins.get(event.message) ?? "initial");
        }
      });
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
      expect(delivered).toEqual(["initial", "steer", "followUp", "followUp"]);
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
