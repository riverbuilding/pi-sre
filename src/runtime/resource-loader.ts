import {
  DefaultResourceLoader,
  type createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import { createSreSystemPrompt } from "./system-prompt.js";

type ResourceLoaderOptions = NonNullable<
  Parameters<typeof createAgentSessionServices>[0]["resourceLoaderOptions"]
>;
type LoaderConstructionOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Shared V0.1 resource policy for Pi's service factory and standalone loader tests. */
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

/**
 * Construct Pi's loader with the V0.1 SRE resource boundary.
 * Loaded now: the code-owned SRE system prompt. The runtime separately adds its
 * own inline shell guard extension.
 * Excluded: project/global context files, extensions, prompt templates, themes,
 * appended prompts, and Pi-discovered skills.
 * Planned for Phase 4: explicitly owned SRE diagnostic skills, without enabling
 * project/global skill discovery.
 */
export function createSreResourceLoader(
  options: Pick<LoaderConstructionOptions, "cwd" | "agentDir" | "settingsManager">,
): DefaultResourceLoader {
  return new DefaultResourceLoader({ ...createSreResourceLoaderOptions(), ...options });
}
