import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { ClusterScopeRule } from "../cluster/context-resolver.js";
import { ClusterPickerError, pickClusterRule } from "./cluster-picker.js";

/** One mounted dialog keeps keyboard focus while draft rows change. */
export class ClusterPickerDialog implements Component {
  private title = "Clusters";
  private options: readonly string[] = [];
  private focusedIndex = 0;
  private pending: ((choice: string | undefined) => void) | undefined;
  private readonly theme: Pick<Theme, "fg" | "bg" | "bold">;
  private readonly requestRender: () => void;
  private readonly terminalRows: () => number;

  constructor(
    theme: Pick<Theme, "fg" | "bg" | "bold">,
    requestRender: () => void,
    terminalRows: () => number,
  ) {
    this.theme = theme;
    this.requestRender = requestRender;
    this.terminalRows = terminalRows;
  }

  select(title: string, options: string[]): Promise<string | undefined> {
    this.title = title;
    this.options = options;
    this.focusedIndex = Math.min(this.focusedIndex, options.length - 1);
    const choice = new Promise<string | undefined>((resolve) => {
      this.pending = resolve;
    });
    this.requestRender();
    return choice;
  }

  handleInput(data: string): void {
    if (!this.pending) return;
    const actionStart = this.options.length - 2;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve(undefined);
    } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve(this.options[this.focusedIndex]);
    } else if (matchesKey(data, "tab")) {
      this.focusedIndex =
        this.focusedIndex < actionStart
          ? actionStart
          : (this.focusedIndex + 1) % this.options.length;
    } else if (matchesKey(data, "shift+tab")) {
      this.focusedIndex =
        this.focusedIndex >= actionStart ? actionStart - 1 : this.options.length - 1;
    } else if (matchesKey(data, "down")) {
      this.focusedIndex = (this.focusedIndex + 1) % this.options.length;
    } else if (matchesKey(data, "up")) {
      this.focusedIndex = (this.focusedIndex - 1 + this.options.length) % this.options.length;
    } else if (
      this.focusedIndex >= actionStart &&
      (matchesKey(data, "left") || matchesKey(data, "right"))
    ) {
      this.focusedIndex = this.focusedIndex === actionStart ? actionStart + 1 : actionStart;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this;
    const rows = this.options.slice(0, -2);
    const maxVisible = Math.max(1, this.terminalRows() - 10);
    const rowFocus = Math.min(this.focusedIndex, rows.length - 1);
    const start = Math.max(0, Math.min(rowFocus - maxVisible + 1, rows.length - maxVisible));
    const lines = ["", theme.fg("accent", theme.bold(this.title)), ""];
    for (let index = start; index < Math.min(rows.length, start + maxVisible); index++) {
      const label = rows[index] ?? "";
      lines.push(this.focusedIndex === index ? theme.fg("accent", `› ${label}`) : `  ${label}`);
    }
    if (rows.length > maxVisible) {
      lines.push(
        theme.fg(
          "dim",
          `  ${start + 1}–${Math.min(rows.length, start + maxVisible)} of ${rows.length}`,
        ),
      );
    }
    lines.push("");
    const buttons = this.options.slice(-2).map((label, index) => {
      const text = `[ ${label} ]`;
      return this.focusedIndex === rows.length + index
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(text)))
        : theme.fg("muted", text);
    });
    if (visibleWidth(buttons.join("  ")) + 2 <= width) lines.push(`  ${buttons.join("  ")}`);
    else lines.push(...buttons.map((button) => `  ${button}`));
    lines.push("", theme.fg("dim", "↑↓ move · Space/Enter toggle · Tab buttons · Esc cancel"), "");
    return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {}

  dispose(): void {
    this.pending?.(undefined);
    this.pending = undefined;
  }
}

export async function showClusterPicker(
  ui: Pick<ExtensionUIContext, "custom">,
  names: readonly string[],
  initialRule: ClusterScopeRule,
  assertCurrent: () => void,
): Promise<ClusterScopeRule | undefined> {
  type Outcome = { readonly rule: ClusterScopeRule | undefined } | { readonly error: unknown };
  let outcome: Outcome;
  try {
    outcome = await ui.custom<Outcome>((tui, theme, _keybindings, done) => {
      const dialog = new ClusterPickerDialog(
        theme,
        () => tui.requestRender(),
        () => tui.terminal.rows,
      );
      // The draft loop updates this component in place; toggles never dismiss the dialog.
      void pickClusterRule(
        { select: (title, options) => dialog.select(title, options) },
        names,
        initialRule,
        assertCurrent,
      ).then(
        (rule) => done({ rule }),
        (error: unknown) => done({ error }),
      );
      return dialog;
    });
  } catch (cause) {
    throw new ClusterPickerError(cause);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.rule;
}
