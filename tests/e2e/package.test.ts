import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
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
    const { stdout, stderr } = await run(process.execPath, [executable, "--help"], {
      cwd: home,
      env: { ...process.env, PI_SRE_HOME: join(home, "app") },
      timeout: 10_000,
    });
    expect(stdout).toContain("Pi SRE — read-only Kubernetes incident diagnosis");
    expect(stdout).toContain("/mcp_restart");
    expect(stderr).toBe("");
    expect(
      await readFile(join(installed, "config", "kubernetes-mcp.example.toml"), "utf8"),
    ).toContain("read_only = true");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
