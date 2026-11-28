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

# 第一次上架：完整操作清单

这一节是给「现在就要传到 Edge 商店」写的。按顺序做，每一步都标了能不能自动化。

## 第 0 步：先确认包是对的

```bash
npm test                 # 236 项，含版本一致性、图标完整性、字体覆盖
npm run check            # 语法 + 8 张图标 + 打包闭包
npm run package:extension
```

产物在 `dist/Alaxee-Proxy-v0.2.0.zip`，32 个文件。**不要手动改这个 zip**——它由 `scripts/runtime-files.mjs` 从 manifest 推导，改了就和非运行时文件混在一起。

## 第 1 步：注册开发者账号（手动，一次）

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge>
2. 用你的 Microsoft 账号注册 Edge 开发者计划。目前**免费**。
3. 等账号审核通过（通常 1–3 个工作日）。

## 第 2 步：创建产品并填清单（手动，一次）

在 Partner Center → Microsoft Edge → 新建扩展。需要填：

| 项目 | 从哪里来 |
| --- | --- |
| 名称 | `Alaxee Proxy` |
| 简短描述 | `STORE-LISTING.md` 的「Short description」 |
| 详细描述 | 同上「Detailed description」，直接复制 |
| 权限说明 | 同上「Permission justifications」——**这一项审核最常打回**，务必写清 `proxy`/`storage`/`activeTab` 各自的用途 |
| 隐私政策 URL | 见第 3 步 |
| 商店图标 | `icons/icon128.png`（已与套件一致，1024px 版在 `alaxee-kit/brand/icons/png/icon-day-1024.png`） |
| 截图 | **必须你本机截**，见下 |

### 截图怎么做（只能手动）

沙箱里没有浏览器，我无法生成真实截图。在 Edge 里：

1. `edge://extensions` → 打开开发者模式 → **加载解压缩的扩展** → 选仓库根目录
2. 点工具栏图标弹出面板 → 截图（380×600 的区域）
3. 同一个面板点「⚙ 设置」→ 全页设置界面 → 再截一张
4. 建议第三张：规则列表里有几条规则的界面（演示按域名分流）

截图要求：PNG、最短边 ≥ 640px、最长边 ≤ 1280px。**把 380px 的截图放大到 640 宽即可**（等比放大，不要拉伸变形）。

保存到 `store-assets/` 目录（已加进 `.gitignore`，避免大图进仓库）。

## 第 3 步：隐私政策要有公开 URL（手动，一次性配置）

Partner Center 要求一个可访问的 URL，指向 `PRIVACY.md` 的内容。三个免费选项：

- **GitHub Pages**：仓库 Settings → Pages → Source 选 `main` 分支 `/docs`。然后把 `PRIVACY.md` 复制成 `docs/privacy.html`（或直接用 `https://github.com/alaxeecc/Alaxee-proxy/blob/main/PRIVACY.md`，多数情况可接受）
- **Gist**：把 `PRIVACY.md` 内容贴成公开 Gist
- **Cloudflare Pages / Vercel**：静态托管，免费

填进 Partner Center 后**这一项以后不用再改**。

## 第 4 步：提交第一个版本（手动，一次）

1. Partner Center → 你的产品 → Packages → **上传** `dist/Alaxee-Proxy-v0.2.0.zip`
2. 填「Notes for certification」（给审核员看的说明，**建议写**）：
   ```
   This extension only sets Edge's own browser proxy configuration.
   It ships with no proxy server and does not provide VPN service.
   The proxy address field is empty on first install; nothing is proxied until
   the user enters an address they already run.
   Tab URLs are read only after the user clicks the toolbar button, and only to
   show which host the current page is routed to. Nothing is sent anywhere.
   ```
3. 点 **Publish** → 进入认证队列
4. 等认证（通常 1–7 个工作日）

**认证通过后商店上线，这一步没有自动化替代。**

## 第 5 步：配置自动更新（手动，一次，之后就全自动了）

这是你问的「以后都能自动更新」的核心。

### 5.1 在 Partner Center 拿三样东西

Partner Center → 你的产品 → **Microsoft Edge → Publish API**：

1. 启用 **new API experience**
2. 点 **Create API credentials**
3. 记下：
   - **Client ID**（一串 GUID）
   - **API Key**（只显示一次，务必立刻保存）
4. 回到产品概览页，复制 **Product ID**（另一个 GUID）

### 5.2 存进 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → **New repository secret**：

| 名称 | 值 |
| --- | --- |
| `EDGE_ADDONS_PRODUCT_ID` | 产品 GUID |
| `EDGE_ADDONS_CLIENT_ID` | Client ID |
| `EDGE_ADDONS_API_KEY` | API Key |

⚠️ **API Key 有效期约 72 天**，过期后发布 workflow 会报 401。到期前在 Partner Center 重新生成并更新 Secret。这是微软的限制，绕不过去。

### 5.3 以后每次发版的完整流程

```bash
# 1. 改版本号（两处必须一致，测试会检查）
#    manifest.json 和 package.json 都改成 0.2.1

# 2. 本地验证
npm test && npm run check

# 3. 提交并推送到 main
git add -A && git commit -m "Release 0.2.1" && git push origin main

# 4. 打标签 —— 这一步触发自动发布
git tag v0.2.1
git push origin v0.2.1
```

推送标签后，`.github/workflows/release.yml` 自动：

1. 校验标签 / `manifest.json` / `package.json` 三者版本一致（不一致直接失败）
2. 跑全部测试
3. 打包
4. 调 Microsoft 的 API 上传并提交认证
5. 上传 zip 作为 Actions artifact，保留 90 天

然后你去 Partner Center 看认证状态。**认证通过后，所有通过商店安装的用户会在 Edge 下次检查更新时自动收到新版本**——这由 Edge 自己的更新机制完成，不需要你做任何事。

### 5.4 如果发布失败了

- 在 GitHub Actions 页面找到失败的 run，看日志
- 修好后，去 **Actions → Release to Edge Add-ons → Run workflow**，输入那个已经存在的标签（比如 `v0.2.1`）重跑
- 不要删除再重推标签——那会重写别人已经拉取过的历史

## 关于「自动更新」的准确边界

| 环节 | 谁来做 | 频率 |
| --- | --- | --- |
| 改代码、改版本号、打标签 | 你 | 每次发版 |
| 打包、校验、上传、提交认证 | GitHub Actions | 自动 |
| 认证审核 | 微软 | 1–7 天，不可控 |
| 推送给已安装用户 | Edge 浏览器 | 自动，无需操作 |

**真正省下的**：不用每次手动打包、登录 Partner Center、上传、点发布。省不掉的是打标签和等微软审核。
