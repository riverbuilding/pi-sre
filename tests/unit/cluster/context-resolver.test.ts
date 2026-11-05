import { describe, expect, it } from "vitest";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { CurrentClusterSelection } from "../../../src/cluster/current-selection.js";
import {
  createExactClusterRule,
  createStartupSelection,
  parseClusterRule,
} from "../../../src/cluster/context-resolver.js";

function registry(names: readonly string[], defaultName?: string): ClusterContextRegistry {
  return new ClusterContextRegistry(
    names.map((name) => ({
      name,
      server: "https://example.invalid",
      isDefault: name === defaultName,
    })),
  );
}

describe("startup and current selection", () => {
  it.each([undefined, "alpha"])("defaults to live all despite MCP default %s", (defaultName) => {
    const selection = new CurrentClusterSelection(registry(["alpha", "beta"], defaultName));
    expect(selection.rule).toEqual({ kind: "all" });
    expect(selection.availability).toEqual({ available: ["alpha", "beta"], unavailable: [] });
  });
  it("keeps CLI > configuration > live all precedence", () => {
    const configured = createExactClusterRule(["beta"]);
    expect(createStartupSelection({}, configured)).toEqual({ rule: configured, source: "config" });
    expect(createStartupSelection({ rule: { kind: "all" } }, configured)).toEqual({
      rule: { kind: "all" },
      source: "cli",
    });
    expect(createStartupSelection()).toEqual({ rule: { kind: "all" }, source: "default-all" });
    expect(
      new CurrentClusterSelection(registry(["alpha"]), { rule: { kind: "all" } }, configured)
        .availability.available,
    ).toEqual(["alpha"]);
  });
  it("rejects unknown startup names atomically without fallback", () => {
    expect(
      () =>
        new CurrentClusterSelection(registry(["alpha"]), {
          rule: createExactClusterRule(["alpha", "missing"]),
        }),
    ).toThrow("Unknown startup");
    expect(
      () => new CurrentClusterSelection(registry([]), {}, createExactClusterRule(["missing"])),
    ).toThrow("Unknown startup");
  });
  it("preserves exact identities, including literal wildcard and pattern-like names", () => {
    const names = ["alpha", " alpha ", "*", "prod-*", "Alpha"];
    const selection = new CurrentClusterSelection(registry(names), {
      rule: createExactClusterRule(names),
    });
    expect(selection.availability.available).toEqual([...names].sort());
    expect(parseClusterRule(["*"])).toEqual({ kind: "all" });
  });
  it("canonicalizes and freezes private exact sets; rejects duplicates and invalid bounds", () => {
    const names = ["beta", "alpha"];
    const rule = createExactClusterRule(names);
    names[0] = "changed";
    expect(rule).toEqual({ kind: "exact", contexts: ["alpha", "beta"] });
    expect(Object.isFrozen(rule)).toBe(true);
    if (rule.kind === "exact") expect(Object.isFrozen(rule.contexts)).toBe(true);
    for (const invalid of [
      [],
      ["a", "a"],
      [" "],
      ["x\n"],
      ["é".repeat(513)],
      Array.from({ length: 1025 }, (_, i) => `${i}`),
    ]) {
      expect(() => createExactClusterRule(invalid)).toThrow();
    }
    expect(() =>
      createExactClusterRule(Array.from({ length: 1024 }, (_, i) => `${i}`)),
    ).not.toThrow();
  });
});
