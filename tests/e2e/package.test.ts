import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

it("packs a built executable that launches outside the source checkout", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-sre-package-"));
  try {
    // prepack must build the executable, including in a clean checkout.
    await run("npm", ["pack", "--cache", join(home, "cache"), "--pack-destination", home], {
      cwd: root,
      timeout: 30_000,
    });
    const archives = (await readdir(home)).filter((name) => name.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archive = archives[0];
    if (!archive) throw new Error("Expected npm package archive");
    await run("tar", ["-xzf", join(home, archive), "-C", home]);
    const installed = join(home, "package");
    // Reuse locked dependencies without network access or a second installation.
    // Application code is loaded exclusively from the extracted npm payload.
    await symlink(join(root, "node_modules"), join(installed, "node_modules"), "dir");
    const executable = join(installed, "dist", "main.js");
    expect(await readFile(executable, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
    const appHome = join(home, "app");
    const options = {
      cwd: home,
      env: {
        ...process.env,
        PI_SRE_HOME: appHome,
        PI_SRE_CONFIG: join(home, "missing.yaml"),
        PI_SRE_MCP_COMMAND: join(home, "missing-mcp-server"),
      },
      timeout: 10_000,
    };
    for (const args of [
      ["--help"],
      ["--clusters", "alpha", "beta", "--help"],
      ["-h", "--clusters=alpha"],
      ["--clusters", "*", "--help"],
      ["--clusters=*", "--help"],
      ["--clusters", "context with spaces", "beta", "--help"],
    ]) {
      const { stdout, stderr } = await run(process.execPath, [executable, ...args], options);
      expect(stdout).toContain("Pi SRE — read-only Kubernetes incident diagnosis");
      expect(stdout).toContain("/mcp_restart");
      expect(stdout).toContain("--clusters=<name>");
      expect(stdout).toContain("--clusters > kubernetes.contexts > live all (*)");
      expect(stdout).toContain("/clusters --status");
      expect(stdout).toContain("/incident new <question>");
      expect(stdout).toContain("/evidence [<id> | --cursor <cursor>]");
      expect(stdout).toContain("selection changes apply to the next incident");
      expect(stdout).toContain("lost on process exit");
      expect(stdout).not.toMatch(/--cluster(?:[ =]|$)/m);
      expect(stdout).toContain("Unknown selections never fall back");
      expect(stderr).toBe("");
    }
    for (const [args, message] of [
      [["--clusters="], "--clusters requires"],
      [["--help", "--clusters"], "--clusters requires"],
      [["--clusters", "--help"], "--clusters requires"],
      [["--clusters", "   "], "--clusters requires"],
      [["--clusters=alpha\n"], "--clusters requires"],
      [["--clusters=alpha", "--clusters", "beta"], "Duplicate --clusters"],
      [["--help", "--unknown"], "Unknown argument"],
      [["--cluster", "alpha"], "Unknown argument"],
      [["--all-clusters"], "Unknown argument"],
      [["--clusters=alpha", "beta"], "Unknown argument"],
      [["--clusters", "alpha", "alpha"], "--clusters requires"],
      [["--clusters", "alpha", "*"], "must be the sole"],
    ] as const) {
      await expect(run(process.execPath, [executable, ...args], options)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining(message),
      });
    }
    await expect(access(appHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(installed, "config", "kubernetes-mcp.example.toml"), "utf8"),
    ).toContain("read_only = true");
    for (const module of [
      "app/investigation-controller.js",
      "domain/incident.js",
      "investigation/evidence-store.js",
      "runtime/investigation-lifecycle.js",
      "runtime/investigation-tools.js",
      "mcp/incident-diagnostic.js",
    ]) {
      await access(join(installed, "dist", module));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
