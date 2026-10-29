#!/bin/bash
# 録音ヘルパーの単体テストを実行する。
# Command Line Toolsの新しいビルドシステムは、swift-testingのマクロプラグインを読み込めない場合がある
# （2026-10-28、Swift 6.4で約3回に2回失敗）。プラグインのフォルダを明示して回避する。
set -euo pipefail

package_dir="$(cd "$(dirname "$0")/../native/MeetingAudioHelper" && pwd)"
plugin_dir="$(dirname "$(xcrun -f swift)")/../lib/swift/host/plugins/testing"

swift test --package-path "$package_dir" -Xswiftc -plugin-path -Xswiftc "$plugin_dir" "$@"
