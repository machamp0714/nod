# レビュー入力の準備と探索の記録

`nod review prepare` はコミット差分と要求・規約の版を固定し、担当が読む読取専用snapshotを作って保存する。レビュー本体や修正は実行しない。終了コード0の意味は準備完了であり、レビューの完了や合格ではない。Standards / Specはともに `not_started`、最終 `score` は常に `null` になる。

準備のあとは同じ実行IDに対して、計画の固定（`review plan`）、工程入力の取得（`review input`）、探索の記録（`review record --phase exploration`）の順に進む。どの段階も点数を持たず、最終の候補検証記録が無い限りレビュー完了にならない。現在の段階は `review show` で確認できる。

```sh
nod review prepare --repo /path/to/repo --base main --issue API-123 --json
nod review prepare --repo /path/to/repo --base HEAD~3 --document /path/to/spec.md --json
```

`--head` は既定で `HEAD`。基点とheadをSHAへ解決し、既存Skillと同じ3点比較、すなわちmerge-baseから固定headまでを読む。未コミット変更を含めず、作業ツリー・index・commitを変更しない。

IssueやDocumentを省略すると、現在のbranchと一致し、記録した作業場所が対象リポジトリに属するIssueを探す。Personalなど別WorkspaceのIssueも対象になる。作業場所未記録の古いIssueは対象リポジトリのWorkspace内で探す。候補が0件または複数なら未完了にし、ブランチ名からIssue IDを推測しない。

Documentは登録済みID・パス、または明示したMarkdownパスを受け付ける。登録済みDocumentに紐付くIssue本文も取得する。有効なSpec全文、Issue本文、現在のTask・Stepと元の計画Documentを保存する。独立した承認フラグは既存DBにないため、Issueへ取り込まれた現在計画を計画の出典とする。

旧版・検討資料・草案と明示された文書は除外理由を記録する。タイトルの先頭、`状態:` 行、frontmatterの `status: superseded/rejected/draft` を明示として扱う。Specがない場合だけIssue全文を正本にする。Spec取得不能、本文なし、要求元不明では未完了になる。複数の有効な要求Documentは補完関係か矛盾かを準備段階で確定できないため未完了にし、更新日時で選ばない。単一SpecとIssue本文の意味上の整合性も `unverified` として後続工程に残す。

規約は固定headにある `AGENTS.md`、`CLAUDE.md`、`CODING_STANDARDS.md`、`CONTRIBUTING.md`、`README.md` を変更ファイルの祖先ディレクトリから集め、そこからリンクされたローカルMarkdownをたどる。必要な参照が固定headに存在しない、通常ファイルでない、秘密候補のパスである場合は未完了にする。秘密候補の規約本文は読まない。未コミット・未追跡の規約や外部URLはこの準備対象に含まない。

結果はnod DBと同じディレクトリの `reviews/<実行ID>/preparation.json` に保存する。実行ごとにUUIDを割り当て、以前の結果は上書きしない。JSONには対象SHA・merge-base・差分・変更ファイル、全文の出典・SHA-256・節の行番号と識別値、要求元、除外理由、未完了理由、残件、規約適用計画の雛形 `standardScopeTemplatePath`、読取専用snapshotの索引 `context` を含む。準備未完了は終了コード1で同じ形式の結果を返す。

`context` は同じ準備実行で作る `reviews/<実行ID>/context/` の索引である。固定head（local対象では固定したtree）の読み込めた通常ファイルを同じ相対パスへ、基点（merge-base）側を `.review-base-<実行ID>/` 配下へ、固定資料の本文を `.review-input-<実行ID>/source-<n>.txt` へ、いずれも読取専用で置く。`code`（head側の `paths`・`executable`）、`baseCode`（`directory`・headと異なる基点ファイルの `paths`・同じblobの件数 `sameAsHead`）、`sourceFiles`、読み込まなかったファイルと理由の `excludedSources` を持つ。秘密候補・非通常ファイル・バイナリ・不正なUTF-8・1ファイル2MiB超・総量超過は本文を書かず、変更対象が除外されれば準備未完了にする。元の作業ツリー・index・commitは変更しない。

`remaining` には計画の固定、Standards探索、Spec探索と要求別の充足確認、候補検証と要求同士の意味上の整合性確認が残る。準備の結果だけをレビュー結果として扱わない。

探索と候補検証を1コマンドでモデルCLIに実行させる旧入口と現在の制約は[異なるモデルによる探索と候補検証](review-run.md)を参照する。

