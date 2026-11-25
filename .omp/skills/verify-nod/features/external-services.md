# 外部サービスに依る機能（到達できない範囲）

nod のいくつかの機能は外部のサービスを使う。仕様要否判定（Typesafe の API）、GitHub（`gh` での PR の状態・差分の取得、GitHub Issue の作成・紐付け）、Toggl（打刻）、Orca（worktree を作って Omp のセッションを起動する、端末への送信、通知）。verify-nod の run はこれらをすべて切ってあるので、**どれも成功の経路には到達できない**。成功したと報告しない。確かめてよいのは、未設定・無効のときに利用者に見える表示と、外に出ずに失敗することだけで、この機能のファイルはその手順を書く。

## Sub-features

- `ext-spec-assessment` 仕様要否判定。成功（判定の確率や「仕様が要る」の結果）は到達できない。確かめられるのは、Workspace の自動判定が無効のときの「対象外（未判定）」、`issue assess` の拒否、自動判定を有効にしたときの「判定失敗：APIキーが未設定です」（`failureKind: "missing_key"`）。
- `ext-github-pr` GitHub の PR の状態。取得の成功（レビュー・CI・マージの状態）は到達できない。確かめられるのは、PR の URL を記録した Issue の詳細の「PR 状態」の「未取得」と、「PR の状態を更新」（server の経路）・`issue pr-status --refresh`（CLI の経路）がどちらも「gh が見つかりません」で失敗すること。
- `ext-github-issue` GitHub Issue の作成（`issue publish`）・紐付け（`issue link-github`、詳細の GitHub の「紐付ける」）・取り込み（`import`）。到達できない。外部への書き込みの経路なので、この手順では実行しない。
- `ext-toggl` Toggl の打刻。到達できない。確かめられるのは、Issue の詳細の「Toggl 打刻」の「未設定」、無効の「打刻を開始」、トークンを書くファイルとして run の `config/toggl.json` が案内されること。
- `ext-orca` Orca の連携。到達できない。確かめられるのは、Issue の詳細の「Omp で作業を始める」→「作成して起動」が「作成できませんでした：Orca との連携が無効です（NOD_ORCA=0）」で失敗し、worktree もブランチも記録されないこと。

## How to get to it (user POV)

- 仕様要否判定: CLI の `nod issue create`（自動判定が有効な Workspace で起票すると判定する）、`nod issue assess <ID>`、`nod workspace spec-assessment show|set on|off`。Web の Issue の詳細の「仕様要否判定」の欄（`region "仕様要否判定"`、「判定を再試行」）、Workspace の設定（`/workspaces/<キー>/settings`）。
- GitHub: CLI の `nod issue link-pr <ID> <URL>`（作業中の Issue に PR の URL を記録する。外には出ない）、`nod issue pr-status <ID> [--refresh]`、`nod issue pr-diff`、`nod issue publish`、`nod issue link-github`、`nod import`、`nod workspace github`。Web の Issue の詳細のプロパティの「GitHub」「PR」と「PR 状態」の「PR の状態を更新」。
- Toggl: Web の Issue の詳細の右の欄の「Toggl 打刻」（`region "Toggl 打刻"`）。
- Orca: Web の Issue の詳細のプロパティの「実行場所」の「Omp で作業を始める」。CLI の `nod issue send-instruction`、`nod sprint` の実行の系統。

到達できない理由（run の隔離。`../SKILL.md` の「環境変数（許可リスト）」）と、成功の経路に要るもの:

| 機能 | この run で切っているもの | 成功の経路に要るもの（run には無い） |
| --- | --- | --- |
| 仕様要否判定 | `TYPESAFE_API_KEY` を空文字で渡す（`~/.config/nod/env` も読まない）。run の Workspace は自動判定が無効で始まる | Typesafe の API キーと、API への接続 |
| GitHub | server の `PATH` は `/usr/bin:/bin` で `gh` が見つからない。CLI の `NOD_GH` は run の `config/gh-unavailable`（無いファイル） | 実行できる `gh` と、その認証、GitHub への接続 |
| Toggl | `NOD_TOGGL_CONFIG` は run の `config/toggl.json`（作らない。トークンなし） | Toggl の API トークンと、API への接続 |
| Orca | `NOD_ORCA=0` | 動いている Orca と `orca` の CLI |
| ブラウザから外へ | `browser` は run の origin 以外への要求をすべて止める（記録の `blocked`） | — |

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る（`pid-env` が、上の表の変数を含む許可リストの11項目だけであることを確かめている）。
- run の Issue は0件（`launch` した直後）。
- 外部のサイトを開かない。PR の URL は記録用の例（`https://github.com/example/verify-nod/pull/1`）で、リンクを押さない。

