# 質問と回答（未回答の質問の一覧を含む）

Issue に付いた質問（未決事項・確認依頼）に、利用者が Web で答える。質問は CLI の `nod issue ask` で付き、付けた書き手で出る場所が分かれる。人（書き手 `me`）が付けた未回答の質問は Web の「Open questions」（`/open-questions`）に Issue ごとに並び、エージェント（`me` 以外の書き手。検証の既定の `verify-nod` を含む）が付けた未回答の質問は「Inbox」（`/inbox`）の確認依頼に並ぶ。どちらも Issue の詳細（`/issues/<ID>`）の「未決事項」にも出る。答えると件数が減り、その Issue の質問がすべて決まると一覧から消え、Issue は元の状態（Todo / Backlog）に戻る。回答は CLI の `nod issue show` の `questions` にも残る。

## Sub-features

- `questions-ask-cli` CLI の `issue ask` で質問を付けると、着手前の Issue は Needs Clarification になる。書き手は `--actor` で決まる（`me` か、既定の `verify-nod`）。
- `questions-open-list` `/open-questions` には書き手が `me` の未回答の質問だけが出る（2026-11-25 に確かめた。下の「どこに出るか」）。見出しの件数（`data-testid="open-question-count"`）とサイドバーの「Open questions <件数>」は、その未回答の質問の数。
- `questions-inbox` 書き手が `me` 以外の未回答の質問は `/inbox` の「確認依頼」に出て、`/open-questions` には出ない。サイドバーの「Inbox <件数>」に数えられる。
- `questions-answer-list` `/open-questions` の右の「詳細」の質問のカードで回答を入力して「回答を記録」を押すと、そのカードが消え、件数が1つ減り、「<決定数> / <総数> 決定」が進む。
- `questions-answer-detail` Issue の詳細の「未決事項」で質問の「回答を記録」→ 回答 →「記録する」で答えると、「回答：<回答>」が出て決定数が進む。すべて決まると Issue の「状態」が元の Todo に戻る。
- `questions-list-empty` 人が付けた未回答の質問が無くなると、`/open-questions` は「未回答の未決事項はありません」になり、件数は 0、サイドバーの「Open questions」から件数が消える。
- `questions-answer-inbox` `/inbox` の確認依頼で回答を入力して「回答する」を押すと、確認依頼の一覧から消え、サイドバーが「Inbox 0」になる。
- `questions-cli-show` CLI の `issue show` の `questions` に、回答（`answer`）と回答者（`answeredBy` は Web で答えたので `me`）が残り、`status` が `todo` に戻る。CLI の `questions` は未回答の質問を書き手を問わず数え、`--asked-by me` で人が付けたものに絞る。

**どこに出るか（2026-11-25、run `20261125-221947-da97d` と `20261125-222807-d5037` で確かめた）**: 同じ run で、Todo の Issue に `--actor me` で付けた質問（`askedBy: "me"`）は `/open-questions` の一覧に出て、サイドバーは「Open questions <件数>」、`nod questions --asked-by me` にも出て、`/inbox` と `nod inbox` には出なかった。既定の書き手（`verify-nod`）で付けた質問（`askedBy: "verify-nod"`）は `/inbox` の「確認依頼」と `nod inbox` の `questions` に出て、サイドバーは「Inbox 1」、`/open-questions` の一覧には出なかった。どちらの質問も、付けた Issue の詳細の「未決事項」に出て、`nod questions`（絞り込みなし）には両方が出た（`total` が 2）。したがって、CLI から付けて `/open-questions` で答える経路を通すには `--actor me` で付ける。

## How to get to it (user POV)

