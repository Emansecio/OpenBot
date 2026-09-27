/**
 * Orderly teardown of a running gateway (stopServer): quiesce, cancel turns,
 * stop the background runtimes, close the listener, then close dependent
 * resources once the turns have drained. Every step is attempted even when an
 * earlier one fails; failures are reported together.
 */
import type { ServerHandle } from "../main.js";

const persistentStoreClose = new WeakMap<ServerHandle, Promise<void>>();
const serverShutdown = new WeakMap<ServerHandle, Promise<void>>();
const DEFAULT_DRAIN_TIMEOUT_MS = 250;

function shutdownFailureMessage(failures: readonly unknown[]): string {
  const details = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; ");
  return `server shutdown failed in ${failures.length} cleanup steps: ${details}`;
}

export interface StopServerOptions {
  turnTimeoutMs?: number;
  /** Maximum time to wait for turns after abortAllTurns reports a timeout. */
  drainTimeoutMs?: number;
}

function closePersistentStoresOnce(handle: ServerHandle): Promise<void> {
  const existing = persistentStoreClose.get(handle);
  if (existing !== undefined) return existing;
  const closing = (async () => {
    const failures: unknown[] = [];
    const closes = [
      () => handle.store.close(),
      ...(handle.conversationStore === handle.store.conversationStore
        ? []
        : [() => handle.conversationStore.close()]),
    ];
    for (const close of closes) {
      try {
        await Promise.resolve(close());
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `persistent store shutdown failed in ${failures.length} cleanup steps`);
  })();
  persistentStoreClose.set(handle, closing);
  void closing.catch(() => {
    if (persistentStoreClose.get(handle) === closing) persistentStoreClose.delete(handle);
  });
  return closing;
}

/** Derruba o servidor, encerra SSE e fecha o store SQLite associado. */
export function stopServer(handle: ServerHandle, options: StopServerOptions = {}): Promise<void> {
  handle.config.modelCatalog?.close();
  handle.executionDiagnostics.close();
  const existing = serverShutdown.get(handle);
  if (existing !== undefined) return existing;
  const shutdown = performStopServer(handle, options);
  serverShutdown.set(handle, shutdown);
  void shutdown.catch(() => {
    if (serverShutdown.get(handle) === shutdown) serverShutdown.delete(handle);
  });
  return shutdown;
}

async function performStopServer(handle: ServerHandle, options: StopServerOptions): Promise<void> {
  const failures: unknown[] = [];
  let drainRequired = false;
  const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  };

  // Every resource is attempted even when an earlier cleanup rejects. This is
  // important for shutdown after a provider/runtime failure: a rejected abort
  // must not leave the browser host, gateway, or SQLite handles open.
  handle.gateway.beginQuiescence();
  handle.providerAdmission.shutdown();
  try {
    await handle.runner.abortAllTurns(options.turnTimeoutMs ?? 5_000);
  } catch (error) {
    failures.push(error);
    drainRequired = true;
  }
  // Quiesce the shared async-task worker before closing the listener; otherwise
  // a final SQLite poll can keep the shutdown-test database busy after the
  // HTTP socket has already reported closed.
  await attempt(() => handle.asyncTaskRuntime.stop());
  await attempt(() => handle.a2aRuntime.stop());

  // Stop admission and close SSE first. If turn cancellation timed out, the
  // resources used by those turns remain open until the runner's drain settles.
  await attempt(() => handle.gateway.close());
  await attempt(() => new Promise<void>((resolve, reject) => {
    if (!handle.server.listening) {
      resolve();
      return;
    }
    const forceClose = setTimeout(() => handle.server.closeAllConnections(), 2_000);
    forceClose.unref();
    handle.server.close((err) => {
      clearTimeout(forceClose);
      if (err) reject(err);
      else resolve();
    });
  }));
  // The single bounded stop above is enough. If it timed out, the cleanup
  // branch below waits for the retained loop promise before closing deps.

  const closeDependentResources = async (targetFailures: unknown[]): Promise<void> => {
    const cleanups: Array<() => void | Promise<void>> = [
      () => handle.reflectionWorker?.close(),
      () => handle.providerOAuth?.close(),
      async () => {
        // P2.5: any registered optional adapter (e.g. CLI in-flight
        // executions) gets its lifecycle closed before the broker drains.
        for (const name of handle.registry.names()) {
          try { await handle.registry.get(name)?.close?.(); } catch { /* best effort */ }
        }
      },
      // Both runtimes were stopped before the listener closed; stop() is not repeated here.
      () => handle.providerAdmission.drain(),
      () => handle.executionBroker?.close(),
      () => handle.mcpManager?.close(),
      () => handle.browserSessionManager?.close(),
      () => handle.runtimeManager.close(),
    ];
    const pending: Promise<void>[] = [];
    for (const cleanup of cleanups) {
      try {
        pending.push(Promise.resolve(cleanup()));
      } catch (error) {
        targetFailures.push(error);
      }
    }
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === "rejected") targetFailures.push(result.reason);
    }
    try {
      handle.asyncTaskStore.close();
    } catch (error) {
      targetFailures.push(error);
    }
    try {
      handle.a2aStore.close();
    } catch (error) {
      targetFailures.push(error);
    }
    try {
      await closePersistentStoresOnce(handle);
    } catch (error) {
      targetFailures.push(error);
    }
  };

  let drained = true;
  let drainTimedOut = false;
  let drainPromise: Promise<void> | undefined;
  if (drainRequired) {
    const timeoutMs = Math.max(0, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    try {
      drainPromise = handle.runner.waitForDrain();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timeoutError: Error | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutError = new Error(`turn drain timed out after ${timeoutMs}ms`);
          reject(timeoutError);
        }, timeoutMs);
      });
      try {
        await Promise.race([drainPromise, timeout]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    } catch (error) {
      drained = false;
      drainTimedOut = error instanceof Error && /turn drain timed out/.test(error.message);
      failures.push(error);
    }
  }
  const closeAfterRuntimeDrain = async (): Promise<void> => {
    if (!handle.asyncTaskRuntime.isIdle()) await handle.asyncTaskRuntime.whenIdle();
    const deferredFailures: unknown[] = [];
    await closeDependentResources(deferredFailures);
    if (deferredFailures.length > 0) {
      throw new AggregateError(deferredFailures, "deferred runtime shutdown cleanup failed");
    }
  };

  if (!drained) {
    if (drainTimedOut && drainPromise !== undefined) {
      void drainPromise
        .then(() => closeAfterRuntimeDrain())
        .catch((error) => console.error("[openbot] deferred drain failed:", error));
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, shutdownFailureMessage(failures));
  }
  if (handle.asyncTaskRuntime.isIdle()) {
    await closeDependentResources(failures);
  } else {
    // Never report shutdown success while dependent resources are still
    // closing in the background: the SIGINT handler exits the process on
    // success and would kill the in-flight SQLite/journal/browser closes.
    // The wait stays bounded so a non-cooperative claim cannot hang shutdown.
    const deferredTimeoutMs = Math.max(0, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    try {
      let deferredTimer: ReturnType<typeof setTimeout> | undefined;
      const deferredTimeout = new Promise<never>((_, reject) => {
        deferredTimer = setTimeout(() => reject(new Error(`deferred runtime drain timed out after ${deferredTimeoutMs}ms`)), deferredTimeoutMs);
      });
      try {
        await Promise.race([closeAfterRuntimeDrain(), deferredTimeout]);
      } finally {
        if (deferredTimer !== undefined) clearTimeout(deferredTimer);
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, shutdownFailureMessage(failures));
}