## 未コミット変更を明示して固定する

`--local` を付けた場合だけ、現在のHEAD・index・作業ツリーを取得する。比較はmerge-baseから固定した作業ツリーまでで、stagedとunstagedが同じファイルにあれば最終作業ツリーの内容をレビューする。`--head` は現在の `HEAD` だけを許可する。

```sh
nod review prepare --repo /path/to/repo --base main --issue NOD-123 \
  --local --untracked src/new.ts --untracked tests/new.test.ts --json
```

未追跡ファイルは `--untracked` でリポジトリ相対のファイル名を繰り返し明示する。指定外の未追跡ファイルは本文を収集しない。ignore対象・存在しないパス・ディレクトリ指定は拒否する。秘密候補のファイルとディレクトリ配下は、明示指定でも本文を取り込まない。親ディレクトリがsymlinkの場合も外部を読まない。

`target.mode=local` と `target.hash` が対象版を表す。`target.headSha` は開始時のHEADであり、レビュー対象全体のcommitではない。`target.local` には作業ツリーの `treeSha`、index内容の `indexTreeSha`、元indexの `indexHash`、対象ファイル状態の `sourceFingerprint`、HEADからindexまでの `stagedPatch`、指定した `untracked` を保存する。

固定領域は実行ディレクトリの `snapshot.git`。独立したindexとobject領域でtreeだけを作り、元repoのindex・作業ファイル・refを書き換えず、stash・commitを作らない。既存のGitオブジェクトは元repoのobject領域をalternatesとして参照するため、記録の再利用時も元repoのobject領域が必要である。

取得前後でHEAD・index・対象内容を照合し、同時変更を検出したら `LOCAL_TARGET_CHANGED` で未完了にする。未解決のindex競合、skip-worktree・assume-unchangedを含むindexは明示的に停止し、欠落を削除と誤解しない。無変更の大きいファイルは元のblobを保持し、`context.excludedSources` に理由を残す。変更された大きいファイル・バイナリ・非通常ファイルを必要範囲として取得できなければ未完了になる。

## 規約適用計画と責務計画を固定する

`nod review plan` は、準備した実行に規約適用計画と責務計画を1回だけ固定し、探索の工程入力を保存する。探索を始める前に計画を確定し、候補や採点を見て対象を減らさない。

```sh
nod review plan --run <実行ID> --scope-plan /path/to/scope.json \
  --responsibility-plan /path/to/responsibility.json --json
```

