import { describe, expect, it } from "vitest";

import { parseAsyncTaskCommandV1 } from "../src/tasks/command.js";

describe("AsyncTaskCommandV1", () => {
  it("accepts only canonical typed filesystem/process commands", () => {
    expect(parseAsyncTaskCommandV1('{"version":1,"kind":"filesystem","request":{"operation":"file.list","path":"C:\\\\workspace"}}', "filesystem").kind).toBe("filesystem");
    expect(parseAsyncTaskCommandV1('{"version":1,"kind":"process","request":{"operation":"process.run","executable":"node","argv":["--version"],"cwd":".","timeoutMs":1000,"networkProfile":"none"}}', "process").kind).toBe("process");
    expect(() => parseAsyncTaskCommandV1('{"version":1,"kind":"process","request":{"operation":"file.list","path":"C:\\\\workspace"}}', "process")).toThrow(/process\.run/i);
    expect(() => parseAsyncTaskCommandV1(' {"version":1,"kind":"filesystem","request":{"operation":"file.list","path":"C:\\\\workspace"}}', "filesystem")).toThrow(/canonical/i);
    expect(() => parseAsyncTaskCommandV1("run ls", "filesystem")).toThrow(/canonical JSON/i);
  });

  it("binds browser origin and rejects grant-kind confusion", () => {
    const command = parseAsyncTaskCommandV1('{"version":1,"kind":"browser","origin":"https://example.com","request":{"operation":"browser.snapshot"}}', "browser");
    expect(command).toMatchObject({ kind: "browser", origin: "https://example.com" });
    expect(() => parseAsyncTaskCommandV1('{"version":1,"kind":"browser","origin":"https://example.com","request":{"operation":"browser.snapshot"}}', "filesystem")).toThrow();
  });

  it("keeps MCP and Skill argument shapes closed", () => {
    expect(parseAsyncTaskCommandV1('{"version":1,"kind":"mcp","request":{"serverId":"server","toolName":"tool","args":{}}}', "mcp").kind).toBe("mcp");
    expect(parseAsyncTaskCommandV1('{"version":1,"kind":"skill","request":{"skillId":"skill","args":{}}}', "skill").kind).toBe("skill");
    expect(() => parseAsyncTaskCommandV1('{"version":1,"kind":"mcp","request":{"serverId":"server","toolName":"tool","args":{},"extra":true}}', "mcp")).toThrow();
    expect(() => parseAsyncTaskCommandV1('{"version":1,"kind":"skill","request":{"skillId":"skill","args":{},"extra":true}}', "skill")).toThrow();
  });
});
