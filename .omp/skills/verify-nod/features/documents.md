# Document の作成、Issue への添付、表示

Document は Markdown ファイルへの参照で、本文の正本はファイルのまま。利用者は Web の Documents（`/documents`）の「新規ドキュメント」か Issue の詳細の「Documentを追加」→「新規作成」で、Documents のディレクトリ（`NOD_DOCS_DIR`。検証では run の `data/documents/`）の下に Markdown を作って登録し、Issue の詳細の「既存を添付」では手元の Markdown を絶対パスで添付する。CLI では `nod doc create` で作って登録し、`nod issue doc add` で既存のファイルを添付する。Document の画面（`/documents/<id>`）は本文を Markdown として表示し、「関連 Issue」から Issue へ、Issue の詳細の「Documents」から Document へ、相互に移れる。

## Sub-features

- `doc-create-cli` CLI の `doc create <相対パス> --title --kind --body --issue <ID>` で、run の `data/documents/<相対パス>` にファイルができ（中身は `# <タイトル>` と本文）、Issue にリンクされる。
- `doc-attach-cli` CLI の `issue doc add <ID> <パス>` で、既存の Markdown（パスは cwd からの相対か絶対）が、ファイルを動かさずに Issue に添付される。タイトルはファイルの最初の `#` 見出し。
- `doc-create-web-list` `/documents` の「新規ドキュメント」→ `/documents/new` で相対パス・タイトル・種類・本文・リンク先 Issue を入れて「作成」すると、`/documents/<id>` に移り、見出しと本文と「関連 Issue」が出る。作成画面には Documents のディレクトリ（run の `data/documents/`）が出る。
- `doc-create-web-issue` Issue の詳細の「Documentを追加」→「新規作成」で、リンク先にその Issue を入れた作成画面（`/documents/new?issue=<ID>`）が開く。
- `doc-attach-web` Issue の詳細の「Documentを追加」→「既存を添付」で「Markdown絶対パス」を入れて「追加」すると、Documents の欄に出る。
- `doc-links` Issue の詳細の「Documents」の欄に添付した Document のリンク（種類・添付者・添付日）が並び、Document の画面の「関連 Issue」に Issue のリンクが出る。再読み込みしても同じ。
- `doc-list` `/documents` の表に、Document ごとの行（タイトル、相対パスか絶対パス、種類、リンク先 Issue、作成日）が出る。
- `doc-files` 作ったファイルは run の `data/documents/` の下にだけでき、CLI の `doc list` の `path` と一致する。

## How to get to it (user POV)

- Web のサイドバーの「Documents」（`/documents`）→「新規ドキュメント」（`/documents/new`）。一覧の行のタイトルのリンクで Document の画面（`/documents/<id>`）を開く。
- Web の Issue の詳細の「Documents」の欄（`region "Documents"`）の「Documentを追加」のボタン → メニュー（`menu "Documentの追加"`）の「新規作成」か「既存を添付」。
- Web の Document の画面の「関連 Issue」の「Issue をリンク」（Document の側から Issue をリンク・解除する。この手順では扱わない）。
- 端末で `nod doc create`・`nod doc list`・`nod doc show <id>`・`nod doc link <id> --issue <ID>`、`nod issue doc add <ID> <パス>`・`nod issue doc remove <ID> <パス>`、`nod issue show <ID>`（`documents`）。

## Driving it with verify-nod.ts

Preconditions:

- 作業ツリーのルートで `S=./.omp/skills/verify-nod/scripts/verify-nod.ts` とし、`$S launch` の出力の `runId` を `R` に入れてある。
- `$S doctor $R` が終了コード 0 で通る。
- run の Issue・Document は0件（`launch` した直後）。
- 添付に使う Markdown は、その run の中（`<run>/repo/docs/`）に作った検証用のファイルだけを使う。利用者のファイルや作業ツリーのファイルを添付しない（添付は DB にパスを記録するだけで、ファイルは動かない）。

- **CLI で Issue と Document を作り、既存のファイルを添付する。** 次を実行する。

  ```sh
  RUN=$($S doctor $R | jq -r .runDir)
  ID=$($S cli $R --evidence documents -- --json issue create "Document を添付する Issue" --requested | jq -r .id)
  $S cli $R --evidence documents -- --json doc create specs/cli-doc.md --title "CLI で作った Document" --kind spec --body "CLI で書いた本文" --issue "$ID" | jq -c '{id, path, title, kind}'
  mkdir -p "$RUN/repo/docs"
  printf '# CLI で添付した Document\n\nrun の中に置いたファイル\n' > "$RUN/repo/docs/cli-attach.md"
  printf '# Web で添付した Document\n\nWeb で添付するファイル\n' > "$RUN/repo/docs/web-attach.md"
  $S cli $R --evidence documents -- --json issue doc add "$ID" docs/cli-attach.md --kind plan | jq -c '{id, path, title, kind}'
  ```

  `doc create` は `{"id":1,"path":"<run>/data/documents/specs/cli-doc.md","title":"CLI で作った Document","kind":"spec"}`、`issue doc add` は `{"id":2,"path":"<run>/repo/docs/cli-attach.md","title":"CLI で添付した Document","kind":"plan"}`（証拠 `evidence/documents/001-cli.json`〜`003-cli.json`）。
