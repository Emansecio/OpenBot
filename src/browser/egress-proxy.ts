import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as defaultHttpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as defaultHttpsRequest } from "node:https";
import { connect as defaultConnect, isIP, type NetConnectOpts, type Socket } from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import {
  defaultDnsResolver,
  classifyIpAddress,
  isBlockedHostname,
  NetworkPolicyError,
  normalizeHostname,
  resolvePublicAddresses,
  type DnsResolver,
} from "./network-policy.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export type ProxyHttpRequest = typeof defaultHttpRequest;
export type ProxyHttpsRequest = typeof defaultHttpsRequest;
export type ProxyConnect = typeof defaultConnect;

export interface EgressProxyOptions {
  /** The only accepted bind address. Any other value is rejected. */
  host?: string;
  /** Defaults to zero, letting the OS choose an ephemeral port. */
  port?: number;
  /** Optional test/deployment token. Generated tokens are preferred. */
  token?: string;
  /** Set false only for local loopback-only clients that cannot send proxy auth. */
  requireAuthorization?: boolean;
  resolve?: DnsResolver;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConnections?: number;
  httpRequest?: ProxyHttpRequest;
  httpsRequest?: ProxyHttpsRequest;
  connect?: ProxyConnect;
}

export interface EgressProxyAddress {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly token: string;
}

export class EgressProxyError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "EgressProxyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type OutboundResponse = IncomingMessage;
type RequestLike = IncomingMessage;

const toPositiveInteger = (value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) throw new TypeError("Proxy limit must be a positive safe integer");
  return candidate;
};

const headerValues = (request: RequestLike, name: string): string[] => {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
};

const authorityFor = (protocol: "http:" | "https:", hostname: string, port: string): string => {
  const normalized = normalizeHostname(hostname);
  const ipLiteral = isIP(normalized) === 6;
  const defaultPort = protocol === "https:" ? "443" : "80";
  const rendered = ipLiteral ? `[${normalized}]` : normalized;
  return port && port !== defaultPort ? `${rendered}:${port}` : rendered;
};

const safeHostHeader = (value: string): boolean => {
  if (!value || value.length > 255 || /[\r\n\s/@?#]/.test(value)) return false;
  return true;
};

const isMatchingAuthority = (value: string, expected: string): boolean => value.trim().toLowerCase().replace(/\.$/, "") === expected.toLowerCase().replace(/\.$/, "");

const stripHopByHopHeaders = (headers: IncomingMessage["headers"]): Record<string, string | string[]> => {
  const connectionTokens = new Set<string>();
  const connection = headers.connection;
  for (const value of Array.isArray(connection) ? connection : connection ? [connection] : []) {
    for (const token of value.split(",")) connectionTokens.add(token.trim().toLowerCase());
  }
  const removed = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connectionTokens,
  ]);
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || removed.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  return output;
};

const writeProxyError = (response: ServerResponse, statusCode: number, reason: string): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(reason)),
    connection: "close",
    ...(statusCode === 407 ? { "proxy-authenticate": 'Basic realm="OpenBot"' } : {}),
  });
  response.end(reason);
};