`--scope-plan` は `standardScopeTemplatePath` の雛形から作る規約適用計画、`--responsibility-plan` は機械的な合否だけの要求を自動チェック担当へ分ける責務計画である。形式は[固定資料の索引と規約適用計画](review-run.md#固定資料の索引と規約適用計画)と[自動チェックと独立したレビュー](review-run.md#自動チェックと独立したレビュー)を参照する。相対パスは現在のディレクトリから解決する。省略した場合は全規約を確認し、分担を置かない。

計画の網羅・hash・判断根拠の不正は `SCOPE_PLAN_INVALID`、未判断の範囲は `SCOPE_UNVERIFIED`、責務計画の不正は `RESPONSIBILITY_INVALID`、規約の必須範囲から指す資料が固定対象に無ければ `STANDARD_UNREADABLE`、準備後に要求・規約が変わっていれば `REQUIREMENTS_CHANGED` で拒否する。拒否した計画は固定しないので、直した計画で同じ実行に再実行できる。固定済みの実行への2回目の計画は `PLAN_ALREADY_FIXED` で拒否する。計画を変えるには新しい準備から始める。準備が未完了の実行は `RUN_NOT_PREPARED`、存在しない実行IDは `RUN_NOT_FOUND` になる。

固定した結果は `reviews/<実行ID>/plan.json` に保存する。対象版 `target`、計画とそのhash（`standardScope`・`responsibility`）、計画固定時の要求・規約・計画の識別値 `sourceFingerprint`、工程入力の場所 `inputs` を持ち、状態は `planned`、`score` は `null` である。

工程入力は `reviews/<実行ID>/inputs/` に読取専用で置く。Standards探索とSpec探索の入力（`<工程>.input.json`）は確認単位・段落表・資料索引・`focus`・固定分担・対象diff・`code`/`baseCode` 索引・工程指示を持ち、その軸の全確認単位を1つの担当へ渡す（分割しない）。`contextPath` は読取専用snapshotの場所で、`code.paths`・`sources[].path`・`baseCode.directory` はここからの相対パスである。出力形式は同じ場所の `<工程>.schema.json`（format=3のJSON Schema）に従う。

## 工程入力の場所を取得する

```sh
nod review input --run <実行ID> --phase standards --json
```

`--phase` は `standards` または `spec`。入力本文は大きいため標準出力へ流さず、`inputPath` と `schemaPath` だけを返す。計画の固定前は `PLAN_REQUIRED` で拒否する。

## 探索の出力を記録する

探索担当は工程ごとに1つのformat=3出力をJSONファイルへ書き、CLIへ渡す。

```sh
nod review record --run <実行ID> --phase exploration \
  --standards /tmp/standards.json --spec /tmp/spec.json \
  --agent code-reviewer --model-claim '<担当が知りうるモデル>' --model-claim-source '<その出典>' --json
```

CLIは各出力を次の順に検査する。モデルの起動・認証・課金確認・実効モデル照合・全体期限は行わない。

1. ファイルの指定・存在・読取（16MiB以下の通常ファイル）。
2. JSONとしての解析。
3. トップレベルの `target` が固定対象の `target.hash` と一致すること（不一致は `STALE_EVIDENCE`）。
4. 工程の `schema.json` と同じformat=3のJSON Schema相当の検査（必須項目・型・列挙値・`axis`・担当の要求IDと件数・出典の `type:id` 形式）。
5. 工程・完了状態・配列の検査と内部の工程記録への変換。固定資料に無い出典や範囲外の行は `OUTPUT_INVALID` とし、`problem.referenceDiagnostic` に取り違えの種類だけを残す。出典のhash・引用、要求本文、固定分担の理由はCLIが固定資料と計画から復元し、担当の異なる分担理由は `proposedRationale` に残す。
6. `completed=false` は担当が必要資料・確認の不足を報告したものとして `STAGE_INCOMPLETE`。

出力の欠落・存在しないファイル（`STAGE_MISSING`）、読取不能（`STAGE_UNREADABLE`）、JSON不正・形式不正（`OUTPUT_INVALID`）、対象版の不一致（`STALE_EVIDENCE`）、`completed=false`（`STAGE_INCOMPLETE`）は採点の前に未完了として保存し、工程ごとの `problem` と全体の `problems` に問題コードを残す。`--standards`・`--spec` の欠落も保存対象であり、引数エラーにはしない。

記録は `reviews/<実行ID>/exploration.json` に1回だけ新規作成する。両工程が完了すれば `status=explored`、それ以外は `status=exploration_incomplete`（終了コード1）。どちらも `score=null`・`reviewCompleted=false` で、探索のみ・レビュー未完了であることを表す。`stages` は工程ごとに出力ファイルのパスとSHA-256、検査後の候補・要求別記録、問題を持ち、`target` で準備の対象版に結び付く。探索時点では引用の固定Git照合・採点・候補検証を行わない。記録済みの実行への再記録は `EXPLORATION_ALREADY_RECORDED` で拒否し、やり直しは新しい準備から行う。計画の固定前は `PLAN_REQUIRED`。

`agents.exploration` には `--agent` の定義名と、`modelClaim`（`value`・`source`・`status`）を申告として残す。`--model-claim` があれば `status=declared`、無ければ `value=null`・`status=unverified`。申告は実効モデルの証明ではなく、不明でも記録は止めない。定義名が空なら `AGENT_REQUIRED` で拒否する。

`--check` を付けると、指定した出力だけを同じ検査にかけて結果を返し、保存しない（`saved=false`、問題があれば終了コード1）。記録前に担当が出力を直すためのもので、採点や引用照合はしない。出力を1つも指定しなければ `OUTPUT_REQUIRED` で拒否する。

## 実行の段階を確認する

```sh
nod review show --run <実行ID> --json
```

保存済みの記録を読むだけで、記録を閉じたり書き換えたりしない。`status` は最後に保存された記録の段階（`prepared`・`planned`・`explored`・`exploration_incomplete`、候補検証の記録後は `completed`・`incomplete`、準備未完了は `incomplete`）で、`score`、`reviewCompleted`、両軸の `review`、`agents`（探索担当・検証担当の申告）、`problems`、`remaining`、保存先 `directory` と最新の記録 `artifactPath` を返す。準備・計画・探索の段階では常に `score=null`・`reviewCompleted=false` で、テキスト出力にも「レビュー未完了・点数なし」と表示する。
