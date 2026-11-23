# Changelog

## Unreleased

### 测试与工程

- 新增 `tests/pac.test.js`：真正**执行**生成的 `FindProxyForURL`，不再只对源码做字符串断言。覆盖白/黑名单路由、黑名单优先级、DNS 标签边界、IPv4/IPv6 字面量、主机名注入抵抗。
- 商店包文件清单不再手工维护。新增 `scripts/runtime-files.mjs`，从 `manifest.json` 出发沿 import、HTML 引用和图标字面量推导运行文件闭包；`scripts/package-extension.py` 改为消费该闭包，并在打包后重新读取 ZIP 校验。此前的白名单式清单会在新增模块时**构建成功但漏掉文件**，只在商店用户安装后白屏。
- `scripts/package-extension.py` 现在对未解析引用、未打包的裸 import、ZIP 与闭包不一致三种情况返回非零退出码。运行闭包由 Node 计算，因此打包需要 Node.js 20+ 与 Python 3。
- `tests/package.test.js` 重写为结构性断言：manifest 形态与最小权限、引用可解析、ZIP 内容与闭包一致、`popup.js` 引用的元素 id 均存在于 `popup.html`。移除大量 `includes()` 式文本断言，避免重构误报与虚假通过。
- 新增 `.gitignore`，排除 `dist/`、构建产物与 Python 字节码。
- 删除运行时未使用且已被 PAC 取代的 `buildBypassList`、`createWhitelistEntry`、`createBlacklistEntry`；测试改用 `createDomainEntry`。

### 修复

- **IPv6 规则在 PAC 中永不命中**。规则仍以 `[::1]` 的形式存储（URL host 的规范形式），但写入 PAC 时转换为不带方括号的 `::1`，与 Chromium 传给 `FindProxyForURL` 的形式一致。此前白名单命中 IPv6 字面量时界面显示「浏览器直连」，实际请求仍被送往本机代理。
- **每次请求重建规则数组**。规则数组与 `matches` 辅助函数移到 PAC 脚本作用域，`FindProxyForURL` 只做匹配。PAC 文件只会被求值一次，函数则每个导航都会被调用。
- **代理归属判定改为比对指纹**。PAC 首行注释内嵌规则集指纹，`inferActiveMode` 读取指纹而非重新生成整份脚本再逐字符比较。指纹对规则顺序和重复条目不敏感，且指纹计算通过记忆化的主机名归一化去掉主要开销。
- **规则上限改为显式拒绝**。超过 500 条时 `normalizeDomainEntriesStrict` 抛出 `RuleLimitError`，界面用中文提示具体上限并保持存储与浏览器代理不变。此前超出部分被静默丢弃，界面仍显示绿色成功提示。已有超限的历史数据仍可读取（仅截断），不会导致扩展无法启动。
- **路线判定性能**：在 1000 条规则上限下，`resolveTabRoute` 从 3.11 ms 降至约 0.47 ms；按 40 个标签页计算，一次全量刷新从约 124 ms 降至约 19 ms。
- **合并后台刷新**。代理变更与存储变更原本各自触发一次全量刷新，而一次规则编辑会连续产生三次。现在合并为一次；面板关闭时（`pagehide`）主动请求立即同步，避免图标停留在旧状态。
- **消除重复写入**。新增、删除、清空规则原本先调用 `saveSettings` 再调用会再次写入的 `applyMode`，导致两次存储写入与两次刷新。现在只写入一次。

## 0.1.3 - Unreleased

### 图标与结构

- **修复 3 个损坏的工具栏图标**。`clash16` 调色板 CRC 错误，`clash32` 与 `system32` 文件被截断。`clash32` 正是 `action.default_icon` 指向的高 DPI 图标，即扩展安装后首先呈现的图形；此前没有任何检查能发现它。
- 图标改为**单一真源**：新增 `scripts/render-icons.py`（仅用 Python 标准库，无 Pillow/cairo/npm 依赖），从同一套几何定义生成 8 个 PNG。删除 `background.js` 中 193 行 OffscreenCanvas 运行时绘制代码——图标是静态资源，运行时重画只增加冷启动成本，且与 PNG 重复。`background.js` 由 355 行降至 181 行。
- 图标几何改用**包围盒自动适配**而非手工缩放常数。此前 1.16 倍固定缩放会让环与箭头在 16px 下被画布裁切；现在按实际边界居中缩放并留边距。
- 新增 `tests/icons.test.js`：解析 PNG chunk 表校验每个交付图标的完整性与声明尺寸，并比对已提交文件与生成脚本是否一致。用 0.1.3 的原始损坏文件验证过，能精确报出 `PLTE chunk CRC mismatch`。
- **拆分 `src/popup.js`（615 行）** 为 `popup-render.js`（纯渲染，无副作用）与 `popup-controller.js`（状态与 `chrome.*` 调用）。渲染层不再持有全局可变状态，所有输入显式传入。
- 新增 `tests/render.test.js`（17 条）：首次为渲染逻辑提供可执行测试，覆盖路由文案、状态徽章、规则列表与按钮启用状态。拆分前这些逻辑无法在浏览器外测试。
- **两个界面实时同步**：新增 `chrome.storage.onChanged` 监听，在快捷面板与完整设置页同时打开时，任一侧修改规则或模式，另一侧立即更新。监听器只读不写，不存在反馈循环。
- **修正子域白名单下的按钮状态**：页面为 `a.example.com`、白名单含 `example.com`（含子域）时，界面提示"命中直连白名单"但"加入白名单"按钮仍可点击，会诱导重复添加。现在按实际命中状态禁用。

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
