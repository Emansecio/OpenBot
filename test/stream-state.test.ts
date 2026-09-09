import { describe, expect, it } from "vitest";

import { boundedTranscriptFragment, createLiveStreamState, MAX_TRANSCRIPT_DELTA_BYTES, splitTranscriptFragments } from "../src/rpc/stream-state.js";

describe("LiveStreamState", () => {
  it("publishes at 100ms and persists at 1000ms", () => {
    const events: string[] = [];
    const state = createLiveStreamState({
      id: "assistant-1",
      publishIntervalMs: 100,
      persistIntervalMs: 1000,
      maxTextBytes: 192 * 1024,
      onPublish: (content) => events.push(`publish:${content}`),
      onPersist: (content) => events.push(`persist:${content}`),
      onLimit: () => events.push("limit"),
    });

    state.append("a", 0);
    state.append("b", 50);
    state.append("c", 100);
    state.append("d", 1000);

    expect(events).toEqual(["persist:a", "publish:abc", "publish:abcd", "persist:abcd"]);
  });

  it("keeps a valid UTF-8 prefix and reports the byte limit once", () => {
    const limited: string[] = [];
    const state = createLiveStreamState({
      id: "assistant-1",
      publishIntervalMs: 100,
      persistIntervalMs: 1000,
      maxTextBytes: 5,
      onPublish: () => {},
      onPersist: () => {},
      onLimit: () => limited.push("limit"),
    });

    state.append("ab", 0);
    state.append("\u20acx", 1);
    state.append("ignored", 2);

    expect(state.finalize(3)).toBe("ab\u20ac");
    expect(Buffer.byteLength(state.content, "utf8")).toBe(5);
    expect(limited).toEqual(["limit"]);
  });

  it("finalizes and publishes the final content only once", () => {
    const events: string[] = [];
    const state = createLiveStreamState({
      id: "assistant-1",
      publishIntervalMs: 100,
      persistIntervalMs: 1000,
      maxTextBytes: 192 * 1024,
      onPublish: (content) => events.push(`publish:${content}`),
      onPersist: (content) => events.push(`persist:${content}`),
      onLimit: () => {},
    });

    state.append("final", 0);
    expect(state.finalize(10)).toBe("final");
    expect(state.finalize(20)).toBe("final");
    expect(events).toEqual(["persist:final", "publish:final", "persist:final"]);
  });

  it("splits oversized fragments at UTF-8 boundaries", () => {
    const source = "😀".repeat(MAX_TRANSCRIPT_DELTA_BYTES);
    const fragments = splitTranscriptFragments(source);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join("")).toBe(source);
    expect(fragments.every((fragment) => Buffer.byteLength(fragment, "utf8") <= MAX_TRANSCRIPT_DELTA_BYTES)).toBe(true);
    expect(boundedTranscriptFragment("😀")).toBe("😀");
  });
});
