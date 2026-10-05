/** Shared boundary for model-facing text and process diagnostics. No raw logging. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(
      /((?:^|\n)[ \t]*(?:token|password|secret|client-key-data|api[_-]?key):[ \t]*)[|>][-+]?[ \t]*\r?\n(?:[ \t]+[^\n]*(?:\n|$))+/gi,
      "$1[REDACTED]\n",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._~=-]+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED TOKEN]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED KEY]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /(["']?(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|api[_-]?key|credential|client[_-]?key[_-]?data|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)["']?\s*[:=]\s*)(\[REDACTED(?: AUTHORIZATION| PRIVATE KEY| TOKEN| KEY)?\]|"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}]+)/gi,
      (_match, prefix: string, secret: string) =>
        `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"}`,
    );
}

export function isSensitiveKey(key: string): boolean {
  return /^(?:authorization|.*token|password|passwd|secret|.*apikey|credential|clientkeydata|clientsecret|awssecretaccesskey|kubeconfig|privatekey)$/i.test(
    key.replace(/[-_]/g, ""),
  );
}
