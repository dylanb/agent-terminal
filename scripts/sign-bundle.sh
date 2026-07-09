#!/usr/bin/env bash
# Ad-hoc sign a macOS .app so its signature BINDS its Info.plist and its code-signing identifier is the
# bundle id. macOS grants notification authorization on that pair alone (§24.2.3 T4): a bundle carrying
# only the linker's ad-hoc signature reports `Identifier=Electron` / `Info.plist=not bound`, and
# UNUserNotificationCenter then denies every raise with UNErrorDomain 1. No Developer ID is required —
# `codesign --sign -` is enough. Off darwin, and for a bundle that is not there, this is a no-op: it runs
# from `postinstall` and must never fail an install.
#
# Usage: sign-bundle.sh [app-bundle-path] [bundle-id]

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP="${1:-$ROOT/node_modules/electron/dist/Electron.app}"
# The id macOS matches authorization against IS the bundle id, so it has exactly one source: `appId`.
BUNDLE_ID="${2:-$(sed -n 's/^appId:[[:space:]]*//p' "$ROOT/electron-builder.yml" 2>/dev/null | head -1)}"

[ "$(uname -s)" = "Darwin" ] || exit 0
[ -d "$APP" ] || exit 0
[ -n "$BUNDLE_ID" ] || { echo "sign-bundle: no appId in electron-builder.yml; skipping" >&2; exit 0; }

# Already carries a real signature under this id — re-signing would only cost time.
if codesign -dv "$APP" 2>&1 | grep -qx "Identifier=${BUNDLE_ID}"; then
  exit 0
fi

if ! /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
  echo "sign-bundle: could not set CFBundleIdentifier on $APP; OS notifications will not be delivered" >&2
  exit 0
fi

# No `--deep`: Apple documents it as unsuitable for signing (TN3161), and only the top-level signature
# binds the Info.plist. Reaching inside would discard the nested frameworks' real signatures for nothing.
if ! codesign --force --sign - "$APP" >/dev/null 2>&1; then
  echo "sign-bundle: could not ad-hoc sign $APP; OS notifications will not be delivered" >&2
  exit 0
fi
