import { describe, expect, it } from "vitest";

import {
  MAX_DELEGATED_GRANT_ARRAY_ITEMS,
  MAX_DELEGATED_GRANT_STRING_BYTES,
  parseDelegatedCapabilityGrant,
  mcpGrantTools,
  type AsyncTaskStatus,
  type BudgetCounters,
  type DelegatedCapabilityGrant,
  type DelegatedCapabilityOperation,
  type GrantOperationContext,
  type SubagentBudget,
} from "../src/tasks/contracts.js";
import {
  MAX_TASK_CLIENT_NONCE_BYTES,
  TASK_RESULT_MIN_TRUNCATION_MARKER,
  TASK_RESULT_TRUNCATION_MARKER,
  assertGrantAllowsOperation,
  assertTaskWithinWallBudget,
  assertTaskTransition,
  deriveEffectiveBudget,
  deriveEffectiveGrant,
  emptyBudgetCounters,
  emptyBudgetUsage,
  limitTaskResultUtf8,
  reconcileBudgetReservation,
  remainingBudget,
  requireTaskClientNonce,
  reserveBudget,
} from "../src/tasks/state-machine.js";

const statuses: readonly AsyncTaskStatus[] = [
  "queued",
  "admitted",
  "running",
  "retry_wait",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
];

const allowedTransitions = new Set([
  "queued:admitted",
  "queued:cancelled",
  "admitted:running",
  "admitted:cancelling",
  "admitted:abandoned",
  "running:completed",
  "running:failed",
  "running:retry_wait",
  "running:cancelling",
  "running:abandoned",
  "retry_wait:admitted",
  "retry_wait:failed",
  "retry_wait:cancelled",
  "cancelling:cancelled",
  "cancelling:abandoned",
  "abandoned:retry_wait",
  "abandoned:failed",
  "abandoned:cancelled",
]);

describe("async task state machine", () => {
  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))(
    "enforces the complete transition matrix: %s -> %s",
    (from, to) => {
      if (allowedTransitions.has(`${from}:${to}`)) {
        expect(() => assertTaskTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertTaskTransition(from, to)).toThrowError(
          expect.objectContaining({ code: "invalid_transition" }),
        );
      }
    },
  );
});

describe("task client nonce", () => {
  it("trims and NFC-normalizes a valid nonce deterministically", () => {
    expect(requireTaskClientNonce("  nonce-e\u0301  ")).toBe("nonce-é");
  });

  it.each([
    "",
    " \t ",
    "bad\0nonce",
    "bad\u0001nonce",
    "bad\rnonce",
    "bad\nnonce",
    "bad\u007fnonce",
    "bad\u0085nonce",
    "bad\u009fnonce",
  ])(
    "rejects an invalid nonce %#",
    (value) => {
      expect(() => requireTaskClientNonce(value)).toThrowError(
        expect.objectContaining({ code: "invalid_nonce" }),
      );
    },
  );

  it("rejects a nonce above the documented UTF-8 byte limit", () => {
    expect(() => requireTaskClientNonce("é".repeat(MAX_TASK_CLIENT_NONCE_BYTES))).toThrowError(
      expect.objectContaining({ code: "invalid_nonce" }),
    );
  });
});

const grantBase = {
  grantId: "grant-1",
  taskId: "task-1",
  parentAgentId: "parent-1",
  parentTurnId: "turn-1",
  childRunId: "child-1",
  issuedAt: 100,
  expiresAt: 1_000,
  version: 3,
  depth: 1,
} as const;

function grantContext(overrides: Partial<GrantOperationContext> = {}): GrantOperationContext {
  return {
    now: 500,
    currentVersion: 3,
    expectedGrantId: grantBase.grantId,
    taskId: grantBase.taskId,
    parentAgentId: grantBase.parentAgentId,
    parentTurnId: grantBase.parentTurnId,
    childRunId: grantBase.childRunId,
    ...overrides,
  };
}

