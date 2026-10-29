/** MCP-focused regressions inspect their transport surface separately from local domain tools. */
export function withoutInvestigationTools(names: readonly string[]): string[] {
  return names.filter(
    (name) =>
      ![
        "investigation_get",
        "evidence_list",
        "evidence_get",
        "hypothesis_upsert",
        "investigation_conclude",
      ].includes(name),
  );
}
