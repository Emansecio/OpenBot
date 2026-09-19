import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error Operational script is JavaScript, tested through its public read-only interface.
import { executionDiagnostics } from "../scripts/execution-diagnostics.mjs";

describe("execution diagnostics client", () => {
  it("uses only the local authenticated observational endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-execution-diagnostics-"));
    const tokenPath = join(root, "gateway.token");
    const token = "diagnostic-fixture-secret";
    await writeFile(tokenPath, token);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, value: { version: 1, provider: { active: 0 } } }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No test port.");
      const result = await executionDiagnostics({ port: address.port, tokenPath });
      expect(result).toEqual({ version: 1, provider: { active: 0 } });
      expect(requests).toEqual(["POST /api/getExecutionDiagnostics"]);
      await expect(executionDiagnostics({ port: 0, tokenPath })).rejects.toThrow("port");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
