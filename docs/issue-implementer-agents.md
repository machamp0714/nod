# Issue を実装するエージェントの配置

nod の Issue の実装は、OMP の agent `issue-implementer` が進める。`issue-implementer` は着手条件を確かめてから `nod issue start` で着手し、Task ごとに担当の `task-implementer` を新しく起動して実装させ、Task ごとにコミットして、進みと判断を nod に残す。最終成果物は PR である。
この文書は、2つの定義と担当用のロールの置き場、`issue-implementer` への渡し方、着手条件と止まり方、Task ごとの流れと記録、再開、PR を最終成果物にする権限と禁止操作、残る危険、確かめ方をまとめる。

仕様の出典は NOD-170 の仕様（Document 2010）である。

| 定義名 | 役目 | 参照するロール |
|---|---|---|
| `issue-implementer` | 着手条件を確かめて着手し、Task ごとに担当に実装させてコミットし、nod に記録し、最終成果物の PR を作る主担当 | `@task` |
| `task-implementer` | `issue-implementer` が Task ごとに新しく起動し、渡された1つの Task を上流の `tdd` の進め方で実装する担当 | `@implement-task` |

## 定義の置き場

定義はこのリポジトリの [`omp/content/agents/`](../omp/content/agents/) に置き、版管理する。利用者の設定 `~/.omp/agent/config.yml` の `extensions` に `<nod のリポジトリの絶対パス>/omp/content` を登録していれば、通常の `omp` がこの置き場の定義を読む（登録は [README の pstack の節](../README.md#pstack-を-omp-で使う移行中)と同じ1行で、登録済みなら足すものは無い）。同じ名前の定義が利用者の置き場 `~/.omp/agent/agents/` にあると、そちらが先に使われるので、利用者の置き場に同じ名前の定義を置かない。

```yaml
extensions:
  - <nod のリポジトリの絶対パス>/omp/content
```

`issue-implementer` の frontmatter は次のとおり。

```md
---
name: issue-implementer
model: "@task"
thinking-level: medium
spawns: [task-implementer]
---
```

- `model`: ロール `task` を参照する。具体的なモデル名は書かない。
- `thinking-level: medium`: 現行の `implementer` と同じ値にする。
- `spawns: [task-implementer]`: task で起動できる agent を `task-implementer` だけにする。OMP は `spawns` を書いた定義に `task` ツールを足す。

## 現行の implementer と別の名前にしたこと

同じ名前の定義が利用者の置き場 `~/.omp/agent/agents/` にあると、そちらが `extensions` の置き場の定義より先に使われる。利用者の置き場には、`nod:implement` を手順の正本にする現行の `implementer` がある。新しい定義を確実に使い、現行の流れも動かし続けるため、新しい定義は `issue-implementer` という別の名前にした。

現行の `implementer` は、この定義を置く Issue では変えず、外さない。外すのは後続の Issue で行う。

## 渡すもの

メインセッションから task で起動し、依頼の本文に実装の依頼と Issue の ID を書く（例: `NOD-123 を実装する`）。

- Issue の ID は必須である。明示の依頼と ID が無ければ、着手せずに対象を聞き返す。`nod issue next` などで別の Issue を自分で選ばない。
- 作業ブランチを先に用意してから渡す。デフォルトのブランチ（main・develop など）の上で頼むと、何もせずに止まる。作業ブランチの名前の候補は `nod issue branch-name <id>` で得られる。GitHub に出るブランチ名に nod の Issue ID を書かない。
- 止まったあとに続けるときは、Issue の ID と利用者の回答を依頼の本文に書いて新しく起動する。子の agent は会話を持たず、利用者と直接は話せないためである。

## 着手条件

`issue-implementer` は、着手の前に次を確かめる。

1. 今のブランチがデフォルトのブランチでない。
2. 上流の `implement` を、clone の `~/.agents/mattpocock-skills/skills/engineering/implement/SKILL.md` から read で読める。名前（`skill://`）では読まない。名前だけの `implement` は nod プラグインのものを指すためである。
3. `nod issue show <id> --json` で、本文・ラベル・`specAssessment`・計画（Task と Step の状態）・Documents・Activity を読む。`kind=spec` の Document は `nod doc show` で全文読む。
4. 仕様判定: Issue の Workspace の `nod workspace spec-assessment show --json` で `enabled` を確かめる。Workspace が有効で、`specAssessment` の `status` が `pending` か `failed` で、`suspended` でも `recordOnly` でもないときだけ、`nod issue assess <id> --json` で回復を1回だけ試み、確かめ直す。なお未完了か失敗なら、同じ Issue ID と安全な失敗の種別だけを示して止まる。`specAssessment` が無い・`suspended`・`recordOnly` は止まる理由にしない。設定の無効化やラベルの削除で制限を迂回しない。
5. `needs-spec` が付いていない。付いていれば、仕様書が添付済みでも `nod issue start` を呼ばずに、`spec-planner` での仕様づくりへ案内して止まる。`needs-spec` を自分で外さない。

条件を満たすと `nod issue start <id>` で着手し、出力に追加指示があれば先に読んで反映する。既存の仕様と計画があれば、それを使う。計画が無ければ、本文から実装・検証できる範囲の軽い Task を `nod issue plan <id> --step "..."` で作業の追跡のために記録する。計画の Document の作成や別の工程の承認は増やさない。仕様が無ければ、本文の要求と完了条件を正本にする。

## 上流の implement の置き換え

`issue-implementer` は上流の `implement` を読み、その各文を次のとおり置き換える。

| 上流の文 | 置き換え |
|---|---|
| Call the Skill tool with "tdd" where possible, at pre-agreed seams. | Task ごとに起動する `task-implementer` が、上流の `tdd` を自動で読み込み、合意済みの seam で行う。 |
| Run typechecking regularly, single test files regularly | Task 中の確認を型検査と変更に関係するテストに絞る。 |
| and the full test suite once at the end. | Task ごとの実装では行わず、仕上げに任せる（必須の検査は後続の Issue で入る）。 |
| Once done, call the Skill tool with "code-review" to review the work. | Task ごとの実装では行わず、仕上げに任せる（レビューの入口は後続の Issue で入る）。 |
| Commit your work to the current branch. | `issue-implementer` が Task ごとに、その Task の自分の変更だけをコミットする。 |

## task-implementer

`issue-implementer` が Task ごとに task で新しく起動する担当で、ほかの用途には使わない。渡された1つの Task（または渡された指摘）だけを、自動で読み込んだ上流の `tdd` の進め方で実装し、結果を返す。コミット・Step の完了の判断・nod への記録は `issue-implementer` が行う。定義の要点は次のとおり。

```md
---
name: task-implementer
model: "@implement-task"
tools: read, write, edit, bash, grep, glob, lsp, ast_edit
autoload-skills: tdd
---
```

- `model`: ロール `implement-task` を参照する。具体的なモデル名は書かない。
- `thinking-level` は書かない。effort はロール `implement-task` の値で決め、定義に重ねて固定しない。
- `tools`: 組み込みのツールを、読み書きと確認に要るものだけにする。`tools` を省くと既定の組み込み一式になり、`task` を持ちうるので明示する。`task` と、agent を起動できる `eval` を含めない。`tools` に `task` を含めると、OMP は `spawns` を `*` として扱う。
- `autoload-skills: tdd`: 最初の依頼の前に、名前だけの `tdd` を読み込む。名前だけの `tdd` は利用者の置き場の上流（`~/.agents/skills/tdd`、mattpocock の `engineering/tdd`）に解決される。nod プラグインには `tdd` が無い。OMP は見つからない名前を黙って無視するので、読み込んだことはセッションの記録で確かめる（下の「確かめ方」）。
- `spawns` は書かない。OMP は `spawns` を書いた定義に `task` ツールを足すためである。
- `advisor` は書かない。

### 渡されるもの

`issue-implementer` は依頼の本文に次を書く。

- Issue ID。
- Task N のタイトルと Step。
- 仕様書の場所。仕様書が無ければ、Issue 本文の全文と、それが正本であること。
- 仕様の Testing Decisions で合意したテストの seam。仕様が無ければ、完了条件と既存のテストに沿って外から観測できる既存の境界を選び、その選択を報告すること。
- 確認を型検査と変更に関係するテストに絞ること。
- 禁止事項と、報告するもの。
- 同じ Task の続きなら、前の担当の報告の要点と、足りないこと。

### 進め方

- 上流の `tdd` の進め方で red → green で実装する。上流の `tdd` はテストを書く前に seam を利用者と確かめるとするが、合意済みの seam が渡されるので聞き直さない。
- 合意した seam では確かめられない境界が本当に要るときだけ、テストを書く前に止まり、既存の seam で何が観測できず候補の seam で何を確かめられるかを親に返す。
- 仕様が無ければ、完了条件と既存のテストに沿って外から観測できる既存の境界を選び、その選択を報告する。
- 確認は型検査と変更に関係するテストに絞る。実行方法はリポジトリの `CLAUDE.md` / `AGENTS.md` に従う。全体のテストスイートは回さない。
- nod を操作できないので、止まるときは理由を親に返すだけにする。作業ログは `issue-implementer` が残す。

### 禁止事項

- コミット・push・PR・nod の操作・外部への書き込みをしない。
- git の状態を変える操作（add・commit・stash・reset・checkout など）をしない。無関係な未コミットの変更に触れない。
- `issue-implementer` とレビュー（nod プラグインのスキルと、現行の3つのレビュー担当を含む）を呼ばない。
- agent を増やさない。

### 返すもの

変更（ファイルごと）・テスト（検査の名前・コマンド・対象・成否）・Step ごとの成否・判断（使った seam か選んだ境界と、決めた細部の理由）・懸念。

## ロール implement-task

`~/.omp/agent/config.yml` の `modelRoles` に `implement-task` を1行足す。既定の値は `anthropic/claude-opus-5-5:high` とする。

```yaml
modelRoles:
  task: <今の値>
  implement-task: anthropic/claude-opus-5-5:high
```

- 担当のモデルと effort を替えるときは、agent 定義ではなくこの値を変える。コードを書く担当のモデルと effort の比較（NOD-122）の結果も、この値で反映する。
- ロールが未登録のときや認証が無いときなどは、OMP が別のモデルで担当を起動することがある（[コードレビュー担当エージェントの配置](code-review-agents.md#ロール)の「ロール」の節）。実際に使われたモデルは、担当のセッションの記録で確かめる。

## Task ごとの流れと記録

Task は1つずつ直列に進める。1つの Task は次の順に進む。

1. `nod issue step <id> <N> doing` にし、今の HEAD の短い SHA を基点の SHA として `progress` の作業ログ（`Task N 開始: 基点の SHA <sha>`）に残す。
2. `task-implementer` を新しく起動する。前の Task の担当を再利用しない。起動できなければ自分で実装せず、`blocker` の作業ログを残して止まる。
3. 担当の報告と差分（未追跡のファイルを含む）から、差分が Task の範囲に収まるか、Step を満たすかを確かめる。足りなければ、新しい担当に足りないことを渡して同じ Task を続けさせる。
4. その Task の自分の変更だけを、ファイルを指定してコミットする。メッセージはリポジトリの既存の書き方に合わせ、nod の Issue ID を書かない。対応する GitHub Issue が同じリポジトリにあるときだけ、作業が済んだ最後のコミットに `Fixes #<番号>` を書く。
5. 手元で実行した確認ごとに `test` の作業ログを残す（下の書き方）。
6. 満たした Step を `nod issue step <id> <N.M> done`、すべての Step を満たした Task を `nod issue step <id> <N> done` にする。満たせなかった Step は `skipped` にせず `doing` のまま残し、理由を作業ログに書く。
7. `progress` の作業ログに `Task N 完了: <何ができたか>。コミット <短い sha>。次: Task M` の形で残す。

選んだ案と理由は `rationale`、進められない Task は `blocker` に原因と要るものを残す。進められない Task に依存する Task も飛ばし、依存しない Task は続ける。ただし、進められない Task の未コミットの変更が残るときは、次の Task の変更と混ざるので、そこで止まる。作業ログは要点だけにし（1件 4000 字まで）、秘密値を書かない。

### test の作業ログの書き方

手元で実行した確認（担当が実行したものと `issue-implementer` が実行したもの）ごとに、検査の名前・コマンド・対象・成否を書く。Task 中のテストは、担当が編集したあと、`issue-implementer` がコミットする前に動く。そのため、動かした時点の HEAD を「確かめた SHA」と書かず、「基点の SHA <sha> と Task N の未コミットの差分で実行」と書き、あとのコミットの SHA を対応先として区別して書く。

```text
型検査: bun run typecheck（対象: リポジトリ全体の型）→ 成功。基点の SHA abc1234 と Task 2 の未コミットの差分で実行。対応先のコミット def5678
```

全テストの件数の照合と必須の検査の記録は、後続の Issue（NOD-171）で扱う。

### テストの seam

- 仕様の Testing Decisions で合意した seam は聞き直さない。
- 本当に別の seam が要るときだけ、テストを書く前に、既存の seam で観測できないことと候補の seam で確かめられることを `blocker` の作業ログに残して止まり、親に返す。担当がそう報告してきたときも同じにする。再開の依頼で受けた回答は `rationale` の作業ログに残す。
- 仕様が無いときは、完了条件と既存のテストに沿って外から観測できる既存の境界を選び、`rationale` の作業ログに残す。

## 再開

中断したあと、別のセッションで同じ Issue を渡すと、`issue-implementer` は「着手条件」のとおりに確かめ、`nod issue start` を呼んでから続きの Task に進む。

- `done` と `skipped` の Task は飛ばす。
- `doing` の Task は、Activity（最後の記録）・`git log`・`git status` から、どこまで進んだかを確かめて続ける。最後の `Task N 開始` の作業ログの基点の SHA より後のコミットがその Task のコミットで、`Task N 完了` の作業ログが無ければ、コミットのあとの記録から続ける。この Issue の変更か判断できない未コミットの変更には触れない。
- 残りの Task のうち、依存先（Task のタイトルの末尾の「依存: …」）がすべて `done` のものから、番号の小さいものを選ぶ。
- 止まったあとの再開では、依頼の本文の回答を、続ける前に `rationale` の作業ログに残す。

## 止まり方

- `nod issue ask` を使わない。止まるときは、`blocker` の作業ログに止まった理由と要るもの（問いがあれば問い・番号付きの選択肢・推奨と理由）を残し、呼び出した親に返す。
- デフォルトのブランチの上での停止だけは、何も書かずに止まる。
- 重要な利用者向けの仕様を決めないと進められないときも、`blocker` の作業ログを残して止まる。
- 利用者の回答は再開の依頼の本文で受け取り、続ける前に `rationale` の作業ログに残す。

## PR を最終成果物にする権限と禁止操作

- 最終成果物は PR である。実装、レビュー、PR の作成、CI チェックの順に進む。
- 最終成果物の PR に必要な push と PR の作成は、追加の承認を求めずに行う。
- マージ・force push・ブランチの削除はしない。
- 無関係な未コミットの変更に触れず、stash しない。コミットには自分の変更だけを入れる。
- PR のタイトル・本文、コミット、GitHub に出るブランチ名に nod の Issue ID を書かない。
- nod プラグインのスキル（`nod:implement`・`nod:code-review`・`nod:to-spec`・`nod:to-plan`・`nod`）と、現行の3つのレビュー担当（`code-reviewer-standards`・`code-reviewer-spec`・`code-reviewer-refute`）を使わない・起動しない。

最後の Task のあとの必須の検査・レビュー・PR の作成・CI の対応の手順は、まだ定義に無い。それが入るまでは、`issue-implementer` は最後の Task を終えたら、終えた Task とコミット・飛ばした Task と理由・実行した確認・Issue の状態を親に返して止まり、レビューの前に PR を作らない。

## 残る危険

禁止操作は、定義の本文の決まり（指示）で守らせるもので、仕組みでは止めていない。

- 指示を受けたことと、できないことは別である。マージ・force push・ブランチの削除や、外部への書き込みは、技術的には実行できる。
- 子の `task-implementer` のコミット・push・nod の操作・外部への書き込みも、担当の定義の本文と `issue-implementer` が渡す依頼の本文の指示で禁じるだけで、仕組みでは止めていない。担当は bash を持つので、技術的には `git push` や `nod` を実行できる。
- OMP の agent 定義は deny を持てず、deny はプロセスの設定で効く（ソースで確認）。利用者の設定に deny が無いことは確かめた。
- task で起動した子に親のセッションの deny がそのまま効くことと、現行の `implementer` に仕組みによる禁止が一切無いことは、どちらも推測で、確かめていない。
- 禁止操作を仕組みで止めることは、後続の Issue（NOD-173）で扱う。

## 確かめ方

この置き場の定義とロールは、新しい `omp` のセッションの task で使える agent の一覧に `issue-implementer`・`task-implementer` として出る。リポジトリの作業ツリー（worktree など）の定義を確かめるときは、利用者の設定を変えずに、`--config` の一時オーバーレイで `extensions` をその作業ツリーの `omp/content` にする（オーバーレイの `extensions` は一覧を丸ごと置き換え、`modelRoles` はキーごとに上書きする）。

```yaml
extensions:
  - <作業ツリーの絶対パス>/omp/content
```

```sh
omp -p --config <上のオーバーレイ> --session-dir <実行ごとの新しいディレクトリ> "<issue-implementer を task で起動する依頼>"
```

`issue-implementer` と `task-implementer` のセッションの記録（`<session-dir>` の下の子の jsonl）と nod の CLI（`nod issue show --json`、`nod doc show`）で、外から見える振る舞いを確かめる。たとえば `needs-spec` の付いた検査用の Issue を渡すと、`nod issue start` を呼ばずに、`blocker` の作業ログに理由を残して止まること。Task を1つコミットしたあとでセッションを止め、新しいセッションで同じ Issue を渡すと、続きの Task から再開すること。nod では、Task/Step の状態と `progress`・`test` の作業ログが残ることを確かめる。

セッションの記録では、次を確かめる。

- `task-implementer` の解決後のモデルが、ロール `implement-task` の値であること。
- `task-implementer` が上流の `tdd` を読み込んだこと。読み込んだ skill の実パスが `~/.agents/skills/tdd` か mattpocock の clone（`engineering/tdd`）であること。
- `issue-implementer` と `task-implementer` が、nod プラグインのスキルと現行の3つのレビュー担当を使っていないこと。
