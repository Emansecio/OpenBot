import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// An 8.3 TEMP (e.g. C:\Users\THIAGO~1\...) has a realpath that differs from
// its spelling, which the workspace sandbox rejects as a reparse ancestor.
// Tests create their roots under tmpdir(), so pin it to the canonical path.
const canonicalTemp = realpathSync.native(tmpdir());

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    env: {
      OPENBOT_KEYSTORE_MEMORY: "1",
      TEMP: canonicalTemp,
      TMP: canonicalTemp,
    },
    include: ["test/**/*.test.ts"],
    maxConcurrency: 2,
    maxWorkers: 10,
    // Cobertura do escopo T1/T2: contratos e smoke. Testes de integração
    // HTTP (T3+) entram no mesmo diretório test/.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
