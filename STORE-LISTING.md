# Microsoft Edge Add-ons listing draft

## Name
Alaxee Proxy

## Short description
A lightweight Edge proxy switcher: point the browser at any HTTP or SOCKS5 server, with per-site direct and force-proxy lists.

## Detailed description
Alaxee Proxy is a small, local-only proxy control panel for Microsoft Edge. It points Edge's browser proxy at a listener you already run - any HTTP or SOCKS5 endpoint, such as Clash/mihomo, sing-box, v2ray, a corporate HTTP proxy, or an SSH tunnel. It does not provide proxy servers, nodes, subscriptions, or VPN service, and it does not integrate with any particular proxy application.

Features:
- Switch Edge between your configured proxy server and direct connection.
- Configure the proxy protocol, address, and port.
- Local addresses (localhost, 127.0.0.1, ::1, *.local) always connect directly, so local dev servers keep working.
- Search and sort the domain rule lists, and see which rule matches the current page.
- Add the current website to a direct-connection bypass list from the toolbar popup.
- Choose whether a bypass entry applies only to the hostname or also to its subdomains.
- Keep settings locally in Edge; no account or cloud service is required.
- Back up and restore the whole configuration as a local JSON file.
- Optionally sync settings and rules across the user's own devices through the browser's built-in sync storage. Off by default.
- Local addresses (localhost, 127.0.0.1, ::1, *.local) always connect directly.

The extension does not read or change any proxy application's configuration. Websites not in the direct list continue through the configured listener, where that program's own rules decide how to route them. The extension reports what the browser is configured to do; it does not health-check the listener.

## Permission justifications

- `proxy`: required to set Edge's browser-level proxy configuration (including the PAC script that implements the domain rules).
- `storage`: required to save the user's proxy endpoint and domain rules locally, and to use the browser's own sync storage when the user turns cross-device sync on.
- `activeTab`: required to read the hostname of the currently active page after the user invokes the toolbar popup, for the one-click bypass feature.
- `tabs` (optional): requested only if the user enables per-tab toolbar status. It reads tab URLs locally to select the matching state icon/title; it does not read page contents or transmit browsing data.

## Privacy
See `PRIVACY.md`. Publish a publicly accessible privacy policy URL before submitting the store listing if Partner Center requires it for the declared data practices.

## Store visual assets still needed

- Store logo / icon asset in the required Partner Center dimensions.
- Small promotional tile.
- At least one accurate screenshot of the final Edge popup/settings UI.
