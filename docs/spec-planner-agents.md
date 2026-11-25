# 仕様と計画を作るエージェントの配置

`needs-spec` の Issue の仕様書と計画は、OMP の agent `spec-planner` が作る。`spec-planner` は面談の各ラウンドで、主担当と別系列のモデルの照会役 `spec-consultant` に、今回の推奨を渡さずに独立の回答を求める。
この文書は、その2定義と照会用のロールの置き場、`spec-planner` への渡し方と流れ、確かめ方をまとめる。

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

`needs-spec` の Issue の仕様書と計画を作る主担当。上流の `grilling` の進め方で面談し、仕様書を `kind=spec` で同じ Issue に添付する。利用者が仕様書を承認したら、計画を `kind=plan` で添付して同じ Issue の Task/Step に取り込む。仕様が添付済みの Issue では、面談せずに計画だけを作ることもできる。実装へは進まない。

上流の `to-spec` と `to-tickets` は、上流の clone（`~/.agents/mattpocock-skills`）の `SKILL.md` をパスで読む。読めなければ止まる。nod プラグインのスキル（`nod:to-spec`・`nod:to-plan` など）は読まない。

### 渡すもの

メインセッションから task で起動し、依頼の本文に次のどれかを書く。Issue の ID は必須で、無ければ対象を聞き返す。

| 頼むこと | 依頼の本文に書くもの | 例 |
|---|---|---|
| 仕様づくり | `needs-spec` の Issue の ID | `NOD-123 の仕様づくりをする` |
| 仕様の承認 | Issue の ID と、承認する仕様の Document ID | `NOD-123 の仕様 Document 456 を承認する` |
| 計画だけ | 仕様が添付済みの Issue の ID。`kind=spec` が複数あれば、元にする Document ID | `NOD-123 の計画だけを作る（仕様は Document 456）` |

- 承認には、`spec-planner` が承認を求めたときに示した Document ID を添える。ID が無いときや違うときは、どの Document を承認するのかを聞き返す。承認は新しいセッションで渡してもよい。決定ログの執筆記録と仕様 Document から続ける。
- 計画だけの依頼で `kind=spec` が複数あり、Document ID が無ければ、どれを元にするかを聞き返す。仕様の無い Issue では、要求・決定事項・受け入れ条件などの材料を依頼の本文に書く。子の agent は会話を持たないためである。材料も無ければ、仕様づくりから始めるよう勧めて止まる。
- 計画が既にある Issue では、置き換える範囲を示して作り直してよいかを聞き返す。依頼で置き換えを明示すれば聞き直さない。

`spec-planner` は、利用者への確認を論点・選択肢・推奨と理由の形で返して止まる。メインセッションは利用者の回答を中継するだけで、合意を作らない。続けるときは、Issue の ID と利用者の回答を依頼の本文に書いて新しく起動する。`spec-planner` は決定ログから続ける。

### 流れ

1. 面談: 上流の `grilling` の進め方で面談する。Issue 本文の決定事項・受け入れ条件・例文は問わない。問いと決定は、同じ Issue に添付した決定ログ（`kind=doc`）に残す。
2. 照会: 各ラウンドで、今回の推奨を渡さずに `spec-consultant` に独立の回答を求める。一致した問いは確定し、割れた問いだけを利用者に聞く。照会の回答の原文と、問いごとの決定者（一致・ユーザー・差し戻し）を決定ログに残す。
3. 仕様の添付と `needs-spec` の解除: 上流 `to-spec` の7節で仕様書を書き、`kind=spec` で添付する。添付を確かめ、未決事項が無いときだけ `needs-spec` を外し、決定の要約を `rationale` の作業ログに残す。
4. 承認待ち: 仕様書の Document ID・要約・承認の対象の指紋を示して待つ。直したいと伝えると、仕様書を作り直してもう一度待つ。
5. 承認: 承認された Document ID を承認を求めた Document と比べ、本文の指紋を示した版と比べる。本文が変わっていれば、計画を作らずに違いを示してもう一度承認を求める。
6. 計画の取り込み: 計画の承認は求めずに、上流 `to-tickets` の分割ルールで Task と Step の計画を作る。計画には元の仕様の Document ID を書き、`kind=plan` で添付して `nod issue plan` で取り込み、Task と Step の数を照合する。
7. `ready-for-agent`: 件数を照合したあとに付ける。
8. `implementer` の案内: 作業ブランチの用意と、`implementer` に Issue ID を渡して実装に進む方法を示して待つ。

計画だけの依頼では 6〜8 だけを行う。どの流れでも、Sub-issue や別の Issue は作らない（仕様の Out of Scope から切り出すと利用者が認めたものを除く）。

終えると、Issue の ID、仕様書・決定ログ・計画の Document ID、実施した検証、未解決の事項を返す。

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

- 定義: 照会役の組み込みのツールは、読むためのツール（read・grep・glob）だけ。
- 渡し方: `spec-planner` は今回のラウンドの節を除いた決定ログを依頼の本文に埋め込み、決定ログのファイルの場所を伝えない。
- 指示: 照会役は依頼の本文と、根拠を確かめるためのリポジトリのコード・文書だけを読む。`agent://`・`history://`・`local://`・セッションの記録・nod の Document を読まず、nod を操作せず、ファイルを書かない。

照会役の読むツールでは、指示で禁じた範囲（決定ログのファイルやセッションの記録）も技術的には読める。task の子は `agent://`・`history://`・`local://` も使える。OMP は MCP のツールを `tools` の指定とは別に足すので、照会役も利用者の設定にある MCP のツールを持つ（NOD-151 の検証で、照会役のセッションの記録の使えるツールの一覧に `mcp__` で始まるツールがあった）。これは定義では外せない。agent ごとに読めるパスを制限する設定も見つかっていない。この隔離は指示によるもので保証ではないことを、`spec-planner` は決定ログの冒頭に書く。

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
