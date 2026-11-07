#!/bin/bash
set -euo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$BASE/CUKTECH Station.app"
BUILD="$(mktemp -d /tmp/cuktech-web-build.XXXXXX)"
trap 'rm -rf "$BUILD"' EXIT
for ARCH in arm64 x86_64; do
    /usr/bin/xcrun swiftc -O -target "$ARCH-apple-macosx12.3" -framework AppKit "$BASE/macos/Launcher.swift" -o "$BUILD/$ARCH"
done
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BASE/macos/Info.plist" "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources/en.lproj" "$APP/Contents/Resources/zh-Hans.lproj"
cp "$BASE/macos/en.lproj/InfoPlist.strings" "$APP/Contents/Resources/en.lproj/InfoPlist.strings"
cp "$BASE/macos/zh-Hans.lproj/InfoPlist.strings" "$APP/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
/usr/bin/lipo -create "$BUILD/arm64" "$BUILD/x86_64" -output "$APP/Contents/MacOS/Launcher"
/usr/bin/codesign --force --deep --sign - "$APP"
