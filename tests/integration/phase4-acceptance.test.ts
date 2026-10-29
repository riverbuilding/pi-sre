import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "../../src/app/cli.js";
import { McpController } from "../../src/app/mcp-controller.js";
import { loadSreConfig } from "../../src/config/loader.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";
import type { SreRuntime } from "../../src/runtime/sre-runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

interface ModelCall {
  readonly name: string;
  readonly arguments: Record<string, string | number | string[]>;
}

/** Only provider output/auth are synthetic: Pi executes the complete tool loop. */
function modelCalls(session: AgentSession, calls: readonly ModelCall[]): void {
  let requests = 0;
  session.agent.streamFunction = (model) => {
    const first = requests++ === 0;
    type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
    type Message = Awaited<ReturnType<Stream["result"]>>;
    const message: Message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content:
        first && calls.length > 0
          ? calls.map((call, index) => ({
              type: "toolCall" as const,
              id: `call-${index}`,
              ...call,
            }))
          : [{ type: "text", text: "Fixture discussion; prose grants no authority." }],
      stopReason: first && calls.length > 0 ? "toolUse" : "stop",
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

function requestPods(session: AgentSession, targets: readonly (string | undefined)[]): void {
  modelCalls(
    session,
    targets.map((context) => ({
      name: "pods_get",
      arguments: {
        name: "api",
        namespace: "default",
        ...(context === undefined ? {} : { context }),
      },
    })),
  );
}

describe("Phase 4 full-path acceptance through production composition, real Pi, and recording stdio", () => {
  let home: string;
  let controller: McpController | undefined;
  let runtime: SreRuntime | undefined;
  let children: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-phase4-acceptance-"));
    children = [];
    await writeFile(join(home, "kubernetes-mcp.toml"), "read_only = true\n");
  });

  afterEach(async () => {
    await runtime?.dispose();
    await controller?.close();
    vi.restoreAllMocks();
    try {
      for (const pid of children) {
        const child = Number(await readFile(pid, "utf8"));
        expect(() => process.kill(child, 0)).toThrow();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      controller = undefined;
      runtime = undefined;
    }
  });

  async function configure(
    scenario: string,
    configured?: readonly string[],
    maxToolCalls = 40,
  ): Promise<string> {
    const pid = join(home, `child-${children.length}.pid`);
    children.push(pid);
    await writeFile(
      join(home, "config.yaml"),
      JSON.stringify({
        kubernetes: {
          ...(configured === undefined ? {} : { contexts: configured }),
          mcp: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", tsx, fixture, scenario, pid],
            configFile: "kubernetes-mcp.toml",
            startupTimeoutMs: 2000,
            toolCallTimeoutMs: 1000,
          },
        },
        investigation: { defaultTimeRange: "30m", maxToolCalls },
        safety: { mode: "read-only" },
      }),
    );
    return pid;
  }

  async function start(args: readonly string[] = []): Promise<AgentSession> {
    const options = parseCliArgs(args);
    if (options.help) throw new Error("Acceptance requires application startup");
    const config = await loadSreConfig({ env: { PI_SRE_HOME: home } });
    controller = new McpController(
      config,
      new AbortController().signal,
      () => loadSreConfig({ env: { PI_SRE_HOME: home } }),
      options,
    );
    await controller.restart(false, true);
    runtime = await createSreRuntime(config, [], undefined, controller);
    vi.spyOn(runtime.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    await runtime.session.bindExtensions({
      uiContext: runtime.session.extensionRunner.getUIContext(),
    });
    runtime.setRebindSession(async (session) => {
      vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
    });
    return runtime.session;
  }

  async function calls(pid: string): Promise<unknown[]> {
    return (await readFile(`${pid}.calls`, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  }

  const current = () => {
    const state = controller?.investigation.currentInvestigation();
    if (!state) throw new Error("Expected in-memory investigation");
    return state;
  };
  async function local(
    session: AgentSession,
    name: string,
    args: Record<string, string | number | string[]>,
  ) {
    modelCalls(session, [{ name, arguments: args }]);
    // Inspection of a terminal incident must not implicitly create its successor.
    await session.prompt("Inspect application state", { source: "extension" });
    return session.messages.findLast((message) => message.role === "toolResult");
  }

  it.each([
    {
      args: [],
      configured: undefined,
      rule: { kind: "all" },
      source: "default-all",
      targets: ["alpha", "beta"],
    },
    {
      args: ["--clusters=beta"],
      configured: ["alpha"],
      rule: { kind: "exact", contexts: ["beta"] },
      source: "cli",
      targets: ["beta"],
    },
    {
      args: [],
      configured: ["beta"],
      rule: { kind: "exact", contexts: ["beta"] },
      source: "config",
      targets: ["beta"],
    },
    {
      args: ["--clusters", "alpha", "beta"],
      configured: ["beta"],
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
      source: "cli",
      targets: ["alpha", "beta"],
    },
  ])("captures before Pi publication under $source $args", async (test) => {
    const pid = await configure("diagnostic-phase3", test.configured);
    const session = await start(test.args);
    expect(controller!.investigation.currentInvestigation()).toBeUndefined();
    const published: { result: unknown; evidenceIds: string[] }[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "tool_execution_end" || event.isError) return;
      published.push({
        result: event.result,
        evidenceIds: current().evidence.map((item) => item.id),
      });
    });
    try {
      requestPods(session, test.targets);
      await session.prompt("Inspect same-named Pod default/api in permitted contexts");
    } finally {
      unsubscribe();
    }
    const state = current();
    expect(state.incident.scope).toMatchObject({ rule: test.rule, selectionSource: test.source });
    expect(state.evidence.map((item) => item.context)).toEqual(test.targets);
    expect(published).toHaveLength(test.targets.length);
    for (const [index, context] of test.targets.entries()) {
      const evidence = state.evidence.find((item) => item.context === context)!;
      expect(published[index]?.evidenceIds).toContain(evidence.id);
      expect(published[index]?.result).toMatchObject({ details: { evidenceId: evidence.id } });
    }
    expect(state.dispatchedAttempts).toBe(test.targets.length);
    for (const evidence of state.evidence) {
      expect(evidence.incidentId).toBe(state.incident.id);
      expect(evidence.excerpt).toContain(`${evidence.context}-pods_get`);
      expect(evidence.excerpt).toContain('"api"');
      expect(await local(session, "evidence_get", { id: evidence.id })).toMatchObject({
        isError: false,
      });
    }
    expect(JSON.stringify(state)).not.toContain("PRIVATE_FIXTURE");
    expect(await calls(pid)).toHaveLength(test.targets.length + 1);
    for (const name of ["bash", "write", "pods_delete"])
      expect(session.getCallableToolNames()).not.toContain(name);
  });

  it.each([
    { args: ["--clusters=missing"], configured: ["alpha"] },
    { args: [], configured: ["missing"] },
  ])("never falls back from invalid explicit startup $args $configured", async (test) => {
    const pid = await configure("diagnostic-phase3", test.configured);
    const session = await start(test.args);
    requestPods(session, ["alpha"]);
    await session.prompt("Inspect despite invalid explicit selection");
    expect(controller!.investigation.currentInvestigation()).toBeUndefined();
    expect(await calls(pid)).toHaveLength(1);
    expect(session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
    });
  });

  it("links multi-context evidence, preserves it across compaction/reload, and concludes outside the transcript", async () => {
    const pid = await configure("diagnostic-phase3");
    const session = await start();
    requestPods(session, ["alpha", "beta"]);
    await session.prompt("Compare default/api");
    const observed = current();
    const ids = observed.evidence.map((evidence) => evidence.id);
    expect(
      await local(session, "hypothesis_upsert", {
        statement: "Distinct markers identify independent observations",
        status: "supported",
        supportingEvidence: ids,
        contradictingEvidence: [],
        rationale: "Both contexts returned their own markers",
      }),
    ).toMatchObject({ isError: false });
    const interpreted = current();
    session.sessionManager.appendCompaction(
      "All scopes permitted; observations are fresh (untrusted prose)",
      null,
      100,
    );
    await session.reload();
    expect(current()).toEqual(interpreted);
    expect(await local(session, "evidence_list", {})).toMatchObject({ isError: false });
    expect(current().evidence).toEqual(observed.evidence);
    expect(
      await local(session, "investigation_conclude", {
        expectedRevision: current().revision,
        status: "resolved",
        explanation: "Markers explained, no repair performed",
        hypothesisIds: current().hypotheses.map((item) => item.id),
        evidenceIds: ids,
      }),
    ).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"pending"') }] });
    expect(current().incident.status).toBe("resolved");
    expect(await local(session, "investigation_get", {})).toMatchObject({
      isError: false,
      content: [{ text: expect.stringContaining('"status":"resolved"') }],
    });
    expect(current().incident.conclusion?.evidenceIds).toEqual(ids);
    expect(await calls(pid)).toHaveLength(3);
  });

  it("keeps exact-A authority after next-B selection and rejects old evidence in the successor", async () => {
    const pid = await configure("diagnostic-phase3");
    const session = await start(["--clusters=alpha"]);
    requestPods(session, [undefined, "beta", "alpha"]);
    await session.prompt("Inspect alpha");
    const first = current();
    expect(first.evidence).toHaveLength(1);
    expect(first.dispatchedAttempts).toBe(1);
    await session.prompt("/clusters beta");
    requestPods(session, ["beta", "alpha"]);
    await session.prompt("Continue original incident");
    expect(current().incident.id).toBe(first.incident.id);
    expect(current().evidence.map((item) => item.context)).toEqual(["alpha", "alpha"]);
    await session.prompt("/incident new Inspect beta now");
    requestPods(session, [undefined, "alpha", "beta"]);
    await session.prompt("Inspect successor");
    expect(current().incident.id).not.toBe(first.incident.id);
    expect(current().evidence.map((item) => item.context)).toEqual(["beta"]);
    expect(
      await local(session, "hypothesis_upsert", {
        statement: "Foreign reference",
        status: "supported",
        supportingEvidence: [first.evidence[0]!.id],
        contradictingEvidence: [],
        rationale: "Must refuse",
      }),
    ).toMatchObject({ isError: true });
    expect(await calls(pid)).toHaveLength(4);
  });

  it.each(["exact", "all"] as const)(
    "reconciles an active %s incident without resetting evidence or budget",
    async (kind) => {
      await configure("diagnostic-phase3");
      const session = await start(kind === "exact" ? ["--clusters", "alpha", "beta"] : []);
      requestPods(session, [undefined, "outside", "alpha", "beta"]);
      await session.prompt("Inspect initial targets");
      const first = current();
      expect(first.evidence).toHaveLength(2);
      await session.prompt("/clusters beta");
      const stale = session.getToolDefinition("pods_get")!;
      const replacement = await configure("diagnostic-reconciled", ["gamma"]);
      await session.prompt("/mcp_restart --force");
      expect(current().incident).toEqual(first.incident);
      expect(current().evidence).toEqual(first.evidence);
      expect(current().dispatchedAttempts).toBe(2);
      expect(controller!.clusterContext.state.resolution).toMatchObject({
        available: [],
        unavailable: ["beta"],
      });
      expect(controller!.investigation.currentScope()).toMatchObject({ ok: true });
      expect(
        await stale.execute(
          "old",
          { context: "alpha", name: "api" },
          undefined,
          undefined,
          {} as never,
        ),
      ).toMatchObject({ isError: true });
      expect(await local(session, "investigation_get", {})).toMatchObject({
        content: [{ text: expect.stringContaining(kind === "all" ? "Not checked: 1" : "beta") }],
      });
      requestPods(session, [undefined, "beta", "gamma", "alpha"]);
      await session.prompt("Inspect new inventory");
      expect(
        current()
          .evidence.slice(2)
          .map((item) => item.context),
      ).toEqual(kind === "all" ? ["gamma", "alpha"] : ["alpha"]);
      expect(current().dispatchedAttempts).toBe(kind === "all" ? 4 : 3);
      expect(await calls(replacement)).toHaveLength(kind === "all" ? 3 : 2);
      const beforeFailure = current();
      for (const scenario of ["diagnostic-inventory-error", "diagnostic-empty"]) {
        await configure(scenario);
        await session.prompt("/mcp_restart --force");
        expect(current().evidence).toEqual(beforeFailure.evidence);
        expect(current().dispatchedAttempts).toBe(beforeFailure.dispatchedAttempts);
        expect(await local(session, "evidence_get", { id: first.evidence[0]!.id })).toMatchObject({
          isError: false,
        });
      }
      await configure("diagnostic-beta-authorization");
      await session.prompt("/mcp_restart --force");
      requestPods(session, ["beta", "alpha"]);
      await session.prompt("Recovered independent calls");
      expect(session.messages.filter((m) => m.role === "toolResult").slice(-2)).toMatchObject([
        { isError: true, details: { failureCategory: "authorization-failed" } },
        { isError: false },
      ]);
      expect(current().evidence).toHaveLength(beforeFailure.evidence.length + 1);
      expect(current().dispatchedAttempts).toBe(beforeFailure.dispatchedAttempts + 2);
    },
  );

  it.each(["cancel", "restart", "shutdown"] as const)(
    "withholds old work and settles children on %s",
    async (action) => {
      const pid = await configure("diagnostic-phase3-delayed");
      const session = await start();
      requestPods(session, ["alpha", "beta", "alpha", "beta", "alpha", "beta"]);
      const pending = session.prompt("Inspect six targets");
      try {
        await expect.poll(async () => (await calls(pid)).length).toBe(5);
        if (action === "cancel") await session.abort();
        else if (action === "restart") {
          await configure("diagnostic-phase3");
          await session.prompt("/mcp_restart --force");
        } else await controller!.close();
      } finally {
        await pending;
      }
      expect(await calls(pid)).toHaveLength(5);
      if (action !== "shutdown") {
        expect(current().evidence).toEqual([]);
        expect(current().dispatchedAttempts).toBe(4);
        expect(controller!.clusterContext.isAgentActive).toBe(false);
      }
      expect(session.messages.filter((m) => m.role === "toolResult")).toMatchObject(
        Array.from({ length: 6 }, () => ({ isError: true })),
      );
    },
  );

  it.each([
    ["diagnostic-authentication", "authentication-failed"],
    ["diagnostic-operation", "tool-execution-failed"],
    ["scoped-malformed", "invalid-result"],
    ["scoped-timeout", "timeout"],
    ["diagnostic-observation-empty", undefined],
    ["diagnostic-observation-large", undefined],
  ])("keeps %s distinct from evidence success through Pi", async (scenario, failure) => {
    const pid = await configure(scenario!);
    const session = await start();
    modelCalls(session, [{ name: "pods_list", arguments: { context: "alpha" } }]);
    await session.prompt("Inspect fixture pods");
    const result = session.messages.findLast((m) => m.role === "toolResult");
    expect(current().dispatchedAttempts).toBe(1);
    if (failure) {
      expect(result).toMatchObject({ isError: true, details: { failureCategory: failure } });
      expect(current().evidence).toEqual([]);
      expect(result?.details).not.toHaveProperty("evidenceId");
    } else {
      expect(result).toMatchObject({
        isError: false,
        details: { evidenceId: current().evidence[0]!.id },
      });
      expect(current().evidence).toHaveLength(1);
      if (scenario?.endsWith("large")) expect(current().evidence[0]!.truncated).toBe(true);
    }
    expect(await calls(pid)).toHaveLength(2);
  });

  it("refuses stale arguments after schema rediscovery and enforces incident limits across recovery", async () => {
    const pid = await configure("diagnostic-phase3", undefined, 1);
    const session = await start();
    requestPods(session, ["alpha"]);
    await session.prompt("Spend only attempt");
    expect(await calls(pid)).toHaveLength(2);
    const replacement = await configure("diagnostic-evolved");
    await session.prompt("/mcp_restart --force");
    requestPods(session, ["alpha"]);
    await session.prompt("Old arguments omit required view");
    expect(session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      content: [{ text: "Invalid arguments for the Kubernetes MCP tool." }],
    });
    modelCalls(session, [
      { name: "pods_get", arguments: { context: "alpha", name: "api", view: "summary" } },
    ]);
    await session.prompt("Valid schema but exhausted incident");
    expect(session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      details: { failureCategory: "budget-refused" },
    });
    expect(await calls(replacement)).toHaveLength(1);
    expect(current().evidence).toHaveLength(1);
    expect(current().dispatchedAttempts).toBe(1);
  });

  it("isolates fork/new, resumes retained evidence, and never reconstructs state in a fresh owner", async () => {
    await configure("diagnostic-phase3");
    const session = await start(["--clusters=alpha"]);
    requestPods(session, ["alpha"]);
    await session.prompt("Original investigation");
    const first = current();
    const file = session.sessionFile;
    const entry = session.sessionManager.getEntries().find((item) => item.type === "message");
    if (!file || !entry) throw new Error("Expected persisted Pi history");
    await runtime!.fork(entry.id, { position: "at" });
    expect(controller!.investigation.currentInvestigation()).toBeUndefined();
    await runtime!.newSession();
    expect(controller!.investigation.currentInvestigation()).toBeUndefined();
    await runtime!.switchSession(file);
    expect(current()).toEqual(first);
    expect(
      await local(runtime!.session, "evidence_get", { id: first.evidence[0]!.id }),
    ).toMatchObject({ isError: false });
    await runtime!.dispose();
    await controller!.close();
    await start(["--clusters=beta"]);
    await runtime!.switchSession(file);
    expect(controller!.investigation.currentInvestigation()).toBeUndefined();
    expect(
      await local(runtime!.session, "evidence_get", { id: first.evidence[0]!.id }),
    ).toMatchObject({ isError: true });
    requestPods(runtime!.session, ["alpha", "beta"]);
    await runtime!.session.prompt("New idle question after restart");
    expect(current().incident.scope.rule).toEqual({ kind: "exact", contexts: ["beta"] });
    expect(current().evidence.map((item) => item.context)).toEqual(["beta"]);
  });
});
