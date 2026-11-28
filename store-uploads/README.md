# 商店上传素材

从这里下载，逐个上传到 Partner Center。**不要放进扩展包里**——它们不是运行时文件。

| 文件 | 上传到 Partner Center 的哪一页 |
| --- | --- |
| `logo-300.png` | Store listings → Edit details → **Extension logo**（必填） |
| `tile-440x280.png` | 同一页 → **Small promotional tile**（选填） |
| `01-overview.png` | 同一页 → **Screenshots** 第 1 张 |
| `02-rules.png` | 同一页 → **Screenshots** 第 2 张 |
| `03-sync.png` | 同一页 → **Screenshots** 第 3 张 |

所有截图都是 1280×800，符合微软要求。

`logo-300.png` 和 `tile-440x280.png` 由 `python3 scripts/store-assets.py` 从品牌套件生成，
截图由 `python3 scripts/store-shot.py` 套进合规画布。想重新生成就重跑这两条命令。

## 为什么不放进 store-assets/

`store-assets/` 在 `.gitignore` 里，是用来放**你自己新截的原图**的工作目录。
这个目录放的是**已经处理完成、可以直接上传**的成品，所以提交进仓库是为了让你能下载到。
