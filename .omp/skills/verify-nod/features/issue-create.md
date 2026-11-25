# Issue の作成と、一覧・詳細での表示

利用者は CLI の `nod issue create` で Issue を起票し、Web の Issues の一覧（`/issues`）でその行を見つけ、タイトルのリンクから Issue の詳細（`/issues/<ID>`）を開いて、ID・タイトル・本文・状態を読む。CLI の `nod issue show` でも同じ内容を読み直せる。Web のサイドバーの「New Issue」は今は無効（準備中）で、Web からは起票できない。

## Sub-features

- `issue-create-cli` CLI で、タイトルと本文を付けて起票する。出力の JSON に ID・タイトル・本文・状態（既定は Triage）が出る。
- `issue-create-web-disabled` Web の「New Issue」のボタンが無効（title が「New Issue（準備中）」）で、Web からは起票できない。
- `issue-list-row` `/issues` の All のタブに、起票した Issue の行（ID・Status・Title・Workspace）が出る。
- `issue-detail` 一覧のタイトルのリンクで `/issues/<ID>` に移り、見出し・パンくず・説明・状態・プロパティの Status に CLI と同じ値が出る。再読み込みしても同じ。
- `issue-show-cli` CLI の `issue show` で、起票時と同じ ID・タイトル・本文・状態を読み直せる（書き込みの副作用を別の見方で確かめる）。

## How to get to it (user POV)

- 端末で `nod issue create <タイトル> -d <本文>` を実行する（検証では `$S cli $R -- ...` から）。`--requested` を付けると Triage ではなく Todo で起票される。
- Web のサイドバーの「Issues」のリンク（`/issues`）から一覧を開き、行のタイトルのリンクで詳細（`/issues/<ID>`）を開く。詳細は URL を直接開いてもよい。
- Web のサイドバーの「Triage」（`/triage`）にも、Triage の Issue として出る。
- 端末で `nod issue show <ID>` を実行する。
- Web のサイドバーの「New Issue」のボタンは入口にならない。無効（`disabled`、title「New Issue（準備中）」。`packages/web/src/layout/Sidebar.tsx` の `IconButton icon="square-pen" label="New Issue"`）で、押しても何も起きない。このため、作成は CLI から行う。

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る。
- run の Issue は0件（`launch` した直後）。0件でない run では、`All 1` の確認と、行の name の部分一致が別の Issue に当たらないかを読み替える。

