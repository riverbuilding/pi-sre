import type { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

import { createSreSystemPrompt } from "./system-prompt.js";

type ResourceLoaderOptions = NonNullable<
  Parameters<typeof createAgentSessionServices>[0]["resourceLoaderOptions"]
>;

/** V0.1 resource policy for Pi's service factory. */
export function createSreResourceLoaderOptions(): ResourceLoaderOptions {
  return {
    // Loaded now: the Pi SRE prompt is supplied in code, so project or agent-home
    // SYSTEM.md files cannot replace it. The runtime separately adds its own inline shell guard.
    systemPrompt: createSreSystemPrompt(),

    // Never load arbitrary project or Pi-style agent-home resources into Pi SRE.
    // noExtensions still permits explicitly registered SRE inline extensionFactories.
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [],

    // Planned for V0.1 Phase 4: explicitly owned Kubernetes diagnostic skills.
    // Keep Pi's project/global skill discovery off until that loading path exists.
    noSkills: true,
  };
}
