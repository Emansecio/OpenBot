import { describe, expect, it } from "vitest";
import { DEVELOPER_TOOLS, HOME_SYSTEM_PROMPT, SAFE_HOME_TOOLS } from "../src/execution/home-tools.js";

describe("SAFE_HOME_TOOLS", () => {
  it("publishes file/search and the structured visual browser, without shell or delete", () => {
    const names = SAFE_HOME_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual([
      "workspace_info",
      "file",
      "search_files",
      "search_text",
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_click_element",
      "browser_scroll",
      "browser_press_key",
      "browser_type",
      "browser_upload",
      "browser_screenshot",
      "browser_handoff",
      "browser_close",
      "whatsapp",
    ]);
    expect(JSON.stringify(SAFE_HOME_TOOLS)).not.toMatch(/shell|"delete"/);
    const file = SAFE_HOME_TOOLS.find((tool) => tool.function.name === "file");
    expect(file?.type).toBe("function");
    expect(file?.function.parameters).toMatchObject({
      type: "object",
      required: ["op"],
      additionalProperties: false,
    });
    expect(file?.function.parameters).toMatchObject({
      properties: { op: { enum: ["list", "stat", "mkdir", "copy", "move", "trash", "restore", "read", "write"] } },
    });
  });

  it("keeps the same browser surface for Developer and adds only process_run", () => {
    const liteNames = SAFE_HOME_TOOLS.map((tool) => tool.function.name);
    const developerNames = DEVELOPER_TOOLS.map((tool) => tool.function.name);
    expect(developerNames.slice(0, liteNames.length)).toEqual(liteNames);
    expect(developerNames.at(-1)).toBe("process_run");
    expect(developerNames.filter((name) => name === "process_run")).toHaveLength(1);
  });

  it("tells the model to work in its home and reach the Windows host when needed", () => {
    expect(HOME_SYSTEM_PROMPT).toMatch(/private physical Windows workspace/);
    expect(HOME_SYSTEM_PROMPT).toContain("workspace_info");
    expect(HOME_SYSTEM_PROMPT).toContain("shared://Documents");
    expect(HOME_SYSTEM_PROMPT).toMatch(/absolute paths on any mounted drive/);
    expect(HOME_SYSTEM_PROMPT).toMatch(/PowerShell/);
    expect(HOME_SYSTEM_PROMPT).toMatch(/process_run/);
    expect(HOME_SYSTEM_PROMPT).toMatch(/1 MB/);
    expect(HOME_SYSTEM_PROMPT).not.toMatch(/LOCALAPPDATA/i);
    const processRun = DEVELOPER_TOOLS.find((tool) => tool.function.name === "process_run");
    expect(processRun?.function.description).toMatch(/trusted host access/);
    expect(processRun?.function.description).toMatch(/absolute path on any mounted drive/);
  });
});
