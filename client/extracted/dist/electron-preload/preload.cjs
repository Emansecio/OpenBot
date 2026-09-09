const __mod=require('node:module');const __p=require('node:path');const __depsDir=__p.join(__dirname,'..','deps');process.env.NODE_PATH=__depsDir+(process.env.NODE_PATH?__p.delimiter+process.env.NODE_PATH:'');__mod.Module._initPaths();const __import_meta_url=require('node:url').pathToFileURL(__filename).href;
"use strict";

// dune/src/internal/rpc/contract.ts
function declareRpcContract(edge, ...events) {
  return { edge, hasEvents: events.length > 0 };
}

// dune/src/internal/rpc/edge.ts
var EDGE_UNKNOWN_METHOD = "edge/unknown-method";
var EDGE_HANDLER_FAILED = "edge/handler-failed";
var EdgeCallFailure = class extends Error {
  code;
  detail;
  constructor(failure) {
    super(`${failure.code}: ${failure.detail}`);
    this.name = "EdgeCallFailure";
    this.code = failure.code;
    this.detail = failure.detail;
  }
};
function isEdgeReplyEnvelope(value) {
  if (typeof value !== "object" || value == null || !("ok" in value)) return false;
  return typeof value.ok === "boolean";
}
function methodChannel(edge, method) {
  return `sand-rpc:${edge}:m:${method}`;
}
function eventChannel(edge, event) {
  return `sand-rpc:${edge}:e:${event}`;
}
function bridgeEdge(contract, table, transport) {
  const bridge = {};
  const callMethod = async (method, payload) => {
    let reply;
    try {
      reply = await transport.invoke(methodChannel(contract.edge, method), payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EdgeCallFailure({ code: EDGE_UNKNOWN_METHOD, detail });
    }
    if (!isEdgeReplyEnvelope(reply)) {
      throw new EdgeCallFailure({
        code: EDGE_HANDLER_FAILED,
        detail: "The edge replied outside its envelope."
      });
    }
    if (reply.ok) return reply.value;
    throw new EdgeCallFailure(reply.failure);
  };
  for (const [method, row] of Object.entries(table)) {
    bridge[method] = row.args === "none" ? () => callMethod(method, {}) : (args) => callMethod(method, args);
  }
  if (contract.hasEvents) {
    bridge.subscribe = (handlers) => {
      const unsubscribes = [];
      for (const [event, listener] of Object.entries(handlers)) {
        if (listener == null) continue;
        unsubscribes.push(
          transport.on(eventChannel(contract.edge, event), listener)
        );
      }
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    };
  }
  return bridge;
}

// src/electron-preload/preload.cts
var import_electron = require("electron");

// src/shared/persistence.ts
var CLIENT_PERSISTENCE_CHANNELS = {
  read: "sand:client-persistence-read",
  write: "sand:client-persistence-write",
  remove: "sand:client-persistence-remove",
  listKeys: "sand:client-persistence-list-keys",
  migrate: "sand:client-persistence-migrate"
};

// src/shared/rpc/main.ts
var mainRpcContract = declareRpcContract("main", "events");
var MAIN_METHOD_TABLE = {
  openExternal: { args: "object" },
  submitFeedback: { args: "object" },
  getDesktopEnvironment: { args: "none" },
  getWindowState: { args: "none" },
  minimizeWindow: { args: "none" },
  toggleMaximizeWindow: { args: "none" },
  closeWindow: { args: "none" },
  resizeWindowWidth: { args: "object" },
  setTitleBarOverlayTone: { args: "object" },
  getThemeState: { args: "none" },
  setThemePreference: { args: "object" },
  getEgressTunnelEnabled: { args: "none" },
  setEgressTunnelEnabled: { args: "object" },
  getEgressTunnelStatus: { args: "none" },
  getWebauthnProxyEnabled: { args: "none" },
  setWebauthnProxyEnabled: { args: "object" },
  getUpdateStatus: { args: "none" },
  checkForUpdates: { args: "none" },
  setUpdateTrack: { args: "object" },
  quitAndInstallUpdate: { args: "none" },
  setAutoUpdateWhenIdleOptIn: { args: "object" },
  getBoxMigrationStatus: { args: "none" },
  getOnboardingSeen: { args: "none" },
  setOnboardingSeen: { args: "object" },
  getTimeZone: { args: "none" },
  setTimeZoneOverride: { args: "object" },
  getAutoReviewInstructions: { args: "none" },
  setAutoReviewInstructions: { args: "object" },
  getLocalToolPermission: { args: "none" },
  getLocalToolPermissionCeiling: { args: "none" },
  setLocalToolPermission: { args: "object" },
  recordLocalToolApproval: { args: "object" },
  clearLocalToolApprovals: { args: "none" },
  getSidebarCollapsed: { args: "none" },
  setSidebarCollapsed: { args: "object" },
  pickAvatarSource: { args: "none" },
  pickAvatarFile: { args: "none" },
  generateAgentAvatarImage: { args: "object" },
  resolveAttachmentMedia: { args: "object" },
  readAttachmentText: { args: "object" },
  readAttachmentBytes: { args: "object" },
  stageAttachmentBytes: { args: "object" },
  downloadAttachment: { args: "object" },
  commitStagedAttachments: { args: "object" },
  discardStagedAttachment: { args: "object" },
  forceRecreateComputer: { args: "none" },
  updateComputer: { args: "object" },
  forceReconnectGateway: { args: "none" },
  getExperimentsSnapshot: { args: "none" },
  applyFeatureFlagOverride: { args: "object" },
  refreshFeatureFlags: { args: "none" },
  startRpcTraceWindow: { args: "none" },
  getAgentDefaultModel: { args: "none" },
  setAgentDefaultModel: { args: "object" },
  getHostPinnedAgents: { args: "none" },
  setHostPinnedAgents: { args: "object" },
  getHostSidebarSections: { args: "none" },
  setHostSidebarSections: { args: "object" },
  getAvailableModels: { args: "none" },
  transcribeAudio: { args: "object" },
  getCursorAuthStatus: { args: "none" },
  loginCursor: { args: "none" },
  cancelCursorLogin: { args: "none" },
  logoutCursor: { args: "none" },
  updateCursorAccountName: { args: "object" },
  getCursorAvatar: { args: "none" },
  getCursorWeeklyUsage: { args: "none" },
  getCursorUsageSummary: { args: "none" },
  getCursorPrivacyModeEnabled: { args: "none" },
  getSandAccess: { args: "none" },
  invokeCursorDashboardAction: { args: "object" },
  reportAgentLoad: { args: "object" },
  reportAgentsUnreachable: { args: "object" },
  reportRecoveryAction: { args: "object" },
  reportRebuildLifecycle: { args: "object" },
  reportReconciliation: { args: "object" },
  reportBoxVisibility: { args: "object" },
  reportSendLatency: { args: "object" },
  reportSendAck: { args: "object" },
  reportReactionAck: { args: "object" },
  reportRenderTtfr: { args: "object" },
  reportRenderStream: { args: "object" },
  reportVncSession: { args: "object" },
  reportVncLiveness: { args: "object" },
  reportOpenComputer: { args: "object" },
  reportUpdatePrompt: { args: "object" },
  reportSigninGate: { args: "object" },
  reportOnboardingStep: { args: "object" },
  reportClientFailure: { args: "object" },
  openCloudAgent: { args: "object" },
  getLinkMetadata: { args: "object" },
  listSecrets: { args: "none" },
  revealSecret: { args: "object" },
  upsertSecrets: { args: "object" },
  removeSecrets: { args: "object" },
  getMcpState: { args: "none" },
  getEffectivePlugins: { args: "none" },
  getMcpCatalog: { args: "none" },
  getMcpTeamPopularity: { args: "none" },
  getMcpPluginLogo: { args: "object" },
  installEntry: { args: "object" },
  updatePluginInstall: { args: "object" },
  removeMcpServer: { args: "object" },
  uninstallPlugin: { args: "object" },
  authenticateMcpServer: { args: "object" },
  renameMcpAccount: { args: "object" },
  removeMcpAccount: { args: "object" },
  setMcpCustomInstructions: { args: "object" },
  listMcpServerTools: { args: "object" },
  toggleMcpToolDisabled: { args: "object" }
};

// src/electron-preload/coordinator-port-bridge.ts
function createCoordinatorPortBroker(options) {
  let owner = null;
  return {
    bridge: {
      claim(consumer) {
        if (owner != null) return null;
        owner = consumer;
        return {
          request: () => {
            if (owner !== consumer) return;
            options.invokeRequest();
          },
          release: () => {
            if (owner !== consumer) return;
            owner = null;
          }
        };
      }
    },
    deliver(port) {
      owner?.onPort(port);
    }
  };
}
var openBotPendingConversations = new Map();
function rememberOpenBotPendingConversations(value) {
  if (typeof value !== "string") return;
  try {
    const records = JSON.parse(value).value?.records ?? [];
    openBotPendingConversations.clear();
    for (const record of records) {
      if (record.openbotConversationId) {
        for (const nonce of [record.nonce, ...(record.priorNonces ?? [])]) openBotPendingConversations.set(JSON.stringify([record.agentId, nonce]), record.openbotConversationId);
      }
    }
  } catch {}
}
const openBotPromptDeliveryListeners = new Set();
function publishOpenBotPromptDelivery(state) {
  for (const listener of openBotPromptDeliveryListeners) {
    try { listener(state); } catch {}
  }
}
function wrapTransferredCoordinatorPort(port) {
  const sends = new Map();
  port.addEventListener("message", (event) => {
    const reply = event.data;
    if (reply?.kind !== "reply") return;
    const send = sends.get(reply.requestId);
    if (!send) return;
    sends.delete(reply.requestId);
    const value = reply.outcome?.status === "ok" ? reply.outcome.value : null;
    if (value?.accepted === true || (value?.outcome === "found" && value.record?.status === "accepted")) {
      publishOpenBotPromptDelivery({ ...send, phase: "accepted" });
    }
  });
  port.addEventListener("close", () => sends.clear());
  return {
    postMessage: (message) => {
      if (message?.kind === "request" && ["sendPrompt", "promptAcceptanceStatus"].includes(message.method)) {
        const args = message.args;
        const nonce = args?.clientNonce ?? args?.nonce;
        const bindings = [...openBotPendingConversations].filter(([key]) => {
          const [agentId, boundNonce] = JSON.parse(key);
          return nonce === boundNonce && (args?.agentId === undefined || args.agentId === agentId);
        });
        if (bindings.length === 1) message = { ...message, args: { ...args, agentId: JSON.parse(bindings[0][0])[0], conversationId: bindings[0][1] } };
      }
      if (message?.kind === "request" && ["sendPrompt", "promptAcceptanceStatus"].includes(message.method)) {
        const agentId = message.args?.agentId;
        const nonce = message.args?.clientNonce ?? message.args?.nonce;
        if (typeof agentId === "string" && typeof nonce === "string") {
          const send = { agentId, nonce };
          sends.set(message.requestId, send);
          if (message.method === "sendPrompt") publishOpenBotPromptDelivery({ ...send, phase: "sending" });
        }
      }
      port.postMessage(message);
    },
    close: () => {
      sends.clear();
      port.close();
    },
    start: () => {
      port.start();
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        port.addEventListener("message", (event) => {
          listener({ data: event.data });
        });
        return;
      }
      port.addEventListener("close", () => {
        listener({});
      });
    }
  };
}

