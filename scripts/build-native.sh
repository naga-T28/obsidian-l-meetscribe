#!/bin/bash
# 録音ヘルパーをビルドし、ad-hoc署名した単一の実行ファイルをリポジトリ直下の lms-audio-helper に置く。
# .app化はせず、Info.plistを__TEXT,__info_plistへ埋め込む（Package.swiftのリンカ設定）。Obsidianから直接起動すれば、録音の許可はObsidianに付くため。
# 配置先はVaultの .obsidian/plugins/l-meetscribe/（scripts/setup.sh が配置する）。
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
package_dir="$repo_dir/native/MeetingAudioHelper"
output="$repo_dir/lms-audio-helper"
signing_identifier="dev.l-meetscribe.audio-helper"

# プラグインはreadyのhelperVersionとmanifest.jsonの版を照合し、違えば録音を始めない。版の食い違いはここで止める。
plugin_version="$(plutil -extract version raw -o - "$repo_dir/manifest.json")"
helper_version="$(plutil -extract CFBundleShortVersionString raw -o - "$package_dir/Info.plist")"
if [[ "$plugin_version" != "$helper_version" ]]; then
  echo "version mismatch: manifest.json $plugin_version, Info.plist $helper_version" >&2
  exit 1
fi

# Info.plistはリンカの入力だがSwiftPMの依存関係に含まれない。古い内容が残らないよう、毎回リンクし直させる。
bin_dir="$(swift build --package-path "$package_dir" -c release --show-bin-path)"
rm -f "$bin_dir/MeetingAudioHelper"
# -sectcreateの相対パスを解決するため、パッケージのフォルダで実行する。
(cd "$package_dir" && swift build -c release)

# 署名と確認が済むまで既存の生成物を置き換えない。
staged="$output.tmp"
trap 'rm -f "$staged"' EXIT
cp "$bin_dir/MeetingAudioHelper" "$staged"
codesign --force --sign - --identifier "$signing_identifier" "$staged"
codesign --verify --strict "$staged"
# grep -qが先に終わるとcodesignがSIGPIPEで失敗し、pipefailで誤判定するため、出力を受けてから調べる。
signature="$(codesign -dv "$staged" 2>&1)"
if [[ "$signature" != *$'\nInfo.plist entries='* ]]; then
  echo "Info.plist is not embedded in the helper" >&2
  exit 1
fi
ready="$(printf '{"type":"hello","requestId":"build","protocolVersion":1}\n' | "$staged")"
if [[ "$ready" != *"\"helperVersion\":\"$helper_version\""* ]]; then
  echo "helper did not report version $helper_version: $ready" >&2
  exit 1
fi
mv -f "$staged" "$output"

codesign -dv "$output" 2>&1 | grep -E '^(Identifier|Format|Signature|Info.plist)'
echo "built $output ($helper_version)"
