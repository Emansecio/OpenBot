import { join } from "node:path";

/**
 * Absolute path of a Windows system tool (`whoami.exe`, `icacls.exe`,
 * `taskkill.exe`, ...). Resolving by bare name follows PATH, where shells such
 * as Git Bash put their own `whoami`/`find` ahead of System32 with different
 * command-line syntax.
 */
export function systemToolPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", name);
}

/** Windows PowerShell 5.1, which ships with every supported Windows. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return systemToolPath(join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
}
