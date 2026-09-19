const { app, nativeImage, Menu, Tray } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

// Windows taskbar identity is independent of BrowserWindow's icon.
if (process.platform === "win32") {
  const appId = "OpenBot.Desktop";
  const iconPath = join(process.env.OPENBOT_RELEASE_ROOT || join(__dirname, ".."), "assets", "openbot.ico");
  const launcher = process.env.OPENBOT_INSTALL_ROOT
    ? join(process.env.OPENBOT_INSTALL_ROOT, "OpenBot.vbs")
    : join(__dirname, "openbot-desktop.vbs");
  const windowIconPath = join(process.env.OPENBOT_RELEASE_ROOT || join(__dirname, ".."), "assets", "openbot.png");
  const image = nativeImage.createFromPath(windowIconPath);
  const shellIcon = nativeImage.createFromPath(iconPath);
  if (image.isEmpty() || shellIcon.isEmpty()) {
    throw new Error("OpenBot desktop icons are missing or invalid. Repair the installation before launching.");
  }
  process.env.SAND_DEV_APP_ICON = windowIconPath;
  app.setName("OpenBot");
  app.setAppUserModelId(appId);
  // Keep the extracted renderer/main intact; only the desktop entry owns tray UX.
  let mainWindow;
  let tray;
  let quitting = false;
  const rendererURL = pathToFileURL(join(__dirname, "../client/extracted/dist/renderer/index.html")).href;
  const reopen = () => {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    tray?.destroy();
    tray = undefined;
  });
  // The extracted second-instance handler focuses, but does not show hidden windows.
  app.on("second-instance", reopen);
  app.on("activate", reopen);
  app.on("browser-window-created", (_event, window) => {
    // Never silently fall back to the stock Electron icon.
    window.setIcon(image);
    window.setAppDetails({
      appId,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.env.SystemRoot || "C:\\Windows"}\\System32\\wscript.exe" "${launcher}"`,
      relaunchDisplayName: "OpenBot",
    });
    // Identify the main document, not creation order or window title. Electron
    // does not expose the preload path in getLastWebPreferences().
    window.webContents.on("did-finish-load", () => {
      if (window.webContents.getURL().split(/[?#]/, 1)[0] !== rendererURL || mainWindow === window) return;
      mainWindow = window;
      // Let the document (including modal scrims) paint behind native controls.
      // Preserve the host's theme symbols and dynamic caption height.
      const setTitleBarOverlay = window.setTitleBarOverlay.bind(window);
      window.setTitleBarOverlay = (options) => setTitleBarOverlay({ ...options, color: "#00000000" });
      window.setTitleBarOverlay({});
      if (!tray) {
        let candidate;
        try {
          candidate = new Tray(shellIcon);
          candidate.setToolTip("OpenBot");
          candidate.setContextMenu(Menu.buildFromTemplate([
            { label: "Reabrir OpenBot", click: reopen },
            { type: "separator" },
            { label: "Encerrar OpenBot", click: () => app.quit() },
          ]));
          candidate.on("double-click", reopen);
          tray = candidate;
        } catch (error) {
          candidate?.destroy();
          // Never hide the only window without a working way to reopen it.
          console.error("[openbot] Tray unavailable; closing the window will exit normally.", error);
        }
      }
      window.on("close", (event) => {
        if (quitting || !tray || tray.isDestroyed()) return;
        event.preventDefault();
        window.hide();
      });
      // Windows logoff/shutdown must not be blocked by close-to-tray.
      window.on("query-session-end", () => { quitting = true; });
      window.on("session-end", () => { quitting = true; });
      window.on("closed", () => {
        if (mainWindow === window) mainWindow = undefined;
      });
    });
  });
}

require("../client/extracted/dist/electron-main/main.cjs");
