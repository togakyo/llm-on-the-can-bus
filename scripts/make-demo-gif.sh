#!/usr/bin/env bash
# make-demo-gif.sh — DemoDirector が書き出した連番PNGを README 用 GIF に変換する
#
#   使い方: scripts/make-demo-gif.sh [フレームのディレクトリ] [出力GIF]
#   既定:   unity/Playground/Recordings → docs/assets/demo-unity.gif
#
# 要 ffmpeg（brew install ffmpeg）。パレット2パスで 256色に最適化し、
# README 掲載向けに幅 720px / 15fps に整える。
set -euo pipefail

FRAMES_DIR="${1:-unity/Playground/Recordings}"
OUT="${2:-docs/assets/demo-unity.gif}"

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg が見つかりません: brew install ffmpeg" >&2
  exit 1
fi
if ! ls "$FRAMES_DIR"/frame_0000.png >/dev/null 2>&1; then
  echo "フレームが見つかりません: $FRAMES_DIR/frame_0000.png" >&2
  echo "Unity のメニュー CAN-AI → Set Up Demo Recording → Play で録画してください" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
PALETTE="$(mktemp /tmp/demo-palette-XXXX.png)"
trap 'rm -f "$PALETTE"' EXIT

ffmpeg -y -loglevel error -framerate 15 -i "$FRAMES_DIR/frame_%04d.png" \
  -vf "scale=720:-1:flags=lanczos,palettegen=stats_mode=diff" "$PALETTE"
ffmpeg -y -loglevel error -framerate 15 -i "$FRAMES_DIR/frame_%04d.png" -i "$PALETTE" \
  -lavfi "scale=720:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=4" "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