- **CLI で起票する。** タイトルと本文を決めて起票し、ID を受け取る。`TITLE="verify-nod 起票の確認"; BODY="CLI から起票した本文"; ID=$($S cli $R --evidence issue-create -- --json issue create "$TITLE" -d "$BODY" | jq -r .id); echo "$ID"` を実行する。終了コード 0 で、`$ID` は `V<5桁>-1`。証拠 `evidence/issue-create/001-cli.json` の `stdoutJson` に `title`・`description` が入力と同じ値で、`status` が `triage`、`createdBy` が `verify-nod` で入る。
- **Web の一覧と詳細で確かめる。** 次の1回の呼び出しで、一覧を開き、「New Issue」が無効であることと行を確かめ、タイトルのリンクで詳細を開いて確かめ、再読み込みする。ヒアドキュメントの区切りは引用しない（`<<EOF`。`$ID`・`$TITLE`・`$BODY` を展開する）。

  ```sh
  $S browser $R --feature issue-create <<EOF
  [
    {"goto": "/issues"},
    {"expect": {"role": "button", "name": "New Issue", "exact": true}, "disabled": true, "attr": {"title": "New Issue（準備中）"}},
    {"expect": {"role": "tab", "name": "All 1", "exact": true, "within": {"role": "tablist", "name": "絞り込み"}}, "attr": {"aria-selected": "true"}},
    {"expect": {"role": "row", "name": "$ID"}, "text": "Triage"},
    {"expect": {"role": "cell", "name": "$ID", "exact": true, "within": {"role": "row", "name": "$ID"}}},
    {"expect": {"role": "link", "name": "$TITLE", "exact": true, "within": {"role": "row", "name": "$ID"}}, "attr": {"href": "/issues/$ID"}},
    {"read": {"role": "row", "name": "$ID"}},
    {"snapshot": "list"},
    {"screenshot": "list"},
    {"click": {"role": "link", "name": "$TITLE", "exact": true, "within": {"role": "row", "name": "$ID"}}},
    {"url": "/issues/$ID"},
    {"expect": {"role": "heading", "level": 1, "name": "$TITLE"}},
    {"expect": {"role": "navigation", "name": "パンくず"}, "text": "$ID"},
    {"expect": {"role": "region", "name": "説明", "exact": true}, "text": "$BODY"},
    {"expect": {"role": "group", "name": "状態"}, "text": "Triage"},
    {"expect": {"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}, "attr": {"data-value": "triage"}},
    {"read": {"role": "region", "name": "説明", "exact": true}},
    {"snapshot": "detail"},
    {"screenshot": "detail"},
    {"reload": true},
    {"expect": {"role": "heading", "level": 1, "name": "$TITLE"}},
    {"expect": {"role": "region", "name": "説明", "exact": true}, "text": "$BODY"}
  ]
  EOF
  ```

  終了コード 0 で、標準出力の JSON が `"ok": true`、`blockCheck.blocked` が `true`。`evidence/issue-create/002-browser.json` の各手順が `ok: true` で、`read` の手順に一覧の行の文字（ID・`Triage`・タイトル・Workspace の名前）と説明の本文が残る。`002-07-list.aria.yml` に `button "New Issue" [disabled]` と、ID・`Triage`・タイトルのリンク（`/url: /issues/<ID>`）の行があり、`002-17-detail.aria.yml` に `heading "<タイトル>" [level=1]`、`region "説明"` の本文、`group "状態": Triage` がある。`002-08-list.png`・`002-18-detail.png` の上の帯に run の ID と URL が出る。
- **CLI で読み直す。** 起票した Issue を別の見方で読み、起票時の出力と比べる。`$S cli $R --evidence issue-create -- --json issue show "$ID"` を実行し、`E=$($S doctor $R | jq -r .runDir)/evidence/issue-create; jq -s 'map(.stdoutJson | {id, title, description, status}) | .[0] == .[1]' "$E/001-cli.json" "$E/003-cli.json"` が `true` を出す。
- **証明。** `ls "$E"` に `001-cli.json`（起票）、`002-browser.json` と一覧・詳細の `.aria.yml`・`.png`、`003-cli.json`（読み直し）がある。`$S cleanup $R` のあとも `$E` の中身は同じで、run のディレクトリには `evidence/` だけが残る。

## Gotchas

- 起票の既定の状態は Triage。一覧の行・詳細の「状態」・プロパティの Status（`data-value="triage"`）は Triage を前提にしている。`--requested` で起票したときは `Todo`（`todo`）に読み替える。
- `issue create` のタイトルは位置引数で、`--title` は無い。本文は `-d`（`--description`）。
- 起票時の仕様要否判定は、検証の Workspace では自動判定が無効なので呼ばれず、`specAssessment` は `null`、詳細の「仕様要否判定」は「対象外（未判定）」になる。判定の成功の経路はこの隔離では確かめられない（Typesafe の API につながらない）。
- 行の `{"role": "row", "name": "$ID"}` は name の部分一致なので、Issue が10件以上ある run では `V…-1` が `V…-10` の行にも当たる。そのときは `"hasText"` やセルの `exact` で絞る。
- ヒアドキュメントの JSON に値を展開するので、タイトルと本文に `"` や `\` を入れない。
- 詳細の見出し（`heading` level 1）は中に同じ名前の編集用のボタンを持つ。`{"role": "button", "name": "<タイトル>"}` で探すと見出しのボタンに当たる。
- 一覧の行には `プレビュー` のボタンもある。詳細へはタイトルのリンクで移る（行のクリックではない）。
- `browser` の呼び出しをまたいでページの状態は残らない。詳細だけを確かめ直すときも `{"goto": "/issues/<ID>"}` から書く。
