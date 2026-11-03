import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { ExecutionLimits } from "../config/execution.js";
import { executionLimitsSchema } from "../config/execution.js";
import { RequestExecution } from "../execution/request-execution.js";
import { ExecutionQueue } from "../cluster/execution-queue.js";

const installed = new WeakSet<AgentSession>();

/** Staged integration: install once, after selecting the provider stream. */
export function installRequestExecution(
  session: AgentSession,
  limits: ExecutionLimits,
  notify: (message: string) => void,
) {
  const validatedLimits = executionLimitsSchema.parse(limits);
  if (installed.has(session)) throw new Error("Request execution is already installed.");
  installed.add(session);
  const agent = session.agent;
  const queue = new ExecutionQueue();
  let current: RequestExecution | undefined;
  let stopping: Promise<void> | undefined;
  let stopFailure: unknown;
  const pending = new Set<Promise<void>>();
  const cancellations = new Map<RequestExecution, () => void>();
  const bindCancellation = (request: RequestExecution, signal: AbortSignal) => {
    cancellations.get(request)?.();
    const cancel = () => {
      request.cancel();
      session.clearQueue();
    };
    signal.addEventListener("abort", cancel, { once: true });
    cancellations.set(request, () => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  };
  const original = {
    stream: agent.streamFunction,
    finishTurn: agent.finishTurn,
    abort: session.abort,
  };
  const stop = () => {
    current?.cancel();
    session.clearQueue();
    if (!stopping) {
      // Never await abort from inside the running stream or event hook.
      stopping = original.abort.call(session).catch((error: unknown) => {
        stopFailure = error;
      });
    }
  };
  // Both user-message queues deliver one message per model turn. Budgeting
  // depends only on user message_start, without queue-origin bookkeeping.
  const restoreModes: (() => void)[] = [];
  for (const [property, setter] of [
    ["steeringMode", "setSteeringMode"],
    ["followUpMode", "setFollowUpMode"],
  ] as const) {
    const sessionSetter = session[setter];
    const settingsSetter = session.settingsManager[setter];
    const descriptor = Object.getOwnPropertyDescriptor(agent, property);
    const previousMode = agent[property];
    agent[property] = "one-at-a-time";
    Object.defineProperty(agent, property, {
      configurable: true,
      get: () => "one-at-a-time",
      set: () => {},
    });
    session[setter] = () => sessionSetter.call(session, "one-at-a-time");
    session.settingsManager[setter] = () =>
      settingsSetter.call(session.settingsManager, "one-at-a-time");
    session[setter]("one-at-a-time");
    restoreModes.push(() => {
      session[setter] = sessionSetter;
      session.settingsManager[setter] = settingsSetter;
      if (descriptor) Object.defineProperty(agent, property, descriptor);
      else Reflect.deleteProperty(agent, property);
      agent[property] = previousMode;
    });
  }
  const trackFinish = (request: RequestExecution) => {
    const done = request.finish();
    pending.add(done);
    void done.then(() => {
      pending.delete(done);
      cancellations.get(request)?.();
      cancellations.delete(request);
    });
    return done;
  };
  const unsubscribe = agent.subscribe((event, signal) => {
    if (event.type === "agent_start" && current) bindCancellation(current, signal);
    if (event.type === "message_start" && event.message.role === "user") {
      const previous = current;
      current = new RequestExecution(validatedLimits, queue);
      bindCancellation(current, signal);
      stopping = undefined;
      if (previous) return trackFinish(previous);
    }
    // The public loop signal covers cancellation through Session or agent APIs.
    if (signal.aborted) current?.cancel();
  });
  session.abort = () => {
    current?.cancel();
    session.clearQueue();
    return original.abort.call(session);
  };
  agent.streamFunction = (model, context, options) => {
    // Compaction summarization uses this stream too, outside an active agent run.
    if (session.isCompacting) return original.stream(model, context, options);
    try {
      if (!current) throw new Error("No active user request.");
      current.consumeModelIteration();
    } catch (error) {
      stop();
      notify("Request stopped: model iteration limit reached or request cancelled.");
      throw error;
    }
    return original.stream(model, context, options);
  };
  agent.finishTurn = async (turn, signal) => {
    await current?.waitForIdle();
    const decision = await original.finishTurn?.(turn, signal);
    return current?.signal.aborted ? { action: "end" } : (decision ?? undefined);
  };
  const unsubscribeSession = session.subscribe((event) => {
    if (event.type === "agent_settled" && current) trackFinish(current);
  });

  return {
    get current() {
      return current;
    },
    async dispose() {
      stop();
      await stopping;
      if (current) await current.finish();
      await Promise.all(pending);
      for (const remove of cancellations.values()) remove();
      cancellations.clear();
      unsubscribe();
      unsubscribeSession();
      agent.streamFunction = original.stream;
      if (original.finishTurn) agent.finishTurn = original.finishTurn;
      else delete agent.finishTurn;
      session.abort = original.abort;
      for (const restore of restoreModes) restore();
      installed.delete(session);
      if (stopFailure) throw stopFailure;
    },
  };
}
