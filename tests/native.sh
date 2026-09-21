#!/usr/bin/env bash
#
# Tests for the macOS app.
#
# The engine has its own suites; this only checks the things the app adds,
# which are exactly the things that break when a program becomes an
# application: does it start its own server, does the page load, does the menu
# bar reach the page, does a file handed over by Finder open, does everything
# stop when the window closes.
#
#   tests/native.sh                 build it first, then test
#   tests/native.sh --no-build      test whatever is already built
#
set -uo pipefail
cd "$(dirname "$0")/.."

APP="native/build/gerak.app"
BIN="$APP/Contents/MacOS/gerak"
LOG="$HOME/Library/Logs/gerak.log"
WORK="${TMPDIR:-/tmp}/gerak-native-test"
mkdir -p "$WORK"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }
check() { if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi; }

if [ "${1:-}" != "--no-build" ]; then
  native/build.sh > "$WORK/build.log" 2>&1
  check $? "the app builds"
  grep -q "satisfies its Designated Requirement" "$WORK/build.log"
  check $? "and its signature verifies"
fi

echo
echo "── the bundle ──────────────────────────────────────────────────"

[ -x "$BIN" ]; check $? "there is an executable at Contents/MacOS/gerak"
[ -f "$APP/Contents/Info.plist" ]; check $? "there is an Info.plist"
[ -f "$APP/Contents/Resources/gerak.icns" ]; check $? "there is an icon"
[ -f "$APP/Contents/Resources/server.py" ]; check $? "the server is inside the bundle"
[ -f "$APP/Contents/Resources/web/app.js" ]; check $? "so is the page"
[ -f "$APP/Contents/Resources/blender/worker.py" ]; check $? "so are the Blender jobs"

plutil -lint "$APP/Contents/Info.plist" > /dev/null 2>&1
check $? "the Info.plist is valid"

types=$(plutil -extract CFBundleDocumentTypes.0.CFBundleTypeExtensions json -o - \
  "$APP/Contents/Info.plist" 2>/dev/null)
echo "$types" | grep -q "glb"
check $? "it offers to open .glb files ($types)"

plutil -extract NSAppTransportSecurity.NSAllowsLocalNetworking raw -o - \
  "$APP/Contents/Info.plist" 2>/dev/null | grep -q true
check $? "it is allowed to reach its own server over localhost"

echo
echo "── starting, running, stopping ─────────────────────────────────"

