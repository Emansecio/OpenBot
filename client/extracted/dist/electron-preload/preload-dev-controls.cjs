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
function bridgeEdge(contract, table, transport2) {
  const bridge = {};
  const callMethod = async (method, payload) => {
    let reply;
    try {
      reply = await transport2.invoke(methodChannel(contract.edge, method), payload);
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
          transport2.on(eventChannel(contract.edge, event), listener)
        );
      }
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    };
  }
  return bridge;
}

// src/electron-preload/preload-dev-controls.cts
var import_electron = require("electron");

// src/shared/rpc/dev-controls.ts
var devControlsRpcContract = declareRpcContract("dev-controls");
var DEV_CONTROLS_METHOD_TABLE = {
  restartElectron: { args: "none" },
  reloadWindow: { args: "none" },
  restartOnboarding: { args: "none" },
  skipOnboarding: { args: "none" },
  themeStatus: { args: "none" },
  setThemePreference: { args: "object" },
  boxStatus: { args: "none" },
  boxHealth: { args: "none" },
  upgradeHost: { args: "none" },
  pokeHostUpgrade: { args: "none" },
  rebuildBox: { args: "none" },
  tailLogs: { args: "none" },
  startBox: { args: "none" },
  teardownBox: { args: "none" },
  nukeBox: { args: "none" },
  openDesktop: { args: "none" },
  boxStoreStatus: { args: "none" },
  boxStoreSnapshotNow: { args: "none" },
  boxStoreLogs: { args: "none" },
  boxStoreRecreateFresh: { args: "none" },
  boxStoreClear: { args: "none" },
  attachProdBoxStatus: { args: "none" },
  setAttachProdBoxEnabled: { args: "object" },
  setWidgetGallery: { args: "object" },
  gatewayOfflineStatus: { args: "none" },
  setGatewayOffline: { args: "object" },
  onePasswordCliStatus: { args: "none" },
  prepareOnePasswordCli: { args: "none" },
  cancelOnePasswordCliPrepare: { args: "none" },
  onePasswordAccounts: { args: "none" },
  onePasswordVaults: { args: "none" },
  onePasswordFindVault: { args: "none" },
  onePasswordSyntheticProvisioning: { args: "none" }
};

// src/electron-preload/preload-dev-controls.cts
var transport = {
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
var devControls = bridgeEdge(
  devControlsRpcContract,
  DEV_CONTROLS_METHOD_TABLE,
  transport
);
import_electron.contextBridge.exposeInMainWorld("sand", { devControls });
//# sourceMappingURL=preload-dev-controls.cjs.map
