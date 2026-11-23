# Alaxee Proxy 项目审查与优化方案

审查日期：2026-11-23 · 基线版本：`0.1.3` · 基线提交：`9051cf8`

---

## 1. 项目定位与架构

**一句话：** 一个只用原生 API、零依赖的 Edge MV3 扩展，把浏览器的代理开关交给已经跑在本机的 Clash/Mihomo。

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| 纯逻辑（可测试） | `src/core.js` | ~300 | 主机名校验、白/黑名单归一化、PAC 生成、路由推断 |
| 后台 | `background.js` | 355 | 逐标签页图标刷新、事件订阅、离屏 Canvas 画图标 |
| UI / 控制器 | `src/popup.js` + `popup.html` + `popup.css` | 593 / 183 / 454 | 全部交互逻辑，快捷面板与完整设置**复用同一份** |
| 入口垫片 | `settings.js` | 3 | 把 options 页重定向到 `popup.html?full=1` |
| 打包 | `scripts/package-extension.py` | 61 | 运行时白名单 → 商店 ZIP |
| 发布 | `scripts/publish-edge-addons.mjs` | 100 | Edge Add-ons Publish API v1 |
| 校验 | `tests/*.test.js`、`.github/workflows/ci.yml` | 38 个用例 | Node 原生测试 + 源文件断言 |

**整体评价：** 架构判断是正确的（业务逻辑与 UI 分离、单一控制器避免两个界面漂移、权限最小化、PAC 用 `JSON.stringify` 而非字符串拼接）。代码风格统一、注释解释「为什么」而非「做了什么」，`AGENTS.md` 把产品边界写得很清楚——这对一个需要过商店审核的扩展很重要。

**核心健康度：** `npm test` 38/38 通过，`npm run check` 19/19 通过，CI 覆盖测试 + 语法检查 + manifest 校验 + 打包。

问题不在于「写得差」，而在于**几处安全网是假的**：测试断言的是源码文本而不是行为，打包脚本的清单可能漏文件，最关键的路由判定存在真实错误。

---

## 2. 用实测确认的问题

以下每条都经过实际运行验证，不是纸面推断。

### P0-1 · PAC 里的 IPv6 规则永远不匹配（功能性 bug）

`core.js:26` 把 IPv6 存成 `[::1]`（带方括号），且 `buildPacScript` 直接把这个值写进 PAC 比较。但 [Chromium 文档](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) 明确说明传给 `FindProxyForURL(url, host)` 的 `host` 是**不带方括号**的 host 部分。

实测：

```
存储的规则:        "[::1]"
PAC 比较对象:      [::1]
PAC("::1")   -> SOCKS5 127.0.0.1:7890   ← 期望 DIRECT
扩展自己的判定 -> direct                 ← 弹窗显示「浏览器直连」
```

**后果：UI 声称直连、浏览器实际走了代理。** 对代理工具来说这是最坏的失败模式——用户看到绿灯，流量却出了网。命中条件：用户把 IPv6 字面量加入白名单/黑名单。

### P0-2 · `isHostMatched` 每次匹配都重建整份名单（性能放大器）

`core.js:116-128`：

```js
return normalizeDomainEntries(entries).some(...)   // 每次调用都重新归一化 500 条
```

而 `normalizeDomainEntries` 对每条记录都执行一次 `new URL()` + 标签校验。实测（500 + 500 条规则，即上限）：

| 操作 | 单次耗时 |
| --- | --- |
| `resolveTabRoute` | **3.11 ms** |
| 其中 `buildChromeProxyConfig` 的 PAC 重建（约 52 KB 序列化） | 1.45 ms |

`resolveTabRoute` 每次都会重建整份 PAC 只为和浏览器里的 PAC 做字符串比对。放大链条：

> 后台 `refreshAllTabs`（40 个标签页）→ 40 × 3.11 ms ≈ **124 ms**
> 而一次加规则触发 **3 次** `refreshAllTabs`（`proxy.settings.onChange` 1 次 + `storage.onChanged` 2 次，而 `storage.onChanged` 又会被 `popup.js` 的 `saveSettings` 和 `applyMode` 各写一次触发）→ **≈ 370 ms 的 CPU 集中在一次点击上**

这是 MV3 service worker 里最不该有的浪费：worker 会被反复唤醒，每次唤醒都做几十毫秒的重计算。

### P0-3 · 规则超过 500 条静默丢弃（数据丢失）

