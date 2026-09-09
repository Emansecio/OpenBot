const REDACTED_TEMP_PATH = "<redacted-temp-path>";

export function sanitizeBenchmarkError(message) {
  const workspaceRoot = process.cwd();
  const temporaryRoot = process.env.TEMP ?? process.env.TMP ?? "";
  let sanitized = String(message)
    .replaceAll(workspaceRoot, "<workspace>");
  if (temporaryRoot.length > 0) sanitized = sanitized.replaceAll(temporaryRoot, "<temp>");
  return sanitized.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:tmp|var|home|Users|workspace)\/)[^\s"'<>]+/gu, "<path>");
}

/**
 * Durable evidence is part of the benchmark gate, not merely diagnostic output.
 * A green benchmark must prove that the long stream used SQLite and survived a
 * close/reopen cycle without exposing the temporary path.
 */
export function longStreamGate(longStream) {
  return longStream?.storeKind === "sqlite"
    && longStream.databasePath === REDACTED_TEMP_PATH
    && Number.isFinite(longStream.databaseBytes)
    && longStream.databaseBytes > 0
    && longStream.persistenceVerified === true
    && Number.isFinite(longStream.ttftMs)
    && longStream.ttftMs >= 0;
}
