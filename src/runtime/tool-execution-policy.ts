import {
  DEFAULT_RESOURCE_READ_POLICY,
  type ResourceReadPolicy,
} from "../config/resource-policy.js";
import { validateResourceRead } from "../mcp/read-policy.js";

/** Application access and retrieval limits, independent of discovered schema constraints. */
export function allowsMcpToolExecution(
  name: string,
  args: Readonly<Record<string, unknown>>,
  resourcePolicy: ResourceReadPolicy = DEFAULT_RESOURCE_READ_POLICY,
): boolean {
  if (name === "resources_get" || name === "resources_list") {
    validateResourceRead(args, resourcePolicy);
  }
  if (name !== "pods_log" && name !== "nodes_log") {
    return true;
  }
  const tail = name === "nodes_log" ? args.tailLines : args.tail;
  if (
    name === "nodes_log" &&
    (typeof args.query !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(args.query))
  ) {
    return false;
  }
  return (
    typeof tail === "number" &&
    Number.isInteger(tail) &&
    tail >= 1 &&
    args.follow !== true &&
    args.stream !== true &&
    tail <= 1000
  );
}
