> 自动发布工作流已就位：`.github/workflows/release.yml`。推一个 `vX.Y.Z` 标签即提交到商店；首次上架仍需在 Partner Center 手动完成，见下。

# Microsoft Edge Add-ons distribution

## What can be automated

- GitHub Actions runs tests and creates the clean Edge package.
- After the first store listing exists, a version tag (`vX.Y.Z`) runs the Microsoft Edge Add-ons Update REST API workflow.
- The workflow uploads the new package and submits the draft for certification.
- Microsoft performs certification and controls the store rollout. After publication, Edge users who installed the store listing receive updates through Edge's normal store update mechanism.

## What must happen manually once

1. Register for the Microsoft Edge developer program through Partner Center. Microsoft currently documents no registration fee.
2. Create the first Alaxee Proxy product/submission in Partner Center. Microsoft's Update REST API cannot create a new product or update listing metadata; the initial listing and store details must be completed in Partner Center.
3. Provide the required listing assets and accurate privacy/permission/data-use disclosures. The current extension asks for `proxy`, `storage`, and `activeTab`; explain that these powers are used only to control Edge's proxy configuration, save local preferences, and read the current tab's hostname after the user invokes the extension.
4. Complete Microsoft's initial certification and wait until the listing is in the store.
5. In Partner Center, open **Microsoft Edge → Publish API**, enable the new API experience, and create API credentials. Use the v1.1 API key flow.
6. Copy the product GUID from the extension overview page.
7. Add these GitHub Actions repository secrets (never put credentials in source files):
   - `EDGE_ADDONS_PRODUCT_ID`
   - `EDGE_ADDONS_CLIENT_ID`
   - `EDGE_ADDONS_API_KEY`

## Routine release

1. Update `manifest.json` version and `package.json` version together.
2. Run `npm test`, `npm run check`, and `python scripts/package-extension.py`.
3. Commit and push the change to `main`.
4. Create and push a matching tag, for example `v0.2.0`.
   The tag, `manifest.json` and `package.json` must all carry the same number;
   a test enforces it, because a stale one once produced a zip with the wrong
   label. Note that the backup file format has its own version number, so
   bumping the product version does not invalidate exported backups.
5. GitHub Actions validates the tag/version match, reruns checks, packages only runtime files, uploads the package, and submits it to Microsoft for certification.
6. Check the workflow result and Partner Center status. A successful API submission is **not** the same as Microsoft certification or store publication.

The Edge Add-ons API supports package upload, operation-status checks, submission publishing, and publish-status checks. The first product creation and listing metadata remain manual Partner Center steps.

## Security

- Keep all Microsoft API credentials in GitHub Actions secrets.
- Do not paste API keys into issues, commits, chat, or the extension itself.
- Rotate an API key in Partner Center if it is exposed.
- Do not tag a release until its code and tests are ready. Pushing a `v*` tag is the release/publish trigger.

---

# 上传到 Edge 商店：逐步操作

这一节按 Partner Center 左侧导航的实际顺序写。每一步都标了：

- **[手动]** 只能在网页上点，自动化做不了
- **[已备好]** 仓库里已经有文件，直接上传
- **[生成]** 用仓库脚本一条命令生成

先说一句结论：**截图不是必填项**（微软文档标为 Optional，最多 6 张）。没有截图可以提交，只是商店页面会空一些。所以不要让它卡住你。

---

## 准备：要上传的文件在哪

```bash
npm test && npm run check && npm run package:extension
python3 scripts/store-assets.py        # 生成 Logo 和促销图
```

跑完你会得到：

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `dist/Alaxee-Proxy-v0.2.0.zip` | 扩展包本体 | 32 个文件，来自 `runtime-files.mjs` |
| `store-assets/logo-300.png` | Extension logo（300×300） | 脚本生成，套件等比缩放 |
| `store-assets/tile-440x280.png` | Small promotional tile（440×280） | 脚本生成，可选 |
| 截图 | Screenshots（640×480 或 1280×800） | **需要你本机截，见附录** |

Partner Center 对图片的硬要求（照抄微软文档）：

