import { describe, expect, it } from "vitest";

import { COMPAT_PRESETS, compatKeyProvider, compatPresetEndpoints } from "../src/providers/compat-presets.js";

describe("compat presets", () => {
  it("maps ClinePass and Command Code URLs to their own keystore slots", () => {
    expect(compatKeyProvider("https://api.cline.bot/api/v1/")).toBe("clinepass");
    expect(compatKeyProvider("https://api.commandcode.ai/provider/v1")).toBe("commandcode");
    expect(compatKeyProvider("http://127.0.0.1:1234/v1")).toBe("openai-compat");
  });

  it("exposes both presets as reachable discovery chips", () => {
    expect(COMPAT_PRESETS.map((preset) => preset.id)).toEqual(["clinepass", "commandcode"]);
    expect(compatPresetEndpoints().map((endpoint) => endpoint.id)).toEqual(["clinepass", "commandcode"]);
    expect(compatPresetEndpoints().every((endpoint) => endpoint.reachable)).toBe(true);
  });
});
