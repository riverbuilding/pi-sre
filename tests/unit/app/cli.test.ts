import { describe, expect, it } from "vitest";

import { formatHelp, parseCliArgs } from "../../../src/app/cli.js";

describe("Pi SRE CLI", () => {
  it("starts the app when called without arguments", () => {
    expect(parseCliArgs([])).toEqual({ help: false });
  });

  it.each(["--help", "-h"])("accepts %s without loading configuration", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ help: true });
  });

  it.each([["--clusters", "production"], ["--clusters=production"]])(
    "accepts exact context selection %j",
    (...args) => {
      expect(parseCliArgs(args)).toEqual({
        help: false,
        rule: { kind: "exact", contexts: ["production"] },
      });
    },
  );

  it("preserves opaque context identity", () => {
    expect(parseCliArgs(["--clusters", " production "])).toEqual({
      help: false,
      rule: { kind: "exact", contexts: [" production "] },
    });
    expect(parseCliArgs(["--clusters=-production"])).toEqual({
      help: false,
      rule: { kind: "exact", contexts: ["-production"] },
    });
  });

  it.each([
    ["--clusters"],
    ["--clusters="],
    ["--clusters", ""],
    ["--clusters", "   "],
    ["--clusters", "--help"],
    ["--clusters=alpha\n"],
    ["--clusters=alpha\u202e"],
    [`--clusters=${"é".repeat(513)}`],
  ])("rejects missing or invalid selection %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow("--clusters requires");
  });

  it.each([
    ["--clusters", "alpha", "--clusters=beta"],
    ["--clusters=alpha", "--clusters", "alpha"],
  ])("rejects duplicate selection %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow("Duplicate --clusters");
  });

  it.each([["--unknown"], ["alpha"], ["--help", "--unknown"], ["--clusters=alpha", "extra"]])(
    "rejects unknown arguments %j",
    (...args) => {
      expect(() => parseCliArgs(args)).toThrow("Unknown argument");
    },
  );

  it.each([
    ["--clusters=alpha", "--help"],
    ["-h", "--clusters", "alpha"],
  ])("returns help with a valid selection %j", (...args) => {
    expect(parseCliArgs(args)).toEqual({ help: true });
  });

  it("validates missing values even when help is requested", () => {
    expect(() => parseCliArgs(["--help", "--clusters"])).toThrow("--clusters requires");
  });

  it("accepts sets and sole wildcard with canonical immutable identities", () => {
    expect(parseCliArgs(["--clusters", "beta", "alpha"])).toEqual({
      help: false,
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
    });
    for (const args of [["--clusters", "*"], ["--clusters=*"]])
      expect(parseCliArgs(args)).toEqual({ help: false, rule: { kind: "all" } });
    expect(parseCliArgs(["--clusters", "prod-*"])).toMatchObject({
      rule: { kind: "exact", contexts: ["prod-*"] },
    });
  });

  it.each([
    ["--clusters", "a", "a"],
    ["--clusters", "a", "*"],
    ["--clusters", "*", "a"],
    ["--cluster", "a"],
    ["--all-clusters"],
    ["--clusters", ...Array.from({ length: 1025 }, (_, i) => `${i}`)],
  ])("refuses duplicate, conflicting and legacy selections", (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });

  it("documents the single application home and configuration lookup", () => {
    expect(formatHelp()).toContain("~/.pi-sre");
    expect(formatHelp()).toContain("PI_SRE_CONFIG");
    expect(formatHelp()).toContain("kubernetes.mcp.configFile");
    expect(formatHelp()).toContain("--clusters=<name>");
    expect(formatHelp()).toContain("Unknown selections never fall back");
  });
});
