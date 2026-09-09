import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { connect as netConnect, createServer as netCreateServer, type NetConnectOpts } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  EgressProxy,
  type EgressProxyAddress,
} from "../src/browser/egress-proxy.js";
import {
  classifyIpAddress,
  isBlockedHostname,
  isBlockedNetworkAddress,
} from "../src/browser/network-policy.js";

const proxies: EgressProxy[] = [];
const servers: Array<{ listening: boolean; close(callback?: (error?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  })));
});

const request = async (address: EgressProxyAddress, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const client = httpRequest({
    host: address.host,
    port: address.port,
    path,
    headers: {
      "proxy-authorization": `Bearer ${address.token}`,
      host: "public.test",
      ...headers,
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
  });
  client.once("error", reject);
  client.end();
});

describe("browser egress policy", () => {
  it("classifies loopback, private, link-local, multicast, unspecified and metadata addresses", () => {
    expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("10.0.0.1")).toBe("private");
    expect(classifyIpAddress("169.254.1.1")).toBe("link-local");
    expect(classifyIpAddress("169.254.169.254")).toBe("metadata");
    expect(classifyIpAddress("168.63.129.16")).toBe("metadata");
    expect(classifyIpAddress("224.0.0.1")).toBe("multicast");
    expect(classifyIpAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyIpAddress("203.0.113.1")).toBe("reserved");
    expect(classifyIpAddress("::1")).toBe("loopback");
    expect(classifyIpAddress("fc00::1")).toBe("private");
    expect(classifyIpAddress("fec0::1")).toBe("private");
    expect(classifyIpAddress("fe80::1")).toBe("link-local");
    expect(classifyIpAddress("ff02::1")).toBe("multicast");
    expect(classifyIpAddress("::")).toBe("unspecified");
    expect(isBlockedNetworkAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });

  it("applies IPv4 policy to NAT64 addresses and blocks the local-use NAT64 prefix", () => {
    expect(classifyIpAddress("64:ff9b::a9fe:a9fe")).toBe("metadata");
    expect(classifyIpAddress("64:ff9b::a83f:8110")).toBe("metadata");
    expect(classifyIpAddress("64:ff9b::c0a8:101")).toBe("private");
    expect(classifyIpAddress("64:ff9b::5db8:d822")).toBeNull();
    expect(classifyIpAddress("64:ff9b:1::1")).toBe("private");
  });

  it("binds only to loopback on an ephemeral port and creates a strong token", async () => {
    const proxy = new EgressProxy();
    proxies.push(proxy);
    const address = await proxy.start();
    expect(address.host).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(address.token.length).toBeGreaterThanOrEqual(43);
    expect(proxy.token).toBe(address.token);
  });

  it("does not remain listening when close races with startup", async () => {
    const proxy = new EgressProxy();
    proxies.push(proxy);

    const starting = proxy.start();
    await proxy.close();
    await starting.catch(() => undefined);

    expect(proxy.address).toBeNull();
  });

  it("requires bearer authentication and never forwards proxy credentials", async () => {
    const target = createServer((req, res) => {
      expect(req.headers["proxy-authorization"]).toBeUndefined();
      res.end("ok");
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as { port: number }).port;

    const proxy = new EgressProxy({
      resolve: async () => ["93.184.216.34"],
      httpRequest: ((options: RequestOptions, callback: (response: IncomingMessage) => void) => httpRequest({ ...options, hostname: "127.0.0.1", port: targetPort }, callback)) as never,
    });
    proxies.push(proxy);
    const address = await proxy.start();

    const unauthenticated = await request(address, "http://public.test/", { "proxy-authorization": "Bearer wrong" });
    expect(unauthenticated.status).toBe(407);
    const challenge = await new Promise<string | undefined>((resolve, reject) => {
      const client = httpRequest({
        host: address.host,
        port: address.port,
        path: "http://public.test/",
        headers: { host: "public.test" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.headers["proxy-authenticate"]));
      });
      client.once("error", reject);
      client.end();
    });
    expect(challenge).toBe('Basic realm="OpenBot"');
    const authorized = await request(address, "http://public.test/");
    expect(authorized).toEqual({ status: 200, body: "ok" });
    const basic = await request(address, "http://public.test/", {
      "proxy-authorization": `Basic ${Buffer.from(`openbot:${address.token}`).toString("base64")}`,
    });
    expect(basic).toEqual({ status: 200, body: "ok" });
  });

  it("can disable proxy authentication for loopback-only browser hosts", async () => {
    const target = createServer((_req, res) => {
      res.end("ok");
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as { port: number }).port;

    const proxy = new EgressProxy({
      requireAuthorization: false,
      resolve: async () => ["93.184.216.34"],
      httpRequest: ((options: RequestOptions, callback: (response: IncomingMessage) => void) => httpRequest({ ...options, hostname: "127.0.0.1", port: targetPort }, callback)) as never,
    });
    proxies.push(proxy);
    const address = await proxy.start();

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = httpRequest({
        host: address.host,
        port: address.port,
        path: "http://public.test/",
        headers: { host: "public.test" },
      }, (upstream) => {
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstream.on("end", () => resolve({ status: upstream.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      client.once("error", reject);
      client.end();
    });

    expect(response).toEqual({ status: 200, body: "ok" });
  });

  it("rejects ambiguous Host headers and every blocked DNS answer for HTTP", async () => {
    const proxy = new EgressProxy({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
    proxies.push(proxy);
    const address = await proxy.start();

    const blocked = await request(address, "http://public.test/");
    expect(blocked.status).toBe(403);

    const ambiguous = await request(address, "http://public.test/", { host: "other.test" });
    expect(ambiguous.status).toBe(400);
  });

  it("blocks private IP literals without consulting or bypassing DNS policy", async () => {
    let resolved = false;
    const proxy = new EgressProxy({ resolve: async () => { resolved = true; return ["93.184.216.34"]; } });
    proxies.push(proxy);
    const address = await proxy.start();
    const response = await request(address, "http://[::1]/", { host: "[::1]" });
    expect(response.status).toBe(403);
    expect(resolved).toBe(false);
  });

  it("bounds resolver latency without exposing resolver errors or target data", async () => {
    const proxy = new EgressProxy({
      connectTimeoutMs: 20,
      resolve: () => new Promise<readonly string[]>(() => undefined),
    });
    proxies.push(proxy);
    const address = await proxy.start();
    const response = await request(address, "http://public.test/");
    expect(response.status).toBe(504);
  });

  it("rejects blocked CONNECT targets before dialing and closes cleanly", async () => {
    let dialed = false;
    const proxy = new EgressProxy({
      resolve: async () => ["127.0.0.1"],
      connect: ((...args: Parameters<typeof netConnect>) => {
        dialed = true;
        return netConnect(...args);
      }) as never,
    });
    proxies.push(proxy);
    const address = await proxy.start();
    const socket = netConnect({ host: address.host, port: address.port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(`CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\nProxy-Authorization: Bearer ${address.token}\r\n\r\n`);
    const response = await new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(String(chunk))));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(dialed).toBe(false);
    socket.destroy();
    await proxy.close();
    expect(proxy.address).toBeNull();
  });

  it("forwards an authenticated CONNECT only after policy validation", async () => {
    const target = netCreateServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as { port: number }).port;
    const proxy = new EgressProxy({
      resolve: async () => ["93.184.216.34"],
      connect: ((options: NetConnectOpts) => netConnect({ ...options, host: "127.0.0.1", port: targetPort })) as never,
    });
    proxies.push(proxy);
    const address = await proxy.start();
    const socket = netConnect({ host: address.host, port: address.port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(`CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\nProxy-Authorization: Bearer ${address.token}\r\n\r\n`);
    const established = await new Promise<string>((resolve) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += String(chunk);
        if (data.includes("\r\n\r\n")) resolve(data);
      });
    });
    expect(established).toMatch(/^HTTP\/1\.1 200/);
    socket.write("echo-through-tunnel");
    const echoed = await new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(String(chunk))));
    expect(echoed).toBe("echo-through-tunnel");
    socket.destroy();
  });
});
