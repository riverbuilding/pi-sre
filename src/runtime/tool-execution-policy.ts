/** Application retrieval limits, independent of discovered MCP argument constraints. */
export function allowsMcpToolExecution(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (name !== "pods_log") return true;
  return (
    typeof args.tail === "number" &&
    Number.isInteger(args.tail) &&
    args.tail >= 1 &&
    args.follow !== true &&
    args.stream !== true &&
    args.tail <= 1000
  );
}
