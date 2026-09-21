#!/usr/bin/env bash
# Build the proof movie end to end. Requires: the local dev instance on :8787 with a
# real Granola sync, Playwright + Chrome, ffmpeg, uv, and the proving-it-works skill
# scripts (SKILL_DIR). Every step is gated; a non-zero exit means do not ship.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/plugins/cache/proving-it-works/proving-it-works/0.1.0/skills/proving-it-works-with-a-movie}"
WORK="${WORK:-$HERE/work}"
mkdir -p "$WORK"

echo "== 1. narrate (measured durations)"
"$SKILL_DIR/scripts/narrate" "$HERE/scenes.yaml" "$WORK/narration" ${NARRATE_ARGS:-}

echo "== 2. record frames against ${ORIGIN:-http://localhost:8787}"
node "$HERE/record.mjs" "$HERE/scenes.yaml" --work "$WORK"

echo "== 2b. render cards"
node "$HERE/cards.mjs" "$HERE/scenes.yaml" "$WORK"

echo "== 3. assemble"
# record.mjs wrote $WORK/scenes.yaml with measured frame rates; assemble resolves frame dirs relative to it.
test -f "$WORK/scenes.yaml" || cp "$HERE/scenes.yaml" "$WORK/scenes.yaml"
"$SKILL_DIR/scripts/assemble" "$WORK/scenes.yaml" "$WORK/silent-cut.mp4" --narration "$WORK/narration" --work "$WORK/segments"

echo "== 4. subtitles"
"$SKILL_DIR/scripts/make-subtitles" "$WORK/narration/manifest.json" "$WORK/movie.srt" --offsets-json "$WORK/segments/offsets.json"
"$SKILL_DIR/scripts/burn-subtitles" "$WORK/silent-cut.mp4" "$WORK/movie.srt" "$WORK/movie.mp4"

echo "== 5. gate"
"$SKILL_DIR/scripts/check-movie" "$WORK/movie.mp4" --subs "$WORK/movie.srt" --out "$WORK/check"
echo "movie: $WORK/movie.mp4"
