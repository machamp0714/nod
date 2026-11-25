# Issue の状態の変更（詳細と Board）

利用者は Web の Issue の詳細（`/issues/<ID>`）のプロパティの「Status」のメニューで状態を選ぶか、Board（`/issues?layout=board`）でカードを別の列（または「Hidden columns」の行）へドラッグして、Issue の状態を変える。変えた状態は、画面の表示（詳細の「状態」とプロパティの Status、Board の列）にすぐ出て、再読み込みしても同じで、CLI の `nod issue show` の `status` と Activity（書き手は `me`）にも残る。

## Sub-features

- `status-detail-menu` 詳細のプロパティの「Status」を押すとメニュー（`menu "Status を変更"`）が開き、今の状態に印（`aria-checked="true"`）が付いている。別の状態を選ぶとメニューが閉じ、「状態」と Status の値が変わり、Activity に「me がステータスを <前> から <後> に変えた」が出る。
- `status-detail-reload` 詳細を再読み込みしても、選んだ状態のまま。
- `status-board-column` Board でカードを表示中の列（例 In Progress）へドラッグすると、カードがその列に移る。
- `status-board-hidden` Board でカードを「Hidden columns」の行（例 Done）へドラッグすると、その列が現れ、カードが移る。
- `status-board-reload` Board を再読み込みしても、カードは移した列にある。
- `status-cli-show` CLI の `issue show` の `status` が画面で選んだ状態で、`activity` に書き手 `me` の `status_changed`（`from`・`to`）がある。

## How to get to it (user POV)

- Web の Issue の詳細（一覧のタイトルのリンクか、`/issues/<ID>` を直接開く）の右の欄（`region "プロパティ"`）の「Status」のボタン。
- Web のサイドバーの「Issues」（`/issues`）を Board の表示にした画面。この手順は URL `/issues?layout=board` を直接開く（ヘッダーの「表示設定」での切り替えは確かめていない）。既存の e2e（`packages/web/e2e/board-drag-status.e2e.ts`）は、Workspace で絞った `/issues?workspace=<キー>&layout=board` と View・Project の Board（`/views/<ID>?layout=board`、`/projects/<ID>?layout=board`）でも同じドラッグを確かめている（この手順では扱わない）。
- Board の列は状態ごとで、カードの無い状態は「Hidden columns」の行（`region "Hidden columns"` の `listitem`）にまとまる。Triage の Issue は Board に出ない（Triage は `/triage` で扱う）。
- CLI の `nod issue update <ID> -s <状態>` でも変えられる（この機能のファイルは Web の操作を扱い、CLI は読み直しに使う。CLI の書き込みが Web に出ることは [`cli-to-web`](./cli-to-web.md)）。

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る。
- run の Issue は0件（`launch` した直後）。

