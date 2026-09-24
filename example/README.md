# Model Selector Chat Example

`headless_core` の `getAvailableModels({ agent })` と `createHeadlessCore().run()` / `createSession()` を使い、共有設定にある model と `default` を選べる最小チャットUIです。Codex / Claude を選んだ場合は、実行時 option として `reasoningEffort` も選べます。

`Transport` で実行経路を切り替えられます。Codex は `cli` / `app-server`、Devin は `cli` / `acp` を選べるので、`codex app-server` や `devin acp` の永続 session 動作もこのUIから試せます。

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

## Persistent transports

`Transport` の選択肢は agent ごとです。

| agent | transport | 実行方法 |
| --- | --- | --- |
| Codex | `cli` / `app-server` | `codex exec` の1回起動 / `codex app-server` 常駐プロセス上の thread |
| Devin | `cli` / `acp` | `devin --print` の1回起動 / `devin acp` 常駐プロセス上の ACP session |
| その他 | `cli` | 1回起動のみ |

- `cli`: 送信ごとにCLIを起動し、会話 transcript を毎回 prompt として渡します。
- `app-server` / `acp`: `headless.createSession({ agent: { provider, transport, model, reasoningEffort } })` で作った session を agent+transport ごとに server 側で再利用します。session が会話履歴を持つため、2回目以降の送信には最新 user message だけを渡します(新規 session の1ターン目は transcript 全体を渡します)。
- session 使用中に model / reasoningEffort を変えて送信すると `session.setModel()` で切り替わります。devin では family slug (`swe-2`, `claude-opus-5.5`) と effort が runtime の提供する variant uid (`swe-2-high`, `claude-opus-5-5-medium`) に自動で解決され、解決できない model id は session 側の error として表示されます。
- devin では transport によって使える effort が異なります。`cli` は `devin models list` の全 variant (`gpt-6-luna-none` 等) を解決できますが、`acp` は session の `model` config option が提示する subset (`gpt-6-luna-medium` のみ等) に限られ、option 外の値は ACP が拒否します。例: `gpt-6-luna` + `none` は `cli` では動きますが `acp` では `UNSUPPORTED_EFFORT` になります。
- 永続 session の初回 run 後、`session.getAvailableModels()` が返す model id を dropdown に merge します(codex `model/list` / devin acp の session config option)。models.json に無い runtime 側の実際の候補をそのまま試せます。
- `New chat` は browser 側の履歴をクリアし、永続 transport では `session.reset()` で同じ process 上に新しい会話を始めます。status 行に現在の session id (codex thread id / ACP session id) を表示します。
- server を Ctrl+C などで終了すると、開いている session を close して常駐 process も終了します。

## Notes

- UIはmodel idだけを表示します。
- `default` は provider CLI に `--model` を渡さない選択肢です。
- チャット実行は `headless.run({ agent: { provider, model, reasoningEffort }, prompt })` (transport=`cli`) または `session.run({ prompt })` (永続 transport) 経由です。
- `reasoningEffort` の `default` は provider CLI に reasoning effort / effort 系 option を渡さない選択肢です。`none` は reasoning を完全に OFF にする指定で、対応していない model では `UNSUPPORTED_EFFORT` エラーになります(`minimal` への暗黙変換はしません)。
- `reasoningEffort` は全 agent で選択できますが、表現できる値は provider / model ごとに異なります。Agy は `--effort` または effort 埋め込みの variant model id (`gemini-3-8-flash-low` 等)、Devin は variant uid / `thought_level`、Codex は `model_reasoning_effort` に変換されます。非対応の組み合わせは session 側の error として表示されます。永続 transport では codex の turn effort / devin の `thought_level` として渡されます。
- 表示labelやmodel説明はproduct側の責務として持ちません。
- SDK内部ではローカルのAgent CLIを起動します。
- 会話履歴はブラウザ側と永続 session の process 内にだけ保持し、serverには永続保存しません。
