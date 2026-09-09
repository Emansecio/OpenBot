const outputText = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");

export async function listGuestInventoryRoot(run, target, options = {}) {
  const symbolicLink = await run(["test", "-L", target]);
  if (symbolicLink.exitCode === 0) {
    throw new Error(`guest inventory root is a symbolic link: ${target}`);
  }
  const exists = await run(["test", "-e", target]);
  if (exists.exitCode !== 0) return [];
  const directory = await run(["test", "-d", target]);
  if (directory.exitCode !== 0) {
    throw new Error(`guest inventory root is not a directory: ${target}`);
  }
  const findArguments = [
    "find",
    target,
    "-mindepth",
    String(options.minimumDepth ?? 1),
    "-maxdepth",
    String(options.maximumDepth ?? 1),
  ];
  if (options.directoriesOnly === true) findArguments.push("-type", "d");
  findArguments.push("-print");
  const result = await run(findArguments);
  if (result.exitCode !== 0) {
    throw new Error(`guest inventory ${target} failed: ${outputText(result.stderr).trim()}`);
  }
  const output = outputText(result.stdout).replaceAll("\r", "").trim();
  return output.length === 0 ? [] : output.split("\n").filter(Boolean).sort();
}

export function selectActiveGuestUserProcesses(processTable) {
  return String(processTable ?? "")
    .split("\n")
    .filter((line) => {
      const fields = line.trim().split(/\s+/u);
      return /^\d+$/u.test(fields[0] ?? "") && /^ob-/iu.test(fields[1] ?? "");
    });
}

export function parseGuestSocketEntries(socketTable) {
  return String(socketTable ?? "")
    .split("\n")
    .filter((line) => /^\s*\d+:/u.test(line))
    .map((line) => {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10) throw new Error(`guest socket inventory row is invalid: ${line.trim()}`);
      return [fields[1], fields[2], fields[3], `uid=${fields[7]}`, `inode=${fields[9]}`].join("|");
    })
    .sort();
}

export function findResidualGuestSockets(baselineEntries, currentEntries) {
  const allowance = new Map();
  for (const entry of baselineEntries) allowance.set(entry, (allowance.get(entry) ?? 0) + 1);
  const residual = [];
  for (const entry of currentEntries) {
    const remaining = allowance.get(entry) ?? 0;
    if (remaining > 0) allowance.set(entry, remaining - 1);
    else residual.push(entry);
  }
  return residual.sort();
}

export function assertNoResidualGuestSockets(baselineEntries, currentEntries, label) {
  const residual = findResidualGuestSockets(baselineEntries, currentEntries);
  if (residual.length > 0) {
    throw new Error(`${label} has residual guest sockets: ${JSON.stringify(residual)}`);
  }
}
