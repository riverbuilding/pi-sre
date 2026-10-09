#!/usr/bin/env node

import { SreApplication } from "./app/application.js";
import { formatHelp, parseCliArgs } from "./app/cli.js";
import { loadSreConfig } from "./config/loader.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(formatHelp());
    return;
  }

  const config = await loadSreConfig();
  await new SreApplication(config, args).run();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