`core.js:61` 的 `entries.slice(0, MAX_RULE_ENTRIES)` 没有任何提示。实测输入 520 条，存下 500 条，20 条**无声消失**。用户会以为规则保存成功（提示是绿色 success），但网络上不生效。

### P0-4 · 打包脚本是「白名单」，漏文件不会报错（上架风险）

`scripts/package-extension.py` 硬编码了 21 个 `RUNTIME_FILES`。实测：新增 `src/helper.js` 并被 `popup.js` import 后——

- `npm test` → 38 passed，无警告
- `package-extension.py` → `Created dist/...zip`，`Included 21 runtime files`，**成功退出**
- 解压 ZIP 检查 → `helper.js` **不在包里**

用户从商店安装后会因为模块缺失而直接白屏。现有 `tests/package.test.js` 检查的是**仓库里的源文件**是否存在，而不是**ZIP 构建产物**是否完整，所以这条路径完全没被覆盖。

### P1-1 · 测试断言的是源码文本，不是行为

`tests/package.test.js` 里大量 `assert.ok(script.includes('...'))`。例如：

```js
assert.ok(script.includes('chrome.permissions.request({ permissions: ["tabs"] }'));
```

这类断言只证明「这行字还在」，不证明权限确实被正确请求。它带来了 38 个绿灯的**虚假信心**，同时把实现细节焊死——重构一个等价的写法就会让 CI 变红，反而阻碍了 P0-1/P0-2 这类必要修复。P0-1 的 IPv6 bug 之所以能活到 0.1.3，正是因为没有一个测试真的**执行** `FindProxyForURL`。

### P1-2 · 同一个图标画了三遍

- `background.js:30-222`：约 **193 行** Canvas 绘制代码
- `src/popup.html:15-49`：**同一套路径**的 SVG 版本
- `icons/status/*.png`：**8 个 PNG**（4 状态 × 2 尺寸）

PNG 还同时充当两个角色：manifest 里的 `default_icon`（初始图标）+ 运行时绘制失败时的兜底。改一次品牌视觉要动三个地方、三种格式，且三者已经开始出现细微差异（Canvas 版有 1.16 倍缩放补丁，SVG 版没有）。`drawStateIcon` 每次冷启动还要为 4 种状态各画 2 个尺寸 = 8 次离屏绘制，只为得到 8 张静态图。

### P1-3 · 快照式同步，界面会看到过期状态

`popup.js` 只读取一次状态，**没有** `chrome.storage.onChanged` 监听。实测 `grep` 无任何匹配。当用户同时开着完整设置页和工具栏面板（这是被鼓励的用法，`settings.js` 就是这么设计的），在一边改规则，另一边不会更新。`background.js` 会正确响应 `storage.onChanged`，但两个前台界面之间不会互相同步。

### P1-4 · 「首次使用引导」被放错位置

`popup.html:68` 的 `status-permission-panel` 是**常驻**的完整区块，占据了 600px 弹窗顶部——但 `tabs` 权限只是可选的增强项。首次打开面板的默认状态，就是一个大概率用不到的权限请求横幅在最显眼的位置。而用户真正每次都要操作的「切模式」被推到了下面。

### P2 · 其余一致性与工程债

| # | 位置 | 问题 |
| --- | --- | --- |
| P2-1 | 仓库根目录 | **没有 `.gitignore`**，`npm run package:extension` 生成的 `dist/` 处于未跟踪状态，一个人误提交就会进仓库 |
| P2-2 | `README.md:82` | 声称「项目包含 GitHub Actions…推送 `vX.Y.Z` 标签会自动提交」，但 `.github/workflows/` 里只有 `ci.yml`。`docs/EDGE-ADDONS-PUBLISHING.md` 顶部也自认这一点，**两份文档互相矛盾** |
| P2-3 | `PRIVACY.md` | 可选权限未授予时写的是「工具栏显示全局代理模式」，`README` 和代码实际行为是**显示「未知」**。隐私声明与实际行为不一致，这是商店审核会看的地方 |
| P2-4 | `popup.html` | 302 行 HTML 全部堆在单行，可读性与后续 diff 质量都很差 |
| P2-5 | `core.js:92,116` | `buildBypassList` / `isHostMatched` / `createWhitelistEntry` / `createBlacklistEntry` 中，除 `createDomainEntry` 外运行时**均未使用**（`buildBypassList` 生成的是旧版 bypass 列表，已被 PAC 取代），只剩测试在调用 |
| P2-6 | `popup.js:273` | `renderRules()` 每次 `replaceChildren()` 重建整个列表，`applyMode` + `saveSettings` 一链触发 3 次重建 |
| P2-7 | `popup.html:79` | 规则数量计数 `nav-count` 只算总数，切到子页后标题与列表不同步的细节需要人工核对 |
| P2-8 | `manifest.json` | MV3 的 `action.default_popup` 高度在 Chromium 里最高约 600px，当前 `height: 600px` 已顶格，加入任何内容都要重新考虑滚动策略 |

