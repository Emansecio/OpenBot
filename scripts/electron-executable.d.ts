export const HERMES_ELECTRON_EXE: string;
export function resolveElectronExecutable(
  repoRoot: string,
  explicitPath?: string,
  exists?: (path: string) => boolean,
): string;