// src/electron-preload/preload.cts
var isDevRestartEnabled = process.env.SAND_RESTART_EXIT_CODE != null && process.env.SAND_RESTART_EXIT_CODE.length > 0;
var devRestart = isDevRestartEnabled ? async () => {
  await import_electron.ipcRenderer.invoke("sand:dev-restart");
} : void 0;
var attachProdBox = {
  async getStatus() {
    return await import_electron.ipcRenderer.invoke("sand:attach-prod-box-status");
  },
  async setEnabled(enabled, options) {
    return await import_electron.ipcRenderer.invoke("sand:attach-prod-box-set-enabled", {
      enabled,
      isRestartMainApp: options?.isRestartMainApp
    });
  }
};
var initialExperimentSnapshot = import_electron.ipcRenderer.sendSync(
  "sand:experiments-snapshot-sync"
);
var initialThemeState = import_electron.ipcRenderer.sendSync("sand:theme-get-sync");
var initialEgressTunnelEnabled = import_electron.ipcRenderer.sendSync("sand:egress-tunnel-get-sync") === true;
var initialWebauthnProxyEnabled = import_electron.ipcRenderer.sendSync("sand:webauthn-proxy-get-sync") === true;
var initialEgressTunnelStatus = import_electron.ipcRenderer.sendSync(
  "sand:egress-tunnel-status-get-sync"
);
var coordinatorPortBroker = createCoordinatorPortBroker({
  invokeRequest: () => {
    void import_electron.ipcRenderer.invoke("sand:coordinator-port-request");
  }
});
var mainEdgeTransport = {
  invoke: (channel, payload) => import_electron.ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on(channel, wrapped);
    return () => {
      import_electron.ipcRenderer.off(channel, wrapped);
    };
  }
};
var mainEdge = bridgeEdge(mainRpcContract, MAIN_METHOD_TABLE, mainEdgeTransport);
var clientPersistence = {
  async recoverFailedSend(args) {
    await clientPersistence.flush();
    const result = await import_electron.ipcRenderer.invoke("openbot:recover-failed-send", args);
    window.location.reload();
    return result;
  },
  async flush() {
    await import_electron.ipcRenderer.invoke("sand:client-persistence-flush");
  },
  async getDraftStatus() {
    return await import_electron.ipcRenderer.invoke("sand:client-persistence-draft-status");
  },
  onDraftStatus(listener) {
    const wrapped = (_event, state) => listener(state);
    import_electron.ipcRenderer.on("openbot:draft-persistence", wrapped);
    return () => import_electron.ipcRenderer.off("openbot:draft-persistence", wrapped);
  },
  async read(key) {
    const value = await import_electron.ipcRenderer.invoke(CLIENT_PERSISTENCE_CHANNELS.read, { key });
    if (key.endsWith(".send-journal")) rememberOpenBotPendingConversations(value);
    return value;
  },
  async write(key, value) {
    const saved = await import_electron.ipcRenderer.invoke(CLIENT_PERSISTENCE_CHANNELS.write, { key, value });
    if (key.endsWith(".send-journal")) rememberOpenBotPendingConversations(saved);
  },
  async remove(key) {
    await import_electron.ipcRenderer.invoke(CLIENT_PERSISTENCE_CHANNELS.remove, { key });
  },
  async listKeys(prefix) {
    return await import_electron.ipcRenderer.invoke(CLIENT_PERSISTENCE_CHANNELS.listKeys, { prefix });
  },
  async migrateFromLocalStorage(entries) {
    return await import_electron.ipcRenderer.invoke(CLIENT_PERSISTENCE_CHANNELS.migrate, { entries });
  }
};
async function changeOpenBotConversation(operation) {
  await clientPersistence.flush();
  const result = await operation();
  await clientPersistence.flush();
  setTimeout(() => window.location.reload(), 0);
  return result;
}
var desktop = {
  async resolveAttachmentMedia(url) {
    return await import_electron.ipcRenderer.invoke("sand:resolve-attachment-media", {
      url
    });
  },
  async readAttachmentText(path) {
    return await import_electron.ipcRenderer.invoke("sand:read-attachment-text", { path });
  },
  async readAttachmentBytes(path, maxBytes) {
    return await import_electron.ipcRenderer.invoke("sand:read-attachment-bytes", {
      path,
      maxBytes
    });
  },
  async downloadAttachment(path, suggestedName) {
    return await import_electron.ipcRenderer.invoke("sand:download-attachment", {
      path,
      suggestedName
    });
  },
  async getLinkMetadata(url) {
    return await import_electron.ipcRenderer.invoke("sand:link-metadata-get", { url });
  },
  async openExternal(url) {
    await import_electron.ipcRenderer.invoke("sand:open-external", { url });
  },
  async openCloudAgent(bcId) {
    await import_electron.ipcRenderer.invoke("sand:open-cloud-agent", { bcId });
  },
  async stageAttachmentBytes(filename, bytes) {
    return await import_electron.ipcRenderer.invoke("sand:attachment-stage-bytes", {
      filename,
      bytes
    });
  },
  async commitStagedAttachments(paths, filenames) {
    return await import_electron.ipcRenderer.invoke("sand:attachment-commit", {
      paths,
      filenames
    });
  },
  async discardStagedAttachment(path) {
    await import_electron.ipcRenderer.invoke("sand:attachment-discard", { path });
  },
  mcp: {
    async list() {
      return await import_electron.ipcRenderer.invoke("sand:mcp-list");
    },
    async effectivePlugins() {
      return await import_electron.ipcRenderer.invoke("sand:mcp-effective-plugins");
    },
    async catalog() {
      return await import_electron.ipcRenderer.invoke("sand:mcp-catalog");
    },
    async teamPopularity() {
      return await import_electron.ipcRenderer.invoke("sand:mcp-team-popularity");
    },
    async pluginLogo(url) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-plugin-logo", { url });
    },
    async install(request) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-install", request);
    },
    async updatePluginInstall(request) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-update-plugin-install", request);
    },
    async remove(serverId) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-remove", { serverId });
    },
    async uninstallPlugin(pluginId) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-uninstall-plugin", { pluginId });
    },
    async authenticate(serverId, accountKey) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-auth", {
        serverId,
        ...accountKey != null ? { accountKey } : {}
      });
    },
    async renameAccount(args) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-rename-account", args);
    },
    async removeAccount(args) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-remove-account", args);
    },
    async setCustomInstructions(args) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-set-instructions", args);
    },
    async listServerTools(serverId) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-list-server-tools", { serverId });
    },
    async toggleToolDisabled(args) {
      return await import_electron.ipcRenderer.invoke("sand:mcp-toggle-tool-disabled", args);
    },
    onAuthCompleted(listener) {
      const wrapped = (_event, payload) => {
        listener(payload);
      };
      import_electron.ipcRenderer.on("sand:mcp-auth-event", wrapped);
      return () => {
        import_electron.ipcRenderer.off("sand:mcp-auth-event", wrapped);
      };
    }
  },
  async forceGatewayReconnect() {
    await import_electron.ipcRenderer.invoke("sand:gateway-force-reconnect");
  },
  async pickAvatarSource() {
    return await import_electron.ipcRenderer.invoke("sand:dialog-pick-avatar-source");
  },
  async pickAvatarFile() {
    return await import_electron.ipcRenderer.invoke("sand:dialog-pick-avatar-file");
  },
  async generateAgentAvatarImage(description) {
    return await import_electron.ipcRenderer.invoke("sand:agents-generate-avatar-image", {
      description
    });
  },
  onFocusAgent(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:focus-agent", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:focus-agent", wrapped);
    };
  },
  onDeepLink(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:deep-link", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:deep-link", wrapped);
    };
  },
  // Main queues OS deep links until this ready signal, so a cold-start link cannot race the listener.
  deepLinksReady() {
    import_electron.ipcRenderer.send("sand:deep-links-ready");
  },
  async getBoxMigrationStatus() {
    return await import_electron.ipcRenderer.invoke("sand:box-migration-status");
  },
  onBoxMigration(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:box-migration", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:box-migration", wrapped);
    };
  },
  onDevBoxRebuild(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:dev-box-rebuild", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:dev-box-rebuild", wrapped);
    };
  },
  onOpenFeedback(listener) {
    const wrapped = () => {
      listener();
    };
    import_electron.ipcRenderer.on("sand:open-feedback", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:open-feedback", wrapped);
    };
  },
  onOpenAbout(listener) {
    const wrapped = () => {
      listener();
    };
    import_electron.ipcRenderer.on("sand:open-about", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:open-about", wrapped);
    };
  },
  async submitFeedback(payload) {
    return await import_electron.ipcRenderer.invoke("sand:feedback-submit", payload);
  },
  onWidgetGallery(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:dev-widget-gallery", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:dev-widget-gallery", wrapped);
    };
  },
  onForceOnboarding(listener) {
    return mainEdge.subscribe({ "force-onboarding": () => listener() });
  },
  async transcribeAudio(audio, mimeType, language) {
    return await import_electron.ipcRenderer.invoke("sand:transcribe-audio", {
      audio,
      mimeType,
      language
    });
  },
  cursorAccount: {
    async getStatus() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-auth-status");
    },
    async login() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-auth-login");
    },
    async cancelLogin() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-auth-cancel-login");
    },
    async logout() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-auth-logout");
    },
    async updateName(name) {
      return await import_electron.ipcRenderer.invoke("sand:cursor-auth-update-name", name);
    },
    async getAvatar() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-avatar-get");
    },
    async getWeeklyUsage() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-usage-get");
    },
    async getUsageSummary() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-usage-summary");
    },
    async getPrivacyModeEnabled() {
      return await import_electron.ipcRenderer.invoke("sand:cursor-privacy-mode");
    },
    async getSandAccess() {
      return await import_electron.ipcRenderer.invoke("sand:sand-access");
    },
    async invokeDashboardAction(request) {
      return await import_electron.ipcRenderer.invoke("sand:cursor-dashboard-action", request);
    },
    onStatusChanged(listener) {
      const wrapped = (_event, payload) => {
        listener(payload);
      };
      import_electron.ipcRenderer.on("sand:cursor-auth-event", wrapped);
      return () => {
        import_electron.ipcRenderer.off("sand:cursor-auth-event", wrapped);
      };
    }
  },
  experiments: {
    initialSnapshot: initialExperimentSnapshot,
    async getSnapshot() {
      return await import_electron.ipcRenderer.invoke("sand:experiments-snapshot");
    },
    async applyFeatureFlagOverride(command) {
      await import_electron.ipcRenderer.invoke("sand:experiments-apply-override", command);
    },
    async refresh() {
      await import_electron.ipcRenderer.invoke("sand:experiments-refresh");
    },
    async startRpcTraceWindow() {
      return await import_electron.ipcRenderer.invoke("sand:experiments-start-rpc-trace-window") === true;
    },
    onChanged(listener) {
      const wrapped = (_event, payload) => {
        listener(payload);
      };
      import_electron.ipcRenderer.on("sand:experiments-event", wrapped);
      return () => {
        import_electron.ipcRenderer.off("sand:experiments-event", wrapped);
      };
    }
  },
  platform: process.platform,
  isDev: isDevRestartEnabled,
  async getWindowState() {
    return await import_electron.ipcRenderer.invoke("sand:window-state-get");
  },
  onWindowStateEvent(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:window-state-event", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:window-state-event", wrapped);
    };
  },
  // Chromium restores a persisted per-origin zoom before the renderer runs, so the chrome reads it live.
  getZoomFactor() {
    return import_electron.webFrame.getZoomFactor();
  },
  onZoomFactorEvent(listener) {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("sand:zoom-factor-event", wrapped);
    return () => {
      import_electron.ipcRenderer.off("sand:zoom-factor-event", wrapped);
    };
  },
  windowControls: {
    minimize() {
      import_electron.ipcRenderer.send("sand:window-minimize");
    },
    toggleMaximize() {
      import_electron.ipcRenderer.send("sand:window-maximize-toggle");
    },
    close() {
      import_electron.ipcRenderer.send("sand:window-close");
    },
    setTitleBarOverlayTone(isOverlayTone) {
      import_electron.ipcRenderer.send("sand:window-title-bar-overlay-tone", { isOverlayTone });
    },
    async resizeWidth(deltaWidth) {
      const applied = await import_electron.ipcRenderer.invoke("sand:window-resize-width", {
        deltaWidth
      });
      return typeof applied === "number" ? applied : 0;
    }
  },
  foreverBox: {
    async forceRecreate() {
      return await import_electron.ipcRenderer.invoke("sand:forever-box-force-recreate");
    },
    async update(id, force = false) {
      return await import_electron.ipcRenderer.invoke("sand:forever-box-update", { id, force });
    },
    onVncUserPresence(listener) {
      const wrapped = (_event, isPresent) => {
        listener(isPresent);
      };
      import_electron.ipcRenderer.on("sand:vnc-user-presence-event", wrapped);
      return () => {
        import_electron.ipcRenderer.off("sand:vnc-user-presence-event", wrapped);
      };
    },
    onDevBoxPullProgress(listener) {
      const wrapped = (_event, payload) => {
        listener(payload);
      };
      import_electron.ipcRenderer.on("sand:dev-box-pull-progress", wrapped);
      return () => {
        import_electron.ipcRenderer.off("sand:dev-box-pull-progress", wrapped);
      };
    },
    egressTunnel: {
      initial: initialEgressTunnelEnabled,
      async get() {
        return await mainEdge.getEgressTunnelEnabled() === true;
      },
      async set(enabled) {
        return await mainEdge.setEgressTunnelEnabled({ enabled }) === true;
      },
      onChanged(listener) {
        return mainEdge.subscribe({
          "egress-tunnel-changed": (enabled) => {
            listener(enabled === true);
          }
        });
      },
      initialStatus: initialEgressTunnelStatus,
      async getStatus() {
        return await mainEdge.getEgressTunnelStatus();
      },
      onStatusChanged(listener) {
        return mainEdge.subscribe({ "egress-tunnel-status-changed": listener });
      }
    },
    webauthnProxy: {
      initial: initialWebauthnProxyEnabled,
      async get() {
        return await mainEdge.getWebauthnProxyEnabled() === true;
      },
      async set(enabled) {
        return await mainEdge.setWebauthnProxyEnabled({ enabled }) === true;
      },
      onChanged(listener) {
        return mainEdge.subscribe({
          "webauthn-proxy-changed": (enabled) => {
            listener(enabled === true);
          }
        });
      }
    }
  },
  onboarding: {
    async getSeen() {
      return await mainEdge.getOnboardingSeen();
    },
    async setSeen(seen) {
      await mainEdge.setOnboardingSeen({ seen });
    },
    onSkip(listener) {
      return mainEdge.subscribe({ "skip-onboarding": () => listener() });
    }
  },
  telemetry: {
    reportAgentLoad(report) {
      import_electron.ipcRenderer.send("sand:report-agent-load", report);
    },
    reportBoxVisibility(report) {
      import_electron.ipcRenderer.send("sand:report-box-visibility", report);
    },
    reportSendLatency(report) {
      import_electron.ipcRenderer.send("sand:report-send-latency", report);
    },
    reportHeapMetrics(report) {
      import_electron.ipcRenderer.send("sand:report-heap-metrics", report);
    },
    reportSendAck(report) {
      import_electron.ipcRenderer.send("sand:report-send-ack", report);
    },
    reportReactionAck(report) {
      import_electron.ipcRenderer.send("sand:report-reaction-ack", report);
    },
    reportRenderTtfr(report) {
      import_electron.ipcRenderer.send("sand:report-render-ttfr", report);
    },
    reportRenderStream(report) {
      import_electron.ipcRenderer.send("sand:report-render-stream", report);
    },
    reportAgentsUnreachable(report) {
      import_electron.ipcRenderer.send("sand:report-agents-unreachable", report);
    },
    reportRecoveryAction(report) {
      import_electron.ipcRenderer.send("sand:report-recovery-action", report);
    },
    reportRebuildLifecycle(report) {
      import_electron.ipcRenderer.send("sand:report-rebuild-lifecycle", report);
    },
    reportReconciliation(report) {
      import_electron.ipcRenderer.send("sand:report-reconciliation", report);
    },
    reportVncSession(report) {
      import_electron.ipcRenderer.send("sand:report-vnc-session", report);
    },
    reportVncLiveness(report) {
      import_electron.ipcRenderer.send("sand:report-vnc-liveness", report);
    },
    reportOpenComputer(report) {
      import_electron.ipcRenderer.send("sand:report-open-computer", report);
    },
    reportUpdatePrompt(report) {
      import_electron.ipcRenderer.send("sand:report-update-prompt", report);
    },
    reportSigninGate(report) {
      import_electron.ipcRenderer.send("sand:report-signin-gate", report);
    },
    reportOnboardingStep(report) {
      import_electron.ipcRenderer.send("sand:report-onboarding-step", report);
    },
    reportClientFailure(report) {
      import_electron.ipcRenderer.send("sand:report-client-failure", report);
    },
    noteSentryConversation(report) {
      import_electron.ipcRenderer.send("sand:sentry-conversation", report);
    }
  },
  timeZone: {
    async get() {
      return await import_electron.ipcRenderer.invoke("sand:time-zone-get");
    },
    async setOverride(timeZone) {
      return await import_electron.ipcRenderer.invoke("sand:time-zone-override-set", {
        timeZone
      });
    }
  },
  autoReviewInstructions: {
    async get() {
      return await import_electron.ipcRenderer.invoke("sand:auto-review-instructions-get");
    },
    async set(instructions) {
      return await import_electron.ipcRenderer.invoke("sand:auto-review-instructions-set", {
        instructions
      });
    }
  },
  localToolPermission: {
    async get() {
      return await import_electron.ipcRenderer.invoke("sand:local-tool-permission-get");
    },
    async set(permission) {
      return await import_electron.ipcRenderer.invoke("sand:local-tool-permission-set", {
        permission
      });
    },
    async ceiling() {
      return await import_electron.ipcRenderer.invoke("sand:local-tool-permission-ceiling");
    },
    async recordApproval(approvalId, action, target) {
      await import_electron.ipcRenderer.invoke("sand:local-tool-approval-record", {
        approvalId,
        action,
        target
      });
    },
    async clearApprovals() {
      await import_electron.ipcRenderer.invoke("sand:local-tool-approval-clear");
    }
  },
  theme: {
    initial: initialThemeState,
    async get() {
      return await mainEdge.getThemeState();
    },
    async set(preference) {
      return await mainEdge.setThemePreference({ preference });
    },
    onChanged(listener) {
      return mainEdge.subscribe({ "theme-changed": listener });
    }
  },
  secrets: {
    async list() {
      return await import_electron.ipcRenderer.invoke("sand:secrets-list");
    },
    async reveal(_key) {
      return null;
    },
    async upsert(entries) {
      return await import_electron.ipcRenderer.invoke("sand:secrets-upsert", { entries });
    },
    async remove(keys) {
      return await import_electron.ipcRenderer.invoke("sand:secrets-delete", { keys });
    }
  },
  agent: {
    clientPersistence,
    // null = never written, [] = an intentional clear; a transport rejection must never read as empty.
    async getPinnedAgents() {
      return await import_electron.ipcRenderer.invoke("sand:host-pinned-agents-get");
    },
    async setPinnedAgents(pinnedAgentIds) {
      return await import_electron.ipcRenderer.invoke("sand:host-pinned-agents-set", { value: pinnedAgentIds });
    },
    async getSidebarSections() {
      return await import_electron.ipcRenderer.invoke("sand:host-sidebar-sections-get");
    },
    async setSidebarSections(sections) {
      return await import_electron.ipcRenderer.invoke("sand:host-sidebar-sections-set", { value: sections });
    },
    async getDefaultModel() {
      return await import_electron.ipcRenderer.invoke("sand:agent-default-model-get");
    },
    async setDefaultModel(model) {
      return await import_electron.ipcRenderer.invoke("sand:agent-default-model-set", { model });
    },
    async getComputerUseModel() {
      return await import_electron.ipcRenderer.invoke("sand:agent-computer-use-model-get");
    },
    async setComputerUseModel(model) {
      return await import_electron.ipcRenderer.invoke("sand:agent-computer-use-model-set", {
        model
      });
    },
    async getProviderModelCatalog(request) {
      return await import_electron.ipcRenderer.invoke("sand:provider-model-catalog", request);
    },
    async getAvailableModels() {
      return await import_electron.ipcRenderer.invoke("sand:agent-available-models");
    },
    async createAgent(args) {
      return await import_electron.ipcRenderer.invoke("sand:create-agent", args ?? {});
    },
    async getLocalProfile() {
      return await import_electron.ipcRenderer.invoke("sand:local-profile-get");
    },
    async updateLocalProfile(profile) {
      return await import_electron.ipcRenderer.invoke("sand:local-profile-set", profile);
    },
    async getActiveProvider() {
      return await import_electron.ipcRenderer.invoke("sand:active-provider-get");
    },
    async setActiveProvider(provider) {
      return await import_electron.ipcRenderer.invoke("sand:active-provider-set", { provider });
    },
    async getProviderConfig(agentId) {
      return await import_electron.ipcRenderer.invoke("sand:provider-config-get", { agentId });
    },
    async setProviderConfig(config) {
      return await import_electron.ipcRenderer.invoke("sand:provider-config-set", config);
    },
    async startProviderOAuth(provider) {
      return await import_electron.ipcRenderer.invoke("sand:provider-oauth-start", { provider });
    },
    async getProviderOAuthStatus(provider) {
      return await import_electron.ipcRenderer.invoke("sand:provider-oauth-status", { provider });
    },
    async cancelProviderOAuth(provider) {
      return await import_electron.ipcRenderer.invoke("sand:provider-oauth-cancel", { provider });
    },
    async disconnectProviderOAuth(provider) {
      return await import_electron.ipcRenderer.invoke("sand:provider-oauth-disconnect", { provider });
    },
    async getProviderSecretsStatus() {
      return await import_electron.ipcRenderer.invoke("sand:provider-secrets-status");
    },
    async setProviderApiKey(provider, apiKey) {
      return await import_electron.ipcRenderer.invoke("sand:provider-secret-set", { provider, apiKey });
    },
    async removeProviderSecret(provider) {
      return await import_electron.ipcRenderer.invoke("sand:provider-secret-delete", { provider });
    },
    async openWorkspace() {
      return await import_electron.ipcRenderer.invoke("sand:open-agent-workspace");
    },
    async openUserDocuments() {
      return await import_electron.ipcRenderer.invoke("sand:open-user-documents");
    },
    async getWorkspaceInventory() {
      return await import_electron.ipcRenderer.invoke("sand:workspace-inventory-get");
    },
    async cancelPrompt(args) {
      return await import_electron.ipcRenderer.invoke("sand:cancel-prompt", args ?? {});
    },
    async retryPrompt(args) {
      return await import_electron.ipcRenderer.invoke("sand:retry-prompt", args ?? {});
    },
    async getPromptStatus(args) {
      return await import_electron.ipcRenderer.invoke("sand:prompt-status", args ?? {});
    },
    onPromptDelivery(listener) {
      openBotPromptDeliveryListeners.add(listener);
      return () => openBotPromptDeliveryListeners.delete(listener);
    },
    async getLocalRuntimeStatus(args) {
      return await import_electron.ipcRenderer.invoke("sand:runtime-status", args ?? {});
    },
    async repairLocalRuntime(args) {
      return await import_electron.ipcRenderer.invoke("sand:runtime-repair", args ?? {});
    },
    async listConversations(args) {
      return await import_electron.ipcRenderer.invoke("sand:conversation-list", args ?? {});
    },
    async getActiveConversation(args) {
      return await import_electron.ipcRenderer.invoke("sand:conversation-active", args ?? {});
    },
    async createConversation(args) {
      return await changeOpenBotConversation(() => import_electron.ipcRenderer.invoke("sand:conversation-create", args ?? {}));
    },
    async activateConversation(args) {
      return await changeOpenBotConversation(() => import_electron.ipcRenderer.invoke("sand:conversation-activate", args ?? {}));
    },
    async renameConversation(args) {
      return await import_electron.ipcRenderer.invoke("sand:conversation-rename", args ?? {});
    },
    async archiveConversation(args) {
      return await changeOpenBotConversation(() => import_electron.ipcRenderer.invoke("sand:conversation-archive", args ?? {}));
    },
    async deleteConversation(args) {
      return await changeOpenBotConversation(() => import_electron.ipcRenderer.invoke("sand:conversation-delete", args ?? {}));
    },
    async getMemorySettings(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-settings-get", args ?? {});
    },
    async setMemorySettings(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-settings-set", args ?? {});
    },
    async listMemories(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-list", args ?? {});
    },
    async listMemoriesPage(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-list-page", args ?? {});
    },
    async updateMemory(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-update", args ?? {});
    },
    async deleteMemory(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-delete", args ?? {});
    },
    async getMemoryStatus(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-status-get", args ?? {});
    },
    async searchMemoryHistory(args) {
      return await import_electron.ipcRenderer.invoke("sand:memory-history-search", args ?? {});
    },
    async discoverLocalProviders() {
      return await import_electron.ipcRenderer.invoke("sand:discover-local-providers");
    },
    async testProviderConnection(config) {
      return await import_electron.ipcRenderer.invoke("sand:test-provider-connection", config ?? {});
    },
  
  },
  tasks: {
    async getAsyncTasks(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-list", { ...(args ?? {}), method: "getAsyncTasks" });
    },
    async getSubagents(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-list", { ...(args ?? {}), method: "getSubagents" });
    },
    async listAsyncTasks(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-list", { ...(args ?? {}), method: "listAsyncTasks" });
    },
    async getAsyncTask(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-get", args ?? {});
    },
    async abortAsyncTask(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-abort", args ?? {});
    },
    async steerAsyncTask(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-steer", args ?? {});
    },
    async openStream(args) {
      return await import_electron.ipcRenderer.invoke("sand:async-task-stream-start", args ?? {});
    },
    async closeStream() {
      return await import_electron.ipcRenderer.invoke("sand:async-task-stream-stop");
    },
    onFrame(listener) {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, frame) => {
        try { listener(frame); } catch {}
      };
      import_electron.ipcRenderer.on("openbot:async-tasks-frame", handler);
      return () => import_electron.ipcRenderer.removeListener("openbot:async-tasks-frame", handler);
    }
  },
  p23: {
    async stageAttachmentBytes(agentId, filename, bytes) {
      return await import_electron.ipcRenderer.invoke("sand:p23-stage", { agentId, filename, bytes });
    },
    async discardStagedAttachment(agentId, attachmentId) {
      return await import_electron.ipcRenderer.invoke("sand:p23-discard", { agentId, attachmentId });
    },
    async searchTranscript(agentId, query, conversationId, cursor) {
      return await import_electron.ipcRenderer.invoke("sand:p23-search", { agentId, query, conversationId, ...(cursor === undefined ? {} : { cursor }) });
    },
    async sendPrompt(agentId, prompt, extras) {
      return await import_electron.ipcRenderer.invoke("sand:p23-send", { ...(extras ?? {}), agentId, prompt });
    },
  },
  clientPersistence,
  update: {
    async getStatus() {
      return await mainEdge.getUpdateStatus();
    },
    async check() {
      return await mainEdge.checkForUpdates();
    },
    async setTrack(track) {
      return await mainEdge.setUpdateTrack({ track });
    },
    async quitAndInstall() {
      await mainEdge.quitAndInstallUpdate();
    },
    async setAutoUpdateWhenIdleOptIn(enabled) {
      return await mainEdge.setAutoUpdateWhenIdleOptIn({ enabled });
    },
    onStatusEvent(listener) {
      return mainEdge.subscribe({ "update-status": listener });
    }
  },
  ...devRestart == null ? {} : { devRestart },
  attachProdBox
};
var coordinatorPort = coordinatorPortBroker.bridge;
import_electron.contextBridge.exposeInMainWorld("desktop", desktop);
import_electron.contextBridge.exposeInMainWorld("coordinatorPort", coordinatorPort);

import_electron.ipcRenderer.on("sand:coordinator-port", (event) => {
  const port = event.ports[0];
  if (port == null) return;
  coordinatorPortBroker.deliver(wrapTransferredCoordinatorPort(port));
});
