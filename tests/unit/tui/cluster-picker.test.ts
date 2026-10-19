import { describe, expect, it, vi } from "vitest";
import { createExactClusterRule } from "../../../src/cluster/context-resolver.js";
import { pickClusterRule } from "../../../src/tui/cluster-picker.js";

// Exercise draft behavior independently of Pi's terminal renderer.
describe("clusters selection draft", () => {
  it("stages multiple exact names and returns the full set only on Apply", async () => {
    const first = Promise.withResolvers<string | undefined>();
    const select = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('[ ] "alpha"')
      .mockResolvedValueOnce("Apply selection");
    const initial = Object.freeze({ kind: "all" as const });
    const pending = pickClusterRule({ select }, ["alpha", "beta"], initial, () => {});
    first.resolve('[x] "beta"');
    expect(await pending).toEqual({ kind: "exact", contexts: ["alpha", "beta"] });
    expect(initial).toEqual({ kind: "all" });
  });

  it("All selects the live rule rather than a snapshot of current names", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("All (*)")
      .mockResolvedValueOnce("Apply selection");
    expect(
      await pickClusterRule(
        { select },
        ["alpha", "beta"],
        createExactClusterRule(["alpha"]),
        () => {},
      ),
    ).toEqual({ kind: "all" });
  });

  it.each([undefined, "Cancel"])("discards toggled drafts on %s", async (cancel) => {
    const select = vi.fn().mockResolvedValueOnce('[x] "alpha"').mockResolvedValueOnce(cancel);
    expect(await pickClusterRule({ select }, ["alpha"], { kind: "all" }, () => {})).toBeUndefined();
  });

  it("cannot apply an empty exact draft", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce('[x] "alpha"')
      .mockResolvedValueOnce("Apply selection")
      .mockResolvedValueOnce("Cancel");
    expect(
      await pickClusterRule({ select }, ["alpha"], createExactClusterRule(["alpha"]), () => {}),
    ).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("keeps action labels and literal wildcard identities separate from context names", async () => {
    const names = ["*", "All (*)", "Apply selection", "Cancel", " spaced "];
    const select = vi
      .fn()
      .mockResolvedValueOnce('[x] "*"')
      .mockResolvedValueOnce('[ ] "All (*)"')
      .mockResolvedValueOnce("Apply selection");
    expect(await pickClusterRule({ select }, names, { kind: "all" }, () => {})).toEqual({
      kind: "exact",
      contexts: ["*", "All (*)"],
    });
  });

  it("lets users remove an unavailable exact member", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce('[x] "beta" (unavailable)')
      .mockResolvedValueOnce("Apply selection");
    expect(
      await pickClusterRule(
        { select },
        ["alpha"],
        createExactClusterRule(["alpha", "beta"]),
        () => {},
      ),
    ).toEqual({ kind: "exact", contexts: ["alpha"] });
  });

  it("rechecks authority after each awaited choice", async () => {
    const choice = Promise.withResolvers<string | undefined>();
    const select = vi.fn(() => choice.promise);
    let current = true;
    const pending = pickClusterRule({ select }, ["alpha"], { kind: "all" }, () => {
      if (!current) throw new Error("Selection invalidated");
    });
    current = false;
    choice.resolve("Apply selection");
    await expect(pending).rejects.toThrow("Selection invalidated");
  });

  it("withholds raw UI failure text", async () => {
    const select = vi.fn().mockRejectedValue(new Error("PRIVATE_FIXTURE"));
    await expect(pickClusterRule({ select }, ["alpha"], { kind: "all" }, () => {})).rejects.toThrow(
      "Clusters picker failed",
    );
  });
});
