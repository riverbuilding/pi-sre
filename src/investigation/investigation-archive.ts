import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { requireDomain } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { InvestigationState } from "../domain/investigation-state.js";

export type InvestigationArchiveRecord =
  | {
      readonly type: "investigation";
      readonly version: 1;
      readonly state: Omit<InvestigationState, "evidence">;
      readonly evidenceCount: number;
    }
  | { readonly type: "evidence"; readonly evidence: Evidence };

/** Publish a complete, private JSONL file without overwriting any existing destination. */
export async function writeInvestigationArchive(
  path: string,
  state: InvestigationState,
): Promise<void> {
  requireDomain(isAbsolute(path), "Investigation archive requires an absolute file path.");
  const temporary = join(dirname(path), `.pi-sre-${randomUUID()}.tmp`);
  const { evidence, ...metadata } = state;
  const records: readonly InvestigationArchiveRecord[] = [
    { type: "investigation", version: 1, state: metadata, evidenceCount: evidence.length },
    ...evidence.map((item): InvestigationArchiveRecord => ({ type: "evidence", evidence: item })),
  ];
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        for (const record of records) await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // Same-directory hard link publishes atomically and refuses existing files/symlinks.
      await link(temporary, path);
    } finally {
      await unlink(temporary);
    }
  } catch (cause) {
    throw new Error(
      `Failed to archive investigation ${state.incident.id}; in-memory state retained.`,
      {
        cause,
      },
    );
  }
}
