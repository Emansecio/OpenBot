import { isIP } from "node:net";

/** Resolver used by the egress proxy. It is injectable so policy tests never
 * need to trust the host resolver or make an external network request. */
export type DnsResolver = (hostname: string) => readonly string[] | Promise<readonly string[]>;

export type BlockedAddressReason =
  | "invalid"
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "multicast"
  | "metadata"
  | "reserved";

export class NetworkPolicyError extends Error {
  readonly code = "egress_policy_denied" as const;
  readonly reason: BlockedAddressReason | "hostname" | "no-addresses";

  constructor(message: string, reason: BlockedAddressReason | "hostname" | "no-addresses") {
    super(message);
    this.name = "NetworkPolicyError";
    this.reason = reason;
  }
}

const IPV4_METADATA = 0xa9feA9fe;
const IPV4_AZURE_PLATFORM = 0xa83f8110;

const ipv4Number = (address: string): number | null => {
  const pieces = address.split(".");
  if (pieces.length !== 4) return null;
  const octets = pieces.map((piece) => {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const value = Number(piece);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((value) => value === null)) return null;
  return (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
};

const classifyIpv4 = (address: string): BlockedAddressReason | null => {
  const value = ipv4Number(address);
  if (value === null) return "invalid";

  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;
  const first16 = value >>> 16;
  if (value === 0 || first === 0) return "unspecified";
  if (first === 127) return "loopback";
  if (value === IPV4_METADATA || value === IPV4_AZURE_PLATFORM) return "metadata";
  if (first === 169 && second === 254) return "link-local";
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || first16 === 0xc0a8) return "private";
  if (first === 100 && second >= 64 && second <= 127) return "private";
  if (first === 192 && second === 0) return "reserved";
  if (first === 192 && second === 0 && (value & 0xffff) === 2) return "reserved";
  if (first === 192 && second === 2) return "reserved";
  if (first === 198 && second >= 18 && second <= 19) return "reserved";
  if (first === 198 && second === 51 && ((value >>> 8) & 0xff) === 100) return "reserved";
  if (first === 203 && second === 0 && ((value >>> 8) & 0xff) === 113) return "reserved";
  if (first >= 224 && first <= 239) return "multicast";
  if (first >= 240) return "reserved";
  return null;
};

const ipv6Bytes = (address: string): number[] | null => {
  if (address.includes("%")) return null;
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = ipv4Number(value.slice(lastColon + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, lastColon)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parseGroups = (groups: string[]): number[] | null => {
    const output: number[] = [];
    for (const group of groups) {
      if (!/^[\da-f]{1,4}$/.test(group)) return null;
      output.push(Number.parseInt(group, 16));
    }
    return output;
  };
  const leftValues = parseGroups(left);
  const rightValues = parseGroups(right);
  if (leftValues === null || rightValues === null) return null;
  const missing = halves.length === 2 ? 8 - leftValues.length - rightValues.length : 0;
  if (halves.length === 2) {
    if (missing < 1 || leftValues.length + rightValues.length + missing !== 8) return null;
  } else if (leftValues.length !== 8) {
    return null;
  }
  const groups = halves.length === 2
    ? [...leftValues, ...Array.from({ length: missing }, () => 0), ...rightValues]
    : leftValues;
  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >>> 8) & 0xff, group & 0xff);
  return bytes;
};

const startsWithBytes = (bytes: readonly number[], prefix: readonly number[], bits: number): boolean => {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
};

const classifyIpv6 = (address: string): BlockedAddressReason | null => {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return "invalid";
  if (bytes.every((value) => value === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return "loopback";

  // IPv4-mapped and IPv4-compatible IPv6 addresses must go through the same
  // policy as their embedded IPv4 address.
  const mapped = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((value) => value === 0);
  if (mapped || compatible) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return classifyIpv4(embedded);
  }
  // The well-known NAT64 prefix embeds an IPv4 address in the final 32 bits.
  // Reapply the IPv4 policy so private and metadata targets cannot be hidden
  // behind IPv6. The dedicated local-use NAT64 prefix is never public egress.
  if (startsWithBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 96)) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return classifyIpv4(embedded);
  }
  if (startsWithBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return "private";
  if (startsWithBytes(bytes, [0xfc], 7)) return "private";
  if (startsWithBytes(bytes, [0xfe, 0xc0], 10)) return "private";
  if (startsWithBytes(bytes, [0xfe, 0x80], 10)) return "link-local";
  if (startsWithBytes(bytes, [0xff], 8)) return "multicast";
  if (startsWithBytes(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return "reserved";
  return null;
};

/** Returns the reason an IP is denied, or null for a public routable address. */
export const classifyIpAddress = (address: string): BlockedAddressReason | null => {
  const normalized = address.trim();
  const family = isIP(normalized);
  if (family === 4) return classifyIpv4(normalized);
  if (family === 6) return classifyIpv6(normalized);
  return "invalid";
};

export const isBlockedNetworkAddress = (address: string): boolean => classifyIpAddress(address) !== null;

const normalizedHostname = (hostname: string): string => hostname.trim().toLowerCase().replace(/\.$/, "");

/** Hostnames that should never reach DNS, even if a resolver is compromised. */
export const isBlockedHostname = (hostname: string): boolean => {
  const normalized = normalizedHostname(hostname);
  if (!normalized || normalized.length > 253 || /[^\da-z.-]/i.test(normalized)) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "localhost.localdomain") return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  return new Set([
    "metadata",
    "metadata.google",
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "host.docker.internal",
    "gateway.docker.internal",
    "kubernetes.default.svc",
  ]).has(normalized);
};

export const normalizeHostname = (hostname: string): string => {
  const normalized = normalizedHostname(hostname);
  if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
  return normalized;
};

/** Resolve every answer and fail closed if any answer is private or special. */
export const resolvePublicAddresses = async (hostname: string, resolver: DnsResolver): Promise<string[]> => {
  const normalized = normalizeHostname(hostname);
  if (isBlockedHostname(normalized)) throw new NetworkPolicyError("Target hostname is not allowed", "hostname");
  const answers = [...new Set((await resolver(normalized)).map((answer) => answer.trim()).filter(Boolean))];
  if (answers.length === 0) throw new NetworkPolicyError("Target has no DNS answers", "no-addresses");
  for (const answer of answers) {
    const reason = classifyIpAddress(answer);
    if (reason !== null) throw new NetworkPolicyError("Target resolves to a blocked network", reason);
  }
  return answers;
};

export const defaultDnsResolver: DnsResolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};