- **CLI で Todo の Issue を2つ作る。** Board に出すため `--requested` で起票する（既定の Triage は Board に出ない）。`A=$($S cli $R --evidence issue-status -- --json issue create "詳細で状態を変える" --requested | jq -r .id); B=$($S cli $R --evidence issue-status -- --json issue create "Board で状態を変える" --requested | jq -r .id); echo "$A $B"` を実行する。`$A` は `V<5桁>-1`、`$B` は `V<5桁>-2` で、`evidence/issue-status/001-cli.json`・`002-cli.json` の `stdoutJson.status` が `todo`。
- **詳細の Status で変える。** 次の1回の呼び出しで、`$A` の詳細を開き、Status のメニューで In Progress を選び、表示を確かめてから再読み込みする。

  ```sh
  $S browser $R --feature issue-status <<EOF
  [
    {"goto": "/issues/$A"},
    {"expect": {"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}, "attr": {"data-value": "todo"}},
    {"click": {"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}},
    {"expect": {"role": "menuitemradio", "name": "Todo", "exact": true, "within": {"role": "menu", "name": "Status を変更", "exact": true}}, "attr": {"aria-checked": "true"}},
    {"snapshot": "status-menu", "of": {"role": "region", "name": "プロパティ", "exact": true}},
    {"click": {"role": "menuitemradio", "name": "In Progress", "exact": true, "within": {"role": "menu", "name": "Status を変更", "exact": true}}},
    {"expect": {"role": "menu", "name": "Status を変更", "exact": true}, "count": 0},
    {"expect": {"role": "group", "name": "状態"}, "text": "In Progress"},
    {"expect": {"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}, "attr": {"data-value": "in_progress"}, "text": "In Progress"},
    {"expect": {"role": "listitem", "hasText": "me がステータスを Todo から In Progress に変えた", "within": {"role": "region", "name": "Activity", "exact": true}}},
    {"snapshot": "detail"},
    {"screenshot": "detail"},
    {"reload": true},
    {"expect": {"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}, "attr": {"data-value": "in_progress"}},
    {"expect": {"role": "group", "name": "状態"}, "text": "In Progress"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`evidence/issue-status/003-04-status-menu.aria.yml` に `menu "Status を変更"` と `menuitemradio "Todo" [checked]` があり、`003-10-detail.aria.yml` に `group "状態": In Progress`、`button "Status": In Progress`、`listitem: me がステータスを Todo から In Progress に変えた` がある。
- **Board でドラッグして変える。** 次の1回の呼び出しで、Board を開き、`$B` のカードを In Progress の列へ、続けて Hidden columns の Done の行へドラッグし、再読み込みする。In Progress の列は、前の手順で `$A` を In Progress にしたので表示されている。

  ```sh
  $S browser $R --feature issue-status <<EOF
  [
    {"goto": "/issues?layout=board"},
    {"expect": {"role": "article", "hasText": "$B", "within": {"role": "region", "name": "Todo", "exact": true}}},
    {"expect": {"role": "article", "hasText": "$A", "within": {"role": "region", "name": "In Progress", "exact": true}}},
    {"snapshot": "board-before"},
    {"drag": {"role": "article", "hasText": "$B"}, "to": {"role": "region", "name": "In Progress", "exact": true}},
    {"expect": {"role": "article", "hasText": "$B", "within": {"role": "region", "name": "In Progress", "exact": true}}},
    {"expect": {"role": "article", "hasText": "$B", "within": {"role": "region", "name": "Todo", "exact": true}}, "count": 0},
    {"snapshot": "board-in-progress"},
    {"screenshot": "board-in-progress"},
    {"drag": {"role": "article", "hasText": "$B"}, "to": {"role": "listitem", "hasText": "Done", "within": {"role": "region", "name": "Hidden columns", "exact": true}}},
    {"expect": {"role": "article", "hasText": "$B", "within": {"role": "region", "name": "Done", "exact": true}}},
    {"reload": true},
    {"expect": {"role": "article", "hasText": "$B", "within": {"role": "region", "name": "Done", "exact": true}}},
    {"expect": {"role": "article", "hasText": "$A", "within": {"role": "region", "name": "In Progress", "exact": true}}},
    {"snapshot": "board-reload"},
    {"screenshot": "board-reload"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`004-03-board-before.aria.yml` で `$B` のカード（`article`）が `region "Todo"` に、`004-07-board-in-progress.aria.yml` で `region "In Progress"` に、`004-14-board-reload.aria.yml` で `region "Done"` にある。
- **CLI で保存値を読む。** `$S cli $R --evidence issue-status -- --json issue show "$A" | jq -c '{status, changes: [.activity[] | select(.type == "status_changed") | {actor, data}]}'` と、同じコマンドの `"$B"` を実行する。`$A` は `"status":"in_progress"` と `{"actor":"me","data":{"from":"todo","to":"in_progress"}}`、`$B` は `"status":"done"` と、`me` の `todo`→`in_progress`、`in_progress`→`done` の2件が出る（証拠 `005-cli.json`・`006-cli.json`）。
- **証明。** `E=$($S doctor $R | jq -r .runDir)/evidence/issue-status; ls "$E"` に、起票（`001`・`002`）、詳細の操作（`003-*`）、Board の操作（`004-*`）、読み直し（`005`・`006`）がある。`$S cleanup $R` のあとも `$E` は残る。

## Gotchas

- Triage の Issue は Board に出ない。Board で確かめる Issue は `--requested`（Todo）で起票するか、先に詳細で Triage 以外にする。
- Board の列はカードのある状態だけが表示され、空の状態は「Hidden columns」の行になる。空の列（`region "In Progress"` など）へはドラッグできないので、行（`listitem` の `hasText` に状態の名前）へ落とす。行の accessible name は説明文（例「作業中・進み具合を確認」）なので、`name` ではなく `hasText` で絞る。
- カード（`article`）の `hasText` は部分一致。Issue が10件以上ある run では `V…-1` が `V…-10` にも当たる。
- 保存されないドロップがある（同じ列への落とし、Needs Clarification の行、遷移ルールで禁止した移動など。既存の e2e による）。遷移ルールで拒まれるとカードは元の列に残り、`alert` が出る。この手順の Todo → In Progress → Done は、run の既定の設定で通る。
- メニューの Needs Clarification は選べない（未決事項の有無で決まる状態。[`questions`](./questions.md)）。
- Web で変えた書き手は `me` で、CLI の既定の書き手（`verify-nod`）と区別できる。
- 再読み込みの前後の比較は、同じ1回の `browser` の呼び出しの中で `reload` を使う（呼び出しをまたぐとページは新しくなる）。
