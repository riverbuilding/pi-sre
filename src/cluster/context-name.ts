import { Buffer } from "node:buffer";

/** Selection inputs preserve identity, including surrounding spaces. */
export function isValidContextSelection(name: string): boolean {
  return (
    name.trim().length > 0 &&
    Buffer.byteLength(name, "utf8") <= 1_024 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
  );
}
