import { describe, expect, it } from "vitest";

import { formatHelp, parseCliArgs } from "../../../src/app/cli.js";

describe("Pi SRE CLI", () => {
  it("starts the app when called without arguments", () => {
    expect(parseCliArgs([])).toEqual({ help: false });
  });

  it.each(["--help", "-h"])("accepts %s without loading configuration", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ help: true });
  });

  it.each([["--cluster", "production"], ["--cluster=production"]])(
    "accepts exact context selection %j",
    (...args) => {
      expect(parseCliArgs(args)).toEqual({ help: false, cluster: "production" });
    },
  );

  it("preserves opaque context identity", () => {
    expect(parseCliArgs(["--cluster", " production "])).toEqual({
      help: false,
      cluster: " production ",
    });
    expect(parseCliArgs(["--cluster=-production"])).toEqual({
      help: false,
      cluster: "-production",
    });
  });

  it.each([
    ["--cluster"],
    ["--cluster="],
    ["--cluster", ""],
    ["--cluster", "   "],
    ["--cluster", "--help"],
    ["--cluster=alpha\n"],
    ["--cluster=alpha\u202e"],
    [`--cluster=${"é".repeat(513)}`],
  ])("rejects missing or invalid selection %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow("--cluster requires");
  });

  it.each([
    ["--cluster", "alpha", "--cluster=beta"],
    ["--cluster=alpha", "--cluster", "alpha"],
  ])("rejects duplicate selection %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow("Duplicate --cluster");
  });

  it.each([["--unknown"], ["alpha"], ["--help", "--unknown"], ["--cluster=alpha", "extra"]])(
    "rejects unknown arguments %j",
    (...args) => {
      expect(() => parseCliArgs(args)).toThrow("Unknown argument");
    },
  );

  it.each([
    ["--cluster=alpha", "--help"],
    ["-h", "--cluster", "alpha"],
  ])("returns help with a valid selection %j", (...args) => {
    expect(parseCliArgs(args)).toEqual({ help: true });
  });

  it("validates missing values even when help is requested", () => {
    expect(() => parseCliArgs(["--help", "--cluster"])).toThrow("--cluster requires");
  });

  it("documents the single application home and configuration lookup", () => {
    expect(formatHelp()).toContain("~/.pi-sre");
    expect(formatHelp()).toContain("PI_SRE_CONFIG");
    expect(formatHelp()).toContain("kubernetes.mcp.configFile");
    expect(formatHelp()).toContain("--cluster=<name>");
    expect(formatHelp()).toContain("Unknown selections never fall back");
  });
});
