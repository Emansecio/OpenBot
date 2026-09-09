import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    env: {
      OPENBOT_KEYSTORE_MEMORY: "1",
    },
    include: ["test/**/*.test.ts"],
    maxConcurrency: 2,
    // Cobertura do escopo T1/T2: contratos e smoke. Testes de integração
    // HTTP (T3+) entram no mesmo diretório test/.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
