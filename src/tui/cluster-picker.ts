import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createExactClusterRule, type ClusterScopeRule } from "../cluster/context-resolver.js";

export class ClusterPickerError extends Error {
  constructor(cause?: unknown) {
    super("Clusters picker failed; no selection applied. Retry /clusters.", { cause });
  }
}

/** Pi provides a single-row picker; toggles stage a set until Apply commits it. */
export async function pickClusterRule(
  ui: Pick<ExtensionUIContext, "select">,
  availableNames: readonly string[],
  initialRule: ClusterScopeRule,
  assertCurrent: () => void,
): Promise<ClusterScopeRule | undefined> {
  let all = initialRule.kind === "all";
  const selectedNames = new Set(initialRule.kind === "exact" ? initialRule.contexts : []);
  const available = new Set(availableNames);
  const names = [...new Set([...availableNames, ...selectedNames])].sort();
  while (true) {
    assertCurrent();
    const contextRows = names.map(
      (name) =>
        `[${all || selectedNames.has(name) ? "x" : " "}] ${JSON.stringify(name)}${available.has(name) ? "" : " (unavailable)"}`,
    );
    const actions = ["All (*)", "Apply selection", "Cancel"];
    let choice: string | undefined;
    try {
      choice = await ui.select(
        `Clusters — ${all ? "All (*)" : `${selectedNames.size} selected`} (toggle names, then Apply)`,
        [...actions, ...contextRows],
      );
    } catch (cause) {
      throw new ClusterPickerError(cause);
    }
    assertCurrent();
    if (choice === undefined || choice === "Cancel") return undefined;
    if (choice === "All (*)") {
      all = true;
      selectedNames.clear();
    } else if (choice === "Apply selection") {
      if (all) return { kind: "all" };
      if (selectedNames.size) return createExactClusterRule([...selectedNames]);
      // An empty draft cannot replace the current rule.
    } else {
      const name = names[contextRows.indexOf(choice)];
      if (name === undefined) throw new ClusterPickerError();
      if (all) {
        all = false;
        selectedNames.clear();
      }
      if (selectedNames.has(name)) selectedNames.delete(name);
      else selectedNames.add(name);
    }
  }
}
