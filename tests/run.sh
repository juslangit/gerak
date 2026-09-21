#!/usr/bin/env bash
# Every test gerak has, in order of how much they prove.
#
#   1. the animation maths, in Node - fast, no browser, no server
#   2. the round trip on a real model off your disk, in a real browser
#   3. the whole app driven like a person would drive it
#
# The last two need the server running: start it with `gerak --no-open`.
set -u
cd "$(dirname "$0")/.."
FAILED=0

echo "── 1. the animation maths ──────────────────────────────────────"
node --import ./tests/register.mjs tests/clip.test.mjs || FAILED=1

TOKEN="${GERAK_TOKEN:-}"
PORT="${GERAK_PORT:-8778}"
if [ -z "$TOKEN" ]; then
  echo
  echo "Set GERAK_TOKEN to the token gerak printed when it started"
  echo "to run the browser tests as well. Skipping them."
  exit $FAILED
fi

MODEL="${GERAK_TEST_MODEL:-$HOME/Desktop/project/game/killzone/assets/models/player.glb}"
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$MODEL")

echo
echo "── 2. the round trip, on $(basename "$MODEL") ──────────────────"
node tests/run-browser.mjs \
  "http://127.0.0.1:$PORT/tests/pipeline.html?t=$TOKEN&model=$ENC" || FAILED=1

echo
echo "── 3. the app, driven like a person ────────────────────────────"
node tests/run-browser.mjs \
  "http://127.0.0.1:$PORT/?t=$TOKEN" tests/app.smoke.mjs || FAILED=1

echo
[ $FAILED -eq 0 ] && echo "everything green" || echo "something failed"
exit $FAILED
