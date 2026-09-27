/**
 * Text hygiene for content placed in the model context: secret redaction and
 * neutralization of OpenBot's own block markers.
 */

export const SECRET_REDACTION = "[REDACTED_SECRET]";

/** Masks private keys, JWTs, provider/API keys, bearer tokens and key=value credentials. */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)(?:[\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/gu,
      `$1${SECRET_REDACTION}$2`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, SECRET_REDACTION)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, SECRET_REDACTION)
    .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/gu, SECRET_REDACTION)
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/gu, SECRET_REDACTION)
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, SECRET_REDACTION)
    .replace(/(\bAuthorization\b\s*:\s*Bearer\s+)([^\s,"';]+)/giu, `$1${SECRET_REDACTION}`)
    .replace(/(\bBearer\s+)([^\s,"';]+)/giu, `$1${SECRET_REDACTION}`)
    .replace(
      /(\b(?:api(?:[_ -]?(?:key|token))|token|password|passwd|pwd|cookie|authorization)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1${SECRET_REDACTION}`,
    )
    .replace(
      /(\b(?:api(?:[_ -]?(?:key|token))|token|password|passwd|pwd|cookie|authorization)\b"\s*:\s*)(?:"[^"]*"|[^,\]}]+)/giu,
      `$1"${SECRET_REDACTION}"`,
    );
}

/**
 * Content from users, files, tools, memories or other conversations must not
 * be able to open or close an OpenBot context block ("[[OPENBOT_…]]") or be
 * classified as one. A word joiner between the brackets keeps the text
 * readable while no marker comparison can match it.
 */
export function neutralizeContextMarkers(text: string): string {
  return text.includes("[[OPENBOT_") ? text.replaceAll("[[OPENBOT_", "[⁠[OPENBOT_") : text;
}
