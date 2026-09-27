import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Electron used by the checkout: an explicit override (ELECTRON_EXE, or
 * ELECTRON_PATH as the desktop launcher has always accepted), else the
 * repository's node_modules/electron.
 */
export function resolveElectronExecutable(
  repoRoot,
  explicitPath = process.env.ELECTRON_EXE || process.env.ELECTRON_PATH,
  exists = existsSync,
) {
  const override = typeof explicitPath === "string" ? explicitPath.trim() : "";
  if (override) {
    if (!exists(override)) {
      throw new Error(`Electron override (ELECTRON_EXE/ELECTRON_PATH) not found: ${override}`);
    }
    return override;
  }
  const repoElectron = join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (exists(repoElectron)) return repoElectron;
  throw new Error(
    `Electron runtime not found at ${repoElectron}. Run npm install, or set ELECTRON_EXE to a valid electron.exe.`,
  );
}
