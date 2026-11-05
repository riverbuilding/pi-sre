import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify } from "yaml";
import { startOfflineModelServer } from "../tests/fixtures/offline-model-server.js";

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
  const offlineModel = args.includes("--offline-model");
  if (
    args.some((arg) => !["--prepare-only", "--many-contexts", "--offline-model"].includes(arg)) ||
    (offlineModel && prepareOnly) ||
    new Set(args).size !== args.length
  ) {
    throw new Error(
      "Usage: npm run manual:clusters -- [--many-contexts] [--prepare-only | --offline-model]",
    );
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
            manyContexts
              ? "diagnostic-many-contexts"
              : offlineModel
                ? "diagnostic-manual-delayed"
                : "diagnostic-success",
            join(appHome, "fixture.pid"),
          ],
          configFile: "kubernetes-mcp.toml",
        },
      },
      execution: { maxToolCalls: 40, maxModelIterations: 80 },
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
  console.log(
    `\n${offlineModel ? "Launcher (local model available only during this run)" : "Relaunch"}: ${quote(launcher)}`,
  );
  console.log(`Config: ${configPath}`);
  console.log(`Fixture MCP call log: ${join(appHome, "fixture.pid.calls")}`);
  console.log(
    manyContexts
      ? "Fixture: 45 contexts (context-001 through context-045).\n" +
          "Run /clusters --status to inspect complete current membership.\n" +
          "Run /clusters context-001, then /clusters --all.\n"
      : "Try /clusters --status, /clusters (toggle alpha/beta, Apply or Cancel),\n" +
          "/clusters alpha, /clusters beta, /clusters --all, and /mcp_restart --force.\n" +
          "Selection affects newly accepted calls, including during active work.\n" +
          "Each diagnostic call must supply one exact available context.\n" +
          (offlineModel
            ? "Local model requires no login.\n"
            : "No model login is needed for commands. Use /login for fixture queries.\n"),
  );
  if (offlineModel) {
    const model = await startOfflineModelServer();
    try {
      await writeFile(
        join(appHome, "models.json"),
        JSON.stringify({
          providers: {
            "offline-fixture": {
              baseUrl: model.baseUrl,
              api: "openai-completions",
              apiKey: "offline-fixture",
              models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1000 }],
            },
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(appHome, "settings.json"),
        JSON.stringify({ defaultProvider: "offline-fixture", defaultModel: "fixture" }),
        { mode: 0o600 },
      );
      console.log(
        "Local deterministic model enabled. Try compare alpha beta, inspect beta, or Escape during a query. No model login required.",
      );
      await run(process.execPath, [executable], workspace, env);
    } finally {
      await model.close();
    }
  } else if (!prepareOnly) {
    await run(process.execPath, [executable], workspace, env);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
