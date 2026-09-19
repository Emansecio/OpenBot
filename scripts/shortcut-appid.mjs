import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Pure-Node reader/writer for the Windows taskbar AppUserModelID
// (System.AppUserModel.ID) stored in a .lnk PropertyStoreDataBlock.
//
// Rationale: OpenBot launches through wscript.exe + a hidden .vbs, while the
// running Electron window advertises TASKBAR_APP_ID. When the shortcut carries
// no explicit AppUserModelID, Windows refuses to group the window with the
// shortcut and falls back to the host executable's stock resources, which is
// why the taskbar button shows the Electron icon instead of the OpenBot icon.
// Stamping the same AppUserModelID on the shortcut is the documented grouping
// key. This module edits raw .lnk bytes (MS-SHLLINK) so it works without COM,
// WScript, or extra dependencies. Callers must validate paths; the installer
// applies this writer only to freshly generated, staged shortcuts.

export const TASKBAR_APP_ID = "OpenBot.Desktop";

// PKEY_AppUserModel_ID format identifier as serialized in .lnk
// PropertyStoreDataBlocks (LE-mixed bytes, verified against real pinned
// shortcuts on this machine: Chrome, Hermes, Cursor, and OpenBot itself).
// Note: this differs from the bare FMTID spelling by field order on disk;
// the byte sequence below is the ground truth Windows honors.
const APP_ID_FMTID_HEX = "55284c9f-799f-394b-a8d0-e1d42de1d5f3";
const APP_ID_FMTID = Buffer.from("55284c9f799f394ba8d0e1d42de1d5f3", "hex");
const APP_ID_PID = 5;

const BLOCK_SIGNATURE_PROPERTY_STORE = 0xa0000009;
const STORAGE_VERSION = 0x53505331;
// Explorer writes AppID entries as: PID(4) | 00 1F 00 00 00 | countU32 | UTF-16 units.
// The 5-byte type area is replicated verbatim from real pinned shortcuts.
const APP_ID_TYPE_AREA = Buffer.from([0x00, 0x1f, 0x00, 0x00, 0x00]);
const VT_LPWSTR_FIRST_BYTE = 0x1f;