---

## 3. 优化方案

**指导原则：** 不做功能扩张（`AGENTS.md` 已明确禁止云同步/遥测/远程配置），只修正确性、降复杂度、补真实的安全网。全部改动可在**不新增任何权限、不新增依赖**的前提下完成。

### 阶段 0 —— 先建安全网（约半天，必须先做）

> 理由：在 P0-1/P0-2 的重构开始前，必须先把「假测试」换成「真测试」，否则重构没有回归保护。

1. **把 PAC 变成真正可执行的测试对象**。目前 PAC 是生成出来的字符串，没有任何地方执行它。改为：

   ```js
   // tests/pac.test.js
   const FindProxyForURL = new Function(buildPacScript(settings) + "; return FindProxyForURL;")();
   assert.equal(FindProxyForURL("http://[::1]/", "::1"), "DIRECT");     // ← 现在就红
   ```

   `buildPacScript` 的产物本身就是无副作用的纯函数体，用 `new Function` 在**测试环境**里加载是合理的（`AGENTS.md` 禁止的是扩展运行时代码执行）。这一条测试会立刻暴露 P0-1。

2. **打包完整性测试**。不校验源码，校验**产物**：

   ```js
   // tests/package.test.js
   // 从 manifest 出发解析所有 import，断言每个文件都在 ZIP 的 namelist 里
   ```

3. **删掉脆弱的文本断言**，保留「文件存在 / 引用可解析 / manifest 合法」这类结构性断言。文本断言每减少一条，未来的重构阻力就少一分。

**验收：** 新增测试能在当前代码上**失败**（P0-1、P0-4），修复后转绿。

### 阶段 1 —— 修正确性 bug（约 1 天）

| 任务 | 做法 | 风险 |
| --- | --- | --- |
| **P0-1 IPv6** | 在 PAC 生成时把 `[::1]` 归一化为裸 `::1`；或在 `normalizeHostname` 内部统一「存储格式」与「匹配格式」的转换，并在 `isIpLiteral` 里同时识别两种形态 | 低。仅影响 IPv6 字面量，现有 IPv4/域名行为不变 |
| **P0-2 性能** | ① 给 `normalizeDomainEntries` 加缓存（规则列表按内容 hash 缓存归一化结果）；② `inferActiveMode` 不重建 PAC 做全串比对，改为在 PAC 顶部嵌入一个**稳定指纹**（如 `/* ALAXEE_PROXY_RULES_V1 fp:<sha256 前 16 位> */`），比对指纹而非整份脚本；③ 合并 `applyMode` 里的两次 `saveSettings` 为一次写入 | 中。指纹要保证确定性（对归一化后的规则排序后再 hash） |
| **P0-3 静默截断** | `normalizeDomainEntries` 返回值改为 `{ entries, dropped }`，或在超过上限时抛错由 UI 提示「已达 500 条上限，请先删除规则」 | 低。需要同步改 4 处调用点 |
| **P0-4 打包** | `RUNTIME_FILES` 改为**反向遍历**：从 manifest 入口出发递归解析 import/HTML 引用，得到文件集合；若集合为空或缺少入口则报错 | 低。正好复用于阶段 0 的测试 |

**预期收益：** 一次规则编辑的 CPU 从 ~370 ms 降到 ~10 ms 量级；IPv6 路由与 UI 呈现一致；打包漏文件在 CI 拦截。

### 阶段 2 —— 降复杂度（约 2 天）

1. **图标单一真源。** 三份实现（Canvas / SVG / PNG）收敛为一份：
   - 首选：8 张 PNG 作为**唯一**真源，删掉 `background.js:30-222` 的 193 行 Canvas 代码。图标是静态的，运行时绘制没有任何好处，还带来 `OffscreenCanvas` 不可用时的异常分支。
   - 若坚持矢量：只保留 SVG，用一次性脚本（`scripts/render-icons.mjs`）离线生成 PNG，两个产物同源。

   **收益：** `background.js` 从 355 行降到 ~160 行，冷启动少 8 次离屏绘制。

