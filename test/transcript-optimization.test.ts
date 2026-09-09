import { describe, expect, it } from "vitest";

import { createMemoryTranscriptStore } from "../src/rpc/send.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const message = (id: string, role: "user" | "assistant", content = id) => ({
  kind: "message" as const,
  id,
  role,
  content,
  timestampMs: 1,
  streaming: false,
});

describe("limited TranscriptStore queries", () => {
  it("returns only the recent entries in chronological order", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 20 }, (_, i) => message(`m-${i}`, i % 2 ? "assistant" : "user")));

    expect(store.getRecentEntries("a", { limit: 3 }).map((entry) => entry.id)).toEqual(["m-17", "m-18", "m-19"]);
  });

  it("returns the earliest user without a full-history API", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [message("a0", "assistant"), message("u1", "user"), message("u2", "user")]);

    expect(store.getEarliestUser("a")?.id).toBe("u1");
  });

  it("returns the latest assistant without a full-history API", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [message("u", "user"), message("a1", "assistant"), message("a2", "assistant")]);

    expect(store.getLatestAssistant("a")?.id).toBe("a2");
  });

  it("returns only pending and running tool calls", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "tool-call", id: "p", name: "file", summary: "p", status: "pending" },
      { kind: "tool-call", id: "r", name: "file", summary: "r", status: "running" },
      { kind: "tool-call", id: "c", name: "file", summary: "c", status: "completed" },
    ]);

    expect(store.getOpenToolCalls("a").map((entry) => entry.id)).toEqual(["p", "r"]);
  });
});

describe("limited SQLite TranscriptStore queries", () => {
  it("matches recent/latest/open query semantics", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", [
        message("u", "user"),
        message("a1", "assistant"),
        { kind: "tool-call", id: "p", name: "file", summary: "p", status: "pending" },
        { kind: "tool-call", id: "c", name: "file", summary: "c", status: "completed" },
        message("a2", "assistant"),
        { kind: "tool-call", id: "r", name: "file", summary: "r", status: "running" },
      ]);

      expect(store.getRecentEntries("a", { limit: 3 }).map((entry) => entry.id)).toEqual(["c", "a2", "r"]);
      expect(store.getRecentEntries("a", { limit: 2, kinds: ["message"] }).map((entry) => entry.id)).toEqual(["a1", "a2"]);
      expect(store.getEarliestUser("a")?.id).toBe("u");
      expect(store.getLatestAssistant("a")?.id).toBe("a2");
      expect(store.getOpenToolCalls("a").map((entry) => entry.id)).toEqual(["p", "r"]);
    } finally {
      store.close();
    }
  });

  it("returns only the requested tail from 10,000 entries", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", Array.from({ length: 10_000 }, (_, i) => message(`m-${i}`, i % 2 ? "assistant" : "user")));

      expect(store.getRecentEntries("a", { limit: 3 }).map((entry) => entry.id)).toEqual(["m-9997", "m-9998", "m-9999"]);
    } finally {
      store.close();
    }
  });

  it("keeps outline semantics without a full transcript read", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", [
        message("blank", "user", "   "),
        message("title", "user", "Primeira pergunta"),
        { kind: "notice", text: "ignorar", level: "info" },
        message("last", "assistant", "Ãšltima resposta"),
      ]);

      expect(store.getConversationOutline("a")).toEqual({
        title: "Primeira pergunta",
        lastMessage: "Ãšltima resposta",
      });
    } finally {
      store.close();
    }
  });

  it("separa tail durável do preview live usado pelo renderer", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", [{ ...message("assistant", "assistant", "checkpoint"), streaming: true }]);
      store.setLiveEntry("a", { ...message("assistant", "assistant", "uncheckpointed"), streaming: true });

      const live = store.openAgentTail("a").entries.at(-1);
      const durable = store.openDurableAgentTail("a").entries.at(-1);
      expect(live?.kind === "message" ? live.content : undefined).toBe("uncheckpointed");
      expect(durable?.kind === "message" ? durable.content : undefined).toBe("checkpoint");
    } finally {
      store.close();
    }
  });

  it("keeps exactly the newest accepted nonces", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      for (let i = 0; i < 8; i += 1) store.rememberAcceptedNonce("a", `n-${i}`);
      store.trimAcceptedNonces("a", 3);

      expect([0, 1, 2, 3, 4].every((i) => !store.hasAcceptedNonce("a", `n-${i}`))).toBe(true);
      expect([5, 6, 7].every((i) => store.hasAcceptedNonce("a", `n-${i}`))).toBe(true);
      store.trimAcceptedNonces("a", 0);
      expect(store.hasAcceptedNonce("a", "n-7")).toBe(false);
    } finally {
      store.close();
    }
  });
});
