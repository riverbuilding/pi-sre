import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? `code ${String(code)}`}.`));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const prepareOnly = args.includes("--prepare-only");
  const manyContexts = args.includes("--many-contexts");
  if (
    args.some((arg) => !["--prepare-only", "--many-contexts"].includes(arg)) ||
    new Set(args).size !== args.length
  ) {
    throw new Error("Usage: npm run manual:clusters -- [--many-contexts] [--prepare-only]");
  }
  await access(join(root, "node_modules", "tsx"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-sre-manual-clusters-"));
  console.log(`Manual test workspace (retained after exit): ${workspace}`);

  // Exercise the npm payload, reusing the checkout's dependencies without installation/network.
  await run(
    "npm",
    ["pack", "--cache", join(workspace, "cache"), "--pack-destination", workspace],
    root,
  );
  const archives = (await readdir(workspace)).filter((name) => name.endsWith(".tgz"));
  const archive = archives[0];
  if (archives.length !== 1 || archive === undefined) throw new Error("Expected one npm archive.");
  await run("tar", ["-xzf", join(workspace, archive), "-C", workspace], root);
  const installed = join(workspace, "package");
  await symlink(join(root, "node_modules"), join(installed, "node_modules"), "dir");

  const appHome = join(workspace, "app");
  await mkdir(appHome, { mode: 0o700 });
  const configPath = join(appHome, "config.yaml");
  const fixture = join(installed, "tests", "fixtures", "fake-mcp-server.ts");
  await access(fixture);
  await writeFile(join(appHome, "kubernetes-mcp.toml"), "read_only = true\n", { mode: 0o600 });
  await writeFile(
    configPath,
    stringify({
      kubernetes: {
        contexts: ["*"],
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            fixture,
            manyContexts ? "diagnostic-many-contexts" : "diagnostic-success",
            join(appHome, "fixture.pid"),
          ],
          configFile: "kubernetes-mcp.toml",
        },
      },
      investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
      safety: { mode: "read-only" },
    }),
    { mode: 0o600 },
  );

  // Override inherited application/MCP settings so this launch always uses the fixture.
  const env = {
    ...process.env,
    PI_SRE_HOME: appHome,
    PI_SRE_CONFIG: configPath,
    PI_SRE_MCP_COMMAND: process.execPath,
  };
  const executable = join(installed, "dist", "main.js");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const launch = [
    "#!/bin/sh",
    `cd ${quote(workspace)} || exit 1`,
    `export PI_SRE_HOME=${quote(appHome)}`,
    `export PI_SRE_CONFIG=${quote(configPath)}`,
    `export PI_SRE_MCP_COMMAND=${quote(process.execPath)}`,
    `exec ${quote(process.execPath)} ${quote(executable)} "$@"`,
    "",
  ].join("\n");
  const launcher = join(workspace, "launch.sh");
  await writeFile(launcher, launch, { mode: 0o700 });
  console.log(`\nRelaunch: ${quote(launcher)}`);
  console.log(`Config: ${configPath}`);
  console.log(`Fixture MCP call log: ${join(appHome, "fixture.pid.calls")}`);
  console.log(
    manyContexts
      ? "Fixture: 45 contexts (context-001 through context-045).\n" +
          "Run /clusters --status: expect three pages with 20, 20, and 5 names.\n" +
          "Try Next page, Previous page, select a name to inspect it, then Escape or Close status.\n" +
          "Run /clusters context-001, then /clusters --status to inspect outside-selection labels.\n" +
          "Run /clusters --all to restore live all. No model login or Kubernetes access is needed.\n"
      : "Try /clusters --status, /clusters (toggle alpha/beta, Apply or Cancel),\n" +
          "/clusters alpha, /clusters beta, /clusters --all, and /mcp_restart --force.\n" +
          "Every diagnostic call must supply one exact selected context.\n" +
          "For Phase 4: /clusters alpha, /incident new Inspect alpha, /clusters beta,\n" +
          "/incident (current alpha / next beta), /evidence, then /incident new Inspect beta.\n" +
          "Repeat at normal/narrow widths; see docs/PHASE4_ACCEPTANCE.md for the visual gate.\n" +
          "No model login is needed for these commands. Use /login for model-driven fixture queries.\n",
  );
  if (!prepareOnly) await run(process.execPath, [executable], workspace, env);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
