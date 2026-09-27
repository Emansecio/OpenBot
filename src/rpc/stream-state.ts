import { utf8Prefix } from "../shared/utf8.js";

export const STREAM_PUBLISH_INTERVAL_MS = 100;
export const STREAM_PERSIST_INTERVAL_MS = 1000;
export const MAX_LIVE_RESPONSE_BYTES = 192 * 1024;
/** Maximum fragment emitted by the transcript delta transport. */
export const MAX_TRANSCRIPT_DELTA_BYTES = 16 * 1024;

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
