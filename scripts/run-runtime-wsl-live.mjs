import { randomUUID, createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { win32 as path } from "node:path";

import { startServer, stopServer } from "../dist/main.js";
import { capabilityDigest } from "../dist/execution/runtime/policy.js";
import { WslGuestClient } from "../dist/execution/runtime/wsl/guest-runner.js";
import {
  createManagedRuntimeLayout,
  parseRuntimeGuestPackageManifest,
  readExternalRuntimePackageManifest,
} from "../dist/execution/runtime/wsl/installer.js";
import { createWslCommandRunner, WslProvisioner } from "../dist/execution/runtime/wsl/provisioner.js";
import { validateBlockedNetworkProbe } from "./runtime-wsl-network-evidence.mjs";
import {
  assertNoResidualGuestSockets,
  listGuestInventoryRoot,
  parseGuestSocketEntries,
  selectActiveGuestUserProcesses,
} from "./runtime-wsl-live-inventory.mjs";

const distro = process.env.OPENBOT_RUNTIME_LIVE_DISTRO ?? "";
const root = path.resolve(process.env.OPENBOT_RUNTIME_LIVE_ROOT ?? "");
const sourceArchive = path.resolve(process.env.OPENBOT_RUNTIME_LIVE_ARCHIVE ?? "");
const sourceManifest = path.resolve(process.env.OPENBOT_RUNTIME_LIVE_MANIFEST ?? "");
const liveDistroPattern = /^OpenBotRuntimeLive-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const personalDistros = new Set(["OpenBotRuntime", "OpenBotRuntimeCandidate", "Ubuntu", "Ubuntu-24.04"]);
const safeRuntimeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const calls = [];

const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const owned = (candidate, label) => {
  const checked = path.resolve(candidate);
  const base = root.replace(/[\\/]+$/u, "").toLowerCase();
  const target = checked.toLowerCase();
  assert(target === base || target.startsWith(`${base}\\`), `${label} escaped the live root`);
  return checked;
};
const assertNoReparse = async (candidate, label) => {
  const checked = owned(candidate, label);
  const metadata = await lstat(checked);
  assert(!metadata.isSymbolicLink(), `${label} is a reparse point`);
};
const assertDistro = (name) => {
  assert(name === distro && liveDistroPattern.test(name), "live WSL distro identity is invalid");
};
const assertRuntimeIdentifier = (value, label) => {
  assert(typeof value === "string" && safeRuntimeIdentifier.test(value), `${label} is invalid`);
};

const assertGuestCleanup = async (runtimeBootId, leaseId) => {
  assertRuntimeIdentifier(runtimeBootId, "runtime boot identity");
  assertRuntimeIdentifier(leaseId, "lease identity");
  const sandboxPath = `/run/openbot/sandboxes/${leaseId}`;
  const cgroupPath = `/sys/fs/cgroup/openbot/${runtimeBootId}/${leaseId}`;
  for (const target of [sandboxPath, cgroupPath]) {
    const result = await runner.run(["-d", distro, "--user", "root", "--", "test", "!", "-e", target]);
    assert(result.exitCode === 0, `guest lease cleanup proof failed for ${target}`);
  }
};

const baseRunner = createWslCommandRunner("wsl.exe");
const runner = {
  async run(args, signal, input) {
    const checked = [...args];
    assert(checked.every((value) => typeof value === "string" && value.length > 0 && !value.includes("\0")), "WSL arguments are invalid");
    for (const value of checked) assert(!personalDistros.has(value), "personal WSL distro was addressed");
    if (checked[0] === "--import" || checked[0] === "--export" || checked[0] === "--terminate" || checked[0] === "--unregister") {
      assertDistro(checked[1]);
      if (checked[0] === "--import") {
        owned(checked[2], "WSL import directory");
        owned(checked[3], "WSL package archive");
      }
      if (checked[0] === "--export") owned(checked[2], "WSL export archive");
    }
    const distroIndex = checked.indexOf("-d");
    if (distroIndex >= 0) assertDistro(checked[distroIndex + 1]);
    calls.push(checked);
    return baseRunner.run(checked, signal, input);
  },
};

const runGuest = (client, args, signal, input) => client["runner"].run(["-d", distro, "--user", "root", "--", "/usr/lib/openbot/supervisor", ...args], signal, input);

const sendFrame = async (client, boot, frame, signal) => {
  const encoded = `${JSON.stringify(frame)}\n`;
  const result = await runner.run(["-d", distro, "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "frame"], signal, Buffer.from(encoded, "utf8"));
  assert(result.exitCode === 0, "guest frame command failed");
  return JSON.parse(result.stdout.toString("utf8"));
};

const now = () => Date.now();
const assertNonRootIdentity = (status) => {
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/imu.exec(status);
  const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/imu.exec(status);
  assert(uid && gid, "process UID/GID status was unavailable");
  const uidValues = uid.slice(1).map(Number);
  const gidValues = gid.slice(1).map(Number);
  assert(uidValues.every((value) => Number.isSafeInteger(value) && value > 0), "process UID was privileged or invalid");
  assert(gidValues.every((value) => Number.isSafeInteger(value) && value > 0), "process GID was privileged or invalid");
  assert(uidValues.every((value) => value === uidValues[0]), "process UID was inconsistent");
  assert(gidValues.every((value) => value === gidValues[0]), "process GID was inconsistent");
  return { uid: uidValues[0], gid: gidValues[0] };
};
const frame = (type, bootId, leaseId, agentId, policyDigest, payload, deadline = now() + 30_000) => ({
  protocolVersion: 1,
  type,
  runtimeBootId: bootId,
  leaseId,
  agentId,
  nonce: randomUUID(),
  deadline,
  policyDigest,
  payload,
});

const processRequest = (argv, timeoutMs = 10_000) => ({
  operation: "process.run",
  executable: "node",
  argv,
  cwd: ".",
  timeoutMs,
  networkProfile: "none",
});

const assertProcessSucceeded = (result, label) => {
  assert(result?.ok === true && result.operation === "process.run", `${label} failed: ${JSON.stringify(result)}`);
  assert(result.exitCode === 0, `${label} exited with ${String(result.exitCode)}: ${result.stderr ?? ""}`);
  return result;
};

const postJson = async (port, token, route, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.status === 200 && payload?.ok === true, `${route} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload.value;
};

const postRpc = (port, token, method, body) => postJson(port, token, `/api/${method}`, body);
const postLocalExec = (port, token, agentId, requestId, request) => postJson(
  port,
  token,
  "/local-exec/execute",
  { agentId, requestId, request },
);

const assertPortFree = (port) => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

const guestCommand = async (args, label) => {
  const result = await runner.run(["-d", distro, "--user", "root", "--", ...args]);
  assert(result.exitCode === 0, `${label} failed: ${result.stderr.toString("utf8").trim()}`);
  return result.stdout.toString("utf8").replaceAll("\r", "").trim();
};

const guestList = async (target, minimumDepth = 1, maximumDepth = 1, directoriesOnly = false) => {
  return listGuestInventoryRoot(
    (args) => runner.run(["-d", distro, "--user", "root", "--", ...args]),
    target,
    { minimumDepth, maximumDepth, directoriesOnly },
  );
};

const fileExists = async (candidate) => lstat(candidate).then(() => true, (error) => {
  if (error?.code === "ENOENT") return false;
  throw error;
});

const readHostJournal = async (layout) => {
  const journalPath = path.join(layout.state, "runtime-leases.json");
  if (!(await fileExists(journalPath))) return { path: journalPath, leases: [] };
  const parsed = JSON.parse(await readFile(journalPath, "utf8"));
  assert(parsed?.schemaVersion === 1 && Array.isArray(parsed.leases), "host runtime lease journal is invalid");
  return { path: journalPath, leases: parsed.leases };
};

const captureGuestInventory = async (layout) => {
  const [leases, sandboxes, hostBridges, cgroups, processTable, socketTable] = await Promise.all([
    guestList("/run/openbot/leases"),
    guestList("/run/openbot/sandboxes"),
    guestList("/run/openbot/host"),
    guestList("/sys/fs/cgroup/openbot", 1, 2, true),
    guestCommand(["ps"], "guest process inventory"),
    guestCommand(["cat", "/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"], "guest socket inventory"),
  ]);
  const activeUserProcesses = selectActiveGuestUserProcesses(processTable);
  const socketInventory = parseGuestSocketEntries(socketTable);
  const journal = await readHostJournal(layout);
  return {
    leases,
    sandboxes,
    hostBridges,
    cgroups,
    activeUserProcesses,
    socketDigest: createHash("sha256").update(JSON.stringify(socketInventory)).digest("hex"),
    socketEntries: socketInventory.length,
    socketInventory,
    hostJournalLeases: journal.leases.length,
    activationJournalPresent: await fileExists(path.join(layout.state, "activation-transaction.json")),
  };
};

const assertRuntimeInventoryClean = (inventory, label, baselineSocketInventory) => {
  for (const key of ["leases", "sandboxes", "hostBridges", "cgroups", "activeUserProcesses"]) {
    assert(inventory[key].length === 0, `${label} has residual ${key}: ${JSON.stringify(inventory[key])}`);
  }
  assert(inventory.hostJournalLeases === 0, `${label} has residual host runtime leases`);
  assert(inventory.activationJournalPresent === false, `${label} has a residual activation journal`);
  if (baselineSocketInventory !== undefined) {
    assertNoResidualGuestSockets(baselineSocketInventory, inventory.socketInventory, label);
  }
};

const runBootstrapRpc = async (layout, recoveryRecord) => {
  const gatewayRoot = owned(path.join(root, "gateway"), "gateway root");
  const workspacesRoot = owned(path.join(gatewayRoot, "workspaces"), "gateway workspaces root");
  const token = `openbot-runtime-live-${randomUUID()}`;
  await mkdir(gatewayRoot, { recursive: true });
  await writeFile(
    path.join(layout.state, "runtime-leases.json"),
    `${JSON.stringify({ schemaVersion: 1, leases: [recoveryRecord] }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const handle = await startServer(0, {
    configPath: path.join(gatewayRoot, "config.json"),
    storePath: path.join(gatewayRoot, "store.db"),
    keystoreDir: path.join(gatewayRoot, "keystore"),
    runtimeRoot: layout.root,
    workspacesRoot,
    browserRoot: path.join(gatewayRoot, "browser"),
    runtimeCommandRunner: runner,
    runtimeDistroName: distro,
    workspaceQuota: { maxBytes: 512 * 1024, maxFiles: 1_000, maxEntries: 2_000 },
    shareUserFiles: false,
    sharedIntegrationsEnabled: false,
    gatewayToken: token,
  });

  const agentIds = ["runtime-live-agent-a", "runtime-live-agent-b"];
  let outcome;
  try {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`).then((response) => response.json());
    assert(health?.ok === true && health.pid === process.pid, "gateway health did not identify the live bootstrap");
    const recoveredJournal = await readHostJournal(layout);
    assert(recoveredJournal.leases.length === 0, "bootstrap did not reconcile the persisted runtime lease");
    const inventoryProbe = `/run/openbot/leases/inventory-probe-${randomUUID()}`;
    await guestCommand(["touch", inventoryProbe], "guest inventory sensitivity probe setup");
    try {
      const sensitivity = await captureGuestInventory(layout);
      assert(sensitivity.leases.includes(inventoryProbe), "guest inventory missed a residual regular file");
    } finally {
      await guestCommand(["rm", "-f", inventoryProbe], "guest inventory sensitivity probe cleanup");
    }
    const before = await captureGuestInventory(layout);
    assertRuntimeInventoryClean(before, "pre-execution inventory");

    for (const [index, agentId] of agentIds.entries()) {
      const created = await postRpc(handle.port, token, "createAgent", { id: agentId, name: `Runtime Live ${index + 1}` });
      assert(created?.agent?.id === agentId, `createAgent did not create ${agentId}`);
      const selected = await postRpc(handle.port, token, "setAgentRuntimeMode", { agentId, mode: "developer" });
      assert(selected?.agentId === agentId && selected.runtimeMode === "developer", `setAgentRuntimeMode failed for ${agentId}`);
      const initialStatus = await postRpc(handle.port, token, "getLocalRuntimeStatus", { agentId });
      assert(initialStatus?.agentId === agentId && initialStatus.mode === "developer", `runtime status failed for ${agentId}`);
    }

    const statusScript = "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/proc/self/status','utf8'))";
    const identities = [];
    for (const agentId of agentIds) {
      const result = assertProcessSucceeded(
        await postLocalExec(handle.port, token, agentId, `identity-${randomUUID()}`, processRequest(["-e", statusScript])),
        `${agentId} identity process`,
      );
      const identity = assertNonRootIdentity(result.stdout);
      assert(/NoNewPrivs:\s+1/iu.test(result.stdout), `${agentId} did not enable NoNewPrivs`);
      assert(/Seccomp:\s+2/iu.test(result.stdout), `${agentId} did not enable seccomp`);
      identities.push(identity);
    }
    assert(
      identities[0].uid !== identities[1].uid || identities[0].gid !== identities[1].gid,
      "two agents shared the same Linux identity",
    );

    const tcpScript = [
      "const net=require('node:net')",
      "const fs=require('node:fs')",
      "const socketFds=()=>fs.readdirSync('/proc/self/fd').map((fd)=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)}catch{return ''}}).filter((target)=>target.startsWith('socket:['))",
      "let outcome={status:'blocked',code:'TIMEOUT'}",
      "const socket=net.connect({host:'1.1.1.1',port:80})",
      "const timer=setTimeout(()=>socket.destroy(),1500)",
      "socket.once('connect',()=>{outcome={status:'connected',code:'CONNECTED'};socket.destroy()})",
      "socket.once('error',(error)=>{outcome={status:'blocked',code:String(error.code||error.message)};socket.destroy()})",
      "socket.once('close',()=>{clearTimeout(timer);setImmediate(()=>{const evidence={...outcome,socketFds:socketFds()};process.stdout.write(JSON.stringify(evidence),()=>process.exit(outcome.status==='connected'?91:0))})})",
    ].join(";");
    const tcp = assertProcessSucceeded(
      await postLocalExec(handle.port, token, agentIds[0], `tcp-${randomUUID()}`, processRequest(["-e", tcpScript], 5_000)),
      "TCP isolation process",
    );
    const tcpEvidence = validateBlockedNetworkProbe(tcp.stdout, "tcp");

    const dnsScript = [
      "const dns=require('node:dns')",
      "const fs=require('node:fs')",
      "const socketFds=()=>fs.readdirSync('/proc/self/fd').map((fd)=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)}catch{return ''}}).filter((target)=>target.startsWith('socket:['))",
      "let settled=false",
      "const report=(status,code)=>{if(settled)return;settled=true;clearTimeout(timer);setImmediate(()=>{const evidence={status,code,socketFds:socketFds()};process.stdout.write(JSON.stringify(evidence),()=>process.exit(status==='resolved'?92:0))})}",
      "const timer=setTimeout(()=>report('blocked','TIMEOUT'),2000)",
      "dns.lookup('example.com',{family:4},(error,address)=>{if(address)report('resolved','RESOLVED');else report('blocked',String(error?.code||error?.message))})",
    ].join(";");
    const dns = assertProcessSucceeded(
      await postLocalExec(handle.port, token, agentIds[0], `dns-${randomUUID()}`, processRequest(["-e", dnsScript], 5_000)),
      "DNS isolation process",
    );
    const dnsEvidence = validateBlockedNetworkProbe(dns.stdout, "dns");

    const timeout = await postLocalExec(
      handle.port,
      token,
      agentIds[0],
      `timeout-${randomUUID()}`,
      processRequest(["-e", "setTimeout(()=>{},30000)"], 1_000),
    );
    assert(timeout?.ok === false && timeout.code === "process_timeout", `RPC timeout was not reported: ${JSON.stringify(timeout)}`);

    assert(handle.executionBroker !== undefined, "live bootstrap did not expose the execution broker");
    const cancelController = new AbortController();
    const cancelPromise = handle.executionBroker.execute(
      agentIds[0],
      `cancel-${randomUUID()}`,
      processRequest(["-e", "setTimeout(()=>{},30000)"], 30_000),
      cancelController.signal,
    );
    const cancelTimer = setTimeout(() => cancelController.abort(), 500);
    const cancelled = await cancelPromise.finally(() => clearTimeout(cancelTimer));
    assert(!cancelled?.ok && cancelled.code === "process_aborted", `broker cancellation was not reported: ${JSON.stringify(cancelled)}`);

    const quota = await postLocalExec(
      handle.port,
      token,
      agentIds[1],
      `quota-${randomUUID()}`,
      processRequest(["-e", "require('node:fs').writeFileSync('quota.bin',Buffer.alloc(2*1024*1024))"], 10_000),
    );
    assert(quota?.ok === false && quota.code === "quota_exceeded", `workspace quota was not enforced: ${JSON.stringify(quota)}`);

    const statuses = [];
    for (const agentId of agentIds) {
      const status = await postRpc(handle.port, token, "getLocalRuntimeStatus", { agentId });
      assert(status?.agentId === agentId && status.mode === "developer", `final runtime status failed for ${agentId}`);
      assert(status.activeLeaseCount === 0 && status.activeProcessCount === 0, `${agentId} retained an active runtime resource`);
      statuses.push(status);
    }

    const after = await captureGuestInventory(layout);
    assertRuntimeInventoryClean(after, "post-execution inventory", before.socketInventory);
    outcome = {
      port: handle.port,
      agents: agentIds,
      identities,
      tcp: tcpEvidence,
      dns: dnsEvidence,
      timeout: timeout.code,
      cancellation: cancelled.code,
      quota: quota.code,
      recovery: true,
      statuses,
      inventory: { before, after, globalSocketTableChanged: after.socketDigest !== before.socketDigest },
    };
  } finally {
    await stopServer(handle, { turnTimeoutMs: 5_000, drainTimeoutMs: 5_000 });
  }

  await assertPortFree(handle.port);
  const finalJournal = await readHostJournal(layout);
  assert(finalJournal.leases.length === 0, "host runtime journal retained leases after gateway shutdown");
  return { ...outcome, serverStopped: true, portReleased: true };
};

const run = async () => {
  assert(process.env.OPENBOT_RUNTIME_WSL_LIVE_TEST === "1", "live test override is not enabled");
  assertDistro(distro);
  assert(root && sourceArchive && sourceManifest, "live package inputs are missing");
  await assertNoReparse(sourceArchive, "source package archive");
  await assertNoReparse(sourceManifest, "source package manifest");

  const layout = await createManagedRuntimeLayout(root);
  const archive = path.join(layout.staging, "openbot-runtime-package.tar");
  await copyFile(sourceArchive, archive);
  await copyFile(sourceManifest, path.join(layout.staging, "manifest.json"));
  const manifest = parseRuntimeGuestPackageManifest(await readExternalRuntimePackageManifest(layout));
  const actualDigest = `sha256:${createHash("sha256").update(await (await import("node:fs/promises")).readFile(archive)).digest("hex")}`;
  assert(manifest.archiveDigest === undefined || manifest.archiveDigest === actualDigest, "package archive digest mismatch");

  const provisioner = new WslProvisioner({ layout, runner, testOnlyDistroName: distro });
  const installed = await provisioner.installManagedGuestPackage(archive, manifest);
  assert(installed.distroName === distro, "production installer did not return the temporary distro");

  const workspaces = owned(path.join(root, "workspaces"), "managed workspaces root");
  const agentId = "runtime-live-agent";
  const workspace = owned(path.join(workspaces, agentId), "managed workspace");
  await mkdir(workspace, { recursive: true });
  const client = new WslGuestClient({ runner, distroName: distro, managedWorkspacesRoot: workspaces });
  let boot = await client.start();
  assert((await client.health(boot)).ok, "guest health failed");
  const capability = { kind: "process.run", networkProfile: "none" };
  const policyDigest = capabilityDigest(capability);
  const leaseRequest = {
    leaseId: `live-lease-${randomUUID()}`,
    agentId,
    runtimeBootId: boot.runtimeBootId,
    capability,
    policyDigest,
    expiresAt: now() + 60_000,
  };
  const driverLease = await client.acquire(leaseRequest);
  const lease = {
    ...leaseRequest,
    sandboxId: driverLease.sandboxId,
    released: false,
    release: async () => client.release(driverLease),
  };
  const runRequest = {
    operation: "process.run",
    executable: "node",
    argv: ["-e", "const fs=require('fs');process.stdout.write(fs.readFileSync('/proc/self/status','utf8'))"],
    cwd: ".",
    env: null,
    stdin: null,
    timeoutMs: 10_000,
    networkProfile: "none",
  };
  const processResult = await client.runProcess(lease, runRequest, workspace, new AbortController().signal);
  assert(
    
    processResult.ok,
    `real process.run failed: ${JSON.stringify(processResult)}`,
  );
  const identity = assertNonRootIdentity(processResult.stdout);
  assert(/NoNewPrivs:\s+1/iu.test(processResult.stdout), "NoNewPrivs was not enabled");
  assert(/Seccomp:\s+2/iu.test(processResult.stdout), "Seccomp was not active");
  await client.release(driverLease);
  await assertGuestCleanup(boot.runtimeBootId, lease.leaseId);
  const recoveryRecord = {
    leaseId: lease.leaseId,
    agentId: lease.agentId,
    runtimeBootId: lease.runtimeBootId,
    sandboxId: driverLease.sandboxId,
    temporaryId: `tmp-${lease.leaseId}`,
  };

  // Simulate a host crash after cgroup teardown but before sandbox/state
  // teardown. The next guest start must treat the missing cgroup as already
  // clean, remove the remaining sandbox and delete the persisted lease.
  const partialLeaseRequest = { ...leaseRequest, leaseId: `live-partial-${randomUUID()}`, expiresAt: now() + 60_000 };
  const partialDriverLease = await client.acquire(partialLeaseRequest);
  const partialCgroupPath = `/sys/fs/cgroup/openbot/${partialLeaseRequest.runtimeBootId}/${partialLeaseRequest.leaseId}`;
  const partialSandboxPath = `/run/openbot/sandboxes/${partialLeaseRequest.leaseId}`;
  assertRuntimeIdentifier(partialLeaseRequest.runtimeBootId, "partial runtime boot identity");
  assertRuntimeIdentifier(partialLeaseRequest.leaseId, "partial lease identity");
  const partialSandboxCreate = await runner.run(["-d", distro, "--user", "root", "--", "mkdir", "-p", partialSandboxPath]);
  assert(partialSandboxCreate.exitCode === 0, `partial cleanup sandbox fixture could not be created (exit ${partialSandboxCreate.exitCode})`);
  const partialExists = await runner.run(["-d", distro, "--user", "root", "--", "test", "-d", partialCgroupPath]);
  assert(partialExists.exitCode === 0, `partial cleanup cgroup was not created (exit ${partialExists.exitCode})`);
  const partialRemove = await runner.run(["-d", distro, "--user", "root", "--", "rmdir", partialCgroupPath]);
  assert(
    partialRemove.exitCode === 0,
    `partial cleanup cgroup removal failed (exit ${partialRemove.exitCode}): ${partialRemove.stderr.toString("utf8").trim() || partialRemove.stdout.toString("utf8").trim()}`,
  );
  const partialAbsent = await runner.run(["-d", distro, "--user", "root", "--", "test", "!", "-e", partialCgroupPath]);
  const partialSandboxExists = await runner.run(["-d", distro, "--user", "root", "--", "test", "-d", partialSandboxPath]);
  assert(partialAbsent.exitCode === 0 && partialSandboxExists.exitCode === 0, "partial cleanup fixture was not preserved");
  const partialRuntimeBootId = partialLeaseRequest.runtimeBootId;
  boot = await client.start();
  assert((await client.health(boot)).ok, "guest partial cleanup recovery health failed");
  await assertGuestCleanup(partialRuntimeBootId, partialLeaseRequest.leaseId);

  const timeoutLeaseRequest = { ...leaseRequest, runtimeBootId: boot.runtimeBootId, leaseId: `live-timeout-${randomUUID()}`, expiresAt: now() + 60_000 };
  const timeoutDriverLease = await client.acquire(timeoutLeaseRequest);
  const timeoutLease = { ...timeoutLeaseRequest, sandboxId: timeoutDriverLease.sandboxId, released: false, release: async () => client.release(timeoutDriverLease) };
  const timeoutResult = await client.runProcess(timeoutLease, {
    ...runRequest,
    timeoutMs: 1_000,
    argv: ["-e", "setTimeout(()=>{},30000)"],
  }, workspace, new AbortController().signal);
  assert(!timeoutResult.ok && timeoutResult.code === "process_timeout", "guest timeout was not reported");
  await client.release(timeoutDriverLease);
  await assertGuestCleanup(timeoutLease.runtimeBootId, timeoutLease.leaseId);

  const abortLeaseRequest = { ...leaseRequest, runtimeBootId: boot.runtimeBootId, leaseId: `live-abort-${randomUUID()}`, expiresAt: now() + 60_000 };
  const abortDriverLease = await client.acquire(abortLeaseRequest);
  const abortLease = { ...abortLeaseRequest, sandboxId: abortDriverLease.sandboxId, released: false, release: async () => client.release(abortDriverLease) };
  const abortController = new AbortController();
  const abortRun = client.runProcess(abortLease, {
    ...runRequest,
    timeoutMs: 30_000,
    argv: ["-e", "setTimeout(()=>{},30000)"],
  }, workspace, abortController.signal);
  setTimeout(() => abortController.abort(), 500);
  await abortRun.then(
    () => fail("aborted process unexpectedly completed"),
    (error) => assert(error instanceof Error && error.message === "wsl command was aborted", "abort was not observed at the WSL boundary"),
  );
  assert(abortController.signal.aborted, "abort controller did not enter the aborted state");
  // A fresh boot performs the same orphan-lease recovery used after a host
  // cancellation, then health proves the guest remains usable.
  boot = await client.start();
  assert((await client.health(boot)).ok, "guest orphan recovery health failed");
  await assertGuestCleanup(abortLease.runtimeBootId, abortLease.leaseId);

  await client.stop("shutdown");
  const rollbackArchive = path.join(root, "rollback.tar");
  const badArchive = path.join(layout.staging, "bad-runtime.tar");
  const exportResult = await runner.run(["--export", distro, rollbackArchive]);
  assert(exportResult.exitCode === 0, "rollback export failed");
  await writeFile(badArchive, Buffer.from("not a WSL archive"));
  const badManifest = { ...manifest, archiveDigest: undefined };
  await provisioner.installManagedGuestPackage(badArchive, badManifest).then(() => fail("invalid package unexpectedly installed"), () => undefined);
  const rollbackClient = new WslGuestClient({ runner, distroName: distro, managedWorkspacesRoot: workspaces });
  const rollbackBoot = await rollbackClient.start();
  assert((await rollbackClient.health(rollbackBoot)).ok, "rollback guest health failed");
  await rollbackClient.stop("shutdown");
  const bootstrapRpc = await runBootstrapRpc(layout, recoveryRecord);
  return { installed: true, process: true, identity, abortRecovery: true, rollback: true, bootstrapRpc };
};

run().then((result) => {
  process.stdout.write(JSON.stringify({ ok: true, calls, result }), () => process.exit(0));
}).catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, calls, error: error instanceof Error ? error.message : String(error) }), () => process.exit(1));
});
