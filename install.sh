#!/usr/bin/env bash
# Jinno Slide Kit を使えるようにする。clone したフォルダで1回実行する（更新したら、もう一度実行する）。
#   ./install.sh            依存を入れ、スキル（marp-jinno）を Claude Code / Codex に入れる
#   ./install.sh --no-deps  スキルだけ入れ直す
#   ./install.sh --aws-icons  あわせて AWS の公式アイコン集を配布元から取得する（docs/aws-icons.md）
set -euo pipefail
NO_DEPS=0; AWS_ICONS=0
for arg in "$@"; do
  case "$arg" in
    --no-deps) NO_DEPS=1 ;;
    --aws-icons) AWS_ICONS=1 ;;
  esac
done

KIT="$(cd "$(dirname "$0")" && pwd)"
say() { printf '%s\n' "$*"; }

# 1. 必要なもの
command -v node >/dev/null || { say "Node.js が要ります（22.12 以降）: https://nodejs.org/"; exit 1; }
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || say "注意: Google Chrome が見つかりません（検査・書き出しに使います）。別の場所なら CHROME_PATH を設定してください"
command -v uv >/dev/null || { say "uv が必要です。brew install uv でインストールしてください。"; exit 1; }

if [ "$NO_DEPS" = 0 ]; then
  command -v pnpm >/dev/null || { say "pnpm が必要です（使用する版は package.json の packageManager を参照）"; exit 1; }
  uv python install "$(cat "$KIT/.python-version")"
  (cd "$KIT" && pnpm install --frozen-lockfile)
fi

# 2. キットの場所を覚える
mkdir -p "$HOME/.config/jinno-marp"
printf '%s\n' "$KIT" > "$HOME/.config/jinno-marp/kit"

# 3. スキルを入れる。{{KIT}} をこのフォルダの場所に置き換えてコピーする
#    自分で作った同名のスキルは上書きしない（このキットから入れたものだけ入れ直す）
for base in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  [ -d "$(dirname "$base")" ] || continue
  mkdir -p "$base"
  for src in "$KIT"/skills/*/; do
    name="$(basename "$src")"; dst="$base/$name"
    if [ -e "$dst" ] && [ ! -f "$dst/.from-marp-kit" ]; then
      say "スキップ: $dst（このキット以外のスキルがあります）"; continue
    fi
    rm -rf "$dst"; mkdir -p "$dst"; cp -R "$src". "$dst/"
    find "$dst" -name '*.md' -exec env KIT_PATH="$KIT" perl -pi -e 's/\{\{KIT\}\}/$ENV{KIT_PATH}/g' {} +
    : > "$dst/.from-marp-kit"
    say "スキルを入れました: $dst"
  done
done

# 4. AWS の公式アイコン集（任意）。キットには同梱せず、使う人が配布元から取得する
if [ "$AWS_ICONS" = 1 ]; then
  node "$KIT/marp/bin/slides.mjs" icons fetch || say "注意: AWS のアイコン集を取得できませんでした。docs/aws-icons.md の手動の手順を使ってください"
fi

say ""
say "できました。試すとき:"
say "  node $KIT/marp/bin/slides.mjs new ~/Slides/my-talk --title \"はじめての資料\""
say "  node $KIT/marp/bin/slides.mjs edit ~/Slides/my-talk/slides.md"
say "登壇レイアウトには同梱の Noto Sans JP を使います。"
[ "$AWS_ICONS" = 1 ] || say "構成図に AWS の公式アイコンを使うときは: node $KIT/marp/bin/slides.mjs icons fetch"
