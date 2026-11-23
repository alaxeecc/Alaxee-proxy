# Manual verification checklist

The automated Node tests cover pure validation, proxy-rule generation, and the actual behaviour of the generated PAC script. They do not emulate the Edge extension runtime and cannot prove that a proxy process is listening on the configured port. Complete this checklist on the target Windows + Edge setup before relying on the extension daily.

## What the automated tests do and do not prove

Automated coverage:

- `tests/pac.test.js` **executes** the generated `FindProxyForURL` rather than pattern-matching its source. This covers whitelist/blacklist routing, blacklist priority, DNS label boundaries, IPv4 and IPv6 literals, and hostname-injection resistance.
- `tests/core.test.js` covers hostname validation, proxy endpoint validation, route inference, settings migration and the "no endpoint configured" rules.
- `tests/render.test.js` covers route copy, the rule list's search/sort/match badge, and the unconfigured-endpoint and local-bypass states.
- `tests/package.test.js` derives the runtime file closure from `manifest.json`, asserts every reference resolves, and compares the built ZIP against that closure.

Not covered, and therefore still requires manual checks below: the real Chromium proxy stack, service-worker lifecycle, per-tab icon behaviour, and whether the configured listener is actually reachable.

`node scripts/preview-server.mjs` renders the popup in an ordinary tab with a `chrome.*` shim. It is for layout and copy review only; it proves nothing about the real proxy stack.

## First install

- [ ] Load the unpacked project from `edge://extensions` with Developer mode enabled.
- [ ] Confirm Edge accepts the Manifest V3 extension without manifest or service-worker errors.
- [ ] Confirm the permission prompt is limited to proxy control, local storage, and access to the active tab when invoked.
- [ ] Open the popup and verify the displayed mode matches Edge's actual proxy mode.
- [ ] Confirm the popup has one vertical scrollbar only (the main panel scroll container).
- [ ] Open Settings, click “返回浏览器”, confirm the Settings tab closes, then reopen the quick panel from the Edge toolbar icon.

## Endpoint

- [ ] On a fresh profile, confirm the address and port fields are empty and the endpoint line says the address is missing.
- [ ] Confirm **走代理服务器** will not apply until an address and port are entered.
- [ ] Enter the listener address and port of whatever proxy is running (Clash/mihomo Mixed port, sing-box, v2ray, `ssh -D`, corporate HTTP proxy).
- [ ] Choose HTTP for an HTTP listener; choose SOCKS5 for a SOCKS listener.
- [ ] Select **保存并启用代理** and verify an ordinary destination loads.
- [ ] Verify the proxy program's own routing (its rule mode, selected node, rule set) still decides how proxied domains are handled - the extension has no visibility into that.
- [ ] Stop the proxy program and verify the extension does not claim to have performed a health check; the browser may show connection errors until the listener returns.

## Direct whitelist

- [ ] On an HTTPS site, add the current domain with subdomains enabled.
- [ ] Verify the apex domain and one subdomain bypass the browser proxy.
- [ ] Verify a similar but unrelated hostname does not match (for example, `notexample.com`).
- [ ] Remove the entry and confirm the site returns to the proxy route.
- [ ] Add an exact-host-only entry and confirm a subdomain is not covered.
- [ ] Search the list for a substring and confirm filtering does not change the stored rules.
- [ ] Switch the sort to **按域名** and confirm the list reorders while the applied rules (and the status pill) stay unchanged.
- [ ] Open a site that matches a rule and confirm it carries the **当前网站命中** badge.
- [ ] Restart Edge and confirm settings and whitelist persist.

## Local addresses

- [ ] With a proxy configured, open `http://localhost:<port>` on a local dev server and confirm it loads (it must bypass the proxy).
- [ ] Repeat for `http://127.0.0.1:<port>`, an IPv6 literal (`http://[::1]:<port>`) and a `*.local` name.
- [ ] Confirm a LAN address such as `192.168.1.1` still follows the default route, then add it to the direct whitelist and confirm it becomes direct.
- [ ] Turn **本机地址始终直连** off and confirm the warning appears and localhost now goes to the proxy; turn it back on.

## Modes and conflicts

- [ ] Switch to **直接连接** and verify Edge no longer uses its browser proxy.
- [ ] Switch back to **走代理服务器** and verify the saved endpoint and rules are restored.
- [ ] Confirm there is no third mode: "跟随系统代理" was removed because it made both rule lists inert.
- [ ] Test with other proxy extensions disabled, then enabled, and confirm the UI reports control conflicts clearly.
- [ ] If the proxy program uses TUN or another system-wide capture mode, separately verify its behavior; browser bypass alone does not guarantee OS-level bypass, and switching the extension's mode may have no visible effect at all.


## Upgrade from 0.1.x

- [ ] Install 0.1.3 (or load it unpacked), set a mode, then upgrade in place.
- [ ] Confirm the stored `mode: "clash"` becomes **走代理服务器** with an upgrade notice, and the rules are unchanged.
- [ ] Confirm a stored `mode: "system"` becomes **直接连接** with a notice explaining why the mode is gone.
- [ ] Confirm the toolbar icons switch to the new `proxy` artwork.

## Package entry-point regression test

`npm run check` syntax-checks every shipped script and then runs `scripts/runtime-files.mjs`, which walks forward from `manifest.json` and fails on any reference it cannot resolve. `npm test` additionally builds the ZIP and compares its contents against that derived closure, so a package that is quietly missing a module cannot pass CI.
