#!/bin/bash
# Build in the repository; never install over a user's copy of MarpKit.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Tauri の xattr 等は macOS 標準版を使う（Python の同名コマンドを避ける）。
export PATH="$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$ROOT"
OUT=${MARPKIT_RELEASE_DIR:-"$ROOT/dist/macos"}
# Credentials are accepted only from the caller's environment. Never discover keys/accounts.
IDENTITY=${MARPKIT_SIGN_IDENTITY:-"-"}
NOTARY=0
if [ -n "${MARPKIT_NOTARY_KEY_PATH:-}${MARPKIT_NOTARY_KEY_ID:-}${MARPKIT_NOTARY_ISSUER:-}" ]; then
  if [ "$IDENTITY" = "-" ] || [ -z "${MARPKIT_NOTARY_KEY_PATH:-}" ] || [ -z "${MARPKIT_NOTARY_KEY_ID:-}" ] || [ -z "${MARPKIT_NOTARY_ISSUER:-}" ]; then
    echo '公証には MARPKIT_SIGN_IDENTITY と MARPKIT_NOTARY_KEY_PATH・KEY_ID・ISSUER のすべてが必要です。' >&2
    exit 2
  fi
  if [ ! -f "$MARPKIT_NOTARY_KEY_PATH" ]; then
    echo '指定された公証用の鍵ファイルがありません。' >&2
    exit 2
  fi
  NOTARY=1
fi
mkdir -p "$OUT"
notarize() {
  local archive="$1" result="$2" staple_target="$3"
  xcrun notarytool submit "$archive" --key "$MARPKIT_NOTARY_KEY_PATH" --key-id "$MARPKIT_NOTARY_KEY_ID" --issuer "$MARPKIT_NOTARY_ISSUER" --wait --timeout 30m --output-format json > "$result"
  if [ "$(/usr/bin/plutil -extract status raw -o - "$result")" != Accepted ]; then
    echo "公証に通りませんでした。結果: $result" >&2
    exit 1
  fi
  xcrun stapler staple "$staple_target"
  xcrun stapler validate "$staple_target"
}
for TARGET in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$TARGET"
done
# Build ad-hoc first; only the explicit MARPKIT_* options below may authorize signing/notarization.
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
  APPLE_SIGNING_IDENTITY=- pnpm exec tauri build --target universal-apple-darwin --bundles app \
  --config '{"bundle":{"macOS":{"signingIdentity":"-","hardenedRuntime":true}}}'
APP="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/MarpKit.app"
lipo "$APP/Contents/MacOS/marp-native" -verify_arch arm64 x86_64
if [ "$IDENTITY" = "-" ]; then
  codesign --force --sign - --options runtime --timestamp=none --entitlements "$ROOT/src-tauri/Entitlements.plist" "$APP"
else
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ROOT/src-tauri/Entitlements.plist" "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
WORK=$(mktemp -d /tmp/marpkit-release.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
if [ "$NOTARY" = 1 ]; then
  # Staple the app too, so the installed copy can be checked offline.
  ditto -c -k --keepParent "$APP" "$WORK/MarpKit.zip"
  notarize "$WORK/MarpKit.zip" "$OUT/notary-app.json" "$APP"
fi
STAGE="$WORK/MarpKit"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/MarpKit.app"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/MarpKit-universal.dmg"
hdiutil create -volname MarpKit -srcfolder "$STAGE" -format UDZO -ov "$DMG"
if [ "$IDENTITY" != "-" ]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
  if [ "$NOTARY" = 1 ]; then
    notarize "$DMG" "$OUT/notary-dmg.json" "$DMG"
  else
    echo 'Developer ID 署名済み。公証用の環境変数がないため、公証は未実施です。'
  fi
else
  echo 'ad-hoc 版を作成しました。ほかの Mac へ配るには Developer ID 署名と公証が必要です。'
fi
shasum -a 256 "$DMG"
echo "$DMG"
