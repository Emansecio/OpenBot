import { mkdir, stat } from "node:fs/promises";
import { win32 as path } from "node:path";
import { WorkspaceSandbox } from "../../workspace.js";

/** Additive operational directories. This is not a new Windows user/profile or a security boundary. */
export async function nativeEnvironment(workspaceRoot: string, overrides: Record<string, string> = {}, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const home = await WorkspaceSandbox.create(workspaceRoot, { allowAncestorLinks: true });
  const ensure = async (relative: string): Promise<string> => {
    signal?.throwIfAborted();
    const destination = await home.resolveDestination(relative);
    await mkdir(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    signal?.throwIfAborted();
    const verified = await home.resolveExisting(relative);
    if (!(await stat(verified)).isDirectory()) throw new Error("Operational path is not a directory.");
    return verified;
  };
  await ensure(".openbot-runtime");
  const temporary = await ensure(".openbot-runtime/Temp");
  const cache = await ensure(".openbot-runtime/Cache");
  const defaults: NodeJS.ProcessEnv = {
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    XDG_CACHE_HOME: cache,
    npm_config_cache: await ensure(".openbot-runtime/Cache/npm"),
    PIP_CACHE_DIR: await ensure(".openbot-runtime/Cache/pip"),
    UV_CACHE_DIR: await ensure(".openbot-runtime/Cache/uv"),
    OPENBOT_WORKSPACE: home.root,
  };
  // Windows env keys are case-insensitive. Avoid duplicate PATH/TEMP variants,
  // which Node otherwise selects by lexical order instead of caller intent.
  const environment: NodeJS.ProcessEnv = {};
  for (const layer of [process.env, defaults, overrides]) {
    for (const [name, value] of Object.entries(layer)) {
      const existing = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
      if (existing !== undefined) delete environment[existing];
      environment[name] = value;
    }
  }
  signal?.throwIfAborted();
  return environment;
}

export const nativePowerShellPath = (): string => path.join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
