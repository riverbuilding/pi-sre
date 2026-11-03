import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CurrentClusterSelection } from "../cluster/current-selection.js";
import { pickClusterRule } from "./cluster-picker.js";

/** Staged migration picker: active work never prevents selecting future calls. */
export async function pickCurrentClusters(
  ui: Pick<ExtensionUIContext, "select">,
  selection: CurrentClusterSelection,
): Promise<void> {
  const draft = selection.captureDraft();
  const rule = await pickClusterRule(
    ui,
    selection.inventory.contexts.map((entry) => entry.name),
    draft.rule,
    draft.assertCurrent,
  );
  draft.assertCurrent();
  if (rule) selection.select(rule);
}
