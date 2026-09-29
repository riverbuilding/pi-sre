import { describe, expect, it } from "vitest";

import { formatHelp, parseCliArgs } from "../../../src/app/cli.js";

describe("Pi SRE CLI", () => {
  it("starts the app when called without arguments", () => {
    expect(parseCliArgs([])).toEqual({ help: false });
  });

  it.each(["--help", "-h"])("accepts %s without loading configuration", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ help: true });
  });

  it("rejects unknown arguments rather than silently ignoring them", () => {
    expect(() => parseCliArgs(["--cluster", "production"])).toThrow("Unknown argument: --cluster");
  });

  it("documents the single application home and configuration lookup", () => {
    expect(formatHelp()).toContain("~/.pi-sre");
    expect(formatHelp()).toContain("PI_SRE_CONFIG");
    expect(formatHelp()).toContain("kubernetes.mcp.configFile");
  });
});
