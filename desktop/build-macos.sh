#!/usr/bin/env bash
set -euo pipefail

frameflow_root="$(cd "$(dirname "$0")/.." && pwd)"
frameflow_bundle="$frameflow_root/FrameFlow.app"
frameflow_node="$(command -v node)"
frameflow_arch="$(uname -m)"
cd "$frameflow_root"
mkdir -p "$frameflow_bundle/Contents/MacOS" "$frameflow_bundle/Contents/Resources" .vimax/FrameFlow.iconset .vimax/swift-cache

swiftc -swift-version 5 -O -target "${frameflow_arch}-apple-macosx12.0" -module-cache-path "$frameflow_root/.vimax/swift-cache" desktop/FrameFlow.swift -o "$frameflow_bundle/Contents/MacOS/FrameFlow" -framework Cocoa -framework WebKit
frameflow_icon_source="$frameflow_root/desktop/assets/frameflow-app-icon.png"
frameflow_icon_master="$frameflow_root/.vimax/FrameFlow.iconset/icon_512x512@2x.png"
if [[ -f "$frameflow_icon_source" ]]; then
  sips -z 1024 1024 "$frameflow_icon_source" --out "$frameflow_icon_master" >/dev/null
else
  "$frameflow_bundle/Contents/MacOS/FrameFlow" --render-icon "$frameflow_icon_master"
fi
for frameflow_size in 16 32 128 256 512; do
  sips -z "$frameflow_size" "$frameflow_size" .vimax/FrameFlow.iconset/icon_512x512@2x.png --out ".vimax/FrameFlow.iconset/icon_${frameflow_size}x${frameflow_size}.png" >/dev/null
  frameflow_double=$((frameflow_size * 2))
  if [[ "$frameflow_size" != 512 ]]; then
    sips -z "$frameflow_double" "$frameflow_double" .vimax/FrameFlow.iconset/icon_512x512@2x.png --out ".vimax/FrameFlow.iconset/icon_${frameflow_size}x${frameflow_size}@2x.png" >/dev/null
  fi
done
iconutil -c icns .vimax/FrameFlow.iconset -o "$frameflow_bundle/Contents/Resources/FrameFlow.icns"
FRAMEFLOW_BUILD_ROOT="$frameflow_root" FRAMEFLOW_BUILD_NODE="$frameflow_node" .venv/bin/python - <<'PY'
import os, pathlib, plistlib
root = pathlib.Path(os.environ['FRAMEFLOW_BUILD_ROOT'])
info = {
    'CFBundleName': 'FrameFlow', 'CFBundleDisplayName': 'FrameFlow',
    'CFBundleIdentifier': 'local.frameflow.vimax.desktop',
    'CFBundleExecutable': 'FrameFlow', 'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '1.0.0', 'CFBundleVersion': '1',
    'CFBundleIconFile': 'FrameFlow', 'LSMinimumSystemVersion': '12.0',
    'NSHighResolutionCapable': True, 'CFBundleDevelopmentRegion': 'zh_CN',
    'CFBundleLocalizations': ['zh_CN'], 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
    'FrameFlowWorkspacePath': str(root), 'FrameFlowNodePath': os.environ['FRAMEFLOW_BUILD_NODE'],
    'NSHumanReadableCopyright': 'FrameFlow · 基于 HKUDS ViMax（MIT）',
}
with (root / 'FrameFlow.app/Contents/Info.plist').open('wb') as stream:
    plistlib.dump(info, stream)
PY
cp LICENSE "$frameflow_bundle/Contents/Resources/ViMax-LICENSE"
codesign --force --deep --sign - "$frameflow_bundle"
printf '桌面 App 已生成：%s\n' "$frameflow_bundle"
