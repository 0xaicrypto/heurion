#!/usr/bin/env bash
# build-linux.sh — produce an unsigned Nexus AppImage (and optionally
# a tarball) on Linux.
#
# What this does
# ==============
#  1. dotnet publish for linux-x64, self-contained.
#  2. Wrap in an AppDir (Linux's ".app" equivalent: a directory with
#     a .desktop file, an icon, and an AppRun launcher).
#  3. Run appimagetool to package the AppDir into a single executable
#     .AppImage file. Users `chmod +x` it and run.
#  4. Also produces a plain .tar.gz for users who don't want AppImage
#     (e.g. distros where libfuse isn't installed).
#
# Usage
# =====
#   ./packages/desktop/scripts/build-linux.sh
#
# Output
# ======
#   packages/desktop/dist/Nexus-linux-x86_64.AppImage
#   packages/desktop/dist/Nexus-linux-x86_64.tar.gz
#
# Prereqs (one-time)
# ==================
#   * .NET 10 SDK
#   * appimagetool (one-time download):
#       curl -fsSL https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage \
#         -o /usr/local/bin/appimagetool && chmod +x /usr/local/bin/appimagetool
#   * librsvg for icon rasterisation: apt install librsvg2-bin

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="RuneDesktop.UI/RuneDesktop.UI.csproj"
CONFIG="Release"
DIST="dist"
APP_NAME="Nexus"
RID="linux-x64"
ARCH_LABEL="x86_64"   # AppImage convention

VERSION=$(grep -oE '<Version>[^<]+' "$PROJECT" | head -1 | sed 's/<Version>//' || echo "0.1.0")

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Building Nexus.AppImage (Linux $ARCH_LABEL, unsigned)"
echo "  version: $VERSION"
echo "════════════════════════════════════════════════════════════════"
echo ""

command -v dotnet >/dev/null || { echo "✗ dotnet not on PATH — install .NET 10 SDK"; exit 1; }

# ── Step 1: publish self-contained ───────────────────────────────────
rm -rf "$DIST"
mkdir -p "$DIST"

PUBLISH_DIR="$DIST/publish-$RID"
echo "→ publish $RID"
dotnet publish "$PROJECT" \
    -c "$CONFIG" \
    -r "$RID" \
    --self-contained true \
    -p:PublishSingleFile=false \
    -p:DebugType=none \
    -p:DebugSymbols=false \
    -o "$PUBLISH_DIR" \
    --nologo --verbosity minimal

chmod +x "$PUBLISH_DIR/Nexus"

# ── Step 2: tarball (always, even if appimagetool missing) ───────────
TARBALL="$DIST/$APP_NAME-linux-$ARCH_LABEL-$VERSION.tar.gz"
(
    cd "$PUBLISH_DIR"
    tar czf "../../$TARBALL" \
        --transform "s,^,$APP_NAME-$VERSION/," \
        .
)
echo "✓ wrote $TARBALL"

# ── Step 3: AppDir scaffold ──────────────────────────────────────────
APPDIR="$DIST/$APP_NAME.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# Copy the publish output into AppDir/usr/bin
cp -R "$PUBLISH_DIR/." "$APPDIR/usr/bin/"

# AppRun launcher: tells AppImage how to start the app
cat > "$APPDIR/AppRun" <<EOF
#!/bin/sh
HERE=\$(dirname "\$(readlink -f "\$0")")
export LD_LIBRARY_PATH="\$HERE/usr/bin:\$LD_LIBRARY_PATH"
exec "\$HERE/usr/bin/Nexus" "\$@"
EOF
chmod +x "$APPDIR/AppRun"

# .desktop file (entry shown in app menus)
cat > "$APPDIR/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Self-evolving AI agent on BNB Chain
Exec=Nexus
Icon=$APP_NAME
Categories=Network;Chat;Utility;
Terminal=false
EOF
cp "$APPDIR/$APP_NAME.desktop" "$APPDIR/usr/share/applications/"

# Icon (256x256 PNG required by AppImage spec)
ICON_SRC="RuneDesktop.UI/Assets/nexus-logo.svg"
ICON_PNG="$APPDIR/$APP_NAME.png"
if command -v rsvg-convert >/dev/null && [ -f "$ICON_SRC" ]; then
    rsvg-convert -w 256 -h 256 "$ICON_SRC" -o "$ICON_PNG"
    cp "$ICON_PNG" "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APP_NAME.png"
    echo "✓ icon generated"
else
    # fallback: 1x1 transparent PNG — AppImage requires the file but
    # doesn't strictly require it be the right resolution.
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfc\xff\xff\xff?\x00\x05\xfe\x02\xfe\xa0\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82' > "$ICON_PNG"
    cp "$ICON_PNG" "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APP_NAME.png"
    echo "⚠ rsvg-convert missing — placeholder 1x1 icon"
fi

# ── Step 4: appimagetool ─────────────────────────────────────────────
APPIMAGE="$DIST/$APP_NAME-linux-$ARCH_LABEL-$VERSION.AppImage"
if command -v appimagetool >/dev/null; then
    echo "→ appimagetool"
    ARCH=$ARCH_LABEL appimagetool --no-appstream "$APPDIR" "$APPIMAGE" 2>&1 | tail -5
    chmod +x "$APPIMAGE"
    echo "✓ wrote $APPIMAGE"
else
    echo "⚠ appimagetool not on PATH — skipping AppImage."
    echo "  Install one-time:"
    echo "    curl -fsSL https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage \\"
    echo "      -o ~/.local/bin/appimagetool && chmod +x ~/.local/bin/appimagetool"
fi

# Cleanup
rm -rf "$APPDIR" "$PUBLISH_DIR"

echo ""
echo "Output:"
ls -lh "$DIST"/*."AppImage" "$DIST"/*."tar.gz" 2>/dev/null || ls -lh "$DIST"/