- 質問を付ける: 端末で `nod issue ask <ID> <質問>`（エージェントが付ける経路。検証では `$S cli $R [--actor me] -- ...`）。Web では Issue の詳細の「未決事項」の「未決事項を追加」でも付けられる（書き手は `me`）。
- 人が付けた質問に答える: サイドバーの「Open questions」（`/open-questions`）で Issue を選び、右の「詳細」のカードで答える。Issue の詳細（`/issues/<ID>`）の右の欄の「未決事項」でも答えられる。
- エージェントが付けた質問に答える: サイドバーの「Inbox」（`/inbox`）の「確認依頼」で答える（「はい、進めて」「いいえ、既存を残す」の定型の回答もある）。Issue の詳細の「未決事項」でも答えられる。
- 端末で `nod questions`（未回答の一覧）、`nod inbox`（エージェントからの確認依頼）、`nod answer <ID> <回答> --question <質問の id>`（CLI で答える）。

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る。
- run の Issue・質問は0件（`launch` した直後）。

- **CLI で Issue を2つ作り、書き手を変えて質問を付ける。** 次を実行する。

  ```sh
  A=$($S cli $R --evidence questions -- --json issue create "人が質問を付ける Issue" --requested | jq -r .id)
  B=$($S cli $R --evidence questions -- --json issue create "エージェントが質問を付ける Issue" --requested | jq -r .id)
  $S cli $R --actor me --evidence questions -- --json issue ask "$A" "人が付けた質問 1" | jq -c '{askedBy: .question.askedBy, status: .issue.status}'
  $S cli $R --actor me --evidence questions -- --json issue ask "$A" "人が付けた質問 2" | jq -c '{askedBy: .question.askedBy, status: .issue.status}'
  $S cli $R --evidence questions -- --json issue ask "$B" "エージェントが付けた質問" | jq -c '{askedBy: .question.askedBy, status: .issue.status}'
  $S cli $R --evidence questions -- --json questions --asked-by me | jq -c '{total, issues: [.questions[].issueId] | unique}'
  $S cli $R --evidence questions -- --json inbox | jq -c '{issues: [.questions[].issueId]}'
  ```

  質問の3行は `{"askedBy":"me","status":"needs_clarification"}` が2つと `{"askedBy":"verify-nod","status":"needs_clarification"}`。`questions --asked-by me` は `{"total":2,"issues":["<A>"]}`、`inbox` は `{"issues":["<B>"]}`（証拠 `evidence/questions/001-cli.json`〜`007-cli.json`）。
