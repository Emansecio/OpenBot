import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * File symlinks need SeCreateSymbolicLinkPrivilege on Windows (Developer Mode
 * or elevation); junctions do not. Tests that must create a file symlink skip
 * with this flag instead of failing with EPERM on unprivileged machines.
 */
export const canCreateFileSymlinks: boolean = (() => {
  const root = mkdtempSync(join(tmpdir(), "openbot-symlink-probe-"));
  try {
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(root, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