- **CLI で作った Document を Web で読む。** 次の1回の呼び出しで、Issue の詳細の Documents の欄から Document の画面へ移る。

  ```sh
  $S browser $R --feature documents <<EOF
  [
    {"goto": "/issues/$ID"},
    {"expect": {"role": "link", "name": "CLI で作った Document", "exact": true, "within": {"role": "region", "name": "Documents", "exact": true}}, "attr": {"href": "/documents/1"}},
    {"expect": {"role": "link", "name": "CLI で添付した Document", "exact": true, "within": {"role": "region", "name": "Documents", "exact": true}}},
    {"snapshot": "issue-documents-cli", "of": {"role": "region", "name": "Documents", "exact": true}},
    {"click": {"role": "link", "name": "CLI で作った Document", "exact": true, "within": {"role": "region", "name": "Documents", "exact": true}}},
    {"url": "/documents/1"},
    {"expect": {"role": "heading", "level": 1, "name": "CLI で作った Document"}},
    {"expect": {"role": "main"}, "text": "CLI で書いた本文"},
    {"expect": {"role": "link", "name": "Document を添付する Issue", "exact": true, "within": {"role": "region", "name": "関連 Issue", "exact": true}}, "attr": {"href": "/issues/$ID"}},
    {"snapshot": "cli-doc"},
    {"screenshot": "cli-doc"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`004-03-issue-documents-cli.aria.yml` に2つの Document のリンク（`添付者: verify-nod`）、`004-09-cli-doc.aria.yml` に `heading "CLI で作った Document" [level=1]`、本文、`region "関連 Issue"` の Issue のリンクがある。
- **Web で作り、添付する。** 次の1回の呼び出しで、`/documents` の「新規ドキュメント」で作り、Issue の詳細の「新規作成」で作り、「既存を添付」で添付し、再読み込みと一覧で確かめる。

  ```sh
  $S browser $R --feature documents <<EOF
  [
    {"goto": "/documents"},
    {"click": {"role": "button", "name": "新規ドキュメント", "exact": true}},
    {"url": "/documents/new"},
    {"expect": {"role": "form", "name": "新規ドキュメント"}, "text": "$RUN/data/documents/"},
    {"fill": {"role": "textbox", "name": "相対パス", "exact": true}, "value": "specs/web-list.md"},
    {"fill": {"role": "textbox", "name": "タイトル", "exact": true}, "value": "一覧から作った Document"},
    {"select": {"role": "combobox", "name": "種類", "exact": true}, "value": "spec"},
    {"fill": {"role": "textbox", "name": "本文 Markdown"}, "value": "## 背景\n\n一覧から書いた本文\n"},
    {"fill": {"role": "textbox", "name": "リンク先 Issue"}, "value": "$ID"},
    {"press": "Enter", "on": {"role": "textbox", "name": "リンク先 Issue"}},
    {"expect": {"role": "button", "name": "$ID を外す", "exact": true}},
    {"snapshot": "new-from-list", "of": {"role": "form", "name": "新規ドキュメント"}},
    {"click": {"role": "button", "name": "作成", "exact": true}},
    {"expect": {"role": "heading", "level": 1, "name": "一覧から作った Document"}},
    {"expect": {"role": "heading", "level": 3, "name": "背景"}},
    {"expect": {"role": "link", "name": "Document を添付する Issue", "exact": true, "within": {"role": "region", "name": "関連 Issue", "exact": true}}},
    {"snapshot": "web-list-doc"},
    {"goto": "/issues/$ID"},
    {"click": {"role": "button", "name": "Documentを追加", "exact": true}},
    {"click": {"role": "menuitem", "name": "新規作成", "within": {"role": "menu", "name": "Documentの追加"}}},
    {"url": "/documents/new?issue=$ID"},
    {"expect": {"role": "button", "name": "$ID を外す", "exact": true}},
    {"fill": {"role": "textbox", "name": "相対パス", "exact": true}, "value": "specs/web-issue.md"},
    {"fill": {"role": "textbox", "name": "タイトル", "exact": true}, "value": "Issue から作った Document"},
    {"fill": {"role": "textbox", "name": "本文 Markdown"}, "value": "Issue の詳細から書いた本文"},
    {"click": {"role": "button", "name": "作成", "exact": true}},
    {"expect": {"role": "heading", "level": 1, "name": "Issue から作った Document"}},
    {"expect": {"role": "main"}, "text": "Issue の詳細から書いた本文"},
    {"click": {"role": "link", "name": "Document を添付する Issue", "exact": true, "within": {"role": "region", "name": "関連 Issue", "exact": true}}},
    {"url": "/issues/$ID"},
    {"click": {"role": "button", "name": "Documentを追加", "exact": true}},
    {"click": {"role": "menuitem", "name": "既存を添付", "within": {"role": "menu", "name": "Documentの追加"}}},
    {"fill": {"role": "textbox", "name": "Markdown絶対パス", "exact": true}, "value": "$RUN/repo/docs/web-attach.md"},
    {"click": {"role": "button", "name": "追加", "exact": true, "within": {"role": "region", "name": "Documents", "exact": true}}},
    {"expect": {"role": "link", "name": "Web で添付した Document", "exact": true, "within": {"role": "region", "name": "Documents", "exact": true}}},
    {"expect": {"role": "link", "within": {"role": "region", "name": "Documents", "exact": true}}, "count": 5},
    {"snapshot": "issue-documents-all", "of": {"role": "region", "name": "Documents", "exact": true}},
    {"screenshot": "issue-documents-all"},
    {"reload": true},
    {"expect": {"role": "link", "within": {"role": "region", "name": "Documents", "exact": true}}, "count": 5},
    {"goto": "/documents"},
    {"expect": {"role": "row", "hasText": "$ID"}, "count": 5},
    {"snapshot": "documents-list"},
    {"screenshot": "documents-list"}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`005-11-new-from-list.aria.yml` の作成画面に run の `data/documents/` の絶対パスが出る。`005-16-web-list-doc.aria.yml` に `heading "一覧から作った Document" [level=1]`・`heading "背景" [level=3]`・関連 Issue のリンク、`005-36-issue-documents-all.aria.yml` に5つの Document のリンク（Web で作り・添付したものは `添付者: me`）、`005-42-documents-list.aria.yml` に5行がある。
- **CLI とファイルで確かめる。** 次を実行する。

  ```sh
  E="$RUN/evidence/documents"
  $S cli $R --evidence documents -- --json doc list | jq -c --arg run "$RUN/" 'map({title, kind, issues, path: (.path | ltrimstr($run))})'
  $S cli $R --evidence documents -- --json issue show "$ID" | jq -c '[.documents[] | {title, attachedBy}]'
  (cd "$RUN/data/documents" && find . -type f | sort | while read -r f; do echo "== $f"; cat "$f"; done) | tee "$E/data-documents.txt"
  ```

  `doc list` の5件の `path`（run からの相対）は `data/documents/specs/cli-doc.md`・`data/documents/specs/web-list.md`・`data/documents/specs/web-issue.md`・`repo/docs/cli-attach.md`・`repo/docs/web-attach.md` で、どれも `issues` が `["<ID>"]`（証拠 `006-cli.json`）。`issue show` の `documents` は5件で、CLI の2件が `attachedBy: "verify-nod"`、Web の3件が `"me"`（`007-cli.json`）。`data/documents` の下には `./specs/cli-doc.md`・`./specs/web-issue.md`・`./specs/web-list.md` の3つだけがあり、`./specs/web-list.md` の中身は `# 一覧から作った Document`、空行、`## 背景`、空行、`一覧から書いた本文`（`evidence/documents/data-documents.txt`）。
- **証明。** `ls "$E"` に CLI（`001`〜`003`、`006`・`007`）、Web（`004`・`005` の記録・`.aria.yml`・`.png`）、`data-documents.txt` がある。`$S cleanup $R` のあとも `$E` は残り、run の `data/` と `repo/` は消える。

## Gotchas

- Documents のディレクトリは `NOD_DOCS_DIR`。検証の nod は run の `data/documents/` を指すので、作成画面の表示（`form "新規ドキュメント"` の中の絶対パス）と `doc list` の `path` が run の中であることで確かめる。利用者の `~/.local/share/nod/documents` は読まない・比べない。
- `doc create` と Web の作成は、同じ相対パスのファイルが既にあると失敗する（上書きしない）。同じ run で手順をやり直すときは相対パスを変える。
- 「既存を添付」と `issue doc add` はファイルを動かさず、パスを記録するだけ。run の外のファイルを添付すると、そのパスを後で読み書きする操作が run の外に及ぶ。添付には run の中に作ったファイルだけを使う。
- 「既存を添付」は絶対パスだけを受け付ける。`issue doc add` の相対パスは cwd（`$S cli` では run の `repo/`）から解決される。
- 作成画面の入力欄の accessible name は「本文 Markdown」「リンク先 Issue 任意」のように補足の文字を含む。`exact` を付けずに `本文 Markdown`・`リンク先 Issue` で指す。リンク先 Issue は入力して Enter で確定する（「<ID> を外す」のボタンが出る）。
- 作成直後の URL は `/documents/<id>` で、id は登録の順の通し番号（この手順では 1〜5）。
- ヒアドキュメントに `$RUN` と `$ID` を展開するので、区切りは引用しない（`<<EOF`）。JSON の `\n` は改行として入力される。