- **Extension logo**：1:1，推荐 300×300，最小 128×128
- **Small promotional tile**：正好 440×280
- **Large promotional tile**：正好 1400×560（本项目没做，可选）
- **Screenshots**：只能是 640×480 **或** 1280×800，最多 6 张

---

## 第 1 步：注册开发者账号 **[手动，一次]**

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge/public/login>
2. 用你的 Microsoft 账号登录，注册 Edge 扩展开发者计划
3. 目前**没有注册费**
4. 等审核（通常 1–3 个工作日）

账号下来后会登录到一个叫 **Home** 的页面，`Workspaces` 区域里有 **Edge** 卡片。

---

## 第 2 步：创建扩展、上传包 **[手动]**

这一步就上传 zip，还不用填文案。

1. Home 页 → `Workspaces` → 点 **Edge** 卡片
2. 点 **Create new extension**（带 + 号）
3. 打开 **Upload package (.zip file)** 页面
4. 把 `dist/Alaxee-Proxy-v0.2.0.zip` **拖到 `Drag your package here (.zip)` 区域**，或点 **Browse your files** 选择
5. 等页面显示包已校验通过。**有校验错误就说明包有问题，不要绕过**
6. 左侧点 **Extension overview**，再点 **Packages**
7. 点 **Continue**

> 上传后，manifest 里的 `name` 和 `description` 会**自动填进商店列表且变成只读**。所以要改名称或简短描述，只能改 `manifest.json`、重新打包、重新上传。当前的 manifest 是：
>
> - name：`Alaxee Proxy`
> - description：`A lightweight Edge proxy controller: point the browser at any HTTP or SOCKS5 server, with direct and force-proxy domain rules.`

---

## 第 3 步：Availability（可用性） **[手动]**

左侧点 **Availability**。

| 字段 | 选什么 | 说明 |
| --- | --- | --- |
| **Visibility** | `Public` | 选 `Hidden` 就从搜索里消失，只能靠链接安装 |
| **Markets** | 默认「所有市场」 | 不选就包含以后新增的市场。点 **Change markets** 才能挑国家 |

然后点右上角 **Save & Continue**。

> 注意：如果以后把某个市场去掉，那个市场的用户**能继续用已装的版本，但收不到后续更新**。这一点微软文档明确写了。

---

## 第 4 步：Properties（属性） **[手动]**

左侧点 **Properties**。

| 字段 | 必填 | 填什么 |
| --- | --- | --- |
| **Category** | ✅ 必填 | `Developer tools`（代理控制归这类最合适） |
| **Website** | 可选 | 建议留空，或填仓库地址。文档说必须是**你自己的网站**，不能填商店页面 |
| **Support contact detail** | 可选 | 填 `https://github.com/alaxeecc/Alaxee-proxy/issues` 或你的邮箱 |
| **Mature content** | 可选 | **不勾** |

点 **Save & Continue**。

---

## 第 5 步：Privacy（隐私） **[手动，但文案已写好]**

左侧点 **Privacy**。这页有 5 个小节，**审核最容易卡在这里**。

### 5.1 Single Purpose

一个文本框。填一句话，说清楚这个扩展只做一件事：

```
Alaxee Proxy only configures Microsoft Edge's built-in browser proxy setting,
so the user can point the browser at a proxy endpoint they already run, and
switch between that endpoint and a direct connection.
```

### 5.2 Permission justification

页面会**按 manifest 自动列出每一项权限**，每项一个文本框。本项目声明了 3 项权限 + 1 项可选权限：

| 权限 | 填这段 |
| --- | --- |
| `proxy` | Sets Edge's browser-level proxy configuration, including the PAC script that implements the domain rules. Without it the extension cannot do anything. |
| `storage` | Saves the user's proxy endpoint and domain rules locally, and optionally in the browser's own sync storage when the user turns cross-device sync on. |
| `activeTab` | Reads the hostname of the active page, only after the user clicks the toolbar button, to show which rule matches and to offer a one-click bypass. |
| `tabs`（可选权限） | Requested at runtime only if the user enables per-tab toolbar status. Reads tab URLs locally to select the matching state icon; never reads page contents. |

