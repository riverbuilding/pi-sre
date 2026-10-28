import type { EffectiveInvestigationScope } from "../app/investigation-controller.js";
import type { DiagnosticExecution } from "../investigation/investigation-service.js";
import type { McpToolScope, ToolNameMapping } from "./tool-bridge.js";
import type { NormalizedMcpResult } from "./result-normalizer.js";

export interface ObservationProvenance extends DiagnosticExecution {
  readonly completedAt: string;
  readonly scope: McpToolScope & { readonly scopeRevision: number };
}

export function observationProvenance(
  scope: EffectiveInvestigationScope,
  execution: DiagnosticExecution,
  context: string,
  namespace: string | undefined,
  completedAt: string,
): ObservationProvenance {
  return {
    ...execution,
    completedAt,
    scope: {
      context,
      ...(namespace !== undefined ? { namespace } : {}),
      namespacePolicy: "unrestricted",
      readOnly: true,
      scopeRevision: scope.scopeRevision,
      selectionRevision: scope.selectionRevision,
      inventoryRevision: scope.inventoryRevision,
      connectionGeneration: scope.connectionGeneration,
    },
  };
}

/** Budget the serialized public envelope, retaining whole identities and exactly this excerpt. */
export function presentObservation(
  observation: NormalizedMcpResult,
  provenance: ObservationProvenance,
  mapping: ToolNameMapping,
  maxChars: number,
) {
  const build = (excerpt: string, truncated: boolean) => ({
    content: [
      {
        type: "text" as const,
        text: `Evidence: ${JSON.stringify(provenance.evidenceId)}; context=${JSON.stringify(provenance.scope.context)}; namespace=${provenance.scope.namespace === undefined ? "server/context policy (not asserted)" : JSON.stringify(provenance.scope.namespace)}; READ ONLY\n${excerpt}`,
      },
    ],
    details: { tool: mapping, status: "success" as const, truncated, ...provenance },
    isError: false,
  });
  const fits = (excerpt: string, truncated: boolean) =>
    JSON.stringify(build(excerpt, truncated)).length <= maxChars;
  if (!fits("", true)) return undefined;
  if (fits(observation.text, observation.truncated))
    return { excerpt: observation.text, result: build(observation.text, observation.truncated) };
  const notice = "\n[Result truncated]";
  if (!fits(notice, true)) return undefined;
  let low = 0;
  let high = observation.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(observation.text.slice(0, mid) + notice, true)) low = mid;
    else high = mid - 1;
  }
  // Do not split a UTF-16 surrogate pair at the retained boundary.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(observation.text[low - 1]!)) low--;
  const excerpt = observation.text.slice(0, low) + notice;
  return { excerpt, result: build(excerpt, true) };
}
