import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { win32 as path } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeSearchRegex, LocalCommandExecutor } from "../src/execution/commands.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";
import { TempRoots } from "./helpers/temp-roots.js";

const tempRoots = new TempRoots();
const temp = (prefix = "openbot-command-") => tempRoots.makeAsync(prefix);
afterEach(() => tempRoots.cleanup());
const files = (params: { paths: string[] }, cwd = ".") => ({ operation: "command.run", command: "search.files", cwd, params } as const);
const text = (pattern: string, mode: "fixed" | "regex" = "fixed", paths = ["."]) => ({ operation: "command.run", command: "search.text", cwd: ".", params: { pattern, mode, paths } } as const);

describe("LocalCommandExecutor", () => {
  it("lista arquivos deterministicamente sem shell", async () => {
    const root = await temp(); await mkdir(path.join(root, "src")); await writeFile(path.join(root, "z.txt"), "z"); await writeFile(path.join(root, "src", "a.ts"), "a");
    const result = await (await LocalCommandExecutor.create(root)).execute(files({ paths: ["."] }));
    expect(result).toMatchObject({ ok: true, command: "search.files", stdout: "src/a.ts\nz.txt", stderr: "", exitCode: 0 });
  });

  it("busca texto fixo e regex com linhas", async () => {
    const root = await temp(); await writeFile(path.join(root, "a.txt"), "alpha\nbeta 42\n");
    const executor = await LocalCommandExecutor.create(root);
    expect(await executor.execute(text("beta"))).toMatchObject({ ok: true, stdout: "a.txt:2:beta 42", exitCode: 0 });
    expect(await executor.execute(text("[0-9]+", "regex"))).toMatchObject({ ok: true, stdout: "a.txt:2:beta 42", exitCode: 0 });
    expect(await executor.execute(text("missing"))).toMatchObject({ ok: true, stdout: "", exitCode: 1 });
  });

  it("aceita arquivo direto como raiz", async () => {
    const root = await temp(); await writeFile(path.join(root, "only.txt"), "needle");
    expect(await (await LocalCommandExecutor.create(root)).execute(text("needle", "fixed", ["only.txt"]))).toMatchObject({ ok: true, stdout: "only.txt:1:needle" });
  });

  it("rejeita traversal e junction escape", async () => {
    const root = await temp(); const outside = await temp("openbot-command-outside-"); await writeFile(path.join(outside, "secret.txt"), "secret");
    const executor = await LocalCommandExecutor.create(root);
    expect(await executor.execute(files({ paths: ["../outside"] }))).toMatchObject({ ok: false, code: "outside_workspace" });
    await symlink(outside, path.join(root, "linked"), "junction");
    expect(await executor.execute(files({ paths: ["linked"] }))).toMatchObject({ ok: false, code: "outside_workspace" });
  });

  it("falha fechado se search.text encontra uma junction entre validação e leitura", async () => {
    const root = await temp();
    const outside = await temp("openbot-command-race-outside-");
    await writeFile(path.join(outside, "secret.txt"), "outside-secret");
    const target = path.join(root, "race.txt");
    await writeFile(target, "inside-secret");
    let raced = false;
    const workspace = await WorkspaceSandbox.create(root);
    const executor = LocalCommandExecutor.fromWorkspace(workspace, {
      beforePathUse: async (absolute) => {
        if (raced || absolute !== target) return;
        raced = true;
        await rm(target, { force: true });
        await symlink(outside, target, "junction");
      },
    });

    expect(await executor.execute(text("outside-secret"))).toMatchObject({ ok: false, code: "outside_workspace" });
    expect(raced).toBe(true);
  });

  it("rejeita regex com quantificadores aninhados", async () => {
    const root = await temp(); await writeFile(path.join(root, "dos.txt"), `${"a".repeat(30)}!`);
    const result = await (await LocalCommandExecutor.create(root)).execute(text("^(a+)+$", "regex"));
    expect(result).toMatchObject({ ok: false, code: "invalid_path" });
    expect(isSafeSearchRegex("alpha|beta")).toBe(true);
    expect(isSafeSearchRegex("^(cat|dog)+$")).toBe(true);
    const ambiguous = await (await LocalCommandExecutor.create(root)).execute(text("^((a|aa))*$", "regex"));
    expect(ambiguous).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("aceita alternâncias escapadas e classes de dígito, mas recusa retrorreferências", async () => {
    expect(isSafeSearchRegex("(\\.js|\\.ts)+")).toBe(true);
    expect(isSafeSearchRegex("v[1-9]")).toBe(true);
    expect(isSafeSearchRegex("(a)\\1")).toBe(false);
    const root = await temp(); await writeFile(path.join(root, "a.txt"), "main.js.ts\nv2 release\n");
    const executor = await LocalCommandExecutor.create(root);
    expect(await executor.execute(text("(\\.js|\\.ts)+$", "regex"))).toMatchObject({ ok: true, stdout: "a.txt:1:main.js.ts" });
    expect(await executor.execute(text("^v[1-9]", "regex"))).toMatchObject({ ok: true, stdout: "a.txt:2:v2 release" });
    expect(await executor.execute(text("x".repeat(201), "regex"))).toMatchObject({ ok: false, code: "invalid_path", message: expect.stringMatching(/200 characters/u) });
  });

  it("interrompe uma regex catastrófica que passa pelo filtro sem congelar o gateway", async () => {
    const root = await temp(); await writeFile(path.join(root, "slow.txt"), `${"a".repeat(40)}\nok\n`);
    const executor = await LocalCommandExecutor.create(root);
    expect(isSafeSearchRegex("(.|a)*b")).toBe(true);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    const started = Date.now();
    try {
      const result = await executor.execute(text("(.|a)*b", "regex"));
      expect(result).toMatchObject({ ok: false, code: "invalid_path", message: expect.stringMatching(/took longer/u) });
    } finally {
      clearInterval(ticker);
    }
    expect(Date.now() - started).toBeLessThan(6_000);
    // The event loop kept running while the worker was stuck.
    expect(ticks).toBeGreaterThan(10);
  }, 15_000);

  it("aborta uma regex em andamento encerrando o worker", async () => {
    const root = await temp(); await writeFile(path.join(root, "slow.txt"), `${"a".repeat(40)}\n`);
    const executor = await LocalCommandExecutor.create(root);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expect(await executor.execute(text("(.|a)*b", "regex"), controller.signal)).toMatchObject({ ok: false, code: "aborted" });
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 15_000);

  it("normaliza regex inválida e abort", async () => {
    const root = await temp(); const executor = await LocalCommandExecutor.create(root);
    expect(await executor.execute(text("[", "regex"))).toMatchObject({ ok: false, code: "invalid_path" });
    const controller = new AbortController(); controller.abort();
    expect(await executor.execute(files({ paths: ["."] }), controller.signal)).toMatchObject({ ok: false, code: "aborted" });
  });
});

describe("unsafe search regexes", () => {
  it("rejects nested and repeated unbounded groups", () => {
    expect(isSafeSearchRegex("foo")).toBe(true);
    expect(isSafeSearchRegex("(.*){1000}")).toBe(false);
    expect(isSafeSearchRegex("(.*)(.*)")).toBe(false);
  });
});
