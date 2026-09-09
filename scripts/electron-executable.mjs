import { existsSync } from "node:fs";
import { join } from "node:path";

export const HERMES_ELECTRON_EXE = "C:\\Users\\User\\AppData\\Local\\hermes\\hermes-agent\\apps\\desktop\\node_modules\\electron\\dist\\electron.exe";

export function resolveElectronExecutable(
  repoRoot,
  explicitPath = process.env.ELECTRON_EXE,
  exists = existsSync,
) {
  const override = typeof explicitPath === "string" ? explicitPath.trim() : "";
  if (override) {
    if (!exists(override)) {
      throw new Error(`ELECTRON_EXE override not found: ${override}`);
    }
    return override;
  }
  const repoElectron = join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (exists(repoElectron)) return repoElectron;
  if (exists(HERMES_ELECTRON_EXE)) return HERMES_ELECTRON_EXE;
  throw new Error(
    `Electron runtime not found. Checked ${repoElectron} and ${HERMES_ELECTRON_EXE}. Set ELECTRON_EXE to a valid electron.exe.`,
  );
}