- **自動判定が無効のまま、仕様要否判定の表示と CLI の拒否を確かめる。** run の Workspace は自動判定が無効で始まる。表示は今の設定で決まるので、有効にする前に確かめる。次を実行する。

  ```sh
  RUN=$($S doctor $R | jq -r .runDir)
  A=$($S cli $R --evidence external-services -- --json issue create "自動判定が無効な Workspace の Issue" | jq -r .id)
  $S cli $R --evidence external-services -- --json issue assess "$A"; echo "exit=$?"
  $S browser $R --feature external-services <<EOF
  [
    {"goto": "/issues/$A"},
    {"expect": {"role": "region", "name": "仕様要否判定", "exact": true}, "text": "対象外（未判定）"},
    {"expect": {"role": "region", "name": "仕様要否判定", "exact": true}, "text": "Workspace の自動判定は無効です。"},
    {"snapshot": "spec-disabled", "of": {"role": "region", "name": "仕様要否判定", "exact": true}}
  ]
  EOF
  ```

  `issue assess "$A"` は `{"error":{"code":"INVALID_ARGS","message":"Workspace の自動仕様判定は無効です"}}` と `exit=1`（証拠 `evidence/external-services/001-cli.json`・`002-cli.json`）。`browser` は `"ok": true` で、`003-03-spec-disabled.aria.yml` に「対象外（未判定）」と「Workspace の自動判定は無効です。」がある。
- **CLI で判定を有効にし、PR の URL を記録する。** 次を実行する。

  ```sh
  $S cli $R --evidence external-services -- --json workspace spec-assessment set on | jq -c .
  B=$($S cli $R --evidence external-services -- --json issue create "自動判定が有効な Workspace の Issue" | jq -r .id)
  $S cli $R --evidence external-services -- --json issue show "$B" | jq -c '.specAssessment | {status, failureKind, elapsedMs}'
  C=$($S cli $R --evidence external-services -- --json issue create "PR を記録する Issue" --requested | jq -r .id)
  $S cli $R --evidence external-services -- --json issue update "$C" -s in_progress | jq -c '{status}'
  $S cli $R --evidence external-services -- --json issue link-pr "$C" https://github.com/example/verify-nod/pull/1 | jq -c '{prUrl, status}'
  echo "$A $B $C"
  ```

  `spec-assessment set on` は `"enabled":true`。`$B` の `specAssessment` は `{"status":"failed","failureKind":"missing_key","elapsedMs":0}`（API を呼ばずに失敗した）。`$C` は `in_progress` で、`prUrl` が記録される（証拠 `004-cli.json`〜`009-cli.json`）。
- **Web で未設定・無効の表示と失敗を確かめる。** 次の1回の呼び出しで、`$B`・`$C` の詳細を開き、仕様要否判定、PR、Toggl、Orca を確かめる。

  ```sh
  $S browser $R --feature external-services <<EOF
  [
    {"goto": "/issues/$B"},
    {"expect": {"role": "region", "name": "仕様要否判定", "exact": true}, "text": "判定失敗：APIキーが未設定です"},
    {"expect": {"text": "過去の判定記録", "within": {"role": "region", "name": "仕様要否判定", "exact": true}}, "count": 0},
    {"click": {"role": "button", "name": "判定を再試行", "exact": true}},
    {"expect": {"role": "region", "name": "仕様要否判定", "exact": true}, "text": "過去の判定記録（1件）"},
    {"expect": {"role": "region", "name": "仕様要否判定", "exact": true}, "text": "判定失敗：APIキーが未設定です"},
    {"snapshot": "spec-missing-key", "of": {"role": "region", "name": "仕様要否判定", "exact": true}},
    {"goto": "/issues/$C"},
    {"expect": {"role": "link", "name": "#1", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}, "attr": {"href": "https://github.com/example/verify-nod/pull/1"}},
    {"expect": {"role": "group", "name": "PR 状態", "exact": true}, "text": "未取得"},
    {"click": {"role": "button", "name": "PR の状態を更新", "exact": true}},
    {"expect": {"role": "alert", "within": {"role": "group", "name": "PR 状態", "exact": true}}, "text": "gh が見つかりません。GitHub CLI を導入してください"},
    {"snapshot": "pr-status", "of": {"role": "region", "name": "プロパティ", "exact": true}},
    {"expect": {"role": "region", "name": "Toggl 打刻", "exact": true}, "text": "未設定"},
    {"expect": {"role": "region", "name": "Toggl 打刻", "exact": true}, "text": "$RUN/config/toggl.json"},
    {"expect": {"role": "button", "name": "打刻を開始", "exact": true}, "disabled": true},
    {"snapshot": "toggl", "of": {"role": "region", "name": "Toggl 打刻", "exact": true}},
    {"click": {"role": "button", "name": "Omp で作業を始める", "exact": true}},
    {"click": {"role": "button", "name": "作成して起動", "exact": true, "within": {"role": "dialog", "name": "Omp で作業を始める"}}},
    {"expect": {"role": "alert", "within": {"role": "dialog", "name": "Omp で作業を始める"}}, "text": "作成できませんでした：Orca との連携が無効です（NOD_ORCA=0）"},
    {"snapshot": "orca", "of": {"role": "dialog", "name": "Omp で作業を始める"}},
    {"screenshot": "issue-c"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。再試行の前は「過去の判定記録」が無く、再試行の後に前の判定が「過去の判定記録（1件）」に移る。`evidence/external-services/010-06-spec-missing-key.aria.yml`（判定失敗：APIキーが未設定です、過去の判定記録（1件））、`010-12-pr-status.aria.yml`（`group "PR 状態"` の `alert: gh が見つかりません。GitHub CLI を導入してください`、未取得）、`010-16-toggl.aria.yml`（未設定、`button "打刻を開始" [disabled]`、run の `config/toggl.json`）、`010-20-orca.aria.yml`（`alert: 作成できませんでした：Orca との連携が無効です（NOD_ORCA=0）`）が残る。`003`・`010` のどちらも、標準出力の `blocked` は `blockCheck` の `http://localhost:<ポート>/api/workspaces` の1件だけで、画面からの外への要求は無かった。