> ⚠️ 微软在这里明确说了：如果列表里有你**不需要**的权限，必须先删掉再重新上传包。我们的 3 项都是必需的，不要删。

### 5.3 Are you using remote code?

选 **No, I am not using remote code**。

这是真的：本项目是 Manifest V3，所有 JS 都打包在 zip 里，不加载任何远程脚本。

### 5.4 Data usage

**What user data do you plan to collect from users now or in the future?**

全部**不勾**。理由：设置和规则都存在本地（或用户自己的浏览器同步空间），不上传到任何服务器。这个扩展没有任何后端。

下面 **I certify that the following disclosures are true** 的勾选框**全部勾上**。

> 这两个区块必须和 `PRIVACY.md` 的内容一致。如果以后加了遥测，这里和 `PRIVACY.md` 都要改，否则就是虚假声明。

### 5.5 Privacy policy

**Privacy Policy URL**。仓库是 public，所以可以直接用：

```
https://github.com/alaxeecc/Alaxee-proxy/blob/main/PRIVACY.md
```

微软只要求「URL 可访问、内容最新」。想更正式可以用 GitHub Pages 或 Gist，但不是必须。

点 **Save & Continue**。

---

## 第 6 步：Store listings（商店列表） **[手动，文案已备好]**

左侧点 **Store listings**，表格里会有一行 `English (United States)`。点那一行的 **Edit details** 按钮。

| 字段 | 必填 | 填什么 |
| --- | --- | --- |
| **Extension name** | 至少一种语言必填 | 自动从 manifest 带入，只读 |
| **Description** | ✅ **每个语言都必填** | 见下 |
| **Extension logo** | ✅ **每个语言都必填** | 上传 `store-assets/logo-300.png` |
| **Small promotional tile** | 可选 | 上传 `store-assets/tile-440x280.png` |
| **Large promotional tile** | 可选 | 跳过（需要 1400×560） |
| **Screenshots** | 可选 | **可以跳过**，见附录 |
| **YouTube video URL** | 可选 | 跳过。如果填，视频里不能有广告 |
| **Short description** | 至少一种语言必填 | 自动从 manifest 带入，只读 |
| **Search terms** | 可选 | 见下 |

### Description 怎么填

**要求：250–10,000 字符**，要讲清全部功能。

直接把 `STORE-LISTING.md` 里 `## Detailed description` 下面那段**整段复制**过去即可（1474 字符，已核对合规）。

### Search terms 建议

最多 7 个词/词组，总计不超过 21 个词，每个不超过 30 字符：

```
proxy, socks5, http proxy, proxy switcher, pac script, domain rules, bypass list
```

### 上传图片的小技巧

Logo 上传后，图片下方会出现 **Duplicate** 链接（「Duplicate this logo for all languages」）。如果你加了多种语言，用它一次复制到所有语言，不用重传。

填完点右上角 **Save draft**。

---

## 第 7 步：提交认证 **[手动]**

1. 回到 **Store listings** 页面，确认每行 **Status** 列显示 **Complete**
2. 右上角 **Publish** 按钮此时才可点（灰色说明还有必填项没填）
3. 点 **Publish** → 打开 **Submit your extension** 页面
4. 在 **Notes for certification** 里填给审核员看的说明——**建议一定要填**，这个扩展涉及网络代理，不解释容易被判风险：

```
This extension only sets Edge's own browser proxy configuration. It ships with
no proxy server, no nodes, no subscriptions, and provides no VPN service.

The proxy address field is empty on first install. Nothing is proxied until the
user types in an endpoint they already run themselves. To test: open the popup,
leave the address empty, and confirm the page still loads normally.

The proxy permission is used only for chrome.proxy.settings and for building the
PAC script from the user's own domain rules. No page content is read. Tab URLs
are read only after the user clicks the toolbar button, and only to display
which rule matches the current host. Nothing is transmitted anywhere; there is
no backend server and no telemetry.

There are no test accounts because there is no account system.
```

