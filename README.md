# L-Meetscribe

Obsidianのノートに置いた`lms`ブロックから会議を録音し、手元のMacで文字起こしするプラグイン。録音を止めると、OpenAI APIまたは同じMacのOllamaで要約する。

- マイク（自分）と再生音（相手）を別々に録音し、話者を「自分」「相手」で分ける。
- 文字起こしは[whisper.cpp](https://github.com/ggml-org/whisper.cpp)でローカルに行う。音声は外部へ送らず、文字起こしが終われば削除する。
- ノートには、上から「要約」「文字起こし」「`lms`ブロック」の順に書く。手で編集した部分は上書きしない。

> [!WARNING]
> 試作段階です。テスト及び検証を行っていますがバグやエラーなどがある可能性もあります。

## 動作条件

- Apple SiliconのMac、macOS 14.2以降
- Obsidianデスクトップ版 1.11.4以降（ローカルのVault）
- [Homebrew](https://brew.sh)
- Node.js 24以降（`brew install node`）
- Xcode Command Line Tools（`xcode-select --install`）

## セットアップ

```sh
git clone https://github.com/naga-T28/obsidian-l-meetscribe.git
cd obsidian-l-meetscribe

# Obsidianを終了してから実行する
scripts/setup.sh "/path/to/your/Vault"
```

`scripts/setup.sh`は次の処理をまとめて行います。

1. whisper.cppを入れる（`brew install whisper-cpp`）。
2. Whisperモデル`ggml-large-v3-turbo`（約1.6GB）を`~/whisper-models`へダウンロードする。
3. プラグインと録音ヘルパーをビルドし、Vaultの`.obsidian/plugins/l-meetscribe/`へ置く。
4. プラグインの設定に、Whisperの実行ファイル・モデルフォルダ・使用モデルを書き込む。

終わったらObsidianを起動し、「設定 → コミュニティプラグイン」で制限モードをオフにして「L Meetscribe」を有効にします。

オプションは`scripts/setup.sh --help`で確認できます。

<details>
<summary>手動でセットアップする場合</summary>

```sh
brew install whisper-cpp
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin

npm ci
npm run build
npm run build:native

plugin_dir="/path/to/your/Vault/.obsidian/plugins/l-meetscribe"
mkdir -p "$plugin_dir"
cp main.js manifest.json styles.css "$plugin_dir/"
install -m 755 lms-audio-helper "$plugin_dir/lms-audio-helper"
```

プラグインを有効にした後、「設定 → L Meetscribe」で「実行ファイル」（`/opt/homebrew/bin/whisper-cli`）と「モデルフォルダ」（`~/whisper-models`を展開した絶対パス）を入力します。

</details>

## 使い方

ノートに空の`lms`ブロックを書きます。

````markdown
```lms
```
````

1. ブロックに表示される「録音開始」を押します。初回は、マイクとシステムオーディオの録音の許可を求められます。
2. 録音中は、ブロックの上に文字起こしが追記されていきます。ノートを閉じても録音は続き、ステータスバーから停止できます。
3. 「録音停止」を押すと、残りの文字起こしを終えて要約します。文字起こしに失敗した部分は除外して完了します。

出力の上下にある`<!-- lms:... -->`の行は、プラグインが書き込み先を探す目印です。消さないでください。

## Whisperモデルの変更

既定のモデルは`ggml-large-v3-turbo`です。日本語に使える多言語モデルで、精度と速度の釣り合いがよいモデルです。

**スクリプトで変える（推奨）:** `--model`にモデル名を渡すと、ダウンロードと設定の変更を行います。

```sh
scripts/setup.sh "/path/to/your/Vault" --model ggml-large-v3   # 高精度・低速（約3GB）
scripts/setup.sh "/path/to/your/Vault" --model ggml-base       # 低精度・高速（約150MB）
```

- モデル名は[ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main)にある`ggml-*.bin`から選びます。`.bin`は省略できます。
- モデルを置くフォルダは`--model-dir <パス>`で変えられます（既定は`~/whisper-models`）。
- 日本語の会議では、名前に`.en`が付くモデル（英語専用）は使えません。

**設定画面で変える:** モデルフォルダに置いてあるモデルなら、「設定 → L Meetscribe → 使用モデル」から選べます。新しく置いたモデルが出ない場合は、横の再読み込みボタンを押します。

変更は、次に録音を開始した会議から使われます。

## 要約の設定

「設定 → L Meetscribe」の「実行先」でOpenAIかOllamaを選びます。選んだ実行先が使えない場合は、要約を省略します。別の実行先へは自動で切り替えません。

- **OpenAI:** 「APIキー」でキーを登録します（ObsidianのSecretStorageに保存され、設定ファイルやノートには書かれません）。「モデル」と「コンテキスト長・出力予約トークン数」も入力してください。要約のために、文字起こしの本文がOpenAIへ送られます。
- **Ollama:** 同じMacでOllamaを起動してモデルを取得し（例: `ollama pull gemma4:e4b`）、「モデル」で選びます。文字起こしはMacの外へ出ません。


## うまく動かないとき

| 症状 | 対処 |
| --- | --- |
| 「録音ヘルパー…実行ファイルが見つからないか、実行できません」 | ヘルパーの実行権限が外れています（iCloud DriveのVaultやFinderでのコピーで起きます）。`scripts/setup.sh`を実行し直すか、`chmod 755 <Vault>/.obsidian/plugins/l-meetscribe/lms-audio-helper`を実行します |
| 相手の声が入らない | 「システム設定 → プライバシーとセキュリティ」で、Obsidianのシステムオーディオ録音を許可し、Obsidianを再起動します |
| 要約されない | 会議ブロックに理由が表示されます。APIキー・モデルの設定や、Ollamaが起動しているかを確かめます |
| 書き込みが止まった | ノートの`<!-- lms:... -->`の行が消えたり重複したりしていないか確かめ、元に戻して「再試行」を押します |

## 更新

```sh
git pull
scripts/setup.sh "/path/to/your/Vault"
```

Obsidianを終了してから実行してください。設定済みの使用モデルや要約の設定は変わりません。

## 開発

```sh
npm ci
npm run typecheck   # 型検査
npm run lint        # 静的検査
npm test            # 単体テスト
npm run build       # main.js を生成
npm run build:native   # 録音ヘルパー lms-audio-helper を生成
scripts/test-native.sh # 録音ヘルパーの単体テスト
```

- 音声・APIキー・実際の会議の内容は、テストデータやコミットに含めないでください。

## ライセンス

[MIT](LICENSE)
