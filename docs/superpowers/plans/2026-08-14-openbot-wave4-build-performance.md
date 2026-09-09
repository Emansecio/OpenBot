# OpenBot Wave 4 Build and Performance Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Remove residual queue/build/package waste and add deterministic regression gates for all optimization waves.

**Architecture:** Replace array shifting with a cursor queue, split TypeScript emission configs, create non-destructive runtime packaging, and codify structural performance budgets in Vitest plus a manual benchmark reporter.

**Tech Stack:** TypeScript ESM, Node.js filesystem, Vitest, npm scripts.

**Specification:** `docs/superpowers/specs/2026-08-14-openbot-build-performance-design.md`

---

## File map

- Modify `src/server/gateway.ts`, `test/gateway-backpressure.test.ts`.
- Create `tsconfig.dev.json`, `tsconfig.prod.json`, `scripts/clean-dist.mjs`, `test/build-config.test.ts`.
- Create `scripts/package-runtime.mjs`, `test/package-runtime.test.ts`.
- Create `test/performance-regression.test.ts`, `scripts/benchmark-hot-paths.mjs`.
- Modify `package.json`, `README.md`.
- Create `analysis_outputs/IMPLEMENTATION_RESULTS.md`.

### Task 1: Replace SSE shift queue with cursor frames

- [ ] **Step 1: Write failing queue tests**

Extend `test/gateway-backpressure.test.ts` with thousands of small pending frames. Monkey-patch `Array.prototype.shift` to throw only around flush and assert flush still succeeds after implementation. Assert order and pending bytes return to zero.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/gateway-backpressure.test.ts
```

Expected: current flush calls `shift()`.

- [ ] **Step 3: Implement pending frames and head cursor**

Store `{frame,bytes}`, append without recomputing, advance `pendingHead`, and reset array/head when drained. Update all test harness client shapes.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/gateway-backpressure.test.ts test/gateway.integration.test.ts
```

### Task 2: Split development and production builds

- [ ] **Step 1: Write failing build artifact test**

Create `test/build-config.test.ts`. Spawn `npx tsc -p tsconfig.prod.json --outDir <temporary-dir>` from the test and assert the temporary tree contains executable `.js` files and zero `.map`/`.d.ts` files.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/build-config.test.ts
```

Expected: configs/scripts do not exist.

- [ ] **Step 3: Add configs and clean script**

Create exact overrides:

```json
// tsconfig.dev.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "incremental": true,
    "tsBuildInfoFile": "./node_modules/.cache/openbot/dev.tsbuildinfo",
    "sourceMap": true,
    "declaration": false
  }
}
```

```json
// tsconfig.prod.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "incremental": false,
    "sourceMap": false,
    "declaration": false
  }
}
```

Implement `clean-dist.mjs` using `rm(new URL('../dist', import.meta.url), {recursive:true,force:true})`. Update package scripts exactly as specified.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/build-config.test.ts
npm run typecheck
npm run build:prod
find dist -type f \( -name '*.map' -o -name '*.d.ts' \) -print
```

Expected: test/typecheck/build pass and find prints nothing.

### Task 3: Create non-destructive runtime packager

- [ ] **Step 1: Write failing fixture tests**

Create `test/package-runtime.test.ts` using a temporary fake client tree. Assert prohibited extensions are absent, runtime assets remain, entrypoint absence fails, existing output fails without force, manifest totals match, and source hashes do not change.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/package-runtime.test.ts
```

- [ ] **Step 3: Implement exported packaging functions**

In `scripts/package-runtime.mjs`, export `shouldExclude(path)`, `packageRuntime(options)`, and `main(argv)`. Use `fs/promises.cp` filtering or explicit walk/copy. Reject output nested inside source. On copy failure, remove only the newly created output.

- [ ] **Step 4: Add CLI and manifest**

Parse `--source`, mandatory `--out`, `--dry-run`, and `--force`. Manifest fields: source, output, copiedFiles, copiedBytes, excludedFiles, excludedBytes, exclusions.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/package-runtime.test.ts
```

### Task 4: Add deterministic performance regression gates

- [ ] **Step 1: Write structural tests**

Create `test/performance-regression.test.ts` with four describes:

1. streaming write/event counts using fake clock and counting store;
2. context budget on 10k entries;
3. attachment bounded read and config snapshot count;
4. discovery concurrency and SSE queue behavior.

Do not assert wall-clock milliseconds. Assert counts, bytes and started-before-resolved ordering.

- [ ] **Step 2: Verify tests catch missing budgets**

Run focused tests before final helper integration and confirm at least one assertion fails for each unconnected metric. If Wave 1–3 behavior already makes a test pass immediately, mutate only the test harness to prove it observes the relevant counter, then restore it.

- [ ] **Step 3: Complete metric hooks without production-only test APIs**

Use existing dependency injection (clock, fetch, store, callbacks). Do not add public production methods solely for tests.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/performance-regression.test.ts
```

### Task 5: Add manual benchmark and documentation

- [ ] **Step 1: Implement benchmark reporter**

Create `scripts/benchmark-hot-paths.mjs` importing built modules. Report JSON for 10k transcript read, stream publish/persist counts, local discovery controlled delay, config selector workload, and package size. Exit nonzero only on operational failure, not time variance.

- [ ] **Step 2: Update README and package scripts**

Document `typecheck`, `build:dev`, `build:prod`, `package:runtime`, and benchmark usage. Add scripts:

```json
{
  "package:runtime": "node scripts/package-runtime.mjs",
  "benchmark": "node scripts/benchmark-hot-paths.mjs"
}
```

- [ ] **Step 3: Run real temporary package smoke**

```bash
OUT=$(mktemp -d)/client
npm run package:runtime -- --source client --out "$OUT"
test -f "$OUT/extracted/dist/electron-main/main.cjs"
test -f "$OUT/extracted/dist/renderer/index.html"
find "$OUT" -type f \( -name '*.map' -o -name '*.original' -o -name '*.iobj' -o -name '*.ipdb' -o -name '*.tlog' -o -name '*.vcxproj' -o -name '*.filters' -o -name '*.lastbuildstate' \) -print
```

Expected: entrypoints exist and find prints nothing.

- [ ] **Step 4: Write implementation results**

Create `analysis_outputs/IMPLEMENTATION_RESULTS.md` with files changed, test counts, before/after deterministic counters, runtime package bytes, exclusions, and remaining limitations.

### Task 6: Final verification and review

- [ ] **Step 1: Run complete verification fresh**

```bash
npm run typecheck
npm test -- --reporter=dot
npm run build:prod
npm run smoke:local
npm run benchmark
```

Expected: all commands exit 0; benchmark prints valid JSON.

- [ ] **Step 2: Verify artifacts**

```bash
find dist -type f \( -name '*.map' -o -name '*.d.ts' \) -print
node -e "JSON.parse(require('fs').readFileSync('analysis_outputs/status.json','utf8')); console.log('status ok')"
```

Expected: find prints nothing and JSON is valid.

- [ ] **Step 3: Review all changed files**

Because Git is unavailable, generate `analysis_outputs/IMPLEMENTED_FILES.txt` from files created/modified during the four waves. Read each source diff from saved pre-change copies or compare hashes/checkpoint inventories. Resolve every critical/important review issue.

- [ ] **Step 4: Record final checkpoint**

Write `analysis_outputs/checkpoints/wave4-complete.txt` and ensure `IMPLEMENTATION_RESULTS.md` contains fresh verification output.