5. 再点一次右上角 **Publish**
6. 进入认证队列。微软文档写**最多 7 个工作日**
7. 通过后状态变成 **In the Store**，商店页面就上线了

> 如果点击时报 `Something went wrong. Please try again. correlationId : undefined`，微软给的办法是：清 cookie 和缓存、换 InPrivate 模式、或换一个浏览器再试。这是 Partner Center 自己的老问题，不是你的包有问题。

---

## 第 8 步：配置自动发布（上线后再做） **[手动，一次]**

扩展上线之后才能配 API。**上架前不用管这步。**

### 8.1 拿三样东西

Partner Center → 你的扩展 → **Microsoft Edge → Publish API**：

1. 启用 **new API experience**
2. 点 **Create API credentials**
3. 记下 **Client ID** 和 **API Key**——**API Key 只显示一次**，立刻存好
4. 回 **Extension overview** 页面，复制 **Product ID**

### 8.2 存进 GitHub

仓库 → Settings → Secrets and variables → Actions → **New repository secret**，加三条：

| 名称 | 值 |
| --- | --- |
| `EDGE_ADDONS_PRODUCT_ID` | Product ID |
| `EDGE_ADDONS_CLIENT_ID` | Client ID |
| `EDGE_ADDONS_API_KEY` | API Key |

⚠️ **API Key 约 72 天过期**。过期后发布 workflow 报 401，去 Partner Center 重新生成并更新这条 secret。这是微软的限制。

### 8.3 以后每次发版

```bash
# 1. 改版本号：manifest.json 和 package.json 都要改，必须一致
# 2. 验证
npm test && npm run check
# 3. 推送代码
git add -A && git commit -m "Release 0.2.1" && git push origin main
# 4. 打标签 —— 这一下触发全部自动化
git tag v0.2.1 && git push origin v0.2.1
```

workflow 会自动：校验版本三方一致 → 跑测试 → 打包 → 调微软 API 上传并提交认证 → 存 zip 为 artifact（90 天）。

失败了不用删标签重推——去 Actions → **Release to Edge Add-ons** → **Run workflow**，输入那个标签重跑。

---

# 附录：截图怎么做

**截图是选填的**，没有也能提交。但有一张真实截图对转化率影响很大，建议做。

沙箱里没有浏览器（`which chromium chromium-browser google-chrome firefox` 全部为空），所以这一步只能在你的机器上做。

1. `edge://extensions` → 打开右下角**开发者模式**
2. 点 **加载解压缩的扩展** → 选择本仓库根目录
3. 点工具栏的扩展图标，弹出面板
4. 用系统截图工具截这个面板

**尺寸只有两种选择：640×480 或 1280×800。** 面板本身是 380 宽，所以：

- 截完在图片编辑器里**建一个 1280×800 的画布**，把面板截图**等比**放进去，背景填 `#FAF6F4`（`--bg`）
- **不要拉伸**——等比缩放才不会变形

建议三张：

| 场景 | 怎么弄 |
| --- | --- |
| 主面板（显示当前路由状态） | 直接截弹窗 |
| 设置页 | 弹窗里点 ⚙ → 截整页 |
| 规则列表 | 先加两三条规则，截那个列表，能体现按域名分流 |

存到 `store-assets/`（已在 `.gitignore` 里，不会进仓库）。

---

# 附录：一张表看完

| # | 步骤 | 谁做 | 需要什么 |
| --- | --- | --- | --- |
| 1 | 注册开发者账号 | 你 | Microsoft 账号 |
| 2 | 创建扩展 + 上传 zip | 你 | 跑一次打包 |
| 3 | Availability | 你 | 选 Public |
| 4 | Properties | 你 | 选 Category |
| 5 | Privacy | 你 | 上面 5.1–5.5 的文案，直接抄 |
| 6 | Store listings | 你 | Description + Logo（已生成） |
| 7 | 提交认证 | 你 | Notes for certification（已写好） |
| — | 微软审核 | 微软 | 最多 7 个工作日 |
| 8 | 配 API + secrets | 你 | 上线后做，一次 |
| 之后 | 每次发版 | CI | `git tag && git push` |
