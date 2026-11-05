import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CurrentClusterSelection } from "../cluster/current-selection.js";
import { pickClusterRule } from "./cluster-picker.js";

/** Active work never prevents selecting future calls. */
export async function pickCurrentClusters(
  ui: Pick<ExtensionUIContext, "select">,
  selection: CurrentClusterSelection,
  assertUsable: () => void = () => {},
): Promise<void> {
  const draft = selection.captureDraft();
  const assertCurrent = () => {
    assertUsable();
    draft.assertCurrent();
  };
  const rule = await pickClusterRule(
    ui,
    selection.inventory.contexts.map((entry) => entry.name),
    draft.rule,
    assertCurrent,
  );
  assertCurrent();
  if (rule) selection.select(rule);
}
