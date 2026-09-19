import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { ProviderAdmissionMetrics } from "../providers/admission.js";
import type { AgentRuntimeBackend } from "../execution/runtime/agent-backend.js";
import type { RuntimeAdmissionMetrics } from "../execution/runtime/scheduler.js";

export interface ExecutionDiagnosticsSources {
  provider(): ProviderAdmissionMetrics;
  runtime(): RuntimeAdmissionMetrics | null;
  workspaces(): Array<{ agentId: string; quota: ReturnType<AgentRuntimeBackend["quotaMetrics"]> }>;
}

/** Process-local, content-free counters. Reading them never starts work or scans disk. */
export class ExecutionDiagnostics {
  private readonly startedAt = performance.now();
  private readonly initialUtilization = performance.eventLoopUtilization();
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private closed = false;

  constructor(private readonly sources: ExecutionDiagnosticsSources) {
    this.delay.enable();
  }

  snapshot() {
    const samples = this.delay.count;
    const milliseconds = (value: number): number | null => samples === 0 || !Number.isFinite(value) ? null : value / 1e6;
    return {
      version: 1,
      observedMs: Math.max(0, performance.now() - this.startedAt),
      provider: this.sources.provider(),
      runtime: this.sources.runtime(),
      workspaces: this.sources.workspaces(),
      gateway: {
        memoryBytes: process.memoryUsage(),
        eventLoop: {
          samples,
          meanDelayMs: milliseconds(this.delay.mean),
          maxDelayMs: milliseconds(this.delay.max),
          p99DelayMs: milliseconds(this.delay.percentile(99)),
          utilization: performance.eventLoopUtilization(this.initialUtilization).utilization,
        },
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.delay.disable();
  }
}