function assertAppId(appId) {
  const value = String(appId ?? "").trim();
  if (value === "" || value.length > 128 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid taskbar AppUserModelID: ${JSON.stringify(appId)}`);
  }
  return value;
}

function readU32(view, offset) {
  return view.readUInt32LE(offset);
}

// --- .lnk structural parsing (MS-SHLLINK) ---------------------------------

const LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");

export const APP_ID_FORMAT_GUID = APP_ID_FMTID_HEX;
export const APP_ID_PID_VALUE = APP_ID_PID;
export const SIGNATURE_PROPERTY_STORE = BLOCK_SIGNATURE_PROPERTY_STORE;

export function parseLnk(buffer, label) {
  if (buffer.length < 76 || buffer.readUInt32LE(0) !== 0x4c || !buffer.subarray(4, 20).equals(LINK_CLSID)) {
    throw new Error(`Not a Windows shortcut file: ${label}`);
  }
  const flags = buffer.readUInt32LE(20);
  const isUnicode = (flags & 0x80) !== 0;
  let offset = 76;
  if (flags & 0x01) {
    if (offset + 2 > buffer.length) throw new Error(`Truncated IDList: ${label}`);
    offset += 2 + buffer.readUInt16LE(offset);
  }
  if (flags & 0x02) {
    if (offset + 4 > buffer.length) throw new Error(`Truncated LinkInfo: ${label}`);
    offset += buffer.readUInt32LE(offset);
  }
  const stringSlots = ["name", "relativePath", "workingDir", "arguments", "iconLocation"];
  const stringFlags = [0x04, 0x08, 0x10, 0x20, 0x40];
  const strings = {};
  for (let index = 0; index < stringSlots.length; index += 1) {
    if (flags & stringFlags[index]) {
      if (offset + 2 > buffer.length) throw new Error(`Truncated StringData: ${label}`);
      const count = buffer.readUInt16LE(offset);
      offset += 2;
      const size = isUnicode ? count * 2 : count;
      if (offset + size > buffer.length) throw new Error(`Truncated StringData value: ${label}`);
      strings[stringSlots[index]] = isUnicode
        ? buffer.subarray(offset, offset + size).toString("utf16le")
        : buffer.subarray(offset, offset + size).toString("latin1");
      offset += size;
    } else {
      strings[stringSlots[index]] = null;
    }
  }
  const extraStart = offset;
  const blocks = [];
  let cursor = extraStart;
  for (;;) {
    if (cursor + 4 > buffer.length) throw new Error(`Truncated ExtraData: ${label}`);
    const size = readU32(buffer, cursor);
    if (size < 4) {
      blocks.push({ terminal: true, start: cursor, end: cursor + 4 });
      cursor += 4;
      break;
    }
    if (cursor + 8 > buffer.length) throw new Error(`Truncated ExtraData header: ${label}`);
    const signature = readU32(buffer, cursor + 4);
    if (cursor + size > buffer.length) throw new Error(`Truncated ExtraData block: ${label}`);
    blocks.push({ terminal: false, size, signature, start: cursor, end: cursor + size });
    cursor += size;
  }
  return { flags, isUnicode, strings, extraStart, blocks, totalLength: cursor, trailing: buffer.subarray(cursor) };
}

export function parseSheets(data) {
  const sheets = [];
  let cursor = 0;
  for (;;) {
    if (cursor + 4 > data.length) throw new Error("Truncated property storage terminator");
    if (cursor + 4 === data.length || (data.length - cursor >= 4 && data.readUInt32LE(cursor) === 0 && cursor + 4 >= data.length - 4)) {
      // Trailing zero DWORD terminates the sheet list.
      if (data.readUInt32LE(cursor) !== 0) throw new Error("Corrupt property storage terminator");
      return { sheets, terminatorSize: data.length - cursor };
    }
    if (cursor + 4 > data.length) throw new Error("Truncated sheet size");
    const size = data.readUInt32LE(cursor);
    if (size < 24) throw new Error(`Implausible property sheet size: ${size}`);
    if (cursor + size > data.length) throw new Error("Truncated property sheet");
    const version = data.readUInt32LE(cursor + 4);
    if (version !== STORAGE_VERSION) throw new Error(`Unsupported property storage version: 0x${version.toString(16)}`);
    const fmtid = data.subarray(cursor + 8, cursor + 24);
    const entries = [];
    let entryCursor = cursor + 24;
    const sheetEnd = cursor + size;
    while (entryCursor < sheetEnd) {
      if (entryCursor + 8 > sheetEnd) throw new Error("Truncated property entry header");
      const valueSize = data.readUInt32LE(entryCursor);
      const pid = data.readUInt32LE(entryCursor + 4);
      if (valueSize < 4 || entryCursor + 4 + valueSize > sheetEnd) throw new Error("Truncated property entry");
      entries.push({ valueSize, pid, payload: data.subarray(entryCursor + 8, entryCursor + 4 + valueSize), start: entryCursor });
      entryCursor += 4 + valueSize;
    }
    sheets.push({ size, fmtid, entries, start: cursor });
    cursor = sheetEnd;
  }
}

export function decodeAppIdPayload(payload) {
  if (!payload || payload.length < 13) return null;
  if (payload[0] !== 0x00 || payload[1] !== VT_LPWSTR_FIRST_BYTE) return null;
  if (!payload.subarray(0, 5).equals(APP_ID_TYPE_AREA)) return null;
  const count = payload.readUInt32LE(5);
  if (count === 0 || count > 128) return null;
  const textBytes = payload.subarray(9, 9 + count * 2);
  if (textBytes.length !== count * 2) return null;
  const text = textBytes.toString("utf16le").split("\0")[0] ?? "";
  return { text, count };
}

function buildAppIdEntry(appId) {
  const units = [...appId, "\0"].join("");
  const textBytes = Buffer.from(units, "utf16le");
  const count = textBytes.length / 2;
  const payload = Buffer.concat([APP_ID_TYPE_AREA, Buffer.alloc(4), textBytes, Buffer.alloc(4)]);
  payload.writeUInt32LE(count, 5);
  const entry = Buffer.alloc(8 + payload.length);
  entry.writeUInt32LE(payload.length + 4, 0);
  entry.writeUInt32LE(APP_ID_PID, 4);
  payload.copy(entry, 8);
  return entry;
}

function buildSheet(fmtid, entries) {
  const body = Buffer.concat([Buffer.from([0x31, 0x53, 0x50, 0x53]), fmtid, ...entries]);
  const size = 4 + body.length;
  const sheet = Buffer.alloc(size);
  sheet.writeUInt32LE(size, 0);
  body.copy(sheet, 4);
  return sheet;
}

function buildPropertyBlock(sheets) {
  const body = Buffer.concat([...sheets, Buffer.alloc(4)]);
  const block = Buffer.alloc(8 + body.length);
  block.writeUInt32LE(block.length, 0);
  block.writeUInt32LE(BLOCK_SIGNATURE_PROPERTY_STORE, 4);
  body.copy(block, 8);
  return block;
}

export function getShortcutAppId(shortcutPath) {
  const buffer = readFileSync(shortcutPath);
  const lnk = parseLnk(buffer, shortcutPath);
  for (const block of lnk.blocks) {
    if (block.terminal || block.signature !== BLOCK_SIGNATURE_PROPERTY_STORE) continue;
    const { sheets } = parseSheets(buffer.subarray(block.start + 8, block.end));
    for (const sheet of sheets) {
      if (!sheet.fmtid.equals(APP_ID_FMTID)) continue;
      for (const entry of sheet.entries) {
        if (entry.pid !== APP_ID_PID) continue;
        return decodeAppIdPayload(entry.payload)?.text ?? null;
      }
    }
  }
  return null;
}

function rebuildBlockKeepingForeign(buffer, block, appId) {
  const data = buffer.subarray(block.start + 8, block.end);
  const { sheets } = parseSheets(data);
  if (sheets.length === 0) {
    return { block: buildPropertyBlock([buildSheet(APP_ID_FMTID, [buildAppIdEntry(appId)])]), mode: "rebuilt-empty" };
  }
  const foreignSheets = sheets.filter((sheet) => !sheet.fmtid.equals(APP_ID_FMTID));
  const appSheets = sheets.filter((sheet) => sheet.fmtid.equals(APP_ID_FMTID));
  if (foreignSheets.length > 0 && appSheets.length === 0) {
    // WScript creates ownership/volume sheets even for a fresh shortcut.
    // Preserve every opaque sheet byte-for-byte; add only our missing AppID.
    return {
      block: buildPropertyBlock([
        ...sheets.map((sheet) => data.subarray(sheet.start, sheet.start + sheet.size)),
        buildSheet(APP_ID_FMTID, [buildAppIdEntry(appId)]),
      ]),
      mode: "appended",
    };
  }
  if (foreignSheets.length > 0) {
    // A foreign (Explorer/pinned) property store may carry nested structures
    // this writer does not model. Attempt a byte-size-preserving in-place swap
    // of the PID-5 string; anything else is refused to avoid data loss.
    if (appSheets.length !== 1) throw new Error(`Refusing to edit a foreign property store with ${sheets.length} sheets`);
    const sheet = appSheets[0];
    if (sheet.entries.length !== 1 || sheet.entries[0].pid !== APP_ID_PID) {
      throw new Error("Refusing to edit a foreign AppID sheet with extra entries");
    }
    const decoded = decodeAppIdPayload(sheet.entries[0].payload);
    if (!decoded) throw new Error("Refusing to edit an unrecognized AppID entry layout");
    const newUnits = [...appId, "\0"].join("").length;
    if (newUnits > decoded.count) {
      throw new Error(`New AppID does not fit the existing property entry (${decoded.text.length} units available)`);
    }
    const patched = Buffer.from(buffer);
    const payloadStart = block.start + 8 + sheet.entries[0].start + 8;
    const stringStart = payloadStart + 9;
    const capacity = decoded.count * 2;
    const fresh = Buffer.alloc(capacity, 0);
    Buffer.from(`${appId}\0`, "utf16le").copy(fresh);
    fresh.copy(patched, stringStart);
    patched.writeUInt32LE(newUnits, payloadStart + 5);
    return { block: patched.subarray(block.start, block.end), mode: "in-place" };
  }
  // Only our own single-sheet shape (or an empty AppID sheet): rebuild cleanly.
  for (const sheet of appSheets) {
    for (const entry of sheet.entries) {
      if (entry.pid !== APP_ID_PID || !decodeAppIdPayload(entry.payload)) {
        throw new Error("Refusing to edit an unrecognized AppID sheet layout");
      }
    }
  }
  return { block: buildPropertyBlock([buildSheet(APP_ID_FMTID, [buildAppIdEntry(appId)])]), mode: sheets.length > 1 ? "rebuilt-multi" : "rebuilt" };
}

export function setShortcutAppId(shortcutPath, appId) {
  const value = assertAppId(appId);
  const original = readFileSync(shortcutPath);
  const lnk = parseLnk(original, shortcutPath);
  const propBlock = lnk.blocks.find((block) => !block.terminal && block.signature === BLOCK_SIGNATURE_PROPERTY_STORE);
  let replacement;
  let mode;
  if (!propBlock) {
    replacement = buildPropertyBlock([buildSheet(APP_ID_FMTID, [buildAppIdEntry(value)])]);
    mode = "created";
  } else {
    const current = decodeAppIdPayload(propBlock && (() => {
      const { sheets } = parseSheets(original.subarray(propBlock.start + 8, propBlock.end));
      const sheet = sheets.find((item) => item.fmtid.equals(APP_ID_FMTID));
      return sheet?.entries.find((entry) => entry.pid === APP_ID_PID)?.payload;
    })());
    if (current?.text === value) return { path: shortcutPath, appId: value, changed: false, mode: "already" };
    ({ block: replacement, mode } = rebuildBlockKeepingForeign(original, propBlock, value));
  }
  const head = original.subarray(0, propBlock ? propBlock.start : lnk.blocks.at(-1).start);
  const tail = propBlock ? original.subarray(propBlock.end) : original.subarray(lnk.blocks.at(-1).start);
  const next = Buffer.concat([head, replacement, tail]);
  // Re-parse the result before touching disk: a malformed rebuild must never
  // replace a working shortcut.
  const check = parseLnk(next, `${shortcutPath} (rebuilt)`);
  const checkBlock = check.blocks.find((block) => !block.terminal && block.signature === BLOCK_SIGNATURE_PROPERTY_STORE);
  if (!checkBlock) throw new Error("Rebuilt shortcut lost its property store");
  if (check.strings.arguments !== lnk.strings.arguments || check.strings.iconLocation !== lnk.strings.iconLocation) {
    throw new Error("Rebuilt shortcut changed unrelated fields");
  }
  const roundTrip = (() => {
    const { sheets } = parseSheets(next.subarray(checkBlock.start + 8, checkBlock.end));
    const sheet = sheets.find((item) => item.fmtid.equals(APP_ID_FMTID));
    const entry = sheet?.entries.find((item) => item.pid === APP_ID_PID);
    return entry ? decodeAppIdPayload(entry.payload)?.text ?? null : null;
  })();
  if (roundTrip !== value) throw new Error("AppID round-trip verification failed");
  const temporary = `${shortcutPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, next);
  renameSync(temporary, shortcutPath);
  return { path: shortcutPath, appId: value, changed: true, mode };
}

export async function readShortcutAppId(shortcutPath) {
  return getShortcutAppId(shortcutPath);
}

export async function writeShortcutAppId(shortcutPath, appId) {
  return setShortcutAppId(shortcutPath, appId);
}

export function shortcutStringFields(shortcutPath) {
  const buffer = readFileSync(shortcutPath);
  return parseLnk(buffer, shortcutPath).strings;
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const [command, target, value] = process.argv.slice(2);
  if (command === "get" && target) {
    process.stdout.write(`${JSON.stringify(getShortcutAppId(target))}\n`);
  } else if (command === "set" && target && value) {
    process.stdout.write(`${JSON.stringify(setShortcutAppId(target, value))}\n`);
  } else {
    process.stderr.write("Usage: shortcut-appid.mjs get <lnk> | set <lnk> <appId>\n");
    process.exitCode = 2;
  }
}
