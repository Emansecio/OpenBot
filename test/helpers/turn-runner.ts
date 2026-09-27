// Shared TurnRunner fixtures for the rpc-send test files.
import { createProviderRegistry } from "../../src/providers/router.js";
import { createTurnRunner, type TurnRunnerOptions } from "../../src/rpc/send.js";
import { createFakeAdapter } from "../mocks/fake-provider-adapter.js";

/** Coleta os eventos publicados pelo runner (pub fake — sem HTTP). */
export function collectPublish() {
  const events: { channel: string; payload: unknown }[] = [];
  return {
    events,
    publish: (channel: string, payload: unknown) => {
      events.push({ channel, payload });
    },
  };
}

/** Relógio determinístico (entries com timestampMs estável e crescente). */
export function fixedClock() {
  let t = 1_000;
  return {
    now: () => (t += 1),
  };
}

export function ids() {
  let n = 0;
  return { newId: () => `id:${++n}` };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export type RunnerOpts = Omit<TurnRunnerOptions, "now" | "newId"> & {
  now?: () => number;
  newId?: (role: "user" | "assistant") => string;
};

export function makeRunner(opts: RunnerOpts = {}): {
  runner: ReturnType<typeof createTurnRunner>;
  events: ReturnType<typeof collectPublish>["events"];
} {
  const now = opts.now ?? fixedClock().now;
  const newId = opts.newId ?? ids().newId;
  const pub = collectPublish();
  const runner = createTurnRunner({
    registry: opts.registry,
    store: opts.store,
    config: opts.config,
    systemPrompt: opts.systemPrompt,
    resolveProvider: opts.resolveProvider,
    publish: pub.publish,
    now,
    newId,
    ledgerCap: opts.ledgerCap,
  });
  return { runner, events: pub.events };
}

/** Registra um adapter fake como "xai" (provider do modelo default do catálogo). */
export function fakeXai(deltas: string[] = ["resposta"]): {
  registry: ReturnType<typeof createProviderRegistry>;
  adapter: ReturnType<typeof createFakeAdapter>;
} {
  const registry = createProviderRegistry();
  const adapter = createFakeAdapter("xai", { deltas });
  registry.register(adapter);
  return { registry, adapter };
}
