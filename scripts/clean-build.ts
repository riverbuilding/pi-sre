import { rm } from "node:fs/promises";

// tsc does not remove output for deleted sources; never ship retired tool paths.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