run_app() {                     # run_app <seconds> [extra args...]
  local wait_for="$1"; shift
  rm -f "$LOG"
  "$BIN" --shot "$WORK/shot.png" "$wait_for" "$@" > /dev/null 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 $pid 2>/dev/null && [ $waited -lt 60 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  wait $pid 2>/dev/null
}

rm -f "$WORK/shot.png"
run_app 8

grep -q "server started" "$LOG";  check $? "it starts its own server"
grep -q "server ready on port" "$LOG"; check $? "on a port the system picked, not a fixed one"
grep -q "page loaded" "$LOG";     check $? "the page loads in the window"
[ -f "$WORK/shot.png" ];          check $? "the window renders"
grep -q "server shut down" "$LOG"; check $? "and the server stops when the app does"

sleep 2      # the watchdog checks once a second
pgrep -f "gerak.app/Contents/Resources/server.py" > /dev/null 2>&1
if [ $? -eq 0 ]; then bad "a server was left running"; else ok "no server left behind"; fi

echo
echo "── the server does not outlive the app ─────────────────────────"

# Force-quit, so applicationWillTerminate never runs and only the server's
# own watchdog can save it. This is what happens when the app crashes.
rm -f "$LOG"
"$BIN" --shot "$WORK/kill.png" 30 > /dev/null 2>&1 &
APP_PID=$!
waited=0
while ! grep -q "page loaded" "$LOG" 2>/dev/null && [ $waited -lt 30 ]; do
  sleep 1; waited=$((waited + 1))
done
grep -q "page loaded" "$LOG"; check $? "the app came up so it can be killed"
SERVER_PID=$(pgrep -f "gerak.app/Contents/Resources/server.py" | head -1)
[ -n "$SERVER_PID" ]; check $? "its server is running (pid $SERVER_PID)"
kill -9 $APP_PID 2>/dev/null
sleep 4
kill -0 "$SERVER_PID" 2>/dev/null
if [ $? -eq 0 ]; then
  bad "the server outlived a force-quit"
  kill -9 "$SERVER_PID" 2>/dev/null
else
  ok "the server let itself out when the app was force-quit"
fi

echo
echo "── the menu bar reaches the page ───────────────────────────────"

run_app 9 --js "
  return (async () => {
    const g = window.gerak;
    if (!g) return 'NO BRIDGE';
    if (!g.native) return 'NOT IN NATIVE MODE';
    const pick = g.state.library.find(i => i.rigged && i.joints >= 20 && i.size < 12e6);
    if (!pick) return 'NO RIGGED MODEL';
    await g.openModel(pick);
    const bone = g.state.bones.find(b => /Arm|Leg/.test(b.name)) || g.state.bones[1];
    g.view.select(bone);
    bone.rotation.z += 0.5;
    const before = g.state.clip.totalKeys();
    g.command('key');                       // the Pose > Key the Pose menu item
    const after = g.state.clip.totalKeys();
    g.command('floor');                     // the View > Show the Floor item
    const floor = g.view.ground.visible;
    return JSON.stringify({ model: pick.name, before, after, floor, cmds: Object.keys(g.state).length });
  })()
"

grep -q "SCRIPT RESULT" "$LOG"; check $? "the app can run script in the page"
result=$(grep "SCRIPT RESULT" "$LOG" | tail -1)
echo "$result" | grep -q "NO BRIDGE\|NOT IN NATIVE\|NO RIGGED"
if [ $? -eq 0 ]; then bad "the bridge reported: $result"; else ok "the page answered: ${result#*SCRIPT RESULT: }"; fi
echo "$result" | grep -q '"after":[1-9]'
check $? "a menu command keyed the pose"
echo "$result" | grep -q '"floor":true'
check $? "another menu command turned the floor on"

echo
echo "── opening a file the way Finder does ──────────────────────────"

MODEL="$HOME/Desktop/project/game/killzone/assets/models/player.glb"
if [ -f "$MODEL" ]; then
  # bash 3.2 is what macOS ships, and it has no ${var@Q}, so the path is
  # quoted as a JavaScript string the reliable way.
  MODEL_JS=$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$MODEL")
  run_app 9 --js "
    return (async () => {
      const ok = await window.gerak.openPath($MODEL_JS);
      return JSON.stringify({ ok, open: window.gerak.state.model && window.gerak.state.model.name,
                              joints: window.gerak.state.bones.length });
    })()
  "
  line=$(grep "SCRIPT RESULT" "$LOG" | tail -1)
  echo "$line" | grep -q '"ok":true'
  check $? "a file handed over by path opens: ${line#*SCRIPT RESULT: }"
  echo "$line" | grep -q '"joints":[1-9]'
  check $? "and its skeleton came with it"
else
  echo "  --   skipped: $MODEL is not there"
fi

echo
echo "── Finder really handing a file over ───────────────────────────"

# The check above drives openPath directly. This one goes the whole way: ask
# macOS to open a .glb with the installed app, exactly as double-clicking it
# in Finder does, and watch the file arrive.
INSTALLED="/Applications/gerak.app"
HANDOVER="$HOME/Desktop/project/game/red-card/assets/characters/footballer/footballer_animated.glb"
if [ -d "$INSTALLED" ] && [ -f "$HANDOVER" ]; then
  pkill -f "MacOS/gerak" 2>/dev/null
  sleep 1
  rm -f "$LOG"
  open -a "$INSTALLED" "$HANDOVER"
  waited=0
  while ! grep -qE "opened |could not open" "$LOG" 2>/dev/null && [ $waited -lt 30 ]; do
    sleep 1; waited=$((waited + 1))
  done

  grep -q "Finder handed over" "$LOG"
  check $? "macOS hands the file to the app"
  grep -q "holding .* until the page is up" "$LOG"
  check $? "the app holds it while it is still starting"
  grep -q "permitted $(basename "$HANDOVER")" "$LOG"
  check $? "the server is told it may read it"
  grep -q "opening .* file" "$LOG"
  check $? "and the page is asked to open it"
  grep -q "opened $(basename "$HANDOVER")" "$LOG"
  check $? "and the page confirms it opened it"
  grep -q "refused" "$LOG"
  if [ $? -eq 0 ]; then bad "something was refused: $(grep refused "$LOG" | tail -1)"; fi

  pkill -f "MacOS/gerak" 2>/dev/null
  sleep 2
  pgrep -f "gerak.app/Contents/Resources/server.py" > /dev/null 2>&1
  if [ $? -eq 0 ]; then bad "the installed app left a server running"; else ok "and it tidied up after itself"; fi
else
  echo "  --   skipped: install it first with native/build.sh --install"
fi

echo
[ $FAIL -eq 0 ] && echo "$PASS passed, everything green" || echo "$PASS passed, $FAIL failed"
exit $FAIL
