import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

type Stream = ReturnType<AgentSession["modelRuntime"]["streamSimple"]>;
type Message = Awaited<ReturnType<Stream["result"]>>;
type Context = Parameters<AgentSession["modelRuntime"]["streamSimple"]>[1];

/** Replace only provider I/O; retain the production stream guard and real Pi hooks. */
export async function installOfflineProvider(
  session: AgentSession,
  respond: (context: Context, iteration: number) => Message["content"],
): Promise<void> {
  session.modelRuntime.registerProvider("offline-fixture", {
    baseUrl: "http://unused.invalid",
    apiKey: "offline-fixture",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = session.modelRuntime.getModel("offline-fixture", "fixture");
  if (!model) throw new Error("Missing fixture model");
  await session.setModel(model);
  session.settingsManager.setRetryEnabled(false);
  let iteration = 0;
  vi.spyOn(session.modelRuntime, "streamSimple").mockImplementation((model, context) => {
    const content = respond(context, iteration++);
    const message: Message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content,
      stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
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
    // A deterministic public event stream substitutes only the provider response.
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: message.stopReason, message };
      },
      async result() {
        return message;
      },
    } as unknown as Stream;
  });
}
