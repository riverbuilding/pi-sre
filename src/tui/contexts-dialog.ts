import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { ClusterContextState } from "../cluster/context-manager.js";

/** Inspect a captured scope without granting permission or changing the selection draft. */
export async function showContextsDialog(
  ui: Pick<ExtensionUIContext, "select" | "notify">,
  state: ClusterContextState,
  isCurrent: () => boolean,
): Promise<void> {
  const rule = state.selection.rule;
  const names = [
    ...new Set([
      ...(rule.kind === "exact" ? rule.contexts : []),
      ...(state.inventory?.contexts.map((entry) => entry.name) ?? []),
    ]),
  ].sort();
  if (!names.length) return;
  const rows = names.map((name) => {
    const permitted = rule.kind === "all" || rule.contexts.includes(name);
    const available =
      state.resolution.status === "resolved" &&
      state.resolution.available.some((entry) => entry.name === name);
    const status = !permitted
      ? "outside exact selection"
      : available
        ? "permitted, available; health not checked"
        : state.resolution.status === "blocked"
          ? "in selection; dispatch blocked"
          : "selected, unavailable";
    return `${JSON.stringify(name)} — ${status}${state.resolution.status === "blocked" && state.inventory?.get(name) ? "; last successful inventory" : ""}`;
  });
  const pages = Math.ceil(rows.length / 20);
  let page = 0;
  while (isCurrent()) {
    const start = page * 20;
    const members = rows
      .slice(start, start + 20)
      .map((row, index) => `${start + index + 1}. ${row}`);
    const options = [
      ...members,
      ...(page > 0 ? ["Previous page"] : []),
      ...(page + 1 < pages ? ["Next page"] : []),
      "Close status",
    ];
    const choice = await ui.select(
      `Cluster scope status — page ${page + 1}/${pages}; ${names.length} names; selection ${state.selection.selectionRevision}, inventory ${state.inventoryRevision}, connection ${state.connectionGeneration}`,
      options,
    );
    if (!isCurrent()) {
      ui.notify("Cluster scope changed; reopen /clusters --status for current membership.", "info");
      return;
    }
    if (choice === undefined || choice === "Close status") return;
    if (choice === "Next page" && page + 1 < pages) page++;
    else if (choice === "Previous page" && page > 0) page--;
    else if (members.includes(choice)) ui.notify(choice, "info");
    else return;
  }
}
