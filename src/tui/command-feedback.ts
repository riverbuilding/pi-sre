import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Presentation only; one instance belongs to a Pi session, including extension reloads. */
export class CommandFeedback {
  private invocation = 0;

  begin(
    command: string,
    ui: ExtensionUIContext,
  ): (message: string, type?: "info" | "warning" | "error") => void {
    const number = ++this.invocation;
    return (message, type = "info") => {
      const now = new Date();
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
      ui.notify(`[${time} #${number}] ${command}: ${message}`, type);
    };
  }
}
