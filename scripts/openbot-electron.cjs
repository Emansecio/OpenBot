const { app } = require("electron");
const { join } = require("node:path");

// Windows taskbar identity is independent of BrowserWindow's icon.
if (process.platform === "win32") {
  const appId = "OpenBot.Desktop";
  const iconPath = join(process.env.OPENBOT_RELEASE_ROOT || join(__dirname, ".."), "assets", "openbot.ico");
  const launcher = process.env.OPENBOT_INSTALL_ROOT
    ? join(process.env.OPENBOT_INSTALL_ROOT, "OpenBot.vbs")
    : join(__dirname, "openbot-desktop.vbs");
  process.env.SAND_DEV_APP_ICON = iconPath;
  app.setName("OpenBot");
  app.setAppUserModelId(appId);
  app.on("browser-window-created", (_event, window) => {
    window.setIcon(iconPath);
    window.setAppDetails({
      appId,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.env.SystemRoot || "C:\\Windows"}\\System32\\wscript.exe" "${launcher}"`,
      relaunchDisplayName: "OpenBot",
    });
  });
}

require("../client/extracted/dist/electron-main/main.cjs");