- **CLI で、外に出ずに失敗したことを確かめる。** 次を実行する。

  ```sh
  $S cli $R --evidence external-services -- --json issue pr-status "$C" --refresh | jq -c '{prUrl, status, fetchError: .fetchError.code}'
  $S cli $R --evidence external-services -- --json issue show "$C" | jq -c '{status, prUrl, branch, worktree}'
  $S cli $R --evidence external-services -- --json issue show "$B" | jq -c '{generation: .specAssessment.generation, status: .specAssessment.status, failureKind: .specAssessment.failureKind}'
  /usr/bin/git -C "$RUN/repo" worktree list
  ```

  `pr-status --refresh` は `{"prUrl":"https://github.com/example/verify-nod/pull/1","status":null,"fetchError":"GH_NOT_INSTALLED"}`（CLI の経路）。`$C` は `branch`・`worktree` が `null`（Orca の失敗で何も記録されない）。`$B` の判定は `generation` 2（Web の「判定を再試行」）で `failed`・`missing_key`。`git worktree list` は run の `repo` の1行だけ（証拠 `011-cli.json`〜`013-cli.json`）。
- **証明。** `E=$RUN/evidence/external-services; ls "$E"` に CLI（`001`・`002`、`004`〜`009`、`011`〜`013`）と Web（`003`・`010` の記録・`.aria.yml`・`.png`）がある。`$S cleanup $R` のあとも `$E` は残る。報告では、それぞれの機能について「成功の経路は到達できない（上の表の前提）」と「未設定・無効の表示を確かめた（証拠のパス）」を分けて書く。

## Gotchas

- 未設定・無効の表示を確かめても、その機能が動くことの証明にはならない。「判定失敗」「gh が見つかりません」「未設定」「Orca との連携が無効です」は、隔離が効いていることの観測であって、外部サービスとの連携の成否ではない。
- 仕様要否判定は、run の Workspace では自動判定が無効で始まる（起票しても判定しない。`specAssessment` は `null`）。`missing_key` の表示を見るには `workspace spec-assessment set on` を先に実行する。有効にした後の起票はすべて判定を試みる（キーが無いので外には出ない）。詳細の表示は今の Workspace の設定で決まり、有効にした後は未判定の Issue も「対象外（未判定）」と「このIssueを判定」のボタンになって「Workspace の自動判定は無効です。」が消える（2026-11-25 に確かめた）。無効の表示は有効にする前に確かめる。
- `issue link-pr` は作業中（In Progress）の Issue にだけ使える。URL は記録されるだけで、外には出ない。PR の欄のリンク（`#1`）は github.com を指すので押さない（押しても `browser` が止め、`blocked` に残る）。
- PR の状態の取得は2つの経路がある。Web の「PR の状態を更新」は server が固定の名前の `gh` を実行し（`PATH` で見つからない）、CLI の `--refresh` は `NOD_GH` を実行する（無いファイル）。どちらも `GH_NOT_INSTALLED` で失敗する。片方の失敗を、もう片方の経路の観測として報告しない。CLI で先に `--refresh` すると失敗が保存され、Web の「PR 状態」にもその `alert` が出るので、Web の経路を確かめるときは CLI の `--refresh` より先に Web の「PR の状態を更新」を押す。
- `issue publish`・`issue link-github`・`import` は GitHub に書く・読む経路で、この手順では `--dry-run` も含めて実行しない。実行していないので「到達できない（試していない）」と報告する。
- Toggl の設定ファイル（run の `config/toggl.json`）にトークンを書かない。書くと API に接続しようとする。
- 「Omp で作業を始める」の失敗は、Orca を呼ぶ前に止まる（`NOD_ORCA=0`）。worktree の作成・Orca の起動・端末への送信には到達しない。