2. **拆分 `popup.js`。** 593 行里混了：DOM 查询（30 行）、读写设置、PAC 应用、规则增删、通知、视图切换、权限请求。建议拆为 `popup-controller.js`（状态与副作用）+ `popup-render.js`（纯 DOM 更新）。这也会让渲染逻辑第一次变得**可测试**。

3. **界面实时同步。** 两个前台界面各加一个 `chrome.storage.onChanged` 监听，变更时重读并重渲染。这是 P1-3 的最小修复，约 15 行。

4. **优化首屏信息层级。** `status-permission-panel` 从常驻块改为：未授权时收成一行内联提示（放在规则操作附近，因为权限真正影响的是「逐网页图标」）；已授权后完全隐藏，只保留在设置里。切换模式回到面板最上方。

5. **`renderRules` 增量更新。** 单条增删只操作对应 DOM 节点，不整表重建。

### 阶段 3 —— 工程规范化（约半天）

1. 新增 `.gitignore`：`dist/`、`*.zip`、`node_modules/`、`.DS_Store`、`__pycache__/`
2. **解决文档矛盾**：要么补上 `release.yml`（tag 触发 → 测试 → 打包 → `publish-edge-addons.mjs`），要么把 `README.md:82` 改成「发布脚本已就绪，工作流待启用」并与 `docs/` 保持一致。**推荐前者**——脚本已经写好了，缺的只是一个 40 行的 workflow。
3. **修正 `PRIVACY.md`** 中「未授权时显示全局模式」→「显示未知状态」。这是唯一一处**合规性**错误，优先级应视为 P1。
4. 格式化 `popup.html`（缩进展开），不改结构。
5. 清理 `core.js` 中未被运行时使用的 `buildBypassList` / 旧版 `create*Entry`，或标注 `@deprecated` 保留兼容。
6. 在 `ci.yml` 增加一步：解压构建产物并跑一次「ZIP 内文件集合 == 期望集合」的校验（与阶段 0 的第 2 项复用同一函数）。

---

## 4. 优先级总览

| 优先级 | 项目 | 类型 | 工作量 | 影响 |
| --- | --- | --- | --- | --- |
| **P0** | IPv6 在 PAC 中永不匹配 | 正确性 | 0.5d | 用户看到直连、流量实际走代理 |
| **P0** | `isHostMatched` 重建名单 + PAC 全串比对 | 性能 | 1d | 每次点规则 ~370ms CPU |
| **P0** | 500 条静默截断 | 数据丢失 | 0.5d | 规则不生效且无提示 |
| **P0** | 打包漏文件不报错 | 发布 | 0.5d | 商店版本白屏 |
| **P1** | 文本断言伪装成测试 | 工程 | 1d | 重构无保护 + 虚假信心 |
| **P1** | 隐私声明与行为不一致 | 合规 | 0.2d | 商店审核风险 |
| **P1** | 图标三份实现 | 复杂度 | 1d | 维护成本、冷启动绘制 |
| **P1** | 前台界面不同步 | 体验 | 0.2d | 双开时状态过期 |
| **P2** | 缺 .gitignore / 文档矛盾 / HTML 单行 / 死代码 | 规范 | 0.5d | 长期可维护性 |

**建议顺序：阶段 0 → 阶段 1 → 阶段 3 的合规与 .gitignore（顺手就做）→ 阶段 2。**

阶段 0 与阶段 1 合计约 2 天，就能把「可能误报路由」「性能放大」「商店包缺失」三类真问题清掉。

---

## 5. 明确不建议做的事

结合 `AGENTS.md` 的产品边界，以下方向即使能写也不建议纳入本仓库：

- **不要**为了「更准的状态」请求 `webRequest` 或 `host_permissions`。现在的 4 状态图标是浏览器级别的如实描述，加权限换来的精度不值得破坏最小权限原则。
- **不要**做对 Clash 端口的健康检查（HTTP 请求 `127.0.0.1:9090` 之类）。这会引入 `host_permissions` 或额外网络行为，且 `README` 已经明确定位是「浏览器当前代理配置，不是健康检查」。
- **不要**引入构建工具链（Vite/webpack/TS）。当前零依赖 + 原生 ES module 是这个项目最大的资产之一；阶段 2 的拆分用纯文件拆分即可。
- **不要**为了性能把 PAC 换成 `fixed_servers`。域名规则依赖 PAC，换成固定代理会直接丢掉白/黑名单功能。
