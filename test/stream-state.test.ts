import { describe, expect, it } from "vitest";

import { boundedTranscriptFragment, MAX_TRANSCRIPT_DELTA_BYTES, splitTranscriptFragments } from "../src/rpc/stream-state.js";

describe("transcript stream fragments", () => {
  it("splits oversized fragments at UTF-8 boundaries", () => {
    const source = "😀".repeat(MAX_TRANSCRIPT_DELTA_BYTES);
    const fragments = splitTranscriptFragments(source);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join("")).toBe(source);
    expect(fragments.every((fragment) => Buffer.byteLength(fragment, "utf8") <= MAX_TRANSCRIPT_DELTA_BYTES)).toBe(true);
    expect(boundedTranscriptFragment("😀")).toBe("😀");
  });
});