const grantSamples = [
  {
    ...grantBase,
    kind: "provider",
    constraints: {
      adapters: ["openai", "xai"],
      models: ["gpt-5.6-sol"],
      credentialRefs: [{ secretRef: "provider/openai" }],
      allowNoCredential: false,
    },
  },
  {
    ...grantBase,
    kind: "filesystem",
    constraints: { operations: ["read", "list"], roots: ["C:\\Agents\\parent"] },
  },
  {
    ...grantBase,
    kind: "process",
    constraints: {
      operations: ["run"],
      executables: ["node.exe"],
      cwdRoots: ["C:\\Agents\\parent"],
      networkProfiles: ["none"],
    },
  },
  {
    ...grantBase,
    kind: "browser",
    constraints: {
      commandClasses: ["navigate", "observe"],
      origins: ["HTTPS://Example.COM:443/path"],
      partitionAgentId: "parent-1",
    },
  },
  {
    ...grantBase,
    kind: "mcp",
    constraints: { serverIds: ["docs"], toolNames: ["search"] },
  },
  {
    ...grantBase,
    kind: "skill",
    constraints: { skillIds: ["tdd"] },
  },
] as const;

describe("delegated capability grants", () => {
  it("rejects revocation timestamps outside the grant lifetime", () => {
    const grant = grantSamples[5];
    expect(() => parseDelegatedCapabilityGrant({ ...grant, revokedAt: grant.issuedAt - 1 }))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    expect(() => parseDelegatedCapabilityGrant({ ...grant, revokedAt: grant.expiresAt + 1 }))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    expect(() => parseDelegatedCapabilityGrant({ ...grant, revokedAt: grant.issuedAt })).not.toThrow();
    expect(() => parseDelegatedCapabilityGrant({ ...grant, revokedAt: grant.expiresAt })).not.toThrow();
  });

  it.each(grantSamples)("parses and normalizes the closed $kind grant", (sample) => {
    const parsed = parseDelegatedCapabilityGrant(sample);
    const expected = sample.kind === "browser"
      ? { ...sample, constraints: { ...sample.constraints, origins: ["https://example.com"] } }
      : sample.kind === "filesystem"
        ? { ...sample, constraints: { ...sample.constraints, operations: ["list", "read"] } }
      : sample.kind === "mcp"
        ? { ...sample, constraints: { tools: [{ serverId: "docs", toolName: "search" }] } }
        : sample;
    expect(parsed).toEqual(expected);
  });

  it("rejects unknown fields and inline secrets fail-closed", () => {
    expect(() => parseDelegatedCapabilityGrant({ ...grantSamples[0], extra: true })).toThrowError(
      expect.objectContaining({ code: "invalid_contract" }),
    );
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, token: "plaintext" },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, credentialRefs: [{ secretRef: " \0 " }] },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it.each(["sk-live-plaintext", "plainref"])("rejects non-canonical opaque secretRef %s", (secretRef) => {
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, credentialRefs: [{ secretRef }] },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it.each(["grant\u0085id", "grant\u009fid"])("rejects C1 controls in grant identifiers %#", (grantId) => {
    expect(() => parseDelegatedCapabilityGrant({ ...grantSamples[5], grantId }))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it.each(["apiKey", "cookie", "secret"])("rejects an inline %s field", (field) => {
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, [field]: "plaintext" },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("rejects abusive grant strings and arrays", () => {
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[5],
      constraints: { skillIds: ["x".repeat(MAX_DELEGATED_GRANT_STRING_BYTES + 1)] },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[5],
      constraints: { skillIds: Array.from({ length: MAX_DELEGATED_GRANT_ARRAY_ITEMS + 1 }, (_, index) => `skill-${index}`) },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("intersects requested, parent, and hard policy without escalation", () => {
    const requested = grantSamples[0];
    const parent = {
      ...requested,
      grantId: "parent-grant",
      constraints: {
        adapters: ["openai"],
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        credentialRefs: [{ secretRef: "provider/openai" }, { secretRef: "provider/xai" }],
        allowNoCredential: false,
      },
    };
    const policy = {
      ...requested,
      grantId: "policy-grant",
      expiresAt: 900,
      constraints: {
        adapters: ["openai"],
        models: ["gpt-5.6-sol"],
        credentialRefs: [{ secretRef: "provider/openai" }],
        allowNoCredential: false,
      },
    };

    const effective = deriveEffectiveGrant(requested, parent, policy, 500);
    expect(effective).toMatchObject({
      expiresAt: 900,
      constraints: {
        adapters: ["openai"],
        models: ["gpt-5.6-sol"],
        credentialRefs: [{ secretRef: "provider/openai" }],
      },
    });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "provider",
      adapter: "xai",
      model: "gpt-5.6-sol",
      credential: { kind: "secret_ref", secretRef: "provider/openai" },
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("preserves the earliest scheduled revocation from every authority", () => {
    const requested = { ...grantSamples[5], revokedAt: 800 };
    const parent = { ...grantSamples[5], grantId: "parent-grant", revokedAt: 600 };
    const policy = { ...grantSamples[5], grantId: "policy-grant", revokedAt: 700 };

    const effective = deriveEffectiveGrant(requested, parent, policy, 500);
    expect(effective.revokedAt).toBe(600);
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "skill",
      skillId: "tdd",
    }, grantContext({ now: 599 }))).not.toThrow();
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "skill",
      skillId: "tdd",
    }, grantContext({ now: 600 }))).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("omits a scheduled revocation made redundant by an earlier effective expiry", () => {
    const requested = { ...grantSamples[5], expiresAt: 1_000, revokedAt: 900 };
    const parent = { ...grantSamples[5], grantId: "parent-grant", expiresAt: 800 };
    const policy = { ...grantSamples[5], grantId: "policy-grant", expiresAt: 950 };

    const effective = deriveEffectiveGrant(requested, parent, policy, 500);
    expect(effective.expiresAt).toBe(800);
    expect(effective).not.toHaveProperty("revokedAt");
    expect(parseDelegatedCapabilityGrant(effective)).toEqual(effective);
  });

  it("uses the latest issuance boundary and denies operation before it", () => {
    const requested = { ...grantSamples[5], issuedAt: 100 };
    const parent = { ...grantSamples[5], grantId: "parent-grant", issuedAt: 300 };
    const policy = { ...grantSamples[5], grantId: "policy-grant", issuedAt: 550 };

    const effective = deriveEffectiveGrant(requested, parent, policy, 600);
    expect(effective.issuedAt).toBe(550);
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "skill",
      skillId: "tdd",
    }, grantContext({ now: 549 }))).toThrowError(expect.objectContaining({ code: "capability_denied" }));
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "skill",
      skillId: "tdd",
    }, grantContext({ now: 550 }))).not.toThrow();
  });

  it.each([
    ["taskId", { taskId: "other-task" }],
    ["parentAgentId", { parentAgentId: "other-parent" }],
    ["parentTurnId", { parentTurnId: "other-turn" }],
    ["childRunId", { childRunId: "other-run" }],
  ] as const)("denies an operation when expected %s does not match", (_field, override) => {
    expect(() => assertGrantAllowsOperation(parseDelegatedCapabilityGrant(grantSamples[5]), {
      kind: "skill",
      skillId: "tdd",
    }, grantContext(override))).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("binds operation authorization to the exact effective grant ID", () => {
    const requested = { ...grantSamples[5], constraints: { skillIds: ["tdd"] } };
    const broaderParent = {
      ...requested,
      grantId: "parent-grant",
      constraints: { skillIds: ["tdd", "admin"] },
    };
    const hardPolicy = { ...broaderParent, grantId: "policy-grant" };
    const effective = deriveEffectiveGrant(requested, broaderParent, hardPolicy, 500);
    const effectiveContext = { ...grantContext(), expectedGrantId: effective.grantId };

    expect(effective.constraints).toMatchObject({ skillIds: ["tdd"] });
    expect(() => assertGrantAllowsOperation(parseDelegatedCapabilityGrant(broaderParent), {
      kind: "skill",
      skillId: "admin",
    }, effectiveContext)).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("requires an explicit provider credential selection", () => {
    const credentialGrant = parseDelegatedCapabilityGrant(grantSamples[0]);
    expect(() => assertGrantAllowsOperation(credentialGrant, {
      kind: "provider",
      adapter: "openai",
      model: "gpt-5.6-sol",
    } as unknown as DelegatedCapabilityOperation, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("allows an explicit no-credential provider call when granted", () => {
    const noCredentialGrant = parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: {
        ...grantSamples[0].constraints,
        credentialRefs: [],
        allowNoCredential: true,
      },
    });
    const explicitNone = {
      kind: "provider",
      adapter: "openai",
      model: "gpt-5.6-sol",
      credential: { kind: "none" },
    } as unknown as DelegatedCapabilityOperation;
    expect(() => assertGrantAllowsOperation(noCredentialGrant, explicitNone, grantContext())).not.toThrow();
  });

  it("default-denies omitted and explicit no-credential provider calls", () => {
    const emptyDefaultDenyGrant = parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: {
        ...grantSamples[0].constraints,
        credentialRefs: [],
        allowNoCredential: false,
      },
    });
    const omittedCredential = {
      kind: "provider",
      adapter: "openai",
      model: "gpt-5.6-sol",
    } as unknown as DelegatedCapabilityOperation;
    const explicitNone = {
      kind: "provider",
      adapter: "openai",
      model: "gpt-5.6-sol",
      credential: { kind: "none" },
    } as unknown as DelegatedCapabilityOperation;
    expect(() => assertGrantAllowsOperation(emptyDefaultDenyGrant, omittedCredential, grantContext()))
      .toThrowError(expect.objectContaining({ code: "capability_denied" }));
    expect(() => assertGrantAllowsOperation(emptyDefaultDenyGrant, explicitNone, grantContext()))
      .toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("rejects a non-boolean no-credential provider constraint", () => {
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, allowNoCredential: "yes" },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("intersects the explicit no-credential authority instead of broadening it", () => {
    const requested = {
      ...grantSamples[0],
      constraints: { ...grantSamples[0].constraints, credentialRefs: [], allowNoCredential: true },
    };
    const parent = {
      ...requested,
      grantId: "parent-grant",
      constraints: { ...requested.constraints, allowNoCredential: false },
    };
    const policy = { ...requested, grantId: "policy-grant" };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.kind).toBe("provider");
    if (effective.kind !== "provider") throw new Error("expected provider grant");
    expect(effective.constraints.allowNoCredential).toBe(false);
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "provider",
      adapter: "openai",
      model: "gpt-5.6-sol",
      credential: { kind: "none" },
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("uses Windows-safe root intersection and rejects prefix collisions", () => {
    const requested = {
      ...grantSamples[1],
      constraints: { operations: ["read"] as const, roots: ["C:\\Agents\\parent-child"] },
    };
    const parent = {
      ...grantSamples[1],
      grantId: "parent-grant",
      constraints: { operations: ["read"] as const, roots: ["C:\\Agents\\parent"] },
    };
    const policy = { ...parent, grantId: "policy-grant" };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.constraints).toMatchObject({ roots: [] });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "filesystem",
      operation: "read",
      path: "C:\\Agents\\parent-child\\secret.txt",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("narrows process authority across requested, parent, and policy grants", () => {
    const requested = {
      ...grantSamples[2],
      constraints: { ...grantSamples[2].constraints, executables: ["node.exe", "python.exe"] },
    };
    const parent = {
      ...requested,
      grantId: "parent-grant",
      constraints: { ...requested.constraints, executables: ["node.exe"] },
    };
    const policy = { ...requested, grantId: "policy-grant" };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.constraints).toMatchObject({ executables: ["node.exe"] });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "process",
      operation: "run",
      executable: "python.exe",
      cwd: "C:\\Agents\\parent",
      networkProfile: "none",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("narrows browser authority across requested, parent, and policy grants", () => {
    const requested = {
      ...grantSamples[3],
      constraints: {
        ...grantSamples[3].constraints,
        commandClasses: ["navigate", "interact"],
        origins: ["https://example.com", "https://admin.example"],
      },
    };
    const parent = {
      ...requested,
      grantId: "parent-grant",
      constraints: { ...requested.constraints, commandClasses: ["navigate"] },
    };
    const policy = {
      ...requested,
      grantId: "policy-grant",
      constraints: { ...requested.constraints, origins: ["https://example.com"] },
    };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.constraints).toMatchObject({
      commandClasses: ["navigate"],
      origins: ["https://example.com"],
    });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "browser",
      commandClass: "interact",
      origin: "https://admin.example",
      partitionAgentId: "parent-1",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("narrows MCP authority across requested, parent, and policy grants", () => {
    const requested = {
      ...grantSamples[4],
      constraints: { tools: [{ serverId: "docs", toolName: "search" }, { serverId: "admin", toolName: "delete" }] },
    };
    const parent = {
      ...requested,
      grantId: "parent-grant",
      constraints: { tools: [{ serverId: "docs", toolName: "search" }] },
    };
    const policy = {
      ...requested,
      grantId: "policy-grant",
      constraints: { tools: [{ serverId: "docs", toolName: "search" }] },
    };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.constraints).toMatchObject({ tools: [{ serverId: "docs", toolName: "search" }] });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "mcp",
      serverId: "admin",
      toolName: "delete",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("authorizes MCP by exact server/tool pair, never by a Cartesian product", () => {
    const grant = parseDelegatedCapabilityGrant({
      ...grantSamples[4],
      constraints: { tools: [{ serverId: "A", toolName: "foo" }, { serverId: "B", toolName: "bar" }] },
    });
    if (grant.kind !== "mcp") throw new Error("expected MCP grant");
    expect(grant).toMatchObject({ kind: "mcp", constraints: { tools: [{ serverId: "A", toolName: "foo" }, { serverId: "B", toolName: "bar" }] } });
    expect(mcpGrantTools(grant.constraints)).toEqual([{ serverId: "A", toolName: "foo" }, { serverId: "B", toolName: "bar" }]);
    const context = grantContext({ expectedGrantId: grant.grantId, taskId: grant.taskId, parentAgentId: grant.parentAgentId, parentTurnId: grant.parentTurnId, childRunId: grant.childRunId, currentVersion: grant.version });
    expect(() => assertGrantAllowsOperation(grant, { kind: "mcp", serverId: "A", toolName: "foo" }, context)).not.toThrow();
    expect(() => assertGrantAllowsOperation(grant, { kind: "mcp", serverId: "B", toolName: "bar" }, context)).not.toThrow();
    expect(() => assertGrantAllowsOperation(grant, { kind: "mcp", serverId: "A", toolName: "bar" }, context)).toThrowError(expect.objectContaining({ code: "capability_denied" }));
    expect(() => assertGrantAllowsOperation(grant, { kind: "mcp", serverId: "B", toolName: "foo" }, context)).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("narrows skill authority across requested, parent, and policy grants", () => {
    const requested = {
      ...grantSamples[5],
      constraints: { skillIds: ["tdd", "review"] },
    };
    const parent = { ...requested, grantId: "parent-grant" };
    const policy = {
      ...requested,
      grantId: "policy-grant",
      constraints: { skillIds: ["tdd"] },
    };
    const effective = deriveEffectiveGrant(requested, parent, policy, 500);

    expect(effective.constraints).toMatchObject({ skillIds: ["tdd"] });
    expect(() => assertGrantAllowsOperation(effective, {
      kind: "skill",
      skillId: "review",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it.each([
    ["expired", grantContext({ now: 1_000 })],
    ["stale", grantContext({ currentVersion: 4 })],
  ] as const)("default-denies an %s grant", (_label, context) => {
    expect(() => assertGrantAllowsOperation(parseDelegatedCapabilityGrant(grantSamples[5]), {
      kind: "skill",
      skillId: "tdd",
    }, context)).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("rejects a revoked grant", () => {
    const revoked = { ...grantSamples[5], revokedAt: 400 };
    expect(() => assertGrantAllowsOperation(parseDelegatedCapabilityGrant(revoked), {
      kind: "skill",
      skillId: "tdd",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("rejects stale grant derivation", () => {
    expect(() => deriveEffectiveGrant(grantSamples[5], { ...grantSamples[5], version: 4 }, grantSamples[5], 500))
      .toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("rejects grant derivation with mismatched lineage", () => {
    expect(() => deriveEffectiveGrant(grantSamples[5], { ...grantSamples[5], parentTurnId: "other" }, grantSamples[5], 500))
      .toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("rejects grant derivation at depth two", () => {
    expect(() => deriveEffectiveGrant({ ...grantSamples[5], depth: 2 }, grantSamples[5], grantSamples[5], 500))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("default-denies a missing grant", () => {
    expect(() => assertGrantAllowsOperation(undefined, {
      kind: "skill",
      skillId: "tdd",
    }, grantContext())).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });

  it("enforces browser partition binding", () => {
    expect(() => parseDelegatedCapabilityGrant({
      ...grantSamples[3],
      constraints: { ...grantSamples[3].constraints, partitionAgentId: "child-1" },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("authorizes each closed operation kind only within its constraints", () => {
    const cases: readonly [DelegatedCapabilityGrant, Parameters<typeof assertGrantAllowsOperation>[1]][] = [
      [parseDelegatedCapabilityGrant(grantSamples[0]), { kind: "provider", adapter: "openai", model: "gpt-5.6-sol", credential: { kind: "secret_ref", secretRef: "provider/openai" } }],
      [parseDelegatedCapabilityGrant(grantSamples[1]), { kind: "filesystem", operation: "list", path: "C:\\Agents\\parent\\docs" }],
      [parseDelegatedCapabilityGrant(grantSamples[2]), { kind: "process", operation: "run", executable: "node.exe", cwd: "C:\\Agents\\parent", networkProfile: "none" }],
      [parseDelegatedCapabilityGrant(grantSamples[3]), { kind: "browser", commandClass: "navigate", origin: "https://example.com/page", partitionAgentId: "parent-1" }],
      [parseDelegatedCapabilityGrant(grantSamples[4]), { kind: "mcp", serverId: "docs", toolName: "search" }],
      [parseDelegatedCapabilityGrant(grantSamples[5]), { kind: "skill", skillId: "tdd" }],
    ];
    for (const [grant, operation] of cases) {
      expect(() => assertGrantAllowsOperation(grant, operation, grantContext())).not.toThrow();
    }
  });

  it.each([
    ["process", grantSamples[2], { kind: "process", operation: "run", executable: "python.exe", cwd: "C:\\Agents\\parent", networkProfile: "none" }],
    ["browser", grantSamples[3], { kind: "browser", commandClass: "navigate", origin: "https://denied.example", partitionAgentId: "parent-1" }],
    ["MCP", grantSamples[4], { kind: "mcp", serverId: "docs", toolName: "delete" }],
    ["skill", grantSamples[5], { kind: "skill", skillId: "unapproved" }],
  ] as const)("default-denies an out-of-constraint %s operation", (_kind, grant, operation) => {
    expect(() => assertGrantAllowsOperation(
      parseDelegatedCapabilityGrant(grant),
      operation as DelegatedCapabilityOperation,
      grantContext(),
    )).toThrowError(expect.objectContaining({ code: "capability_denied" }));
  });
});

const budgetFields = [
  "maxWallMs",
  "maxProviderCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxToolRounds",
  "maxToolCalls",
  "maxMcpCalls",
  "maxBrowserCommands",
  "maxResultBytes",
  "maxWorkspaceWriteBytes",
] as const;

const fullBudget: SubagentBudget = {
  maxWallMs: 1_000,
  maxProviderCalls: 10,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxToolRounds: 10,
  maxToolCalls: 20,
  maxMcpCalls: 10,
  maxBrowserCommands: 10,
  maxResultBytes: 1_000,
  maxWorkspaceWriteBytes: 10_000,
  maxDepth: 1,
};

function counters(values: Partial<BudgetCounters> = {}): BudgetCounters {
  return { ...emptyBudgetCounters(), ...values };
}

describe("shared subagent budget", () => {
  it("derives the minimum authority for every exact budget field", () => {
    const hardCap = Object.fromEntries(budgetFields.map((field) => [field, 300]));
    const parentRemaining = Object.fromEntries(budgetFields.map((field) => [field, 200]));
    const requested = Object.fromEntries(budgetFields.map((field) => [field, 250]));
    const effective = deriveEffectiveBudget(
      { ...hardCap, maxDepth: 1 },
      { ...parentRemaining, maxDepth: 1 },
      { ...requested, maxDepth: 1 },
    );
    for (const field of budgetFields) expect(effective[field]).toBe(200);
    expect(effective.maxDepth).toBe(1);
  });

  it("preserves zero dimensions and exhausts only the operation that consumes them", () => {
    const parentRemaining = { ...fullBudget, maxWallMs: 0, maxMcpCalls: 0 };
    const effective = deriveEffectiveBudget(fullBudget, parentRemaining, fullBudget);

    expect(effective.maxWallMs).toBe(0);
    expect(effective.maxMcpCalls).toBe(0);
    expect(() => reserveBudget(effective, emptyBudgetUsage(), {
      reservationId: "filesystem-write",
      amounts: counters({ workspaceWriteBytes: 1 }),
    })).not.toThrow();
    expect(() => reserveBudget(effective, emptyBudgetUsage(), {
      reservationId: "mcp-call",
      amounts: counters({ mcpCalls: 1 }),
    })).toThrowError(expect.objectContaining({ code: "budget_exhausted" }));
    expect(() => assertTaskWithinWallBudget({ createdAtMs: 1_000 }, effective, 1_000))
      .toThrowError(expect.objectContaining({ code: "budget_exhausted" }));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid budget cap: %s",
    (invalid) => {
      expect(() => deriveEffectiveBudget({ ...fullBudget, maxToolCalls: invalid }, fullBudget, fullBudget))
        .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    },
  );

  it.each(budgetFields)("rejects zero for the positive %s cap", (field) => {
    expect(() => deriveEffectiveBudget({ ...fullBudget, [field]: 0 }, fullBudget, fullBudget))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("rejects depth above one", () => {
    expect(() => deriveEffectiveBudget({ ...fullBudget, maxDepth: 2 }, fullBudget, fullBudget))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it.each(["reservation\u0085id", "reservation\u009fid"])(
    "rejects C1 controls in reservation identifiers %#",
    (reservationId) => {
      expect(() => reserveBudget(fullBudget, emptyBudgetUsage(), {
        reservationId,
        amounts: counters({ toolCalls: 1 }),
      })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    },
  );

  it("reserves against used plus all outstanding reservations transactionally", () => {
    const first = reserveBudget(fullBudget, emptyBudgetUsage(), {
      reservationId: "reservation-1",
      amounts: counters({ providerCalls: 6 }),
    });
    expect(first.reserved.providerCalls).toBe(6);
    expect(() => reserveBudget(fullBudget, first, {
      reservationId: "reservation-2",
      amounts: counters({ providerCalls: 5 }),
    })).toThrowError(expect.objectContaining({ code: "budget_exhausted" }));
  });

  it("reconciles exactly one reservation and adds actual usage no greater than reserved", () => {
    const reserved = reserveBudget(fullBudget, emptyBudgetUsage(), {
      reservationId: "reservation-1",
      amounts: counters({ inputTokens: 1_000, outputTokens: 500, toolCalls: 2 }),
    });
    const reconciled = reconcileBudgetReservation(reserved, "reservation-1", counters({
      inputTokens: 800,
      outputTokens: 450,
      toolCalls: 1,
    }));

    expect(reconciled.reservations).toEqual([]);
    expect(reconciled.reserved).toEqual(emptyBudgetCounters());
    expect(reconciled.used).toMatchObject({ inputTokens: 800, outputTokens: 450, toolCalls: 1 });
    expect(() => reconcileBudgetReservation(reserved, "reservation-1", counters({ inputTokens: 1_001 })))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("computes non-negative remaining and carries the same usage into a retry", () => {
    const firstAttempt = reconcileBudgetReservation(
      reserveBudget(fullBudget, emptyBudgetUsage(), {
        reservationId: "attempt-1",
        amounts: counters({ toolCalls: 4 }),
      }),
      "attempt-1",
      counters({ toolCalls: 3 }),
    );
    expect(remainingBudget(fullBudget, firstAttempt, 0).maxToolCalls).toBe(17);

    const retry = reserveBudget(fullBudget, firstAttempt, {
      reservationId: "attempt-2",
      amounts: counters({ toolCalls: 17 }),
    });
    expect(retry.used.toolCalls).toBe(3);
    expect(remainingBudget(fullBudget, retry, 0).maxToolCalls).toBe(0);
  });

  it("requires the elapsed wall-clock argument when computing remaining budget", () => {
    const callWithoutElapsed = remainingBudget as unknown as (
      budget: SubagentBudget,
      usage: ReturnType<typeof emptyBudgetUsage>,
    ) => unknown;
    expect(() => callWithoutElapsed(fullBudget, emptyBudgetUsage()))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("includes queued and retry time in the wall-clock budget", () => {
    expect(() => assertTaskWithinWallBudget({ createdAtMs: 1_000 }, fullBudget, 1_999)).not.toThrow();
    expect(() => assertTaskWithinWallBudget({ createdAtMs: 1_000 }, fullBudget, 2_000))
      .toThrowError(expect.objectContaining({ code: "budget_exhausted" }));
    expect(remainingBudget(fullBudget, emptyBudgetUsage(), 1_000).maxWallMs).toBe(0);
  });

  it("truncates Unicode on code-point boundaries with an explicit marker inside the byte cap", () => {
    const cap = Buffer.byteLength(TASK_RESULT_TRUNCATION_MARKER, "utf8") + 5;
    const result = limitTaskResultUtf8("🙂".repeat(20), cap);

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(TASK_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.bytes).toBeLessThanOrEqual(cap);
    expect(result.text).not.toContain("�");
  });

  it("uses the documented one-byte marker when the full marker does not fit", () => {
    const result = limitTaskResultUtf8("🙂", 1);

    expect(result).toEqual({
      text: TASK_RESULT_MIN_TRUNCATION_MARKER,
      bytes: 1,
      truncated: true,
    });
  });
});