- **Web でどこに出るかを確かめる。** 次の1回の呼び出しで、`/open-questions` と `/inbox` を開く。

  ```sh
  $S browser $R --feature questions <<EOF
  [
    {"goto": "/open-questions"},
    {"expect": {"role": "heading", "level": 1, "name": "Open questions"}},
    {"expect": {"testId": "open-question-count"}, "text": "2"},
    {"expect": {"role": "link", "name": "Open questions 2", "exact": true, "within": {"role": "navigation", "name": "メイン"}}},
    {"expect": {"role": "link", "name": "Inbox 1", "exact": true, "within": {"role": "navigation", "name": "メイン"}}},
    {"expect": {"role": "link", "hasText": "$A", "within": {"role": "region", "name": "未決事項の一覧"}}, "text": "未決 0/2"},
    {"expect": {"role": "link", "hasText": "$B", "within": {"role": "region", "name": "未決事項の一覧"}}, "count": 0},
    {"snapshot": "open-questions"},
    {"screenshot": "open-questions"},
    {"goto": "/inbox"},
    {"expect": {"role": "link", "hasText": "$B", "within": {"role": "region", "name": "確認依頼の一覧"}}, "text": "エージェントが付けた質問"},
    {"expect": {"role": "link", "hasText": "$A", "within": {"role": "region", "name": "確認依頼の一覧"}}, "count": 0},
    {"snapshot": "inbox"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`008-07-open-questions.aria.yml` の `region "未決事項の一覧"` に `$A` の項目だけがあり（`$B` は無い）、`008-12-inbox.aria.yml` の `region "確認依頼の一覧"` に `$B` の項目だけがある。
- **Open questions と Issue の詳細で答える。** 次の1回の呼び出しで、`/open-questions` で1つ目に答え、`$A` の詳細で2つ目に答え、`/open-questions` に戻って一覧が空になったことを確かめる。

  ```sh
  $S browser $R --feature questions <<EOF
  [
    {"goto": "/open-questions"},
    {"expect": {"role": "heading", "level": 2, "name": "人が質問を付ける Issue", "within": {"role": "region", "name": "詳細", "exact": true}}},
    {"expect": {"role": "region", "name": "未決事項", "exact": true, "within": {"role": "region", "name": "詳細", "exact": true}}, "count": 2},
    {"fill": {"role": "textbox", "name": "回答", "exact": true, "within": {"role": "region", "name": "未決事項", "exact": true, "hasText": "人が付けた質問 1", "within": {"role": "region", "name": "詳細", "exact": true}}}, "value": "一覧で答えた回答"},
    {"click": {"role": "button", "name": "回答を記録", "exact": true, "within": {"role": "region", "name": "未決事項", "exact": true, "hasText": "人が付けた質問 1", "within": {"role": "region", "name": "詳細", "exact": true}}}},
    {"expect": {"role": "region", "name": "未決事項", "exact": true, "hasText": "人が付けた質問 1", "within": {"role": "region", "name": "詳細", "exact": true}}, "count": 0},
    {"expect": {"testId": "open-question-count"}, "text": "1"},
    {"expect": {"role": "link", "name": "Open questions 1", "exact": true, "within": {"role": "navigation", "name": "メイン"}}},
    {"expect": {"role": "region", "name": "詳細", "exact": true}, "text": "1 / 2 決定"},
    {"snapshot": "open-questions-answered"},
    {"goto": "/issues/$A"},
    {"expect": {"role": "region", "name": "未決事項", "exact": true}, "text": "1 / 2 決定"},
    {"expect": {"role": "listitem", "hasText": "人が付けた質問 1", "within": {"role": "region", "name": "未決事項", "exact": true}}, "text": "回答：一覧で答えた回答"},
    {"click": {"role": "button", "name": "回答を記録", "exact": true, "within": {"role": "listitem", "hasText": "人が付けた質問 2", "within": {"role": "region", "name": "未決事項", "exact": true}}}},
    {"fill": {"role": "textbox", "name": "回答", "exact": true, "within": {"role": "listitem", "hasText": "人が付けた質問 2", "within": {"role": "region", "name": "未決事項", "exact": true}}}, "value": "詳細で答えた回答"},
    {"click": {"role": "button", "name": "記録する", "exact": true, "within": {"role": "listitem", "hasText": "人が付けた質問 2", "within": {"role": "region", "name": "未決事項", "exact": true}}}},
    {"expect": {"role": "region", "name": "未決事項", "exact": true}, "text": "2 / 2 決定"},
    {"expect": {"role": "listitem", "hasText": "人が付けた質問 2", "within": {"role": "region", "name": "未決事項", "exact": true}}, "text": "回答：詳細で答えた回答"},
    {"expect": {"role": "group", "name": "状態"}, "text": "Todo"},
    {"snapshot": "detail-answered"},
    {"screenshot": "detail-answered"},
    {"goto": "/open-questions"},
    {"expect": {"text": "未回答の未決事項はありません"}},
    {"expect": {"testId": "open-question-count"}, "text": "0"},
    {"expect": {"role": "link", "name": "Open questions", "exact": true, "within": {"role": "navigation", "name": "メイン"}}},
    {"snapshot": "open-questions-empty"},
    {"screenshot": "open-questions-empty"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`009-09-open-questions-answered.aria.yml` に件数 `1` と「1 / 2 決定」、`009-19-detail-answered.aria.yml` に `回答：一覧で答えた回答`・`回答：詳細で答えた回答`・「2 / 2 決定」・`group "状態": Todo`、`009-25-open-questions-empty.aria.yml` に「未回答の未決事項はありません」と `link "Open questions"`（件数なし）がある。
- **Inbox でエージェントの質問に答える。** 次の1回の呼び出しで行う。

  ```sh
  $S browser $R --feature questions <<EOF
  [
    {"goto": "/inbox"},
    {"expect": {"role": "heading", "level": 2, "name": "エージェントが質問を付ける Issue", "within": {"role": "region", "name": "詳細", "exact": true}}},
    {"fill": {"role": "textbox", "name": "回答", "exact": true, "within": {"role": "region", "name": "確認依頼", "exact": true}}, "value": "Inbox で答えた回答"},
    {"click": {"role": "button", "name": "回答する", "exact": true, "within": {"role": "region", "name": "確認依頼", "exact": true}}},
    {"expect": {"role": "link", "hasText": "$B", "within": {"role": "region", "name": "確認依頼の一覧"}}, "count": 0},
    {"expect": {"role": "link", "name": "Inbox 0", "exact": true, "within": {"role": "navigation", "name": "メイン"}}},
    {"snapshot": "inbox-answered"},
    {"screenshot": "inbox-answered"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`010-06-inbox-answered.aria.yml` の `region "確認依頼の一覧"` に `$B` が無く（`tab "確認依頼 0"` と「確認依頼はありません」）、サイドバーが `link "Inbox 0"`。
- **CLI で保存値を読む。** 次を実行する。

  ```sh
  $S cli $R --evidence questions -- --json issue show "$A" | jq -c '{status, questions: [.questions[] | {question, askedBy, answer, answeredBy}]}'
  $S cli $R --evidence questions -- --json issue show "$B" | jq -c '{status, questions: [.questions[] | {question, askedBy, answer, answeredBy}]}'
  $S cli $R --evidence questions -- --json questions | jq -c '{total}'
  ```

  `$A` は `"status":"todo"` と、`人が付けた質問 1`（`askedBy: "me"`、`answer: "一覧で答えた回答"`、`answeredBy: "me"`）・`人が付けた質問 2`（`answer: "詳細で答えた回答"`）。`$B` は `"status":"todo"` と `エージェントが付けた質問`（`askedBy: "verify-nod"`、`answer: "Inbox で答えた回答"`、`answeredBy: "me"`）。`questions` は `{"total":0}`（証拠 `011-cli.json`〜`013-cli.json`）。
- **証明。** `E=$($S doctor $R | jq -r .runDir)/evidence/questions; ls "$E"` に `001`〜`007` の CLI、`008`〜`010` の Web の記録・`.aria.yml`・`.png`、`011`〜`013` の CLI がある。`$S cleanup $R` のあとも `$E` は残る。

## Gotchas

- `/open-questions` に出すには、質問を `--actor me` で付ける。既定の書き手（`verify-nod`）の質問は Inbox に出て、`/open-questions` を開いても見つからない（「どこに出るか」）。
- `/open-questions` の右の「詳細」は、一覧で選んだ Issue（URL の `?selected=<ID>`、無ければ先頭）を出す。Issue が複数あるときは、項目のリンク（`{"role": "link", "hasText": "<ID>", "within": {"role": "region", "name": "未決事項の一覧"}}`）を押してから答える。
- 「詳細」の質問のカードは1つずつ `region "未決事項"`（exact）で、ページの中に同じ名前が複数ある。`hasText` に質問文を入れて絞る。Issue の詳細では「未決事項」は1つで、質問は中の `listitem`。
- 「回答を記録」は、`/open-questions` では入力のあとに押す送信のボタン、Issue の詳細では入力欄を開くボタン（送信は「記録する」）。
- 質問を付けると、着手前の Issue は Needs Clarification になり、すべて答えると元の状態（この手順では Todo）に戻る。作業中（In Progress）の Issue にエージェントが付けると、作業状況が「入力待ち」になる（この手順では扱わない）。
- CLI の `nod answer <ID> <回答>` は `--question` を付けないと、エージェントの未回答の質問にまとめて答える。人が付けた質問に CLI で答えるときは `--question <質問の id>` を付ける。
- 回答の書き手は答えた面で決まる（Web は `me`、CLI は `--actor` の値）。
