# レビュー入力の準備

`nod review prepare` はコミット差分と要求の版を固定して保存する。レビュー本体や修正は実行しない。終了コード0の意味は準備完了であり、レビューの合格ではない。Standards / Specはともに `not_started`、最終 `score` は常に `null` になる。

```sh
nod review prepare --repo /path/to/repo --base main --issue API-123 --json
nod review prepare --repo /path/to/repo --base HEAD~3 --document /path/to/spec.md --json
```

`--head` は既定で `HEAD`。基点とheadをSHAへ解決し、既存Skillと同じ3点比較、すなわちmerge-baseから固定headまでを読む。未コミット変更を含めず、作業ツリー・index・commitを変更しない。

IssueやDocumentを省略すると、現在のbranchと一致し、記録した作業場所が対象リポジトリに属するIssueを探す。Personalなど別WorkspaceのIssueも対象になる。作業場所未記録の古いIssueは対象リポジトリのWorkspace内で探す。候補が0件または複数なら未完了にし、ブランチ名からIssue IDを推測しない。

Documentは登録済みID・パス、または明示したMarkdownパスを受け付ける。登録済みDocumentに紐付くIssue本文も取得する。有効なSpec全文、Issue本文、現在のTask・Stepと元の計画Documentを保存する。独立した承認フラグは既存DBにないため、Issueへ取り込まれた現在計画を計画の出典とする。

旧版・検討資料・草案と明示された文書は除外理由を記録する。タイトルの先頭、`状態:` 行、frontmatterの `status: superseded/rejected/draft` を明示として扱う。Specがない場合だけIssue全文を正本にする。Spec取得不能、本文なし、要求元不明では未完了になる。複数の有効な要求Documentは補完関係か矛盾かを準備段階で確定できないため未完了にし、更新日時で選ばない。単一SpecとIssue本文の意味上の整合性も `unverified` として後続工程に残す。

規約は固定headにある `AGENTS.md`、`CLAUDE.md`、`CODING_STANDARDS.md`、`CONTRIBUTING.md`、`README.md` を変更ファイルの祖先ディレクトリから集め、そこからリンクされたローカルMarkdownをたどる。必要な参照が固定headに存在しない、通常ファイルでない、秘密候補のパスである場合は未完了にする。秘密候補の規約本文は読まない。未コミット・未追跡の規約や外部URLはこの準備対象に含まない。

自動探索に含まれない必須規約は、`prepare` と `run` の両方に `--standard <リポジトリ相対Markdownパス>` を繰り返して指定する。指定ファイルとそのローカルMarkdownリンク先も同じ固定対象から収集する。重複は一度だけ保存する。絶対パス、リポジトリ外への参照、固定対象にないファイル、symlink、秘密候補のパスは拒否し、外部ファイルや未コミットの本文で補わない。

```sh
nod review prepare --repo /path/to/repo --base main --issue API-123 \
  --standard DESIGN.md --standard .claude/rules/testing.md --json
```

この指定は取得経路を追加するもので、全行を今回の必須要件と認定するものではない。取得後の規約適用計画で必須範囲と参考範囲を判断する。`run` は準備JSONを再利用せず入力を固定し直すため、準備時と同じ `--standard` を渡す。

結果はnod DBと同じディレクトリの `reviews/<実行ID>/preparation.json` に保存する。実行ごとにUUIDを割り当て、以前の結果は上書きしない。JSONには対象SHA・merge-base・差分・変更ファイル、全文の出典・SHA-256・節の行番号と識別値、要求元、除外理由、未完了理由、残件を含む。準備未完了は終了コード1で同じ形式の結果を返す。

後続Taskはcoreの `prepareReview(db, input)` と `ReviewPreparation` を接続点にする。`status: prepared` の入力をモデル工程へ渡しても、`remaining` にある整合性・2軸探索・要求別記録・候補検証が終わるまでレビュー完了へ進めない。モデル設定・実効モデル照合・30分期限・修正と反映は後続Taskの責務である。

探索と候補検証を実行する入口と現在の制約は[異なるモデルによる探索と候補検証](review-run.md)を参照する。

## 未コミット変更を明示して固定する

`--local` を付けた場合だけ、現在のHEAD・index・作業ツリーを取得する。比較はmerge-baseから固定した作業ツリーまでで、stagedとunstagedが同じファイルにあれば最終作業ツリーの内容をレビューする。`--head` は現在の `HEAD` だけを許可する。

```sh
nod review prepare --repo /path/to/repo --base main --issue NOD-123 \
  --local --untracked src/new.ts --untracked tests/new.test.ts --json
```

未追跡ファイルは `--untracked` でリポジトリ相対のファイル名を繰り返し明示する。指定外の未追跡ファイルは本文を収集しない。ignore対象・存在しないパス・ディレクトリ指定は拒否する。秘密候補のファイルとディレクトリ配下は、明示指定でも本文を取り込まない。親ディレクトリがsymlinkの場合も外部を読まない。

`target.mode=local` と `target.hash` が対象版を表す。`target.headSha` は開始時のHEADであり、レビュー対象全体のcommitではない。`target.local` には作業ツリーの `treeSha`、index内容の `indexTreeSha`、元indexの `indexHash`、対象ファイル状態の `sourceFingerprint`、HEADからindexまでの `stagedPatch`、指定した `untracked` を保存する。

固定領域は実行ディレクトリの `snapshot.git`。独立したindexとobject領域でtreeだけを作り、元repoのindex・作業ファイル・refを書き換えず、stash・commitを作らない。既存のGitオブジェクトは元repoのobject領域をalternatesとして参照するため、記録の再利用時も元repoのobject領域が必要である。

取得前後でHEAD・index・対象内容を照合し、同時変更を検出したら `LOCAL_TARGET_CHANGED` で未完了にする。未解決のindex競合、skip-worktree・assume-unchangedを含むindexは明示的に停止し、欠落を削除と誤解しない。無変更の大きいファイルは元のblobを保持し、実行時の除外一覧へ渡す。変更された大きいファイル・バイナリ・非通常ファイルを必要範囲として取得できなければ未完了になる。
