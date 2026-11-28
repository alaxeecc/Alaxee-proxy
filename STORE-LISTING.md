# Microsoft Edge Add-ons listing draft

## Name
Alaxee Proxy

## Short description
轻量的 Edge 代理控制器：将浏览器指向你自己运行的 HTTP 或 SOCKS5 服务器，支持直连白名单与强制代理黑名单。

## Detailed description

Alaxee Proxy 是一个只在本机运行的 Edge 代理控制面板。它把 Edge 的浏览器代理指向你自己已经在运行的代理程序——任意 HTTP 或 SOCKS5 端点，例如 Clash/mihomo、sing-box、v2ray、公司 HTTP 代理，或一条 SSH 隧道。它不提供代理服务器、节点、订阅或 VPN 服务，也不与任何特定的代理软件绑定。

主要功能：
- 在「走代理服务器」和「直接连接」之间切换 Edge 的浏览器代理。
- 设置代理协议、地址和端口。
- 本机地址（localhost、127.0.0.1、::1、*.local）始终直连，本地开发服务器不受影响。
- 搜索和排序域名规则列表，并查看当前页面命中了哪一条规则。
- 从工具栏面板把当前网站一键加入直连白名单。
- 选择一条规则只作用于该主机名，还是同时作用于它的子域名。
- 设置保存在 Edge 本地；不需要账号，也不依赖任何云服务。
- 把整套配置导出为本地 JSON 文件，随时恢复。
- 可选：通过浏览器自带的同步存储，在你自己的多台设备之间同步设置和规则。默认关闭。

本扩展不会读取或修改任何代理软件的配置。不在直连名单里的网站会继续交给所配置的代理程序处理，由那个程序自己的规则决定如何分流。本扩展只报告浏览器被配置成什么，不对代理端点做可用性探测。

## Permission justifications

- `proxy`: required to set Edge's browser-level proxy configuration (including the PAC script that implements the domain rules).
- `storage`: required to save the user's proxy endpoint and domain rules locally, and to use the browser's own sync storage when the user turns cross-device sync on.
- `activeTab`: required to read the hostname of the currently active page after the user invokes the toolbar popup, for the one-click bypass feature.
- `tabs` (optional): requested only if the user enables per-tab toolbar status. It reads tab URLs locally to select the matching state icon/title; it does not read page contents or transmit browsing data.

## Privacy
See `PRIVACY.md`. Publish a publicly accessible privacy policy URL before submitting the store listing if Partner Center requires it for the declared data practices.

## Store visual assets

The store logo is covered by the brand kit: `icons/icon128.png` is the kit's
`icon-day-128`, byte-identical, and Partner Center accepts it directly. A 1024px
render exists at `alaxee-kit/brand/icons/png/icon-day-1024.png` if a larger source
is asked for.

Still to produce by hand, because neither can be generated without a live browser:

- **Screenshots** - at least one, showing the popup and the settings view. The
  sandbox this project was built in has no browser, so these come from a real Edge
  window. Requirements and the exact steps are in `docs/EDGE-ADDONS-PUBLISHING.md`.
  Save them under `store-assets/`, which is ignored by Git.
- **Small promotional tile** - optional; Partner Center only uses it if promoted.

Do not redraw the logo to fit a size. Scale the kit file proportionally.
