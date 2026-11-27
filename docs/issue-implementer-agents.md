# Issue を実装するエージェントの配置

nod の Issue の実装は、OMP の agent `issue-implementer` が進める。`issue-implementer` は着手条件を確かめてから `nod issue start` で着手し、Task ごとに実装して、進みと判断を nod に残す。最終成果物は PR である。
この文書は、その定義の置き場、`issue-implementer` への渡し方、着手条件と止まり方、PR を最終成果物にする権限と禁止操作、残る危険、確かめ方をまとめる。

仕様の出典は NOD-170 の仕様（Document 2010）である。

| 定義名 | 役目 | 参照するロール |
|---|---|---|
| `issue-implementer` | 着手条件を確かめて着手し、Task ごとに実装して nod に記録し、最終成果物の PR を作る主担当 | `@task` |

## 定義の置き場

定義はこのリポジトリの [`omp/content/agents/`](../omp/content/agents/) に置き、版管理する。利用者の設定 `~/.omp/agent/config.yml` の `extensions` に `<nod のリポジトリの絶対パス>/omp/content` を登録していれば、通常の `omp` がこの置き場の定義を読む（登録は [README の pstack の節](../README.md#pstack-を-omp-で使う移行中)と同じ1行で、登録済みなら足すものは無い）。

```yaml
extensions:
  - <nod のリポジトリの絶対パス>/omp/content
```

定義の frontmatter は次のとおり。

```md
---
name: issue-implementer
model: "@task"
thinking-level: medium
---
```

- `model`: ロール `task` を参照する。具体的なモデル名は書かない。
- `thinking-level: medium`: 現行の `implementer` と同じ値にする。

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

最後の Task のあとの必須の検査・レビュー・PR の作成・CI の対応の手順は、まだ定義に無い。それが入るまでは、`issue-implementer` は最後の Task を終えたら結果を親に返して止まり、レビューの前に PR を作らない。

## 残る危険

禁止操作は、定義の本文の決まり（指示）で守らせるもので、仕組みでは止めていない。

- 指示を受けたことと、できないことは別である。マージ・force push・ブランチの削除や、外部への書き込みは、技術的には実行できる。
- OMP の agent 定義は deny を持てず、deny はプロセスの設定で効く（ソースで確認）。利用者の設定に deny が無いことは確かめた。
- task で起動した子に親のセッションの deny がそのまま効くことと、現行の `implementer` に仕組みによる禁止が一切無いことは、どちらも推測で、確かめていない。
- 禁止操作を仕組みで止めることは、後続の Issue（NOD-173）で扱う。

## 確かめ方

この置き場の定義は、新しい `omp` のセッションの task で使える agent の一覧に `issue-implementer` として出る。リポジトリの作業ツリー（worktree など）の定義を確かめるときは、利用者の設定を変えずに、`--config` の一時オーバーレイで `extensions` をその作業ツリーの `omp/content` にする（オーバーレイの `extensions` は一覧を丸ごと置き換え、`modelRoles` はキーごとに上書きする）。

```yaml
extensions:
  - <作業ツリーの絶対パス>/omp/content
```

```sh
omp -p --config <上のオーバーレイ> --session-dir <実行ごとの新しいディレクトリ> "<issue-implementer を task で起動する依頼>"
```

`issue-implementer` のセッションの記録（`<session-dir>` の下の子の jsonl）と nod の CLI（`nod issue show --json`、`nod doc show`）で、外から見える振る舞いを確かめる。たとえば `needs-spec` の付いた検査用の Issue を渡すと、`nod issue start` を呼ばずに、`blocker` の作業ログに理由を残して止まること。セッションの記録では、nod プラグインのスキルと現行の3つのレビュー担当を使っていないことを確かめる。
