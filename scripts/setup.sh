#!/bin/bash
# whisper.cppとモデルの準備、プラグインのビルド、Vaultへの配置、Whisper設定の書き込みをまとめて行う。
# 使い方は README.md の「セットアップ」と、--help の表示にある。
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
plugin_id="l-meetscribe"
# 既定のモデルはプラグインの初期値（src/settings/settings.ts の DEFAULT_WHISPER_MODEL）とそろえる。
default_model="ggml-large-v3-turbo.bin"
model_base_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

usage() {
  cat <<'EOF'
使い方: scripts/setup.sh <Vaultのフォルダ> [オプション]

  --model <名前>       使うWhisperモデル（既定: ggml-large-v3-turbo）。例: ggml-large-v3, ggml-base
  --model-dir <パス>   モデルを置くフォルダ（既定: ~/whisper-models）
  -h, --help           この説明を表示する

Obsidianを終了してから実行してください。プラグインが動いていると、書き込んだ設定が上書きされます。
EOF
}

fail() {
  echo "エラー: $*" >&2
  exit 1
}

vault=""
model=""
model_dir="$HOME/whisper-models"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) [[ $# -ge 2 ]] || fail "--model に名前を指定してください。"; model="$2"; shift 2 ;;
    --model-dir) [[ $# -ge 2 ]] || fail "--model-dir にパスを指定してください。"; model_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; fail "不明なオプションです: $1" ;;
    *) [[ -z "$vault" ]] || fail "Vaultのフォルダは1つだけ指定してください。"; vault="$1"; shift ;;
  esac
done
[[ -n "$vault" ]] || { usage >&2; exit 1; }

# --model を省略した場合は、既存の設定のモデルを変えない。
model_explicit=false
if [[ -n "$model" ]]; then
  model_explicit=true
else
  model="$default_model"
fi
# 「large-v3-turbo」「ggml-large-v3-turbo」「ggml-large-v3-turbo.bin」のどれでも受け付ける。
model="${model%.bin}"
model="ggml-${model#ggml-}.bin"
[[ "$model" =~ ^ggml-[A-Za-z0-9._-]+\.bin$ ]] || fail "モデル名に使えない文字が含まれています: $model"

echo "==> 動作環境を確認しています"
[[ "$(uname -s)" == "Darwin" ]] || fail "macOSでのみ動作します。"
[[ "$(uname -m)" == "arm64" ]] || fail "Apple Silicon（arm64）のMacでのみ動作します。"
macos_version="$(sw_vers -productVersion)"
IFS=. read -r major minor _ <<<"$macos_version.0"
if (( major < 14 || (major == 14 && minor < 2) )); then
  fail "macOS 14.2以降が必要です（現在: ${macos_version}）。"
fi
command -v brew >/dev/null || fail "Homebrewが見つかりません。https://brew.sh の手順で導入してから、もう一度実行してください。"
command -v node >/dev/null || fail "Node.jsが見つかりません。Node.js 24以降を導入してください（例: brew install node）。"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 24 )) || fail "Node.js 24以降が必要です（現在: $(node --version)）。"
xcrun -f swift >/dev/null 2>&1 || fail "Swiftが見つかりません。xcode-select --install でCommand Line Toolsを導入してください。"
vault="$(cd "$vault" 2>/dev/null && pwd)" || fail "Vaultのフォルダが見つかりません。"
[[ -d "$vault/.obsidian" ]] || fail "$vault にObsidianの設定フォルダ（.obsidian）がありません。Obsidianで一度開いたVaultを指定してください。"
if pgrep -xq Obsidian; then
  echo "注意: Obsidianが起動しています。終了してから実行しないと、書き込んだ設定がプラグインに上書きされることがあります。" >&2
fi

echo "==> whisper.cppを準備しています"
whisper_cli="$(brew --prefix)/bin/whisper-cli"
if [[ ! -x "$whisper_cli" ]]; then
  brew install whisper-cpp
fi
[[ -x "$whisper_cli" ]] || fail "whisper-cliが見つかりません: $whisper_cli"
echo "    $whisper_cli"

echo "==> Whisperモデル（${model}）を準備しています"
mkdir -p "$model_dir"
model_dir="$(cd "$model_dir" && pwd)"
model_path="$model_dir/$model"
# whisper.cppのモデルファイルは先頭が「lmgg」（GGML_FILE_MAGIC）。プラグインも同じ確認をする。
is_ggml() { [[ "$(head -c 4 "$1" 2>/dev/null)" == "lmgg" ]]; }
if [[ -f "$model_path" ]] && is_ggml "$model_path"; then
  echo "    取得済み: $model_path"
else
  partial="$model_path.part"
  trap 'rm -f "$partial"' EXIT
  echo "    $model_base_url/$model から取得します（large-v3-turboは約1.6GB）"
  curl -fL --retry 3 --progress-bar -o "$partial" "$model_base_url/$model" || fail "モデルを取得できません。モデル名を確認してください: $model"
  is_ggml "$partial" || fail "取得したファイルがwhisper.cppのモデルではありません: $model"
  mv -f "$partial" "$model_path"
  trap - EXIT
  echo "    保存しました: $model_path"
fi

echo "==> プラグインをビルドしています"
(cd "$repo_dir" && npm ci && npm run build && npm run build:native)

echo "==> Vaultへ配置しています"
plugin_dir="$vault/.obsidian/plugins/$plugin_id"
mkdir -p "$plugin_dir"
cp "$repo_dir/main.js" "$repo_dir/manifest.json" "$repo_dir/styles.css" "$plugin_dir/"
# 実行権限が外れると録音を開始できないため、installで権限を付けて置く。
install -m 755 "$repo_dir/lms-audio-helper" "$plugin_dir/lms-audio-helper"
echo "    $plugin_dir"

echo "==> Whisperの設定を書き込んでいます"
# 他の設定は変えない。値は引数で渡し、コードへ連結しない。
node - "$plugin_dir/data.json" "$whisper_cli" "$model_dir" "$model" "$model_explicit" <<'EOF'
const fs = require('fs');
const [file, executablePath, modelDir, model, modelExplicit] = process.argv.slice(2);
let data = {};
if (fs.existsSync(file)) {
	data = JSON.parse(fs.readFileSync(file, 'utf8'));
}
const whisper = typeof data.whisper === 'object' && data.whisper !== null ? data.whisper : {};
whisper.executablePath = executablePath;
whisper.modelDir = modelDir;
if (modelExplicit === 'true' || !whisper.model) {
	whisper.model = model;
}
data.whisper = whisper;
const temp = `${file}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
fs.renameSync(temp, file);
console.log(`    実行ファイル: ${whisper.executablePath}`);
console.log(`    モデルフォルダ: ${whisper.modelDir}`);
console.log(`    使用モデル: ${whisper.model}`);
EOF

cat <<EOF

完了しました。次の手順でプラグインを有効にしてください。
  1. Obsidianで「$(basename "$vault")」を開く。
  2. 設定 → コミュニティプラグイン で制限モードをオフにし、「L Meetscribe」を有効にする。
  3. ノートに空の lms ブロックを書き、「録音開始」を押す。初回はマイクとシステム音声の録音の許可を求められる。
要約を使う場合は、設定 → L Meetscribe でOpenAIかOllamaを設定してください（README.md の「要約の設定」）。
EOF
