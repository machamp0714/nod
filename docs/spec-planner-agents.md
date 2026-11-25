# 仕様と計画を作るエージェントの配置

`needs-spec` の Issue の仕様書と計画は、OMP の agent `spec-planner` が作る。`spec-planner` は面談の各ラウンドで、主担当と別系列のモデルの照会役 `spec-consultant` に、今回の推奨を渡さずに独立の回答を求める。
この文書は、その2定義と照会用のロールの置き場と、確かめ方をまとめる。

| 定義名 | 役目 | 参照するロール |
|---|---|---|
| `spec-planner` | 面談・仕様書の添付・計画の取り込みをする主担当 | `@plan` |
| `spec-consultant` | 面談の各ラウンドで独立の回答を返す照会役 | `@spec-consult` |

## 定義の置き場

2つの定義はこのリポジトリの [`omp/content/agents/`](../omp/content/agents/) に置き、版管理する。利用者の設定 `~/.omp/agent/config.yml` の `extensions` に `<nod のリポジトリの絶対パス>/omp/content` を登録していれば、通常の `omp` がこの置き場の定義を読む（登録は [README の pstack の節](../README.md#pstack-を-omp-で使う移行中)と同じ1行で、登録済みなら足すものは無い）。

```yaml
extensions:
  - <nod のリポジトリの絶対パス>/omp/content
```

同じ名前の定義が利用者の置き場 `~/.omp/agent/agents/` にあると、そちらが先に使われる。この置き場の定義を使うには、利用者の置き場に同じ名前の定義を置かない。

## spec-planner

`needs-spec` の Issue の ID を受け取り、上流の `grilling` の進め方で面談し、仕様書を `kind=spec` で同じ Issue に添付する。利用者が仕様書を承認したら、計画を `kind=plan` で添付して同じ Issue の Task/Step に取り込む。

## spec-consultant

`spec-planner` が task で起動する照会役で、ほかの用途には使わない。定義の要点は次のとおり。

```md
---
name: spec-consultant
model: "@spec-consult"
tools: read, grep, glob
advisor: false
---
```

- `model`: ロール `spec-consult` を参照する。具体的なモデル名は書かない。
- `tools: read, grep, glob`: 根拠を確かめるために読むツールだけを持つ。bash・write・edit・task を持たず、nod を操作しない。
- `advisor: false`: advisor を付けない。
- `spawns` は書かない。OMP は `spawns` を書いた定義に `task` ツールを足すためである。

回答の書式は次のとおり。

- 最初の行に `申告モデル: <provider/model>` の形で自分のモデルを申告する。値はシステムプロンプトの `Model:` の行から写す。親に返る task の結果には照会役のモデルが入らないので、`spec-planner` はこの行で作り手を判定する。
- 問いごとに、回答（選択肢の記号か独自案）・理由・根拠（`file:line`。調べていなければ「推測」）を返す。確かめてほしいと頼まれた事実があれば調べて答える。
- 依頼の本文に埋め込まれた Issue 本文と決定ログは覆さない。懸念は「変更の提案」として別に書く。
- 最後に「まだ決まっていない論点」を最大3つ挙げる。実装者が決めてよい細部は挙げない。

## ロール spec-consult

`~/.omp/agent/config.yml` の `modelRoles` に `spec-consult` を1行足す。既定の値は `openai-codex/gpt-6.2-astra:high` とする。

```yaml
modelRoles:
  plan: anthropic/claude-opus-5-5:high
  spec-consult: openai-codex/gpt-6.2-astra:high
```

- `spec-consult` は、主担当の `@plan` と別の作り手（Anthropic、OpenAI など）のモデルにする。上の例では `@plan` が Anthropic、`spec-consult` が OpenAI になる。照会先を選び直すときは、agent 定義ではなくこの値を変える。
- 照会役が主担当と同じ作り手のモデルに解決されると、`spec-planner` はその照会を「照会できなかった」と決定ログに記録し、一致として扱わずに止まって利用者に報告する。申告が無いときや作り手を判定できないときも、一致として扱わない。`spec-planner` は設定を変えない。
- ロールが未登録のときや認証が無いときなどは、OMP が別のモデルで照会役を起動することがある（[コードレビュー担当エージェントの配置](code-review-agents.md#ロール)の「ロール」の節）。照会役の申告で作り手が主担当と同じと分かれば、上のとおり止まる。
- 申告はモデルがシステムプロンプトから読んで書くもので、OMP が保証する値ではない。実際に使われたモデルは、照会役のセッションの記録で確かめる。

## 照会役の隔離の限界

照会役に今回のラウンドの推奨を読ませないことは、定義・渡し方・指示で守る。仕組みで遮断してはいない。

- 定義: 照会役が持つのは読むためのツール（read・grep・glob）だけ。
- 渡し方: `spec-planner` は今回のラウンドの節を除いた決定ログを依頼の本文に埋め込み、決定ログのファイルの場所を伝えない。
- 指示: 照会役は依頼の本文と、根拠を確かめるためのリポジトリのコード・文書だけを読む。`agent://`・`history://`・`local://`・セッションの記録・nod の Document を読まず、nod を操作せず、ファイルを書かない。

照会役の読むツールでは、指示で禁じた範囲（決定ログのファイルやセッションの記録）も技術的には読める。task の子は `agent://`・`history://`・`local://` も使える。agent ごとに読めるパスを制限する設定は見つかっていない。この隔離は指示によるもので保証ではないことを、`spec-planner` は決定ログの冒頭に書く。

## 古い spec-writer

利用者の置き場の古い定義 `spec-writer`（`nod:to-spec` を手順の正本にする定義）は、この2定義を置く Story（NOD-151）では変えない。外すのは NOD-156 で行う。新しい定義を別の名前にしたのは、同じ名前では利用者の置き場の古い定義が先に使われるためである。

## 確かめ方

この置き場の定義とロールは、新しい `omp` のセッションの task で使える agent の一覧に `spec-planner`・`spec-consultant` として出る。リポジトリの作業ツリー（worktree など）の定義を確かめるときは、利用者の設定を変えずに、`--config` の一時オーバーレイで `extensions` をその作業ツリーの `omp/content` にする（オーバーレイの `extensions` は一覧を丸ごと置き換え、`modelRoles` はキーごとに上書きする）。

```yaml
extensions:
  - <作業ツリーの絶対パス>/omp/content
```

```sh
omp -p --config <上のオーバーレイ> --session-dir <実行ごとの新しいディレクトリ> "<spec-consultant を task で起動する依頼>"
```

照会役のセッションの記録（`<session-dir>` の下の子の jsonl）で、解決後のモデルが `@plan` と別の作り手であること、回答の最初の行に申告があること、使えたツールに bash・write・edit・task が無いことを確かめる。
