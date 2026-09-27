// Sandboxed preload for OpenBot browser tabs. It runs in Electron's isolated
// world before any page script, so its capture listeners are the first to see
// copy/cut events and the page cannot remove them.
//
// Agent clicks and key presses are trusted user gestures, which would let a
// page overwrite the user's real Windows clipboard (for example with a
// command to paste into a terminal). Outside a handoff the page's copy/cut
// handlers are skipped and the selection is collapsed, so nothing is written.
// During a handoff the user is acting and copy/cut work normally.
"use strict";

const { ipcRenderer } = require("electron");

const POLICY_CHANNEL = "openbot:clipboard-write-allowed";

function clipboardWriteAllowed() {
  try {
    return ipcRenderer.sendSync(POLICY_CHANNEL) === true;
  } catch {
    return false;
  }
}

function collapseSelection() {
  try {
    const active = document.activeElement;
    if (active && typeof active.setSelectionRange === "function" && typeof active.selectionEnd === "number") {
      active.setSelectionRange(active.selectionEnd, active.selectionEnd);
    }
  } catch {
    // Some input types do not support selection ranges.
  }
  try {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  } catch {
    // Nothing is selected in a document without a selection object.
  }
}

function guardClipboardEvent(event) {
  if (clipboardWriteAllowed()) return;
  // Not cancelled: a cancelled copy event writes the page's clipboardData.
  // With the page's handlers skipped and no selection left, the default
  // action has nothing to copy.
  event.stopImmediatePropagation();
  collapseSelection();
}

window.addEventListener("copy", guardClipboardEvent, true);
window.addEventListener("cut", guardClipboardEvent, true);
