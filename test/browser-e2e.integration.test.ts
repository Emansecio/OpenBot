import { createServer, request as nodeHttpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserSessionManager, type BrowserDownloadEvent } from "../src/browser/browser-session-manager.js";
import { ConfigStore } from "../src/config/store.js";
import type { ExecutionRequest } from "../src/execution/contracts.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";

const roots: string[] = [];
const managers: BrowserSessionManager[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const handles: ServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await stopServer(handle);
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  })));
}, 90_000);

describe("browser e2e gate", () => {
  it("combines production file/process/browser paths and retains local dependencies after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-workspace-e2e-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const config = new ConfigStore({ configPath });
    config.update({ agents: [{ id: "workspace-agent", name: "Workspace Agent", avatarId: "workspace-agent" }] });
    config.close();
    const userProfile = join(root, "profile");
    await mkdir(join(userProfile, "Documents"), { recursive: true });
    const fixture = createServer(serveFixture);
    servers.push(fixture);
    const port = await listen(fixture);
    const hostname = "fixture.openbot.test";
    const options = {
      configPath, userProfile, shareUserFiles: true, sharedIntegrationsEnabled: false, skillRoots: [],
      storePath: join(root, "store.db"), keystoreDir: join(root, "keys"),
      runtimeRoot: join(root, "runtime"), browserRoot: join(root, "browser"), workspacesRoot: join(root, "workspaces"),
      allowUnauthenticatedLocalGateway: true,
      browserOptions: { egressProxyOptions: {
        resolve: async (host: string) => host === hostname ? ["93.184.216.34"] : [],
        httpRequest: ((request: RequestOptions, listener?: (res: IncomingMessage) => void) =>
          nodeHttpRequest({ ...request, hostname: "127.0.0.1", port }, listener)) as typeof nodeHttpRequest,
      } },
    };
    let handle = await startServer(0, options);
    handles.push(handle);
    let sequence = 0;
    const execute = (request: ExecutionRequest) => handle.executionBroker!.execute("workspace-agent", `workspace-${++sequence}`, request);
    const home = join(options.workspacesRoot, "workspace-agent");
    await expect(execute({ operation: "workspace.info" })).resolves.toMatchObject({ ok: true, homeRoot: home, sharedFolders: [] });
    await expect(execute({ operation: "file.write", path: "Documents/input.txt", content: "2,3,5", encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    const run = (code: string) => execute({ operation: "process.run", executable: process.execPath, argv: ["-e", code],
      cwd: ".", timeoutMs: 5000, networkProfile: "host" });
    await expect(run("const fs=require('fs');fs.writeFileSync('Projects/sum.txt',String(fs.readFileSync('Documents/input.txt','utf8').split(',').reduce((a,b)=>a+Number(b),0)));console.log(process.env.OPENBOT_WORKSPACE)"))
      .resolves.toMatchObject({ ok: true, exitCode: 0, stdout: expect.stringContaining(home) });
    await expect(execute({ operation: "file.read", path: "Projects/sum.txt", encoding: "utf8" })).resolves.toMatchObject({ ok: true, content: "10" });

    await expect(execute({ operation: "browser.open", url: `http://${hostname}:${port}/app` })).resolves.toMatchObject({ ok: true });
    await expect(execute({ operation: "browser.type", text: "persisted-workspace" })).resolves.toMatchObject({ ok: true });
    const snapshot = await execute({ operation: "browser.snapshot" });
    expect(snapshot).toMatchObject({ ok: true, snapshot: { text: expect.stringContaining("persisted-workspace") } });
    if (!snapshot.ok || snapshot.operation !== "browser.snapshot") throw new Error("snapshot failed");
    const link = snapshot.snapshot?.elements?.find((element) => element.name === "Download attribute");
    expect(link).toBeDefined();
    await expect(execute({ operation: "browser.click_element", elementId: link!.id })).resolves.toMatchObject({ ok: true });
    await waitFor(async () => { await expect(readFile(join(home, "Downloads", "report.txt"), "utf8")).resolves.toBe("downloaded-report"); });
    await expect(run("const fs=require('fs');fs.writeFileSync('Projects/download-result.txt',fs.readFileSync('Downloads/report.txt','utf8').toUpperCase())"))
      .resolves.toMatchObject({ ok: true, exitCode: 0 });
    await expect(execute({ operation: "browser.upload", selector: "#upload", path: "Documents/input.txt" }))
      .resolves.toMatchObject({ ok: true });

    // Inventory is read-only; export/repair still drain browser work without
    // erasing the persistent session.
    for (const [method, extra, expectsDrained] of [
      ["getWorkspaceInventory", {}, false],
      ["exportAgentHome", { destination: join(root, "workspace-home.json") }, true],
      ["repairAgentHome", {}, true],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "workspace-agent", ...extra }),
      });
      expect(response.status, method).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(handle.browserSessionManager!.activeLeaseCount).toBe(expectsDrained ? 0 : 1);
      if (!expectsDrained) continue;
      await expect(execute({ operation: "browser.open", url: `http://${hostname}:${port}/app` })).resolves.toMatchObject({ ok: true });
      await expect(execute({ operation: "browser.snapshot" }))
        .resolves.toMatchObject({ ok: true, snapshot: { text: expect.stringContaining("persisted-workspace") } });
    }

    // Install only a controlled local package, with scripts and registry access disabled.
    await expect(execute({ operation: "file.mkdir", path: "Projects/fixture-package" })).resolves.toMatchObject({ ok: true });
    for (const [path, content] of Object.entries({
      "Projects/package.json": JSON.stringify({ name: "workspace-fixture", version: "1.0.0", private: true }),
      "Projects/fixture-package/package.json": JSON.stringify({ name: "openbot-fixture-dependency", version: "1.0.0", main: "index.js" }),
      "Projects/fixture-package/index.js": "module.exports = 42;",
    })) await expect(execute({ operation: "file.write", path, content, encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    const npmCli = join(dirname(await realpath(process.execPath)), "node_modules", "npm", "bin", "npm-cli.js");
    await expect(execute({ operation: "process.run", executable: process.execPath,
      argv: [npmCli, "install", "./fixture-package", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", "./.npm-cache"],
      cwd: "Projects", timeoutMs: 15000, networkProfile: "host" })).resolves.toMatchObject({ ok: true, exitCode: 0 });
    await stopServer(handle);
    handles.splice(handles.indexOf(handle), 1);
    handle = await startServer(0, options);
    handles.push(handle);
    await expect(run("console.log(require('./Projects/node_modules/openbot-fixture-dependency'))"))
      .resolves.toMatchObject({ ok: true, exitCode: 0, stdout: "42\n" });
    await expect(execute({ operation: "file.read", path: "Projects/download-result.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true, content: "DOWNLOADED-REPORT" });
    await expect(execute({ operation: "browser.open", url: `http://${hostname}:${port}/app` })).resolves.toMatchObject({ ok: true });
    await expect(execute({ operation: "browser.snapshot" }))
      .resolves.toMatchObject({ ok: true, snapshot: { text: expect.stringContaining("persisted-workspace") } });
    await expect(stat(join(userProfile, "Downloads"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60000);

  it("exercises the real Electron host with isolated per-agent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-browser-e2e-"));
    roots.push(root);
    const workspacesRoot = join(root, "workspaces");
    const profilesRoot = join(root, "browser-profiles");
    const agentAHome = join(workspacesRoot, "agent-a");
    const agentBHome = join(workspacesRoot, "agent-b");
    await Promise.all([
      mkdir(join(agentAHome, "Downloads"), { recursive: true }),
      mkdir(join(agentBHome, "Downloads"), { recursive: true }),
      mkdir(profilesRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(agentAHome, "Downloads", ".keep"), "", { flag: "w" }),
      writeFile(join(agentBHome, "Downloads", ".keep"), "", { flag: "w" }),
      writeFile(join(agentAHome, "upload.txt"), "upload-from-agent-a", { flag: "w" }),
      writeFile(join(agentBHome, "upload.txt"), "upload-from-agent-b", { flag: "w" }),
    ]);

    const server = createServer((request, response) => serveFixture(request, response));
    servers.push(server);
    const port = await listen(server);
    const fixtureHost = "fixture.openbot.test";
    const baseUrl = `http://${fixtureHost}:${port}`;

    let resolveDownload!: (event: BrowserDownloadEvent) => void;
    const downloads: BrowserDownloadEvent[] = [];
    const downloadSeen = new Promise<BrowserDownloadEvent>((resolvePromise) => {
      resolveDownload = resolvePromise;
    });
    let hostStderr = "";
    const manager = new BrowserSessionManager({
      downloadsRoot: workspacesRoot,
      userDataRoot: profilesRoot,
      resolveDownloadRoot: (agentId) => join(workspacesRoot, agentId, "Downloads"),
      resolveHomeRoot: (agentId) => join(workspacesRoot, agentId),
      onDownload: (event) => { downloads.push(event); resolveDownload(event); },
      onHostStderr: (chunk) => {
        hostStderr += chunk;
      },
      commandTimeoutMs: 15_000,
      readyTimeoutMs: 20_000,
      egressProxyOptions: {
        resolve: async (hostname) => hostname === fixtureHost ? ["93.184.216.34"] : [],
        httpRequest: ((requestOptions: RequestOptions, listener?: (res: IncomingMessage) => void) => {
          const forwarded: RequestOptions = {
            ...requestOptions,
            hostname: "127.0.0.1",
            port,
          };
          return nodeHttpRequest(forwarded, listener);
        }) as typeof nodeHttpRequest,
      },
    });
    managers.push(manager);

    const first = await manager.acquire("agent-a", { sessionId: "browser-a" });
    const second = await manager.acquire("agent-b", { sessionId: "browser-b" });
    expect(first.partition).not.toBe(second.partition);
    expect(first.downloadRoot).not.toBe(second.downloadRoot);

    await expect(manager.open(first, `${baseUrl}/app`)).resolves.toMatchObject({
      command: "open",
      visible: true,
      url: `${baseUrl}/app`,
    });
    await expect(manager.type(first, "alpha-state")).resolves.toMatchObject({ command: "type" });
    await waitFor(async () => {
      const snapshot = await manager.snapshot(first);
      expect(snapshot.snapshot?.text).toContain("alpha-state");
      expect(snapshot.snapshot?.viewport.width).toBeGreaterThanOrEqual(1000);
    });

    const semanticSnapshot = await manager.snapshot(first);
    const button = semanticSnapshot.snapshot?.elements?.find((element) => element.name === "Click me");
    expect(button).toMatchObject({ id: expect.stringMatching(/^ob-el-/), role: "button" });
    await expect(manager.execute(first, { command: "click_element", elementId: button!.id })).resolves.toMatchObject({ command: "click_element" });
    await waitFor(async () => {
      expect((await manager.snapshot(first)).snapshot?.text).toContain("Clicked");
    });
    await expect(manager.execute(first, { command: "scroll", deltaX: 0, deltaY: 640 })).resolves.toMatchObject({ command: "scroll" });
    await expect(manager.execute(first, { command: "scroll", deltaX: 0, deltaY: -640 })).resolves.toMatchObject({ command: "scroll" });
    await expect(manager.execute(first, { command: "press_key", key: "ESCAPE" })).resolves.toMatchObject({ command: "press_key" });

    await expect(manager.click(first, 80, 40)).resolves.toMatchObject({ command: "click" });
    await waitFor(async () => {
      const snapshot = await manager.snapshot(first);
      expect(snapshot.snapshot?.text).toContain("Clicked");
    });

    await expect(manager.upload(first, "#upload", "upload.txt")).resolves.toMatchObject({
      command: "upload",
      upload: { fileName: "upload.txt", bytes: 19 },
    });

    const viewportShot = await manager.screenshot(first);
    const fullPageShot = await manager.screenshot(first, true);
    expect(viewportShot.url).toBe(`${baseUrl}/app`);
    expect(fullPageShot.url).toBe(`${baseUrl}/app`);
    expect(viewportShot.screenshot?.mimeType).toBe("image/png");
    expect(fullPageShot.screenshot?.height).toBeGreaterThan(viewportShot.screenshot!.height);

    await expect(manager.click(first, 120, 185)).resolves.toMatchObject({ command: "click" });
    const downloaded = await downloadSeen;
    expect(downloaded.agentId).toBe("agent-a");
    expect(downloaded.state).toBe("completed");
    expect(isAbsolute(downloaded.path)).toBe(true);
    await expect(stat(downloaded.path)).resolves.toMatchObject({ isFile: expect.any(Function) });

    const downloadSnapshot = await manager.snapshot(first);
    const downloadLink = downloadSnapshot.snapshot?.elements?.find((element) => element.name === "Download attribute");
    expect(downloadLink).toBeDefined();
    await manager.execute(first, { command: "click_element", elementId: downloadLink!.id });
    expect((await manager.snapshot(first)).snapshot?.text).toContain("Attribute clicked");
    await waitFor(async () => {
      expect(downloads, hostStderr).toHaveLength(2);
      expect(downloads[1]).toMatchObject({ state: "completed", agentId: "agent-a" });
    });

    await expect(manager.handoff(first)).resolves.toMatchObject({ command: "handoff", visible: true });

    await expect(manager.open(second, `${baseUrl}/app`)).resolves.toMatchObject({ command: "open" });
    const isolated = await manager.snapshot(second);
    expect(isolated.snapshot?.text).not.toContain("alpha-state");

    await expect(manager.navigate(second, `${baseUrl}/second`)).resolves.toMatchObject({
      command: "navigate",
      url: `${baseUrl}/second`,
    });
    await expect(manager.snapshot(second)).resolves.toMatchObject({
      command: "snapshot",
      snapshot: { text: expect.stringContaining("Second page") },
    });

    await expect(manager.navigate(first, "file:///C:/Windows/win.ini")).rejects.toThrow("browser URL protocol is not allowed");

    await expect(manager.execute(first, { command: "close" })).resolves.toMatchObject({ command: "close", visible: false });
    expect(manager.activeLeaseCount).toBe(1);
    await expect(manager.execute(second, { command: "close" })).resolves.toMatchObject({ command: "close", visible: false });
    expect(manager.activeLeaseCount).toBe(0);
    await waitFor(async () => {
      expect(manager.hostRunning).toBe(false);
    });
    expect(hostStderr).not.toMatch(/Uncaught Exception|Object has been destroyed/iu);
  }, 90_000);
});

function pageHtml(): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<title>OpenBot Browser Fixture</title>",
    "<style>",
    "body { margin: 0; font-family: Segoe UI, sans-serif; }",
    "#button { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }",
    "#text { position: absolute; left: 20px; top: 80px; width: 260px; height: 36px; }",
    "#mirror { position: absolute; left: 20px; top: 130px; width: 400px; font-size: 20px; }",
    "#download { position: absolute; left: 20px; top: 170px; font-size: 20px; }",
    "#upload { position: absolute; left: 20px; top: 220px; }",
    "#spacer { position: absolute; left: 0; top: 320px; width: 100%; height: 1600px; background: linear-gradient(#fff8e1, #ffe0b2); }",
    "</style>",
    "</head>",
    "<body>",
    "<button id=\"button\">Click me</button>",
    "<input id=\"text\" aria-label=\"text input\" />",
    "<div id=\"mirror\">Mirror:</div>",
    "<a id=\"download\" href=\"/download/report.txt\">Download report</a>",
    "<a style=\"position:absolute;left:400px;top:170px\" href=\"/download/report.txt\" download=\"attribute.txt\" onclick=\"document.getElementById('mirror').textContent='Attribute clicked'\">Download attribute</a>",
    "<input id=\"upload\" type=\"file\" />",
    "<div id=\"spacer\">Tall page for full-page screenshots</div>",
    "<script>",
    "const input = document.getElementById('text');",
    "const mirror = document.getElementById('mirror');",
    "const statusKey = 'openbot-browser-fixture-draft';",
    "const sync = (value) => { mirror.textContent = 'Mirror: ' + value; localStorage.setItem(statusKey, value); };",
    "const saved = localStorage.getItem(statusKey) || '';",
    "input.value = saved;",
    "sync(saved);",
    "input.focus();",
    "input.addEventListener('input', () => sync(input.value));",
    "document.getElementById('button').addEventListener('click', () => {",
    "  mirror.textContent = mirror.textContent + ' Clicked';",
    "});",
    "</script>",
    "</body>",
    "</html>",
  ].join("");
}

function secondPageHtml(): string {
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\" /><title>Second</title></head>",
    "<body><h1>Second page</h1><p>Fresh navigation target.</p></body></html>",
  ].join("");
}

function serveFixture(request: IncomingMessage, response: ServerResponse): void {
  const url = request.url ?? "/";
  if (url === "/app") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml());
    return;
  }
  if (url === "/second") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(secondPageHtml());
    return;
  }
  if (url === "/download/report.txt") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename=\"report.txt\"",
      "cache-control": "no-store",
    });
    response.end("downloaded-report");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("fixture server did not expose a TCP address");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function waitFor(check: () => Promise<void>, timeoutMs = 10_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("condition timed out");
}
