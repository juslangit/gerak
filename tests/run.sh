#!/usr/bin/env bash
# Every test gerak has, in the order of how much each one proves.
#
#   1. the animation maths          Node, no browser, no server, under a second
#   2. the IK solver                same
#   3. the round trip               a real model off your disk, in a real browser
#   4. rigging                      a human and a dog, placed and bound by Blender
#   5. the app                      driven the way a person drives it
#   6. the rigging flow             unrigged model → skeleton → bound → animated
#
# The browser tests need the server running. Start it with `gerak --no-open`,
# note the token it prints, and pass it in:
#
#   GERAK_TOKEN=<token> tests/run.sh
set -u
cd "$(dirname "$0")/.."
FAILED=0
run() { echo; echo "── $1 ──────────────────────────────────────────"; shift; "$@" || FAILED=1; }

run "the animation maths" node --import ./tests/register.mjs tests/clip.test.mjs
run "the IK solver"       node --import ./tests/register.mjs tests/ik.test.mjs

TOKEN="${GERAK_TOKEN:-}"
PORT="${GERAK_PORT:-8778}"
if [ -z "$TOKEN" ]; then
  echo
  echo "Set GERAK_TOKEN to the token gerak printed at startup to run the"
  echo "browser tests as well. Skipping them for now."
  exit $FAILED
fi

BASE="http://127.0.0.1:$PORT"
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

MODEL="${GERAK_TEST_MODEL:-$HOME/Desktop/project/game/killzone/assets/models/player.glb}"
run "the round trip, on $(basename "$MODEL")" \
  node tests/run-browser.mjs "$BASE/tests/pipeline.html?t=$TOKEN&model=$(enc "$MODEL")"

RIGS=$(python3 - <<'PY'
import json, os, urllib.parse
home = os.path.expanduser("~")
print(urllib.parse.quote(json.dumps([
  {"path": home + "/Desktop/project/game/referee-for-fun/assets/characters/crowd_a_stand.glb",
   "template": "biped", "label": "Human"},
  {"path": home + "/Desktop/project/ai/boneka/sessions/shots/dog.glb",
   "template": "quadruped", "label": "Dog"},
])))
PY
)
run "rigging a human and a dog" \
  node tests/run-browser.mjs "$BASE/tests/rig.html?t=$TOKEN&models=$RIGS"

run "the app, driven like a person" \
  node tests/run-browser.mjs "$BASE/?t=$TOKEN" tests/app.smoke.mjs

run "the rigging flow, end to end" \
  node tests/run-browser.mjs "$BASE/?t=$TOKEN" tests/rigflow.smoke.mjs

# The rigging suite writes rigged copies into the exports folder. They are
# test output, not your work, so they do not get to sit in Documents.
find "$HOME/Documents/gerak/exports" -maxdepth 1 -name 'test-*-rigged.glb' -delete 2>/dev/null
find "$HOME/Documents/gerak/exports" -maxdepth 1 -name 'crowd_a_stand-rigged.*' -delete 2>/dev/null
find "$HOME/Documents/gerak/exports" -maxdepth 1 -name 'player.*' -delete 2>/dev/null
# and drop the cached library, or the next run is offered files that have gone
rm -f "$HOME/Documents/gerak/.library.json" 2>/dev/null

echo
echo "── the macOS app ───────────────────────────────────────────────"
echo "run tests/native.sh for the app; it builds and launches it, which"
echo "takes about a minute and opens windows, so it is kept separate."

echo
[ $FAILED -eq 0 ] && echo "everything green" || echo "something failed"
exit $FAILED
