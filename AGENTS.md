# Agent operating rules

## Product boundary

- Keep Alaxee Proxy a small, local-only Microsoft Edge Manifest V3 extension.
- The product is **a browser proxy controller**. It points Edge at one HTTP or
  SOCKS5 endpoint the user supplies, and decides per domain whether to use that
  endpoint or connect directly.
- The extension **does not know or care which program is listening** on that
  endpoint. Clash, mihomo, sing-box, v2ray, a corporate HTTP proxy, an
  `ssh -D` tunnel and a test stub are all the same thing to it.
- Therefore: no proxy-product integration. Do not read another program's API,
  configuration, subscription, node list or rule set. Do not name a specific
  proxy product in UI copy as though the extension were its companion.
  (An earlier version hardcoded `mode: "clash"` and Clash port 7890 throughout;
  that coupling is what this rule exists to prevent from returning.)
- It is not a proxy client, node selector, subscription manager, VPN, or hosted
  service.
- Do not add cloud sync, analytics, telemetry, remote configuration, remote code,
  accounts, or a backend without explicit product approval.

## What the extension cannot do

The permission set is `proxy`, `storage`, `activeTab` (+ optional `tabs`). That
ceiling means it **can only**:

- change Edge's browser proxy settings,
- read tab URLs after a user action or with the optional `tabs` grant,
- reload and redirect tabs.

It cannot touch processes, files, shells, other applications, IDM, terminals, or
the operating system's network stack. Do not design features that imply it can,
and do not soften the limitation in copy - state it.

In particular, **do not judge whether a proxy program is running**. The extension
can report what the browser is configured to do; it cannot health-check a local
listener without a host permission, and it must never imply it has.

## Privacy and permissions

- Keep required permissions minimal: `proxy`, `storage`, and `activeTab`.
- The per-tab toolbar-state feature may request the optional `tabs` permission
  only after the user explicitly enables it in the popup. It is used only to read
  tab URLs and update each tab's icon/title locally; it must not collect page
  contents, browsing history, or transmit browsing data.
- Do not add `host_permissions`, `webRequest`, content scripts, or page-content
  collection.
- Keep user settings and whitelist data in `chrome.storage.local`.

## Engineering

- Prefer dependency-free JavaScript and native Chromium extension APIs.
- Keep pure validation/configuration logic in `src/core.js`, rendering in
  `src/popup-render.js` (no `chrome.*`, no DOM mutation beyond the passed-in
  `ui` table), and side effects in `src/popup-controller.js`.
- Cover behaviour with Node's built-in test runner. Prefer executing generated
  PAC script and calling render functions over asserting on source text.
- No inline JavaScript, `eval`, `new Function`, remote scripts, or dynamic code
  execution. (`new Function` appears in tests only, to load a generated PAC.)
- Names in the data model describe routing, not products: `proxy` / `direct`,
  `whitelist` (direct) / `blacklist` (force proxy). No product names.
- Local addresses (loopback, link-local, `.local`, dotless hostnames) always
  connect directly unless an explicit force-proxy rule says otherwise. Do not
  extend that bypass to RFC1918 ranges: a corporate proxy is often the only route
  to intranet hosts.
- Do not claim that browser `DIRECT` bypasses TUN or system-level traffic capture;
  qualify it.

## Verification

Run before each release:

```bash
npm test
npm run check
python -m json.tool manifest.json >/dev/null
```

Also load the unpacked extension in Microsoft Edge and manually verify: proxy mode
switching, endpoint save, current-site whitelist add/remove, subdomain behaviour,
local-address bypass, persistence after browser restart, and behaviour when
another extension controls proxy settings. See `TESTING.md`.

`node scripts/preview-server.mjs` renders the real popup with a `chrome.*` shim for
design review without loading the extension. It is development-only and must stay
outside the runtime file closure.

## Scope control

- Keep changes small and independently verifiable.
- Do not publish to an extension store, create or alter a remote repository, or
  change a user's browser/network settings without explicit authorization.
