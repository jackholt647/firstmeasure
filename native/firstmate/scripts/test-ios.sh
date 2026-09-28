#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../ios"
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen'; exit 1; }
xcodegen generate
mkdir -p build
# Pick an installed iPhone simulator instead of hard-coding a model unavailable on a developer's Mac.
device="${IOS_SIMULATOR_ID:-$(xcrun simctl list devices available --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(x["udid"] for group in d["devices"].values() for x in group if x["name"].startswith("iPhone")))')}"
xcodebuild -project FirstMate.xcodeproj -scheme FirstMate -configuration Development \
  -destination "platform=iOS Simulator,id=$device" -derivedDataPath build/DerivedData \
  -resultBundlePath "build/TestResults-$(date +%s).xcresult" CODE_SIGNING_ALLOWED=NO test
