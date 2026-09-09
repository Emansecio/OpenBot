import http from "node:http";
import crypto from "node:crypto";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const createServer = () => {
  const server = new McpServer({ name: "openbot-real-transport-fixture", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a value through the MCP fixture",
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({ content: [{ type: "text", text: `echo:${value}` }] }),
  );
  return server;
};

const collectBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const toRequest = async (request) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await collectBody(request);
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

const writeResponse = async (response, reply) => {
  reply.statusCode = response.status;
  response.headers.forEach((value, key) => reply.setHeader(key, value));
  reply.end(response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
};

const startStdio = async () => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = async () => {
    await Promise.allSettled([server.close(), transport.close()]);
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.stdin.once("end", () => void close().finally(() => process.exit(0)));
};

const startHttp = async () => {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const listener = http.createServer(async (request, reply) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    try {
      await writeResponse(await transport.handleRequest(await toRequest(request)), reply);
    } catch {
      if (!reply.headersSent) reply.writeHead(500);
      reply.end();
    }
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not receive a port");
  process.stdout.write(`PORT ${address.port}\n`);

  const close = async () => {
    await Promise.allSettled([
      server.close(),
      transport.close(),
      new Promise((resolve) => listener.close(() => resolve())),
    ]);
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
};

if (process.argv[2] === "stdio") await startStdio();
else if (process.argv[2] === "http") await startHttp();
else throw new Error("fixture transport must be stdio or http");
