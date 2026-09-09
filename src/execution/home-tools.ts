import type { ProviderTool } from "../providers/router.js";

export const HOME_SYSTEM_PROMPT =
  "Your default home is a private physical Windows workspace. Relative file, search and process paths refer to the same folders there, including Documents, Downloads and Projects. Browser downloads are saved in this home's Downloads. " +
  "Use workspace_info to discover the absolute home path, granted shared folders and any legacy redirect folders containing older files. Legacy folders are not moved automatically; access their absolute paths when needed. " +
  "Shared folders are explicit file/search/upload references such as shared://Documents/note.txt and require a folder grant. They never replace private Documents. In process_run, use the absolute shared path reported by workspace_info, not the shared:// reference. " +
  "When you need something outside it, use process_run: it runs Windows tools on the host and may use absolute paths on any mounted drive, including AppData, installed applications, repositories, and skill folders. " +
  "You may use PowerShell, cmd, WSL, or any installed executable to inspect, copy, create, move, or modify host files. Prefer the private workspace for normal work and access host paths only when the task needs them. " +
  "File reads are limited to 1 MB; for larger files copy an excerpt into Projects. " +
  "Use the file, search_files, search_text, and browser tools. " +
  "Do not ask the user to pick a folder. " +
  "If the user asks about WhatsApp messages, sending, or the local wacli daemon, use the whatsapp tool.";

const HOME_FILE_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "workspace_info",
      description: "Get this bot's physical workspace, granted shared folder paths/access, and existing legacy redirect paths. Call before combining local commands with shared or older files. Does not move or create files.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "file",
      description:
        "Inspect, create, copy, move, trash, restore, read, write, or list files in this bot's physical workspace or an explicit granted shared folder. " +
        "Use path for list/stat/mkdir/trash/read/write, source and destination for copy/move, and trashId with an optional path for restore. " +
        "Relative paths (for example Documents/note.md) stay in the physical home, exactly as in process_run. Use shared://Documents/note.md for a granted user folder; workspace_info reports physical paths for commands and legacy files. Read defaults to utf8 and is limited to 1 MB per file. " +
        "Trash is recoverable; use process_run for command execution. " +
        "Desktop, Documents, Downloads, Pictures, Videos, Music, and Projects exist. Never ask the user to choose a folder.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "stat", "mkdir", "copy", "move", "trash", "restore", "read", "write"] },
          path: { type: "string" },
          source: { type: "string" },
          destination: { type: "string" },
          trashId: { type: "string" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "List files under physical workspace paths or explicit granted shared:// folders. If paths is omitted, searches the bot's Documents and Projects.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search file contents under physical workspace paths or explicit granted shared:// folders. mode is fixed or regex.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          mode: { type: "string", enum: ["fixed", "regex"] },
          paths: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
];

/**
 * Visual browser capabilities exposed to both Lite and Developer agents.
 * Commands are intentionally finite and structured: no shell, JavaScript
 * evaluation, arbitrary URL scheme, or CDP endpoint is model-addressable.
 */
export const BROWSER_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Open your visible private browser window, optionally at a public HTTP(S) URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "HTTP(S) URL, or omit to open a blank tab." } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the visible private browser to an HTTP(S) URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Read the current page title, URL, visible text, screenshot and actionable elements. Prefer browser_click_element with an element id from this result over guessing coordinates.",
      parameters: {
        type: "object",
        properties: { includeText: { type: "boolean", default: true } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click coordinates in the visible browser viewport. Use only when browser_snapshot did not provide an actionable element id.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
          button: { type: "string", enum: ["left", "middle", "right"] },
          clickCount: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click_element",
      description: "Click one currently visible actionable element using the id returned by the latest browser_snapshot.",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string", pattern: "^ob-el-[1-9][0-9]{0,5}$" } },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the current page by bounded pixel deltas, then call browser_snapshot again.",
      parameters: {
        type: "object",
        properties: {
          deltaX: { type: "number", minimum: -10000, maximum: 10000 },
          deltaY: { type: "number", minimum: -10000, maximum: 10000 },
        },
        required: ["deltaX", "deltaY"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press_key",
      description: "Press one safe navigation key in the focused browser element.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", enum: ["ENTER", "TAB", "ESCAPE", "SPACE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "BACKSPACE"] } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Type text into the focused element of the visible browser.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", maxLength: 65536 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_upload",
      description: "Set a visible browser file input to a file in this bot's physical home or an explicitly granted shared:// folder. Use workspace_info to discover shared folders.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the input[type=file] element." },
          path: { type: "string", description: "Relative file path inside your private home, for example Documents/report.pdf." },
        },
        required: ["selector", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Capture a screenshot of the visible private browser.",
      parameters: {
        type: "object",
        properties: { fullPage: { type: "boolean", default: false } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_handoff",
      description: "Show and focus this bot's browser window for the user.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Close this bot's visible browser tab and release its browser lease.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export const WHATSAPP_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "whatsapp",
    description:
      "Use the user's local WhatsApp CLI (wacli) on the Windows host. " +
      "op=doctor checks the daemon, sweep lists pending chats, messages_list reads one chat, send delivers text, download fetches one media item. " +
      "Do not use process_run or browser for WhatsApp.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["doctor", "sweep", "messages_list", "send", "download"] },
        chat: { type: "string", description: "Chat JID or phone number for messages_list, send, and download." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        text: { type: "string", description: "UTF-8 message body for send." },
        etapa: { type: "string", description: "Optional send.py etapa name." },
        mediaId: { type: "string", description: "Optional media message id for download." },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
};

export const SAFE_HOME_TOOLS: ProviderTool[] = [...HOME_FILE_TOOLS, ...BROWSER_TOOLS, WHATSAPP_TOOL];

export const PROCESS_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "process_run",
    description: "Run a Windows process on the user's PC with trusted host access. cwd may be relative to the agent workspace or an absolute path on any mounted drive. OPENBOT_WORKSPACE contains the physical home path. Installed executables and shells such as powershell.exe and cmd.exe are available. On failure, inspect partialOutput and existing files before retrying; earlier effects may persist.",
    parameters: {
      type: "object",
      properties: {
        executable: { type: "string", description: "Executable name available on PATH or an absolute executable path." },
        argv: { type: "array", items: { type: "string" }, description: "Arguments passed as separate values; never a shell command." },
        cwd: { type: "string", description: "Relative path in the agent workspace or absolute Windows path on any mounted drive." },
        env: { type: "object", additionalProperties: { type: "string" } },
        stdin: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
        networkProfile: { type: "string", enum: ["host"], description: "Trusted Windows execution always uses the host network." },
      },
      required: ["executable", "argv", "cwd", "timeoutMs"],
    },
  },
};

export const DEVELOPER_TOOLS: ProviderTool[] = [...SAFE_HOME_TOOLS, PROCESS_TOOL];
