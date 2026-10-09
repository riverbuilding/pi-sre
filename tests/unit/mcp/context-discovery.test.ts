import { describe, expect, it, vi } from "vitest";

import {
  CONTEXT_ENUMERATION_LIMITS,
  ContextDiscoveryError,
  discoverClusterContexts,
  parseContextRegistry,
} from "../../../src/mcp/context-discovery.js";
import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import captured from "../../fixtures/phase2-server-0.0.67.json" with { type: "json" };
import { phase2ContextResponses } from "../../fixtures/phase2-context-responses.js";

const contexts = [
  { name: "alpha", server: "https://shared.example.invalid", default: true },
  { name: "alphabet", server: "https://shared.example.invalid", default: false },
];
function response(entries = contexts, defaultContext = "alpha") {
  return { content: [], structuredContent: { contexts: entries, defaultContext } };
}
const descriptors = captured.cases["multiple-default"].descriptors;

describe("context enumeration adapter", () => {
  it.each(phase2ContextResponses)("enforces frozen $name outcome", ({ response, outcome }) => {
    if (outcome === "invalid-response" || outcome === "tool-error") {
      expect(() => parseContextRegistry(response)).toThrow(
        expect.objectContaining({ kind: outcome }),
      );
    } else {
      const registry = parseContextRegistry(response);
      expect(registry.defaultContext?.name).toBe(outcome === "bound" ? "alpha" : undefined);
      expect(registry.contexts.length === 0).toBe(outcome === "empty");
    }
  });

  it("accepts the real captured response", () => {
    const registry = parseContextRegistry(captured.cases["multiple-default"].response);
    expect(registry.contexts.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(registry.defaultContext?.name).toBe("alpha");
  });

  it("copies and freezes an exactly indexed inventory in deterministic order", () => {
    const raw = response([...contexts].reverse());
    const registry = parseContextRegistry(raw);
    raw.structuredContent.contexts.length = 0;
    expect(registry.contexts.map((entry) => entry.name)).toEqual(["alpha", "alphabet"]);
    expect(registry.get("alpha")).toBe(registry.defaultContext);
    for (const name of ["alph", "Alpha", "alpha ", "https://shared.example.invalid", "toString"]) {
      expect(registry.get(name)).toBeUndefined();
    }
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.contexts)).toBe(true);
    expect(Object.isFrozen(registry.get("alpha"))).toBe(true);
  });

  it("discards extra fields and endpoint credentials and controls", () => {
    const entry = {
      ...contexts[0]!,
      server: "https://user:PRIVATE@shared.example.invalid/path?token=PRIVATE#PRIVATE\u001b",
      token: "PRIVATE",
    };
    const registry = parseContextRegistry(response([entry]));
    expect(registry.contexts).toEqual([
      { name: "alpha", server: "https://shared.example.invalid", isDefault: true },
    ]);
    expect(JSON.stringify(registry)).not.toContain("PRIVATE");
    expect(
      parseContextRegistry(response([{ ...contexts[0]!, server: "token=PRIVATE" }])).get("alpha")
        ?.server,
    ).toBe("[endpoint withheld]");
  });

  it.each(["", "alpha\n", "alpha\u001b[31m", "alpha\u009b", "alpha\u202e"])(
    "rejects invalid identity %j",
    (name) => {
      expect(() => parseContextRegistry(response([{ ...contexts[0]!, name }], name))).toThrow(
        ContextDiscoveryError,
      );
    },
  );

  it.each([
    undefined,
    null,
    { content: [] },
    { content: [{ type: "text" }] },
    {
      content: [{ type: "image", data: "x", mimeType: "image/png" }],
      structuredContent: { contexts: [] },
    },
    { content: [], isError: "true", structuredContent: { contexts: [] } },
    {
      content: [{ type: "text", text: "No contexts found in kubeconfig" }],
      structuredContent: undefined,
    },
    { content: [{ type: "text", text: '"No contexts found in kubeconfig"' }] },
    { content: [{ type: "text", text: '{"contexts":[]}' }] },
  ])("rejects unsupported envelope or fallback %#", (raw) => {
    expect(() => parseContextRegistry(raw)).toThrow(
      expect.objectContaining({ kind: "invalid-response" }),
    );
  });

  it("rejects malformed blocks even alongside a valid inventory", () => {
    expect(() =>
      parseContextRegistry({ ...response(), content: [{ type: "text", text: 1 }] }),
    ).toThrow(ContextDiscoveryError);
  });

  it("uses UTF-8 field limits without truncation", () => {
    const name = "é".repeat(512);
    expect(
      parseContextRegistry(response([{ ...contexts[0]!, name }], name)).get(name),
    ).toBeDefined();
    expect(() =>
      parseContextRegistry(response([{ ...contexts[0]!, name: name + "a" }], name + "a")),
    ).toThrow(ContextDiscoveryError);
    expect(
      parseContextRegistry(response([{ ...contexts[0]!, server: "x".repeat(4096) }])).contexts,
    ).toHaveLength(1);
    expect(() =>
      parseContextRegistry(response([{ ...contexts[0]!, server: "x".repeat(4097) }])),
    ).toThrow(ContextDiscoveryError);
    expect(() =>
      parseContextRegistry({
        ...response(),
        structuredContent: { contexts: [], defaultContext: "é".repeat(513) },
      }),
    ).toThrow(ContextDiscoveryError);
  });

  it("accepts the entry limit and rejects any extra entry", () => {
    const entries = Array.from({ length: 1024 }, (_, i) => ({
      name: `context-${i}`,
      server: "",
      default: false,
    }));
    expect(parseContextRegistry(response(entries, "")).contexts).toHaveLength(1024);
    expect(() =>
      parseContextRegistry(
        response([...entries, { name: "extra", server: "", default: false }], ""),
      ),
    ).toThrow(ContextDiscoveryError);
  });

  it("applies the complete result byte limit including discarded metadata", () => {
    const raw = { content: [], structuredContent: { contexts: [] }, unused: "" };
    const overhead = Buffer.byteLength(JSON.stringify(raw));
    raw.unused = "x".repeat(CONTEXT_ENUMERATION_LIMITS.resultBytes - overhead);
    expect(parseContextRegistry(raw).contexts).toEqual([]);
    raw.unused += "x";
    expect(() => parseContextRegistry(raw)).toThrow(ContextDiscoveryError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseContextRegistry(circular)).toThrow(ContextDiscoveryError);
  });

  it("invokes only the approved descriptor on the supplied connection", async () => {
    const report = await discoverMcpTools({ listTools: async () => descriptors });
    const callTool = vi.fn().mockResolvedValue(response());
    const signal = new AbortController().signal;
    const registry = await discoverClusterContexts({ state: "ready", callTool }, report, signal);
    expect(registry.defaultContext?.name).toBe("alpha");
    expect(callTool).toHaveBeenCalledExactlyOnceWith("configuration_contexts_list", {}, signal);
  });

  it.each(
    [
      [],
      descriptors.filter((tool) => tool.name !== "configuration_contexts_list"),
      [
        {
          name: "configuration_contexts_list",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ],
      [
        {
          name: "configuration_contexts_list",
          inputSchema: { type: "object", properties: { context: { type: "string" } } },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
      [
        {
          name: "configuration_contexts_list",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
      [descriptors[0], descriptors[0]],
    ].map((tools) => ({ tools })),
  )("fails incompatible descriptor inventories before calling %#", async ({ tools }) => {
    // Discovery treats the external descriptor list as untrusted.
    const report = await discoverMcpTools({ listTools: vi.fn().mockResolvedValue(tools) });
    const callTool = vi.fn();
    await expect(
      discoverClusterContexts({ state: "ready", callTool }, report),
    ).rejects.toMatchObject({ kind: "incompatible-tool" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["ready", "401 Unauthorized token=PRIVATE", "authentication-failed"],
    ["ready", "403 Forbidden", "authorization-failed"],
    ["ready", "timed out", "timeout"],
    ["failed", "untrusted", "transport-unavailable"],
  ] as const)("classifies %s / %s safely", async (state, message, failureCategory) => {
    const report = await discoverMcpTools({ listTools: async () => descriptors });
    const cause = new Error(message);
    const callTool = vi.fn().mockRejectedValue(cause);
    await expect(discoverClusterContexts({ state, callTool }, report)).rejects.toMatchObject({
      kind: "tool-error",
      failureCategory,
      cause,
    });
    try {
      await discoverClusterContexts({ state, callTool }, report);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  });

  it("propagates caller cancellation before dispatch and after a late response", async () => {
    const report = await discoverMcpTools({ listTools: async () => descriptors });
    const controller = new AbortController();
    const callTool = vi.fn(async () => {
      controller.abort();
      return response();
    });
    await expect(
      discoverClusterContexts({ state: "ready", callTool }, report, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    callTool.mockClear();
    await expect(
      discoverClusterContexts({ state: "ready", callTool }, report, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(callTool).not.toHaveBeenCalled();
  });
});
