#!/usr/bin/env bash
#
# Build gerak.app.
#
# There is no Xcode project and nothing to install: swiftc comes with the
# command line tools, and everything else here is assembling a folder in the
# shape macOS expects an application to be.
#
#   native/build.sh              build it into native/build/gerak.app
#   native/build.sh --install    ...and put it in /Applications
#   native/build.sh --run        ...and open it
#
# An app bundle is just a folder:
#
#   gerak.app/Contents/Info.plist          what it is called and what it opens
#   gerak.app/Contents/MacOS/gerak         the compiled program
#   gerak.app/Contents/Resources/          the icon, and gerak's own engine
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="$HERE/build"
APP="$BUILD/gerak.app"
CONTENTS="$APP/Contents"

INSTALL=0
RUN=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --run)     INSTALL=1; RUN=1 ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }

echo
echo "building gerak.app"

# ── start clean ─────────────────────────────────────────────────────
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# ── the icon ────────────────────────────────────────────────────────
# macOS wants every size in one .icns. The 1024 px source is rendered from
# native/icon.html; re-render it with build.sh --icon if the drawing changes.
ICONSET="$BUILD/gerak.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

if [ ! -f "$HERE/icon-1024.png" ]; then
  echo "  icon-1024.png is missing — render it first:"
  echo "    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless \\"
  echo "      --window-size=1024,1024 --screenshot=native/icon-1024.png \\"
  echo "      --default-background-color=00000000 file://$HERE/icon.html"
  exit 1
fi

for size in 16 32 64 128 256 512; do
  sips -z $size $size "$HERE/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
  double=$((size * 2))
  sips -z $double $double "$HERE/icon-1024.png" \
    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/gerak.icns"
rm -rf "$ICONSET"
say "icon: $(du -h "$CONTENTS/Resources/gerak.icns" | cut -f1)"

# ── what macOS needs to know about it ───────────────────────────────
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                 <string>gerak</string>
  <key>CFBundleDisplayName</key>          <string>gerak</string>
  <key>CFBundleExecutable</key>           <string>gerak</string>
  <key>CFBundleIdentifier</key>           <string>com.luqmanhakeem.gerak</string>
  <key>CFBundleIconFile</key>             <string>gerak</string>
  <key>CFBundlePackageType</key>          <string>APPL</string>
  <key>CFBundleShortVersionString</key>   <string>1.0</string>
  <key>CFBundleVersion</key>              <string>1</string>
  <key>LSMinimumSystemVersion</key>       <string>13.0</string>
  <key>NSHighResolutionCapable</key>      <true/>
  <key>LSApplicationCategoryType</key>    <string>public.app-category.graphics-design</string>
  <key>NSHumanReadableCopyright</key>     <string>Luqman Hakeem</string>

  <!-- The window draws its own top bar over a transparent title strip. -->
  <key>NSRequiresAquaSystemAppearance</key> <false/>

  <!-- gerak talks to its own server on 127.0.0.1 over plain HTTP. Without
       this, App Transport Security refuses the connection and the window
       comes up empty. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key> <true/>
  </dict>

  <!-- So a .glb can be opened with gerak from Finder. Alternate rank means
       gerak offers itself in "Open With" without taking over the file type
       from whatever already handles it. -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key>     <string>3D model</string>
      <key>CFBundleTypeRole</key>     <string>Editor</string>
      <key>LSHandlerRank</key>        <string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>org.khronos.gltf.binary</string>
        <string>org.khronos.gltf</string>
      </array>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>glb</string>
        <string>gltf</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST
say "Info.plist written"

# ── compile ─────────────────────────────────────────────────────────
swiftc -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit -framework UniformTypeIdentifiers \
  "$HERE/Sources/main.swift" \
  -o "$CONTENTS/MacOS/gerak"
say "compiled: $(du -h "$CONTENTS/MacOS/gerak" | cut -f1)"

# ── gerak's own engine, carried inside the bundle ───────────────────
# The app is self-contained: it runs the copy in its own Resources folder,
# never the working tree, so moving or reinstalling it changes nothing.
cp "$ROOT/server.py" "$CONTENTS/Resources/"
cp "$ROOT/gltf_anim.py" "$CONTENTS/Resources/"
cp "$ROOT/README.md" "$CONTENTS/Resources/"
cp -R "$ROOT/web" "$CONTENTS/Resources/"
cp -R "$ROOT/blender" "$CONTENTS/Resources/"
rm -rf "$CONTENTS/Resources/blender/__pycache__"
say "engine: $(du -sh "$CONTENTS/Resources" | cut -f1) of server, page and Blender jobs"

# ── sign it ─────────────────────────────────────────────────────────
# Ad-hoc, because there is no Developer ID on this machine and none is needed
# for an app that never leaves it. Without any signature at all, macOS refuses
# to launch an arm64 binary.
codesign --force --deep --sign - "$APP" 2>/dev/null
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/  /'

echo
say "built $APP"

# ── install ─────────────────────────────────────────────────────────
if [ $INSTALL -eq 1 ]; then
  DEST="/Applications/gerak.app"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  # Tell Finder about it, so the icon and the "Open With" entry appear now
  # rather than whenever macOS next gets round to noticing.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$DEST" 2>/dev/null || true
  say "installed to $DEST"
  [ $RUN -eq 1 ] && open "$DEST" && say "opened it"
fi

echo
