import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temporary roots created by one test file. Call `cleanup()` from the file's
 * own `afterEach`, after stopping servers and closing stores that live inside
 * the roots. Removal retries because Windows can briefly keep SQLite/WAL or
 * child-process handles open after close.
 */
export class TempRoots {
  private readonly roots: string[] = [];

  make(prefix: string): string {
    return this.track(mkdtempSync(join(tmpdir(), prefix)));
  }

  async makeAsync(prefix: string): Promise<string> {
    return this.track(await mkdtemp(join(tmpdir(), prefix)));
  }

  track(root: string): string {
    this.roots.push(root);
    return root;
  }

  async cleanup(): Promise<void> {
    const roots = this.roots.splice(0);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  }
}
