# Model Selector Chat Example

`headless_core` の `getAvailableModels({ agent })` と `createHeadlessCore().run()` を使い、共有設定にある model と `default` を選べる最小チャットUIです。Codex / Claude を選んだ場合は、実行時 option として `reasoningEffort` も選べます。

## Run

```sh
npm run example
```

Open:

```txt
http://127.0.0.1:4173
```

`PORT` / `HOST` 環境変数で変更できます。ポートが使用中の場合は自動で次のポートを試します(最大20ポート)。

## Setup

共有設定がない場合は先に作成します。

```sh
npm run build
HEADLESS_CORE_MODELS_PATH=./example/models.json node dist/cli.js models init
node dist/cli.js models inspect > ./example/models.json
```

GUIの `Models source` で `./example/models.json` (Local) と `~/.config/headless-core/models.json` (Shared) を切り替えられます。`HEADLESS_CORE_MODELS_PATH` を指定した場合、そのpathがLocal側として使われます。

UI上でも `Run inspect` を押すと、同じ `headless-core models inspect` 相当の stdout / stderr を確認できます。これは検証用で、`example/models.json` は更新しません。

手元でまずUIだけ確認したい場合は、サンプルをコピーして使えます。

```sh
cp example/models.sample.json example/models.json
npm run example
```

## Notes

- UIはmodel idだけを表示します。
- `default` は provider CLI に `--model` を渡さない選択肢です。
- チャット実行は `headless.run({ agent: { provider, model, reasoningEffort }, prompt })` 経由です。
- `reasoningEffort` の `default` は provider CLI に reasoning effort / effort 系 option を渡さない選択肢です。
- `reasoningEffort` はこのexampleではCodex / Claude実行時だけ有効です。
- 表示labelやmodel説明はproduct側の責務として持ちません。
- SDK内部ではローカルのAgent CLIを起動します。
- 会話履歴はブラウザ側だけに保持し、serverには永続保存しません。
