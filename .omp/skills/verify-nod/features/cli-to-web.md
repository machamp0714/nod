# CLI の書き込みの Web への反映

利用者（多くは LLM のエージェント）が CLI の `nod` で書き込むと、開いたままの Web の画面が、再読み込みしなくても新しい内容に変わる。CLI は server を通らずに同じ DB に書き、server はほかの接続の書き込みを約1秒ごとに検知して、Web に変更の通知（SSE の `change`）を送る。Web は通知を受けると表示中のデータを読み直す。

## Sub-features

- `cli-web-list` `/issues` を開いたまま CLI で起票すると、再読み込みなしで一覧に行が増え、絞り込みのタブの件数（`All <件数>`）が増える。
- `cli-web-detail` `/issues/<ID>` を開いたまま CLI でタイトルと状態を変えると、再読み込みなしで見出しと「状態」が変わる。
- `cli-web-activity` 詳細を開いたまま CLI でコメントを書くと、再読み込みなしで Activity に出る。
- `cli-web-events` Web の変更通知の接続の状態（`<html data-server-events>`）が `ready` になってから書き、反映を待つ。

## How to get to it (user POV)

- 端末で `nod issue create`・`nod issue update`・`nod issue comment` など、書き込む CLI のコマンドを実行する（検証では `$S cli $R -- ...`、ページを開いたままなら `browser` の `cli` の手順）。
- Web のどの画面でも、開いている間は変更の通知を受ける（サイドバーの件数、一覧、詳細、Board など）。この機能のファイルは Issues の一覧（`/issues`）と Issue の詳細（`/issues/<ID>`）で確かめる。
- 利用者が操作することは無い（再読み込みやボタンは要らない）。Web の自分の書き込みは通知を経ずに画面に出るので、この機能の証明にならない。

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る。
- run の Issue は0件（`launch` した直後）。

- **CLI で1件起票しておく。** `ID=$($S cli $R --evidence cli-to-web -- --json issue create "先に起票した Issue" -d "Web を開く前に CLI で起票" | jq -r .id); echo "$ID"` を実行する。`$ID` は `V<5桁>-1`（証拠 `evidence/cli-to-web/001-cli.json`）。
- **Web を開いたまま CLI で書き、再読み込みせずに画面の変化を待つ。** 次の1回の呼び出しで行う。ページの読み込みは最初の `goto` と詳細への `goto` の2回だけで、`reload` は使わない。CLI は `cli` の手順で、同じ run の許可リストの環境のソースの CLI を実行する（書き手は `verify-nod`）。

  ```sh
  $S browser $R --feature cli-to-web <<EOF
  [
    {"goto": "/issues"},
    {"events": "ready"},
    {"expect": {"role": "tab", "name": "All 1", "exact": true, "within": {"role": "tablist", "name": "絞り込み"}}},
    {"snapshot": "list-before"},
    {"cli": ["--json", "issue", "create", "Web を開いたまま起票した Issue", "-d", "変更の通知で一覧に出る"]},
    {"expect": {"role": "row", "name": "Web を開いたまま起票した Issue"}, "text": "Triage"},
    {"expect": {"role": "tab", "name": "All 2", "exact": true, "within": {"role": "tablist", "name": "絞り込み"}}},
    {"snapshot": "list-after"},
    {"screenshot": "list-after"},
    {"goto": "/issues/$ID"},
    {"events": "ready"},
    {"expect": {"role": "heading", "level": 1, "name": "先に起票した Issue"}},
    {"expect": {"role": "group", "name": "状態"}, "text": "Triage"},
    {"cli": ["--json", "issue", "update", "$ID", "-s", "todo", "--title", "CLI で変えたタイトル"]},
    {"expect": {"role": "heading", "level": 1, "name": "CLI で変えたタイトル"}},
    {"expect": {"role": "group", "name": "状態"}, "text": "Todo"},
    {"cli": ["--json", "issue", "comment", "$ID", "CLI から書いたコメント"]},
    {"expect": {"role": "region", "name": "Activity", "exact": true}, "text": "CLI から書いたコメント"},
    {"snapshot": "detail-after"},
    {"screenshot": "detail-after"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`evidence/cli-to-web/` に、`cli` の手順の記録 `002-04-cli.json`・`002-13-cli.json`・`002-16-cli.json`（コマンド・標準出力・終了コード 0。書き手 `verify-nod`）、一覧の前後 `002-03-list-before.aria.yml`（`tab "All 1"`）と `002-07-list-after.aria.yml`（`tab "All 2"`、新しい行）、詳細 `002-18-detail-after.aria.yml`（`heading "CLI で変えたタイトル"`、`group "状態": Todo`、Activity のコメント）が残る。
- **再読み込みしていないことを記録で確かめる。** `E=$($S doctor $R | jq -r .runDir)/evidence/cli-to-web; jq -c '[.steps[] | {index, op: (.step | keys - ["note"] | .[0]), loads, ms}]' "$E/002-browser.json"` を実行する。`loads`（文書の読み込みの回数）は手順 0〜8 で `1`、手順 9〜19 で `2` で、`cli` の手順の前後で変わらない。`cli` の直後の `expect` の `ms` は数秒以内（2026-11-25 の実測で 0.3〜1.3 秒。変更の検知が約1秒ごとのため）。
- **CLI で保存値を読む。** `$S cli $R --evidence cli-to-web -- --json issue show "$ID" | jq -c '{title, status, comments: [.activity[] | select(.kind == "comment") | .body]}'` が `{"title":"CLI で変えたタイトル","status":"todo","comments":["CLI から書いたコメント"]}` を出す（証拠 `003-cli.json`）。
- **証明。** `ls "$E"` に、起票（`001-cli.json`）、操作の記録（`002-browser.json`、`002-NN-cli.json`、`.aria.yml`、`.png`）、読み直し（`003-cli.json`）がある。`$S cleanup $R` のあとも `$E` は残る。

## Gotchas

- 書く前に `{"events": "ready"}` を通す。接続の直後にも Web は読み直すので、接続の前に書くと、変更の通知ではなく接続時の読み直しで出たのと区別できない。
- 変更の検知は約1秒ごと。`expect` の待ち時間（既定 10 秒）の中で出る。固定の時間で待たない。
- `reload`・`goto` を `cli` と `expect` の間に挟まない。挟むと再読み込みで出たのと区別できない（記録の `loads` が増える）。
- 別のシェルから `$S cli` で書いても反映するが、そのとき `browser` の呼び出しは終わっていて、ページは残っていない。ページを開いたまま書くには `cli` の手順を使う。
- `cli` の手順は CLI の終了コードが 0 でなければ失敗にする。値の展開のためヒアドキュメントの区切りは引用せず（`<<EOF`）、引数に `"` や `\` を入れない。
- Web からの書き込み（Status のメニューなど）は、その場で画面を読み直すので、この機能の証明に使わない。
