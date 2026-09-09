export interface WslObservation {
  defaultVersion: number | null;
  distros: readonly string[];
}

export interface WslAvailability {
  supported: boolean;
  dedicatedDistroPresent: boolean;
  reason: "ready" | "wsl2-unavailable" | "managed-distro-missing";
}

export function parseWslDistroList(output: string): string[] {
  if (typeof output !== "string") throw new Error("wsl distro output is invalid");
  return output
    .replaceAll("\0", "")
    .replaceAll("\\0", "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[*\s]+/u, "").trim())
    .filter((line) => line.length > 0);
}

export function probeWslAvailability(
  observation: WslObservation,
  distroName = "OpenBotRuntime",
): WslAvailability {
  const supported = observation.defaultVersion === 2;
  const dedicatedDistroPresent = observation.distros.includes(distroName);
  if (!supported) return { supported: false, dedicatedDistroPresent, reason: "wsl2-unavailable" };
  if (!dedicatedDistroPresent) return { supported: true, dedicatedDistroPresent: false, reason: "managed-distro-missing" };
  return { supported: true, dedicatedDistroPresent: true, reason: "ready" };
}
