import { writeFile } from "node:fs/promises";

import { capturePhase5Server } from "../tests/fixtures/phase5-server/probe.js";

const executable = process.env.PI_SRE_CONTRACT_SERVER;
if (!executable) {
  throw new Error("Set PI_SRE_CONTRACT_SERVER to the selected Kubernetes MCP Server executable.");
}

const capture = await capturePhase5Server(executable);
if (capture.serverVersion !== "0.0.67") {
  throw new Error(
    "Phase 5 Slice 0 selects server 0.0.67; review contracts before changing version.",
  );
}
await writeFile(
  new URL("../tests/fixtures/phase5-server-0.0.67.json", import.meta.url),
  `${JSON.stringify(capture, null, 2)}\n`,
);
