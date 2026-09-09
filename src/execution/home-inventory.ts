import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { HomeArchiveError, validateArchivePath } from "./home-archive.js";
import { DEFAULT_WORKSPACE_QUOTA } from "./quota.js";
import { isHomeTrashArchivePath } from "./user-files.js";

export interface HomeInventoryEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  sha256?: string;
}

export interface HomeInventory {
  agentId: string;
  root: string;
  files: number;
  directories: number;
  bytes: number;
  entries: HomeInventoryEntry[];
  complete: boolean;
}

const hash = (content: Buffer): string => createHash("sha256").update(content).digest("hex");
export const DEFAULT_HOME_INVENTORY_MAX_ENTRIES = DEFAULT_WORKSPACE_QUOTA.maxEntries ?? DEFAULT_WORKSPACE_QUOTA.maxFiles;

export async function inventoryHome(
  root: string,
  agentId: string,
  maxEntries = DEFAULT_HOME_INVENTORY_MAX_ENTRIES,
  maxBytes = DEFAULT_WORKSPACE_QUOTA.maxBytes,
): Promise<HomeInventory> {
  const entries: HomeInventoryEntry[] = [];
  let bytes = 0;
  let files = 0;
  let directories = 0;

  const visit = async (current: string, prefix: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = validateArchivePath(prefix.length === 0 ? child.name : `${prefix}/${child.name}`);
      const absolute = join(current, child.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new HomeArchiveError("unsafe_path", `Home contains a symbolic link: ${path}`);
      if (metadata.isDirectory()) {
        directories += 1;
        entries.push({ path, type: "directory", size: 0 });
        if (entries.length > maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
        if (isHomeTrashArchivePath(path)) continue;
        await visit(absolute, path);
      } else if (metadata.isFile()) {
        const content = await readFile(absolute);
        bytes += content.byteLength;
        if (bytes > maxBytes) throw new HomeArchiveError("invalid_archive", "Home exceeds the inventory size limit.");
        files += 1;
        entries.push({ path, type: "file", size: content.byteLength, sha256: hash(content) });
        if (entries.length > maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
      } else {
        throw new HomeArchiveError("unsafe_path", `Home contains an unsupported filesystem entry: ${path}`);
      }
    }
  };

  await visit(root, "");
  return { agentId, root, files, directories, bytes, entries, complete: true };
}
