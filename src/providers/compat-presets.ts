import type { Keystore } from "../keystore/index.js";

export interface CompatPreset {
  id: "clinepass" | "commandcode";
  name: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
}

export const COMPAT_PRESETS: readonly CompatPreset[] = [
  {
    id: "clinepass",
    name: "ClinePass",
    baseUrl: "https://api.cline.bot/api/v1",
    models: [
      { id: "cline-pass/deepseek-v4-pro", name: "DeepSeek V4 Pro (ClinePass)" },
      { id: "cline-pass/deepseek-v4-flash", name: "DeepSeek V4 Flash (ClinePass)" },
      { id: "cline-pass/qwen3.7-max", name: "Qwen3.7 Max (ClinePass)" },
    ],
  },
  {
    id: "commandcode",
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    models: [
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (Command Code)" },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Command Code)" },
      { id: "zai-org/GLM-5.3", name: "GLM-5.3 (Command Code)" },
    ],
  },
];

export function normalizeCompatBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, "").toLowerCase();
}

export function compatKeyProvider(baseUrl: string): string {
  const normalized = normalizeCompatBaseUrl(baseUrl);
  const match = COMPAT_PRESETS.find((preset) => normalizeCompatBaseUrl(preset.baseUrl) === normalized);
  return match?.id ?? "openai-compat";
}

export function wrapKeystoreForCompat(baseUrl: string, keystore?: Keystore): Keystore | undefined {
  if (!keystore) return keystore;
  const provider = compatKeyProvider(baseUrl);
  if (provider === "openai-compat") return keystore;
  return {
    reveal: async (name: string) => (await keystore.reveal(provider)) ?? keystore.reveal(name),
  } as Keystore;
}

export function compatPresetEndpoints() {
  return COMPAT_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    baseURL: preset.baseUrl,
    reachable: true,
    latencyMs: null,
    models: preset.models,
  }));
}