const writeConnectError = (socket: Socket, statusCode: number, reason: string): void => {
  if (!socket.destroyed) {
    const challenge = statusCode === 407 ? 'Proxy-Authenticate: Basic realm="OpenBot"\r\n' : "";
    socket.end(`HTTP/1.1 ${statusCode} ${statusCode === 407 ? "Proxy Authentication Required" : statusCode === 403 ? "Forbidden" : "Bad Gateway"}\r\n${challenge}Connection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  }
};

class ByteLimitTransform extends Transform {
  private total = 0;

  constructor(private readonly limit: number, private readonly code: string) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.limit) {
      callback(new EgressProxyError("Payload exceeds proxy limit", this.code, 413));
      return;
    }
    callback(null, chunk);
  }
}

const responseHeaders = (headers: IncomingMessage["headers"]): Record<string, string | string[]> => {
  const output: Record<string, string | string[]> = {};
  const removed = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || removed.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  output.connection = "close";
  return output;
};

const contentLength = (headers: IncomingMessage["headers"]): number | null => {
  const raw = headers["content-length"];
  if (raw === undefined || Array.isArray(raw)) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
};

export class EgressProxy {
  readonly token: string;
  private readonly requireAuthorization: boolean;
  private readonly resolver: DnsResolver;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxHeaderBytes: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly httpRequest: ProxyHttpRequest;
  private readonly httpsRequest: ProxyHttpsRequest;
  private readonly connect: ProxyConnect;
  private readonly configuredPort: number;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listeningAddress: EgressProxyAddress | null = null;
  private starting: Promise<EgressProxyAddress> | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: EgressProxyOptions = {}) {
    if ((options.host ?? LOOPBACK_HOST) !== LOOPBACK_HOST) throw new EgressProxyError("Egress proxy may bind only to 127.0.0.1", "bind_not_loopback", 500);
    this.configuredPort = options.port ?? 0;
    if (!Number.isInteger(this.configuredPort) || this.configuredPort < 0 || this.configuredPort > 65_535) throw new TypeError("Proxy port is invalid");
    this.token = options.token ?? randomBytes(32).toString("base64url");
    if (this.token.length < 43 || /[\r\n]/.test(this.token)) throw new TypeError("Proxy token is too weak");
    this.requireAuthorization = options.requireAuthorization ?? true;
    this.resolver = options.resolve ?? defaultDnsResolver;
    this.connectTimeoutMs = toPositiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.idleTimeoutMs = toPositiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxHeaderBytes = toPositiveInteger(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES);
    this.maxRequestBytes = toPositiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
    this.maxResponseBytes = toPositiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.httpRequest = options.httpRequest ?? defaultHttpRequest;
    this.httpsRequest = options.httpsRequest ?? defaultHttpsRequest;
    this.connect = options.connect ?? defaultConnect;
    this.server = createServer({ maxHeaderSize: this.maxHeaderBytes }, (request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.requestTimeout = this.idleTimeoutMs;
    this.server.headersTimeout = this.idleTimeoutMs;
    this.server.on("connect", (request, socket, head) => {
      void this.handleConnect(request, socket as Socket, head);
    });
    this.server.on("connection", (socket) => {
      const netSocket = socket;
      this.sockets.add(netSocket);
      netSocket.on("error", () => undefined);
      netSocket.setTimeout(this.idleTimeoutMs, () => netSocket.destroy());
      netSocket.once("close", () => this.sockets.delete(netSocket));
    });
    this.server.on("clientError", (_error, socket) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 11\r\n\r\nBad Request");
    });
    if (options.maxConnections !== undefined) {
      this.server.maxConnections = toPositiveInteger(options.maxConnections, 1);
    }
  }

  get address(): EgressProxyAddress | null {
    return this.listeningAddress;
  }

  async start(): Promise<EgressProxyAddress> {
    if (this.listeningAddress) return this.listeningAddress;
    if (this.closing) throw new EgressProxyError("Egress proxy is closing", "closing", 500);
    if (this.starting) return this.starting;
    const pending = this.startListening();
    this.starting = pending;
    try {
      return await pending;
    } finally {
      if (this.starting === pending) this.starting = null;
    }
  }

  private async startListening(): Promise<EgressProxyAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ host: LOOPBACK_HOST, port: this.configuredPort });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST) {
      await this.closeServer();
      throw new EgressProxyError("Egress proxy did not bind to loopback", "bind_not_loopback", 500);
    }
    this.listeningAddress = { host: LOOPBACK_HOST, port: address.port, token: this.token };
    return this.listeningAddress;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const pendingStart = this.starting;
    this.closing = (async () => {
      if (pendingStart) await pendingStart.catch(() => undefined);
      await this.closeServer();
    })();
    return this.closing;
  }

  private async closeServer(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) {
      this.listeningAddress = null;
      return;
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listeningAddress = null;
  }

  private authorized(request: RequestLike): boolean {
    if (!this.requireAuthorization) return true;
    const values = headerValues(request, "proxy-authorization");
    if (values.length !== 1) return false;
    const raw = values[0] ?? "";
    const bearer = /^Bearer[ \t]+([^ \t]+)$/i.exec(raw);
    let suppliedToken: string | undefined = bearer?.[1];
    if (!suppliedToken) {
      const basic = /^Basic[ \t]+([^ \t]+)$/i.exec(raw);
      if (basic?.[1]) {
        try {
          const decoded = Buffer.from(basic[1], "base64").toString("utf8");
          const separator = decoded.indexOf(":");
          if (separator > 0 && decoded.slice(0, separator) === "openbot") suppliedToken = decoded.slice(separator + 1);
        } catch {
          return false;
        }
      }
    }
    if (!suppliedToken) return false;
    const supplied = Buffer.from(suppliedToken);
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private validateRequestFraming(request: RequestLike): void {
    if (headerValues(request, "content-length").length > 1 || headerValues(request, "transfer-encoding").length > 1) throw new EgressProxyError("Ambiguous request framing", "ambiguous_framing", 400);
    if (request.headers["content-length"] !== undefined && request.headers["transfer-encoding"] !== undefined) throw new EgressProxyError("Ambiguous request framing", "ambiguous_framing", 400);
    const length = contentLength(request.headers);
    if (request.headers["content-length"] !== undefined && length === null) throw new EgressProxyError("Invalid request body length", "ambiguous_framing", 400);
    if (length !== null && length > this.maxRequestBytes) throw new EgressProxyError("Request body is too large", "request_too_large", 413);
  }

  private async targetFor(target: URL): Promise<{ address: string; hostname: string; port: number; authority: string; tls: boolean }> {
    const hostname = normalizeHostname(target.hostname);
    const protocol = target.protocol === "https:" ? "https:" : "http:";
    const port = target.port ? Number(target.port) : protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new EgressProxyError("Target port is invalid", "target_invalid", 400);
    const family = isIP(hostname);
    let addresses: string[];
    if (family !== 0) {
      const reason = classifyIpAddress(hostname);
      if (reason !== null) throw new EgressProxyError("Target address is not allowed", "egress_policy_denied", 403);
      addresses = [hostname];
    } else {
      if (isBlockedHostname(hostname)) throw new EgressProxyError("Target hostname is not allowed", "egress_policy_denied", 403);
      addresses = await this.resolveAddresses(hostname);
    }
    const authority = authorityFor(protocol, hostname, target.port);
    return { address: addresses[0] ?? "", hostname, port, authority, tls: protocol === "https:" };
  }

  private async resolveAddresses(hostname: string): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<string[]>((resolve, reject) => {
        timer = setTimeout(() => reject(new EgressProxyError("DNS resolution timed out", "dns_timeout", 504)), this.connectTimeoutMs);
        void resolvePublicAddresses(hostname, this.resolver).then(resolve, reject);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private parseAbsoluteTarget(request: RequestLike): URL {
    const raw = request.url ?? "";
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) throw new EgressProxyError("Proxy requires an absolute HTTP URL", "target_invalid", 400);
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw new EgressProxyError("Target URL is invalid", "target_invalid", 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new EgressProxyError("Only HTTP and HTTPS are allowed", "target_protocol", 403);
    if (target.username || target.password || target.hash || !target.hostname) throw new EgressProxyError("Target URL is ambiguous", "target_ambiguous", 400);
    const hostValues = headerValues(request, "host");
    if (hostValues.length > 1) throw new EgressProxyError("Ambiguous Host header", "ambiguous_host", 400);
    const expectedAuthority = authorityFor(target.protocol, target.hostname, target.port);
    const suppliedHost = hostValues[0];
    if (suppliedHost !== undefined && (!safeHostHeader(suppliedHost) || !isMatchingAuthority(suppliedHost, expectedAuthority))) throw new EgressProxyError("Host header does not match target URL", "ambiguous_host", 400);
    return target;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      writeProxyError(response, 407, "Proxy authentication required");
      request.destroy();
      return;
    }
    try {
      this.validateRequestFraming(request);
      const target = this.parseAbsoluteTarget(request);
      const resolved = await this.targetFor(target);
      const headers = stripHopByHopHeaders(request.headers);
      headers.host = resolved.authority;
      headers.connection = "close";
      const options: RequestOptions = {
        protocol: target.protocol,
        hostname: resolved.address,
        port: resolved.port,
        method: request.method,
        path: `${target.pathname || "/"}${target.search}`,
        headers,
        timeout: this.connectTimeoutMs,
        ...(resolved.tls && isIP(resolved.hostname) === 0 ? { servername: resolved.hostname } : {}),
      };
      const requestFn = resolved.tls ? this.httpsRequest : this.httpRequest;
      let bodyTooLarge = false;
      const upstream = requestFn(options, (upstreamResponse) => this.pipeResponse(upstreamResponse, response, request));
      upstream.once("timeout", () => upstream.destroy(new EgressProxyError("Upstream connection timed out", "upstream_timeout", 504)));
      upstream.once("error", (error) => {
        if (bodyTooLarge) return;
        if (!response.headersSent) writeProxyError(response, error instanceof EgressProxyError && error.code === "upstream_timeout" ? 504 : 502, "Upstream connection failed");
        else response.destroy();
      });
      request.once("aborted", () => upstream.destroy());
      const body = new ByteLimitTransform(this.maxRequestBytes, "request_too_large");
      body.once("error", () => {
        bodyTooLarge = true;
        upstream.destroy();
        writeProxyError(response, 413, "Request body is too large");
      });
      request.pipe(body).pipe(upstream);
    } catch (error) {
      this.sendHttpFailure(response, error);
      request.destroy();
    }
  }

  private pipeResponse(upstream: OutboundResponse, response: ServerResponse, request: IncomingMessage): void {
    const length = contentLength(upstream.headers);
    if (length !== null && length > this.maxResponseBytes) {
      writeProxyError(response, 502, "Upstream response is too large");
      upstream.destroy();
      return;
    }
    response.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers));
    const body = new ByteLimitTransform(this.maxResponseBytes, "response_too_large");
    body.once("error", () => {
      upstream.destroy();
      response.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    upstream.pipe(body).pipe(response);
  }

  private parseConnectTarget(request: IncomingMessage): { hostname: string; port: number } {
    const raw = request.url ?? "";
    if (!raw || /[\r\n\s/@?#]/.test(raw)) throw new EgressProxyError("CONNECT target is invalid", "target_invalid", 400);
    let hostname: string;
    let portText: string;
    if (raw.startsWith("[")) {
      const close = raw.indexOf("]");
      if (close < 0 || raw[close + 1] !== ":") throw new EgressProxyError("CONNECT target is invalid", "target_invalid", 400);
      hostname = raw.slice(1, close);
      portText = raw.slice(close + 2);
    } else {
      const separator = raw.lastIndexOf(":");
      if (separator <= 0 || raw.indexOf(":") !== separator) throw new EgressProxyError("CONNECT target is invalid", "target_invalid", 400);
      hostname = raw.slice(0, separator);
      portText = raw.slice(separator + 1);
    }
    if (!/^\d{1,5}$/.test(portText)) throw new EgressProxyError("CONNECT port is invalid", "target_invalid", 400);
    const port = Number(portText);
    if (port < 1 || port > 65_535) throw new EgressProxyError("CONNECT port is invalid", "target_invalid", 400);
    const hostValues = headerValues(request, "host");
    if (hostValues.length > 1) throw new EgressProxyError("Ambiguous Host header", "ambiguous_host", 400);
    const expected = isIP(hostname) === 6 ? `[${normalizeHostname(hostname)}]:${port}` : `${normalizeHostname(hostname)}:${port}`;
    if (hostValues[0] !== undefined && (!safeHostHeader(hostValues[0]) || !isMatchingAuthority(hostValues[0], expected))) throw new EgressProxyError("Host header does not match CONNECT target", "ambiguous_host", 400);
    return { hostname: normalizeHostname(hostname), port };
  }

  private async handleConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      writeConnectError(client, 407, "Proxy authentication required");
      return;
    }
    let upstream: Socket | null = null;
    let connected = false;
    try {
      const target = this.parseConnectTarget(request);
      const family = isIP(target.hostname);
      let addresses: string[];
      if (family !== 0) {
        const reason = classifyIpAddress(target.hostname);
        if (reason !== null) throw new EgressProxyError("Target address is not allowed", "egress_policy_denied", 403);
        addresses = [target.hostname];
      } else {
        if (isBlockedHostname(target.hostname)) throw new EgressProxyError("Target hostname is not allowed", "egress_policy_denied", 403);
        addresses = await this.resolveAddresses(target.hostname);
      }
      const address = addresses[0];
      if (!address) throw new EgressProxyError("Target has no DNS answers", "egress_policy_denied", 403);
      const options: NetConnectOpts = { host: address, port: target.port, timeout: this.connectTimeoutMs };
      upstream = this.connect(options);
      upstream.setTimeout(this.connectTimeoutMs, () => upstream?.destroy(new EgressProxyError("Upstream connection timed out", "upstream_timeout", 504)));
      upstream.once("error", () => {
        if (!client.destroyed && !connected) writeConnectError(client, 502, "Upstream connection failed");
        else if (!client.destroyed) client.destroy();
      });
      upstream.once("connect", () => {
        if (client.destroyed) {
          upstream?.destroy();
          return;
        }
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n");
        if (head.length > 0) upstream?.write(head);
        client.pipe(upstream!);
        upstream?.pipe(client);
      });
      client.once("close", () => upstream?.destroy());
      upstream.once("close", () => client.destroy());
    } catch (error) {
      const status = error instanceof EgressProxyError ? error.statusCode : error instanceof NetworkPolicyError ? 403 : 502;
      writeConnectError(client, status, status === 403 ? "Target is not allowed" : "Bad gateway");
      upstream?.destroy();
    }
  }

  private sendHttpFailure(response: ServerResponse, error: unknown): void {
    if (error instanceof EgressProxyError) {
      writeProxyError(response, error.statusCode, error.statusCode === 403 ? "Target is not allowed" : error.statusCode === 407 ? "Proxy authentication required" : error.message);
      return;
    }
    if (error instanceof NetworkPolicyError) {
      writeProxyError(response, 403, "Target is not allowed");
      return;
    }
    writeProxyError(response, 502, "Bad gateway");
  }
}

export const createEgressProxy = (options: EgressProxyOptions = {}): EgressProxy => new EgressProxy(options);
