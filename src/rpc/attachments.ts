import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_PDF_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 16;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 4 * 1024 * 1024;

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".log", ".xml", ".html", ".htm",
  ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".c", ".h", ".cpp",
  ".yml", ".yaml", ".toml", ".ini", ".env", ".sql", ".sh", ".ps1", ".bat",
]);

export interface AttachmentRef {
  path: string;
  name: string;
}

export interface ExtractedAttachment {
  name: string;
  path: string;
  text?: string;
  skipped?: string;
  /** P2.3 opaque kind when resolved from the server-side staging store. */
  kind?: "text" | "pdf" | "image";
  /** P2.3 data URL for images when the provider/model declares image support. */
  imageDataUrl?: string;
}

export function defaultAttachmentRoots(agentHome?: string): string[] {
  // Legacy path attachments remain supported only inside this agent's home.
  // Global app/staging roots let one bot name bytes owned by another bot.
  return agentHome ? [resolve(agentHome)] : [];
}

function normalizeRoot(value: string): string {
  return resolve(value).replace(/[/\\]+$/, "").toLowerCase();
}

function isInside(root: string, target: string): boolean {
  const base = normalizeRoot(root);
  const path = normalizeRoot(target);
  return path === base || path.startsWith(`${base}${sep.toLowerCase()}`) || path.startsWith(`${base}\\`) || path.startsWith(`${base}/`);
}

async function assertAllowed(absPath: string, roots: readonly string[]): Promise<string> {
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    throw new Error("not_found");
  }
  const stat = await lstat(real);
  if (stat.isSymbolicLink()) throw new Error("outside");
  const parent = await realpath(resolve(real, ".."));
  const allowed = roots.some((root) => {
    try {
      return isInside(root, real) || isInside(root, parent);
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error("outside");
  return real;
}

export function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString("latin1");
  const chunks: string[] = [];
  const literal = /\((?:\\.|[^\\)])*\)/g;
  const show = /Tj|TJ|'|"/g;
  let match: RegExpExecArray | null;
  const pieces: string[] = [];
  while ((match = literal.exec(source)) !== null) {
    const after = source.slice(literal.lastIndex, literal.lastIndex + 12);
    if (!show.test(after) && !/\]\s*TJ/.test(source.slice(Math.max(0, match.index - 2), literal.lastIndex + 8))) {
      continue;
    }
    show.lastIndex = 0;
    const raw = match[0].slice(1, -1);
    const decoded = raw
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\")
      .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
    if (decoded.trim()) pieces.push(decoded);
  }
  if (pieces.length === 0) {
    const fallback = source.match(/\((?:\\.|[^\\)]){3,}\)/g) ?? [];
    for (const item of fallback.slice(0, 400)) {
      const decoded = item.slice(1, -1).replace(/\\[()]/g, "").replace(/\\\\/g, "\\");
      if (/[A-Za-zÀ-ÿ]{3,}/.test(decoded)) pieces.push(decoded);
    }
  }
  const text = pieces.join(" ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
  chunks.push(text);
  return chunks.join("\n").trim();
}

export async function readAllowedAttachment(
  attachment: AttachmentRef,
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<ExtractedAttachment> {
  const name = attachment.name || basename(attachment.path) || "attachment";
  const pathExt = extname(attachment.path).toLowerCase();
  const nameExt = extname(name).toLowerCase();
  if (pathExt && nameExt && pathExt !== nameExt) {
    return { name, path: attachment.path, skipped: "extensão do nome diverge do arquivo armazenado" };
  }
  const ext = pathExt || nameExt;
  if (ext !== ".pdf" && !TEXT_EXT.has(ext)) {
    return { name, path: attachment.path, skipped: "tipo não suportado (texto ou PDF)" };
  }
  let real: string;
  try {
    real = await assertAllowed(resolve(attachment.path), roots);
  } catch (error) {
    const reason = error instanceof Error && error.message === "outside"
      ? "fora da home/staging do bot"
      : "arquivo não encontrado";
    return { name, path: attachment.path, skipped: reason };
  }
  try {
    if (signal?.aborted) return { name, path: real, skipped: "leitura cancelada" };
    const limit = ext === ".pdf" ? MAX_PDF_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
    const handle = await open(real, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return { name, path: real, skipped: "não é um arquivo" };
      if (metadata.size > limit) {
        return { name, path: real, skipped: `maior que ${Math.round(limit / 1024)} KiB` };
      }
      if (signal?.aborted) return { name, path: real, skipped: "leitura cancelada" };
      const bytes = await handle.readFile();
      if (signal?.aborted) return { name, path: real, skipped: "leitura cancelada" };
      if (bytes.length > limit) {
        return { name, path: real, skipped: `maior que ${Math.round(limit / 1024)} KiB` };
      }
      if (ext === ".pdf") {
        const text = extractPdfText(bytes);
        if (!text) return { name, path: real, skipped: "PDF sem texto extraível" };
        return { name, path: real, text };
      }
      return { name, path: real, text: bytes.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch {
    return { name, path: real, skipped: signal?.aborted ? "leitura cancelada" : "falha ao ler" };
  }
}

export function formatAttachmentContext(extracted: readonly ExtractedAttachment[]): string {
  if (extracted.length === 0) return "";
  const blocks: string[] = [];
  for (const item of extracted) {
    const header = `[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\nname: ${JSON.stringify(item.name)}`;
    if (item.text !== undefined) {
      blocks.push(`${header}\ncontent:\n${item.text}\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]`);
    } else if (item.skipped) {
      blocks.push(`${header}\nnot read: ${item.skipped}\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]`);
    }
  }
  return blocks.join("\n\n");
}

export async function readTurnAttachments(
  attachments: readonly AttachmentRef[] | undefined,
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<{ context: string; extracted: ExtractedAttachment[] }> {
  if (!attachments || attachments.length === 0) return { context: "", extracted: [] };
  if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new Error(`máximo de ${MAX_ATTACHMENTS_PER_TURN} anexos por turno`);
  }
  const extracted: ExtractedAttachment[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (signal?.aborted) break;
    const item = await readAllowedAttachment(attachment, roots, signal);
    if (item.text !== undefined) {
      totalBytes += Buffer.byteLength(item.text, "utf8");
      if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
        extracted.push({ name: item.name, path: item.path, skipped: "limite agregado de anexos excedido" });
        break;
      }
    }
    extracted.push(item);
  }
  return { context: formatAttachmentContext(extracted), extracted };
}
