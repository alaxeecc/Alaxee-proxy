/**
 * Development-only stand-in for the chrome.* APIs the popup uses.
 *
 * The popup cannot be opened as a plain file:// page because it is an extension
 * page, so design review used to require loading the unpacked extension in Edge.
 * This shim makes src/popup.html renderable in an ordinary tab, which is how the
 * preview server (scripts/preview-server.mjs) lets the layout and all UI states be
 * checked without a browser extension host.
 *
 * It is NOT shipped: scripts/runtime-files.mjs derives the package contents from
 * manifest.json, and nothing in the extension references this file.
 */
(() => {
  const SETTINGS_KEY = "settings";
  const listeners = [];
  const syncListeners = [];
  let store = {};

  // Simulation knobs, overridable from the preview page's query string.
  const params = new URLSearchParams(location.search);
  const initialSettings = params.get("settings")
    ? JSON.parse(decodeURIComponent(params.get("settings")))
    : {
        mode: "proxy",
        host: "127.0.0.1",
        port: "7890",
        scheme: "socks5",
        includeSubdomains: true,
        localBypass: true,
        whitelist: [{ host: "github.com", includeSubdomains: true }],
        blacklist: [{ host: "ads.example.com", includeSubdomains: false }]
      };
  store[SETTINGS_KEY] = initialSettings;

  // Built from the real generator below, so the previewed state is one the
  // extension would actually produce (fingerprint included) rather than a stub
  // the UI would correctly report as foreign.
  // Relative to the popup document, so the same path resolves both when served over
  // HTTP and when the shim is loaded from disk by a Node smoke test.
  const coreModule = import(new URL("../src/core.js", document.baseURI).href).catch(() => null);
  let proxyValue = null;
  const proxyValueNow = () => {
    if (proxyValue === null) {
      try {
        proxyValue = store[SETTINGS_KEY] ? { mode: "pac_script", pacScript: { data: "/* initialising */" } } : { mode: "direct" };
      } catch {
        proxyValue = { mode: "direct" };
      }
    }
    return proxyValue;
  };
  let levelOfControl = params.get("control") ?? "controlled_by_this_extension";
  let tabUrl = params.get("tab") ?? "https://github.com/alaxeecc/Alaxee-proxy";

  const callbackify = (fn) => (...args) => {
    const callback = typeof args.at(-1) === "function" ? args.pop() : null;
    queueMicrotask(() => {
      const result = fn(...args);
      if (callback) callback(result);
    });
  };

  // Once the real core module is available, seed the simulated browser value with
  // a genuine PAC for the seeded settings.
  coreModule.then((core) => {
    if (!core) return;
    try {
      proxyValue = core.buildChromeProxyConfig(store[SETTINGS_KEY]);
    } catch {
      proxyValue = { mode: "direct" };
    }
  });

  const fireChanged = (changes) => {
    for (const listener of listeners) listener(changes, "local");
  };

  const proxyModes = {
    // Mirrors the real API closely enough for the UI: the extension's own value is
    // reported as owned by this extension, anything else as a foreign config.
    get: callbackify(() => ({ levelOfControl, value: structuredClone(proxyValueNow()) })),
    set: callbackify(({ value }) => {
      proxyValue = structuredClone(value);
      levelOfControl = "controlled_by_this_extension";
      queueMicrotask(() => proxyChangeListeners.forEach((listener) => listener({ levelOfControl, value: proxyValue })));
      return undefined;
    })
  };
  const proxyChangeListeners = [];

  globalThis.chrome = {
    runtime: {
      id: "preview",
      lastError: undefined,
      getURL: (path) => `/${path}`,
      sendMessage: (_message, callback) => callback?.({ ok: true }),
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    storage: {
      local: {
        get: callbackify((keys) => {
          if (keys == null) return structuredClone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        }),
        set: callbackify((items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: store[key], newValue: structuredClone(value) };
            store[key] = structuredClone(value);
          }
          queueMicrotask(() => fireChanged(changes));
          return undefined;
        })
      },
      onChanged: {
        addListener: (listener) => {
          listeners.push(listener);
          syncListeners.push(listener);
        }
      }
    },
    proxy: {
      settings: {
        get: proxyModes.get,
        set: proxyModes.set,
        onChange: { addListener: (listener) => proxyChangeListeners.push(listener) }
      }
    },
    sync: {
      // Backed by localStorage so two preview tabs on this machine share one sync
      // area, which is enough to exercise the reconcile path end to end.
      get: callbackify((keys) => {
        const all = JSON.parse(localStorage.getItem("preview.sync") ?? "{}");
        if (keys == null) return all;
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in all) out[key] = all[key];
        return out;
      }),
      set: callbackify((items) => {
        const all = JSON.parse(localStorage.getItem("preview.sync") ?? "{}");
        Object.assign(all, items);
        localStorage.setItem("preview.sync", JSON.stringify(all));
        queueMicrotask(() => syncListeners.forEach((listener) => listener({}, "sync")));
        return undefined;
      }),
      remove: callbackify((keys) => {
        const all = JSON.parse(localStorage.getItem("preview.sync") ?? "{}");
        for (const key of Array.isArray(keys) ? keys : [keys]) delete all[key];
        localStorage.setItem("preview.sync", JSON.stringify(all));
        return undefined;
      })
    },
    permissions: {
      contains: callbackify((request) => (request.permissions ?? []).every((p) => p === "tabs") && params.get("tabs") === "1"),
      request: callbackify(() => true),
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    action: {
      setIcon: callbackify(() => undefined),
      setTitle: callbackify(() => undefined)
    },
    tabs: {
      query: callbackify(() => [{ id: 1, url: tabUrl, title: "Preview" }]),
      get: callbackify((id) => ({ id, url: tabUrl })),
      getCurrent: callbackify(() => ({ id: 1, url: tabUrl })),
      create: callbackify(() => ({ id: 2 })),
      remove: callbackify(() => undefined),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };

  // Exposed so the preview page can switch simulated situations without a reload.
  globalThis.__preview = {
    setTab(url) {
      tabUrl = url;
      location.reload();
    },
    reset() {
      localStorage.clear();
      location.reload();
    }
  };
})();
