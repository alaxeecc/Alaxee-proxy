# Changelog

## Unreleased

### 测试与工程

- 新增 `tests/pac.test.js`：真正**执行**生成的 `FindProxyForURL`，不再只对源码做字符串断言。覆盖白/黑名单路由、黑名单优先级、DNS 标签边界、IPv4/IPv6 字面量、主机名注入抵抗。
- 商店包文件清单不再手工维护。新增 `scripts/runtime-files.mjs`，从 `manifest.json` 出发沿 import、HTML 引用和图标字面量推导运行文件闭包；`scripts/package-extension.py` 改为消费该闭包，并在打包后重新读取 ZIP 校验。此前的白名单式清单会在新增模块时**构建成功但漏掉文件**，只在商店用户安装后白屏。
- `scripts/package-extension.py` 现在对未解析引用、未打包的裸 import、ZIP 与闭包不一致三种情况返回非零退出码。运行闭包由 Node 计算，因此打包需要 Node.js 20+ 与 Python 3。
- `tests/package.test.js` 重写为结构性断言：manifest 形态与最小权限、引用可解析、ZIP 内容与闭包一致、`popup.js` 引用的元素 id 均存在于 `popup.html`。移除大量 `includes()` 式文本断言，避免重构误报与虚假通过。
- 新增 `.gitignore`，排除 `dist/`、构建产物与 Python 字节码。
- 删除运行时未使用且已被 PAC 取代的 `buildBypassList`、`createWhitelistEntry`、`createBlacklistEntry`；测试改用 `createDomainEntry`。

### 当前已知未修复

以下由新测试直接暴露，将在下一阶段修复：PAC 对 IPv6 规则使用带方括号的 host 进行比对，而 Chromium 传入的是不带方括号的形式，导致白名单命中时仍走代理；PAC 在每次 `FindProxyForURL` 调用中重建规则数组。

## 0.1.3 - Unreleased
- 增加按标签页独立显示的 XEE 轨道状态图标：交由 Clash、浏览器直连、系统代理、未知/冲突。
- 只有用户主动启用可选 `tabs` 权限后，才会逐标签页读取 URL 并更新图标；数据仅在本地处理。
- 将图标状态与 Clash 内部规则分流区分，避免把“交给 Clash”误报成“最终使用代理节点”。

## 0.1.2 - 2026-11-06
- 修正设置页“返回快捷面板”误将受限弹出页嵌入普通网页的问题；改为关闭设置标签页并提示从 Edge 工具栏重新打开面板。
- 固定快捷面板视口高度，并将滚动统一交给唯一的主容器，避免浏览器页面与面板同时出现滚动条。
- 增加设置页返回行为和弹窗单滚动容器的回归检查。


## 0.1.1 - 2026-11-06
- 修正扩展弹窗入口与相对资源路径，解决点击图标时找不到 popup 文件的问题。
- 增加独立的设置页面，可保存本地代理协议、主机和端口，并应用 Clash 模式。
- 在快捷面板增加“设置”入口。
- 更新安装说明，明确 ZIP 解压和正确选择 manifest.json 所在目录的步骤。

## 0.1.0
- Initial local-only Edge Manifest V3 proxy controller.
