import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { ClusterPickerDialog, showClusterPicker } from "../../../src/tui/cluster-picker-dialog.js";
import { pickClusterRule } from "../../../src/tui/cluster-picker.js";

const theme: Pick<Theme, "fg" | "bg" | "bold"> = {
  fg: (_color, text) => text,
  bg: (_color, text) => `\x1b[44m${text}\x1b[49m`,
  bold: (text) => text,
};

describe("persistent clusters dialog", () => {
  it("keeps focus on the toggled context and places buttons below the choices", async () => {
    const render = vi.fn();
    const dialog = new ClusterPickerDialog(theme, render, () => 24);
    const tui = new TuiMainScreen(new ProcessTerminal());
    tui.setFocus(dialog);
    const pending = pickClusterRule(
      { select: (title, options) => dialog.select(title, options) },
      ["alpha", "beta"],
      { kind: "exact", contexts: ["alpha"] },
      () => {},
    );
    dialog.handleInput("\x1b[B"); // alpha
    dialog.handleInput(" ");
    await Promise.resolve();
    let lines = dialog.render(80).map(stripTerminalSequences);
    expect(lines).toContain('› [ ] "alpha"');
    expect(lines.findIndex((line) => line.includes("[ Apply selection ]"))).toBeGreaterThan(
      lines.findIndex((line) => line.includes('"beta"')),
    );
    dialog.handleInput("\x1b[B"); // beta
    dialog.handleInput("\r");
    await Promise.resolve();
    lines = dialog.render(80).map(stripTerminalSequences);
    expect(lines).toContain('› [x] "beta"');
    dialog.handleInput("\t");
    expect(dialog.render(80).join("\n")).toContain("\x1b[44m[ Apply selection ]");
    dialog.handleInput("\r");
    expect(await pending).toEqual({ kind: "exact", contexts: ["beta"] });
    expect(render).toHaveBeenCalled();
  });

  it("preserves focus when an empty draft cannot apply, and cancels with the button", async () => {
    const dialog = new ClusterPickerDialog(
      theme,
      () => {},
      () => 24,
    );
    const pending = pickClusterRule(
      { select: (title, options) => dialog.select(title, options) },
      ["alpha"],
      { kind: "exact", contexts: ["alpha"] },
      () => {},
    );
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await Promise.resolve();
    dialog.handleInput("\t");
    dialog.handleInput("\r");
    await Promise.resolve();
    expect(dialog.render(80).join("\n")).toContain("\x1b[44m[ Apply selection ]");
    dialog.handleInput("\x1b[C");
    expect(dialog.render(80).join("\n")).toContain("\x1b[44m[ Cancel ]");
    dialog.handleInput("\r");
    expect(await pending).toBeUndefined();
  });

  it.each(["\x1b", "\x03"])("cancels with keyboard input %j", async (key) => {
    const dialog = new ClusterPickerDialog(
      theme,
      () => {},
      () => 24,
    );
    const pending = dialog.select("Clusters", [
      "All (*)",
      '[ ] "alpha"',
      "Apply selection",
      "Cancel",
    ]);
    dialog.handleInput(key);
    expect(await pending).toBeUndefined();
  });

  it("scrolls to the focused context and fits rows/buttons into narrow terminals", async () => {
    const dialog = new ClusterPickerDialog(
      theme,
      () => {},
      () => 14,
    );
    const names = Array.from({ length: 20 }, (_, index) => `context-${index}`);
    const pending = dialog.select("Clusters", ["All (*)", ...names, "Apply selection", "Cancel"]);
    for (let index = 0; index < 15; index++) dialog.handleInput("\x1b[B");
    const lines = dialog.render(26);
    expect(lines.every((line) => visibleWidth(line) <= 26)).toBe(true);
    expect(lines.map(stripTerminalSequences)).toContain("› context-14");
    expect(lines.length).toBeLessThanOrEqual(14);
    expect(lines.map(stripTerminalSequences)).toContain("  [ Apply selection ]");
    expect(lines.map(stripTerminalSequences)).toContain("  [ Cancel ]");
    dialog.dispose();
    expect(await pending).toBeUndefined();
  });

  it("redacts custom UI failures", async () => {
    await expect(
      showClusterPicker(
        {
          custom: async () => {
            throw new Error("PRIVATE_FIXTURE");
          },
        },
        ["alpha"],
        { kind: "all" },
        () => {},
      ),
    ).rejects.toThrow("Clusters picker failed; no selection applied");
  });
});
