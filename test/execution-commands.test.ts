import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 as path } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeSearchRegex, LocalCommandExecutor } from "../src/execution/commands.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";

const roots: string[] = [];
const temp = async (prefix = "openbot-command-") => { const root = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(root); return root; };
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
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

  it("normaliza regex inválida e abort", async () => {
    const root = await temp(); const executor = await LocalCommandExecutor.create(root);
    expect(await executor.execute(text("[", "regex"))).toMatchObject({ ok: false, code: "invalid_path" });
    const controller = new AbortController(); controller.abort();
    expect(await executor.execute(files({ paths: ["."] }), controller.signal)).toMatchObject({ ok: false, code: "aborted" });
  });
});
