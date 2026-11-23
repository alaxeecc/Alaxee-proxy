#!/usr/bin/env bash
#
# Pulls the branch you are testing into an already-loaded unpacked extension.
#
# The point is to stop re-downloading and re-installing the extension for every
# change. Edge loads an unpacked extension straight from a folder, so the only file
# that has to be new is the one on disk - then one click on Reload in
# edge://extensions picks it up.
#
# Usage, from the folder you loaded into Edge:
#   bash scripts/update-unpacked.sh
#
# It refuses to run if the working tree has local edits, because silently stashing
# someone's work is worse than making them look at it.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "这不是 git 仓库。" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先处理它们再更新：" >&2
  git status --short >&2
  exit 1
fi

before=$(git rev-parse --short HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)

echo "当前分支：$branch  ($before)"
echo "从远端拉取…"
git pull --ff-only

after=$(git rev-parse --short HEAD)
echo "现在：$(git rev-parse --short HEAD)  $(git log -1 --pretty=%s)"

if [ "$before" = "$after" ]; then
  echo
  echo "已经是最新，没有更新。"
else
  echo
  echo "更新了 $(git rev-list --count "$before..$after") 个提交："
  git log --oneline "$before..$after" | sed 's/^/  /'
fi

echo
echo "接下来：打开 edge://extensions，在 Alaxee Proxy 卡片上点一次「重新加载」。"
echo "不需要删除扩展，也不需要重新选择文件夹。"
