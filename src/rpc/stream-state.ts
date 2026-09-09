export const STREAM_PUBLISH_INTERVAL_MS = 100;
export const STREAM_PERSIST_INTERVAL_MS = 1000;
export const MAX_LIVE_RESPONSE_BYTES = 192 * 1024;
/** Maximum fragment emitted by the transcript delta transport. */
export const MAX_TRANSCRIPT_DELTA_BYTES = 16 * 1024;

export interface LiveStreamStateOptions {
  id: string;
  publishIntervalMs: number;
  persistIntervalMs: number;
  maxTextBytes: number;
  onPublish(content: string, final: boolean): void;
  onPersist(content: string, final: boolean): void;
  onLimit(): void;
}

export interface LiveStreamState {
  readonly id: string;
  readonly content: string;
  readonly bytes: number;
  readonly limited: boolean;
  append(chunk: string, now: number): void;
  finalize(now: number): string;
}

/** Returns a prefix that is valid UTF-8 and never exceeds maxBytes. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const accepted: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    accepted.push(character);
    bytes += characterBytes;
  }
  return accepted.join("");
}

/**
 * Bounds one public streaming fragment.  A provider may give us a very large
 * chunk; the live transcript protocol must never turn that into an oversized
 * SSE frame or split a UTF-8 code point.
 */
export function boundedTranscriptFragment(text: string): string {
  return utf8Prefix(text, MAX_TRANSCRIPT_DELTA_BYTES);
}

/** Splits a provider chunk into bounded, valid UTF-8 transport fragments. */
export function splitTranscriptFragments(text: string): string[] {
  const fragments: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const fragment = boundedTranscriptFragment(text.slice(offset));
    if (fragment.length === 0) break;
    fragments.push(fragment);
    offset += fragment.length;
  }
  return fragments;
}

function validateOptions(options: LiveStreamStateOptions): void {
  if (options.id.length === 0) throw new Error("stream id is required");
  if (!Number.isFinite(options.publishIntervalMs) || options.publishIntervalMs <= 0) {
    throw new Error("publishIntervalMs must be positive");
  }
  if (!Number.isFinite(options.persistIntervalMs) || options.persistIntervalMs <= 0) {
    throw new Error("persistIntervalMs must be positive");
  }
  if (!Number.isSafeInteger(options.maxTextBytes) || options.maxTextBytes <= 0) {
    throw new Error("maxTextBytes must be a positive integer");
  }
}

export function createLiveStreamState(options: LiveStreamStateOptions): LiveStreamState {
  validateOptions(options);
  const chunks: string[] = [];
  let cachedContent = "";
  let contentDirty = false;
  let byteCount = 0;
  let lastPublishMs = 0;
  let lastPersistMs = 0;
  let started = false;
  let closed = false;
  let hitLimit = false;

  const materialize = () => {
    if (contentDirty) {
      cachedContent = chunks.join("");
      contentDirty = false;
    }
    return cachedContent;
  };

  const state: LiveStreamState = {
    id: options.id,
    get content() {
      return materialize();
    },
    get bytes() {
      return byteCount;
    },
    get limited() {
      return hitLimit;
    },
    append(chunk, now) {
      if (closed || hitLimit || chunk.length === 0) return;
      const availableBytes = options.maxTextBytes - byteCount;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      const accepted = chunkBytes <= availableBytes ? chunk : utf8Prefix(chunk, availableBytes);
      if (accepted.length > 0) {
        chunks.push(accepted);
        contentDirty = true;
        byteCount += Buffer.byteLength(accepted, "utf8");
      }

      if (!started && accepted.length > 0) {
        started = true;
        lastPublishMs = now;
        lastPersistMs = now;
        options.onPersist(materialize(), false);
      } else if (accepted.length > 0) {
        if (now - lastPublishMs >= options.publishIntervalMs) {
          lastPublishMs = now;
          options.onPublish(materialize(), false);
        }
        if (now - lastPersistMs >= options.persistIntervalMs) {
          lastPersistMs = now;
          options.onPersist(materialize(), false);
        }
      }

      if (accepted.length !== chunk.length || byteCount >= options.maxTextBytes) {
        hitLimit = true;
        options.onLimit();
      }
    },
    finalize(_now) {
      const content = materialize();
      if (closed) return content;
      closed = true;
      if (content.length > 0) {
        options.onPublish(content, true);
        options.onPersist(content, true);
      }
      return content;
    },
  };

  return state;
}
