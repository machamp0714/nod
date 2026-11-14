# コードレビュー担当エージェントの配置

`nod:code-review` の親は、レビューを役割別のレビュー担当エージェントへ委譲する。委譲するのは Standards 探索・Spec 探索・反証の3担当だけで、毎回この3担当へ委譲する。
この文書は、その3定義とロールを omp に配置し、確認する方法をまとめる。定義はリポジトリには置かず、利用者の環境に置く。レビューの手順・資料の境界・判定はスキル（[`plugins/nod/skills/code-review`](../plugins/nod/skills/code-review/SKILL.md)）に書く。スキルとそのスクリプトはモデルを起動しない。担当の起動は親のハーネスの委譲（omp の task）が行う。

| 役割 | 定義名 | 参照するロール | 担当が読む参照ファイル |
|---|---|---|---|
| Standards 探索 | `code-reviewer-standards` | `@review-standards` | `references/standards.md` |
| Spec 探索 | `code-reviewer-spec` | `@review-spec` | `references/spec.md` |
| 反証 | `code-reviewer-refute` | `@review-refute` | `references/refute.md` |

親はこの3定義だけを呼ぶ。定義が使えない場合も、旧 `code-reviewer` やバンドル済みの `reviewer` で代用しない。

## レビュー結果の読み方

報告は2つのDocumentに分ける。「コードレビュー結果」は結論・Severity付きの要対応・未確認・監査参照、「コードレビュー監査」は担当原文・全対応表・証拠と指紋・担当/試行・再照合・現在のhead・基点の照合を保存する。結果の監査参照から詳細へたどれる。同じrunId・対象SHAで対応付け、監査の原文は改変しない。Issueなしでも結果と監査を別ファイルに残す。

Severityは既存の影響度に対応する表示: 0・1=Critical（致命的）、2=High（高）、3=Medium（中）、4=Low（低）。影響度の数値も併記する。未確認事項は不具合とは分けて示し、Severityを付けない。報告を2つに分けても、判定・採点・マージ条件は変えない。

## マージ可否とCI

マージ可否 `可（人のレビューなしでマージ可）` は、最終状態が `完了`・確定した要対応0件（点数 `5`）・確認が残る事項0件・現在の head がレビューした head と同じ・現在の基点がレビューした基点（基点の指定を GitHub のブランチ名に解決したもの）と同じ、のすべてを満たすときだけで、それ以外は `不可（人の判断が要る）` とする（[親の手順](../plugins/nod/skills/code-review/references/parent.md)の10節の8）。CI の結果は条件に含めない。`mode: commit` では head と基点をマージ可否を決める直前と merge-ready を付ける直前に取り直して照合し、基点をブランチ名に解決できないなど照合できないときも不可にする。`mode: local` は常に不可。merge-ready の操作は、本文が `[merge-ready]` で始まる `--kind progress` の作業ログに残る。

NOD-77 の仕様（同じ head SHA の必須 CI の成功をマージ可否に使う）は、NOD-86 の仕様で置き換えた。CI が落ちた PR をマージさせない責務は、GitHub の必須ステータスチェック（ブランチ保護・ルールセット）にある。レビューは CI を照合・待機・記録せず、マージする側（implement・PM・人）は必須ステータスチェック・ブランチ保護・ルールセットを回避しない（`gh pr merge --admin` を使わない）。必須チェックが設定されていないリポジトリでは、CI が落ちていても GitHub はマージを止めないので、マージする側がそのことを報告に書く。基点を SHA で指定されても PR の基点ブランチで必須の CI を照合する NOD-85 は中止した。


## 定義

ユーザー単位の定義として `~/.omp/agent/agents/<定義名>.md` に置く。Standards 探索の例:

```md
---
name: code-reviewer-standards
description: Act only as the Standards exploration role of the nod code-review skill, when the request names "役割: Standards 探索". Not the bundled general-purpose reviewer; never runs the parent procedure or other roles.
model: "@review-standards"
tools: read, bash
autoloadSkills: [code-review]
advisor: false
---
```

他の2定義は `name`・`description`・`model` を各役割に置き換える。必要な項目は次のとおり。

- `name`: 上の表の定義名。バンドル済みの `reviewer`・`security-reviewer` や旧 `code-reviewer` と衝突しない。
- `description`: nod の code-review の指定された役割だけを担当することを書き、汎用の reviewer と取り違えない。
- `model`: 役割ごとのロール別名。具体的なモデル名は書かない。
- `tools: read, bash`: `read` は指定資料とスキルの参照用、`bash` は固定 SHA の Git 読み取りと、親が指定した作業ディレクトリ・自分の一時ファイルへの保存用。別の書き込みツール（`write`・`edit`）は足さない。`exec` は `bash` と `eval` に展開されるので使わない。
- `autoloadSkills: [code-review]`: 最初の依頼の前にスキルを読み込ませる。
- `advisor: false`: advisor を付けない。
- `spawns` は書かない。omp は `spawns` が宣言された定義に `task` ツールを自動で足すため、省略して子エージェントを起動できないようにする。

本文には次を書く。

- 固定役割は1つで、自動読込した code-review スキルの共通規則と、その役割の参照ファイルだけに従う。
- 依頼の役割が無い・曖昧・固定役割と不一致なら、レビューせず何も書かずに入力不備を返す。定義名から役割を補わない。
- 親の手順（`references/parent.md`）や他役の参照ファイルを実行しない。
- 子エージェント・advisor・再帰的な起動をしない。
- 読むのは、依頼で指定された入力、対象リポジトリとして渡された担当用の限定 clone（Git で読む）、依存の写しだけ。ネットワーク（外部 URL の取得を含む）を使わず、nod・親専用領域・他担当のサブディレクトリ・常設データセット・他担当の履歴や出力・作業ディレクトリと限定 clone の外を読まない。
- 書くのは親が指定した自分のサブディレクトリと自分の一時ファイルだけ。限定 clone（object・ref・index・作業ツリー）・依存の写し・共通入力と nod の Issue を変更しない。
- 自動チェック（lint・型検査・ビルド・テスト・再現コード）を実行も受領もしない。

親が自分のエージェント定義の `spawns` で起動先を制限している場合は、3つの定義名を許可に含める（例: 実装を進める `implementer` の定義の `spawns` に `code-reviewer-standards`・`code-reviewer-spec`・`code-reviewer-refute`）。

## ロール

`~/.omp/agent/config.yml` の `modelRoles` に3つのロールを置く。値は利用者が選んで設定する。

```yaml
modelRoles:
  review-standards: <利用者が設定するモデル>
  review-spec: <利用者が設定するモデル>
  review-refute: <利用者が設定するモデル>
```

- 2つの探索ロールが異なるモデルに解決されること、3担当とも実装のモデルと重ならないことは、この設定側の責務である。スキルと親は実行時にモデルを照合せず、利用者にも尋ねない。
- 常設データセットの再評価で採用したのは、探索を分けた構成（集合の版 v4 の採用版。[評価手順の「現在の採用版」](code-review-evaluation.md#現在の採用版)）だけである。v4 に記録された設定は次のとおりで、設定例として使える。

  ```yaml
  modelRoles:
    review-standards: openai-codex/gpt-6-astra:xhigh
    review-spec: anthropic/claude-fable-5-1:high
    review-refute: anthropic/claude-fable-5-1:high
  ```

  v4 の記録には受け入れ確認のロール（`review-acceptance`）の値もあるが、現在の手順は受け入れ確認担当へ委譲しないので使わない。3つのロールをすべて同じモデルにそろえる構成（同一モデルの構成）は、同じ再評価で不合格だったので採用せず、比較用以外では推奨しない。この例を使うときも、実装のモデルと重ならないことは設定側で確かめる（実装が `gpt-6-astra` なら、この `review-standards` は使えない）。採用の結果は評価で使ったモデルでのもので、別のモデルを設定したときの検出性能は確かめていない。
- 反証のロールを探索のどちらかと同じモデルにするか別にするかも、利用者が設定で決める。
- ロール名が違うだけでは、モデルの違いにならない。複数のロールに同じ値を入れれば同じモデルになる。
- ロールの解決には、`task.agentModelOverrides` などエージェント別の上書き（定義の `model` より優先される）、ロールが解決できないときの親モデルへのフォールバック、認証失敗時の親セッションのモデルへのフォールバック、拡張のフックによる置き換えなどが関わる。設定だけでは、各実行が毎回異なる実効モデルだったとは保証できない。報告に載るモデル情報は担当の申告と出典であり、実効モデルの証明ではない。

## 再試行・モデルの自動切り替え・アカウント

有効な結果が返らなかった担当の扱いはスキル（`references/parent.md` の4.1節）に書く。親は、利用枠の上限以外の判定と無関係な理由で無効になった役割だけを、同じ定義・同じ依頼本文で新しい担当へ1回だけ委譲し直し、利用枠の上限による失敗では委譲し直さずに止める。これとは別に、omp は担当のセッションの中で provider のエラーを retry する（omp 内部の再試行）。報告では両者を分けて記録する。別モデルへの自動切り替え・別アカウントへの切り替え・利用枠の回復待ちは、スキルでも担当の定義・アカウント設定でも担保しない。

omp 18.18.8 の関係する設定と既定値（`@oh-my-pi/pi-coding-agent` の `src/session/settings.ts`・`src/session/turn-recovery.ts`・`src/task/executor.ts`）:

| 設定 | 既定値 | 働き | レビュー担当での扱い |
|---|---|---|---|
| `retry.modelFallback` | `true` | provider のエラー後の retry で、`retry.fallbackChains` の別モデルへ切り替える | 無効にする（下の手順） |
| `retry.fallbackChains` | 空 | ロール名またはモデルごとの切り替え先。`default` の鎖は、自分の鎖を持たないロールにも及ぶ。ロールに空の配列を書くと、そのロールは切り替え先を持たない | レビューの3ロールに空の配列を書くか、`modelFallback` を無効にする |
| `retry.usageAwareFallback` | `false` | 利用枠の残りが少ないとき、起動時に別モデルを選ぶ（`modelFallback` が有効なときに働く） | `false` のまま |
| `retry.waitForUsageReset` | `false` | 利用枠のリセット時刻まで待つ | `false` のまま（回復を待たない） |
| `retry.maxDelayMs` | `300000` | provider の待ち要求がこれを超えると、待たずに失敗を返す（`Provider requested <N>ms wait, exceeds retry.maxDelayMs`） | 変えない。親はこの文言や HTTP 429 を利用枠の上限として見分ける |
| `task.agentAccountPools` | なし | エージェント名ごとに使える OAuth アカウントを限る | レビューの3定義には書かない（別アカウントへの切り替えを担保しない） |
| `codexResets.autoRedeem*`・`claudeResets.autoRedeem*` | `unset`（使う前に尋ねる） | 保存済みの利用枠のリセットを使って回復する | レビューのために使わない |

- omp 18.18.8 の担当定義の frontmatter は retry の設定を持たないので、定義ごとに切り替えを無効にはできない。task の呼び出しでモデルを指定した担当は切り替えが無効になるが、ロールの設定を迂回するので親の手順では使わない。
- 切り替えを無効にする手順（利用者が選ぶ。どちらも `~/.omp/agent/config.yml` の変更）:
  1. ロール単位: `retry.fallbackChains` にレビューの3ロールを空の配列で書く。ほかのロールの切り替えは変わらない。

     ```yaml
     retry:
       fallbackChains:
         review-standards: []
         review-spec: []
         review-refute: []
     ```

  2. 全体: `retry.modelFallback: false`。親・実装担当を含むすべてのセッションで切り替えが無くなる。
- `config.yml` を変えずに確かめるときは、`--config` の一時オーバーレイで `retry.modelFallback: false` を指定する（そのプロセスの親と担当だけに効く）。
- 現在の利用者の設定（`config.yml` に `retry` の節が無い）では、`modelFallback` は既定の `true` だが、切り替え先の鎖が空なので、鎖による別モデルへの切り替えは起きない。`retry.fallbackChains` に `default` の鎖を足すと、レビューの3ロールにも及ぶので、そのときは上の手順でレビューのロールを外す。
- 同じ provider に複数のアカウントでログインしていると、omp は利用枠の上限で同じセッションの中の別の認証情報へ切り替えることがある（担当のセッション記録の `credential_pin` は応答したアカウントが変わったときだけ足されるので、2件目以降があれば切り替えがあった）。これは omp 内部の再試行として記録し、親の再委譲とは扱わない。スキルはこの切り替えを前提にしない。
- 認証が無いときの親モデルへのフォールバック（上の「ロール」の節）は `retry.modelFallback` では止まらない。担当の申告とセッション記録のモデルで確かめる。

## 許可する操作と制限の限界

| ツール | 許可する用途 |
|---|---|
| `read` | 依頼で指定された入力ファイルと依存の写し、スキルの共通規則・自分の役割の参照ファイルと雛形 |
| `bash` | 限定 clone の Git 読み取り（`git show <sha>:<path>`・`git diff --no-ext-diff --no-textconv <merge-base> <head>`・`git ls-tree`・`git grep <pattern> <sha>`・`git log`・`git status` などの clone の中の読み取り、`git archive <sha>` の一時ディレクトリへの展開）、依存の写しの読み取り、自分のサブディレクトリと一時ファイルへの保存、指紋の計算 |

- 旧定義 `code-reviewer` には `tools` の指定が無く、既定の組み込みツール一式が使えた。新しい3定義は `read` と `bash` に絞る。
- 固定 SHA の読み取りにシェルが要るため、定義だけでは担当の操作を機械的に制限しきれない。`bash` と `read` があれば、ネットワーク・nod・元のリポジトリ・他担当の出力や履歴・常設データセットなど指定した領域の外を読むことも、指定外の場所へ書くことも技術的にはできる。これらの能力は残っており、スキルと定義本文で使用を禁止しているだけで、完全なアクセス遮断ではない。作業ディレクトリを役割別に分けるのも指示の境界であり、遮断ではない。
- 担当に対象リポジトリとして渡すのは、親が実行ごとに作る限定 clone（head とその祖先と merge-base だけを持ち、他の ref・remote・元の object DB への参照・作業ツリーのファイルを持たない）である。作業ツリーの現状や head から辿れない commit は担当の環境に無いので、それらを探す操作（`git status`・`git log --all` など）は禁止しない。
- omp の task は担当ごとの作業ディレクトリを指定できない。担当の文脈には親セッションの作業ディレクトリのパス（実装後レビューでは元のリポジトリ）が日付と作業ディレクトリの通知として入り、シェルの既定の場所もそこになる（omp 18.18.8 で観測）。限定 clone は元のリポジトリの中身を担当の環境から無くすものではないので、元のリポジトリを読まない規則と、Git を `git -C <対象リポジトリ>` で指定する規則はスキルに残す。
- 担当には、親セッションが自動で読み込んだ規約ファイル（作業ディレクトリの `CLAUDE.md`・`.github/copilot-instructions.md` など。`AGENTS.md` という名前のものは除かれる）と、作業ディレクトリのプロジェクトのスキル一覧が引き継がれる（omp 18.20.0 で観測。MIN-33 の評価では、元のリポジトリの作業ツリーの `copilot-instructions.md` が `<repo-rules>` として3担当へ入った）。固定 head の規約は担当が限定 clone から読むため、配置確認・評価・単独レビュー・通常の実装後レビューのすべてで、[親の手順0.1節](../plugins/nod/skills/code-review/references/parent.md#01-通常レビューも隔離した親から開始する)の空 cwd＋自動読込抑止付き新規親を使う。実装セッションやPMから3担当を直接起動しない。
- `tools` に `bash` を含む定義には、待機に使う `wait` が自動で足される。`tools` に `write` を含めない定義でも、xd:// のデバイス操作と `local://` の一時ファイルにだけ書ける書き込みの経路（`write`）が足され、MCP のツールは xd:// のデバイスとして足される（omp 18.18.6 で観測）。拡張・カスタムのツールも `tools` の指定とは別に足される。
- ネットワークの使用・nod の参照・指定した領域の外の読み取りをした結果は、禁止された情報が文脈に入ったかどうかにかかわらず、独立レビューの有効な証拠として扱わない。

## 配布時の移行（受け入れ確認担当の定義とロールを外す）

NOD-83 の版から、親は受け入れ確認担当へ委譲しない。利用者の環境にある受け入れ確認担当の定義とロールは、この版を main へ反映して配布するまで外さない（配布前にインストール済みの plugin が読む旧版は、まだそれらを使う）。配布前に残っていても、新しい版の親は呼ばない。

配布と同時に、利用者の環境から次を外す。

1. 定義ファイル `~/.omp/agent/agents/code-reviewer-acceptance.md`。
2. `~/.omp/agent/config.yml` の `modelRoles.review-acceptance`。
3. `~/.omp/agent/config.yml` の `retry.fallbackChains.review-acceptance`（書いてあれば）。
4. 親になる定義（`implementer` など）の `spawns` にある `code-reviewer-acceptance`。

外した後に、モデルを起動せずに3担当の設定を確かめる（読み取りだけ。スキルとスクリプトはモデルを起動しない）。

```sh
ls ~/.omp/agent/agents/code-reviewer-*.md          # standards・spec・refute の3つだけ（acceptance が無い）
grep -n "review-" ~/.omp/agent/config.yml          # modelRoles と fallbackChains に review-standards・review-spec・review-refute だけ
grep -rn "code-reviewer-" ~/.omp/agent/agents/     # spawns に3つの定義名があり、code-reviewer-acceptance が無い
```

- 3定義の frontmatter が上の「定義」の節のとおり（`name`、`model` が対応する `@review-*`、`tools: read, bash`、`autoloadSkills: [code-review]`、`advisor: false`、`spawns` なし）であること。
- 2つの探索ロールが異なるモデルに解決され、3ロールとも実装のモデルと重ならないこと（上の「ロール」の節）。
- 通常のスキル解決が新しい版を読むこと: 読み込まれる `skill://nod/code-review` の `references/parent.md` の0節の委譲先が3定義だけであること。
- 実際の委譲は、下の「配置と確認」の3の単独レビュー1回で確かめる（3定義だけへ委譲され、ほかの担当が起動されないこと）。

## 配置と確認

1. 上の3定義を `~/.omp/agent/agents/` に置き、`config.yml` に3つのロールを足す。omp は委譲の直前に定義と設定を読み直すので、実行中のセッションでも次の委譲から使われる。親が `spawns` で起動先を制限する定義（`implementer` など）には3つの定義名を許可に含める。
2. 確認する環境では、レビューに不要な拡張・MCP・記憶機能を外す。拡張は `--no-extensions` でそのプロセスだけ外せる。ユーザー単位の MCP サーバーは `mcp.json` の `disabledServers` でしか外せず、他のセッションにも効くため、外せないときは担当に足された MCP のツールを実効一覧に記録し、使われていないことをツール呼び出しで確かめる。
   リポジトリの作業ツリーにあるスキルで確かめるときは、インストール済みの plugin を変えずに、`--config` の一時オーバーレイで `skills.customDirectories` にリポジトリの `plugins/nod/skills` を指定する。omp 18.20.0 で観測したところ、このスキルは同名の plugin のスキルより優先されない。plugin のスキルは `nod:code-review`（`skill://nod/code-review`）のまま残り、オーバーレイは接頭辞なしの `code-review`（`skill://code-review`）を足すだけである。そのため、依頼では接頭辞なしの `code-review` を名指しし、セッション記録で、読んだ `SKILL.md`・`references/parent.md` と実行した `scripts/` の実際のパスが作業ツリーのもの（plugin のキャッシュ `~/.omp/plugins/cache/` の下ではない）であることを確かめる。
   親の起動（通常レビューにも必須）: [親の手順0.1節](../plugins/nod/skills/code-review/references/parent.md#01-通常レビューも隔離した親から開始する)のとおり `PI_SESSION_FILE`・`PI_SESSION_ID` を引き継がず、`omp -p --cwd <空のディレクトリ> --no-context-files --no-rules --config <上のオーバーレイ> --session-dir <実行ごとの新しいディレクトリ> "<対象repo・基点・head・Issueまたは明示要求だけを渡す依頼>"` で新しい親を起動する。空の作業ディレクトリでも、オーバーレイの作業ツリーのスキルを接頭辞なしの `code-review` で使える。セッション記録は指定した session-dir から探し、既定の場所を決め打ちしない。共通 context は親の手順どおり固定1文だけにする。既にこの経路で起動された親はさらに親を起動せず、結果を呼出元へ返す。起動できない場合は未実施として報告し、既存セッションの直接委譲へ切り替えない。
   入力の境界は、フラグがあることや作業ディレクトリが空であることでは成立としない。親は `-p` の代わりに `--mode rpc` で同じ引数のまま起動し、依頼の後に同じプロセスへ `/dump` を送って、出たシステムプロンプトに `<repo-rules>`・`<file path=…>` の規約ファイルが無いことを確かめる。担当は担当のセッション記録の `session_init` の `systemPrompt` に同じものが無いことと、`skill-prompt` の `details.path` が作業ツリーの `SKILL.md` であることを確かめる。omp 18.20.0 では、元のリポジトリを作業ディレクトリにした親は規約ファイルを受け取り、同じ作業ディレクトリでも `--no-context-files --no-rules` を付けると親・担当とも規約ファイルが無かったが、プロジェクトのスキル一覧は残った。そのため作業ディレクトリは空にする。MCP のツールと説明は抑止されない（上の制限のとおり）。
3. 実際の omp 経路で単独レビューを1回実行し、次を記録する。
   - 3定義へ委譲されたこと、各担当の ID、両探索が並列で、反証が両探索の後に新しく起動されたこと。ほかの担当（受け入れ確認担当を含む）が起動されていないこと。
   - 各担当の実効ツール一覧（自動で足された `wait` などを含む）。
   - 各担当の最初の入力（依頼本文と自動で読み込まれた資料）。反証担当の最初の入力が許可した項目だけで、探索の返答・要約を含まないこと。どの担当も Issue の Activity・添付 Document の写しを受け取っていないこと。
   - 各担当の対象リポジトリが親の作った限定 clone で、元のリポジトリのパスが依頼本文・共通の context・自動で読み込まれた資料・`input/`・`refute-input/` に無いこと。親の記録（作業ディレクトリの `parent/clone.md`）に限定 clone の確認の結果（ref・remote・alternates・`FETCH_HEAD` が無い、commit と object が head から辿れるものだけ、index と作業ツリーが空）があること。
   - 依存の写しが、lockfile のパスと sha256・取得元・指紋の一覧とともに全担当へ同じ場所で渡り（準備できなければ `manifest.md` に理由があり）、担当が依存を外部から取りに行っていないこと。
   - 担当のツール呼び出しに、ネットワーク（外部 URL の取得を含む）・nod・親専用領域・他担当の出力や履歴・常設データセット・元のリポジトリなど、作業ディレクトリと限定 clone の外の読み取りが無いこと。観測が足りないときは合格にしない。
   - 依存の準備の記録（作業ディレクトリの `parent/deps/`）が、各担当の依頼本文・共通の context・自動で読み込まれた資料・`input/`・`refute-input/` に無く、担当がそれを読んでいないこと。
   - ハーネスが示した各担当のモデルと、担当の申告。ロールの設定と一致するかは参考として記録し、実効モデルの証明とは扱わない。
   - 最終状態・確定した要対応の点数・確認が残る事項・マージ可否を別項目にした報告が返り、結果に範囲の固定の注記1文（コードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は別のフローで扱う）があること。確認が残る事項がコードレベルで結論を出せない未確認と保存直前の要求資料・未コミット変更の変化だけであること。
   - 親がテストを実行せず（セッション記録に、テスト用の checkout・依存の準備・テストのコマンドが無い）、CI の結果を照合せずに、最終状態・確定した要対応の点数・確認が残る事項と、現在の head と基点の照合（`parent/head-check.md`）だけでマージ可否を決めたこと。Issue があるときは、merge-ready の付け外しがマージ可否と一致し、判定した head SHA・現在の head と基点の照合・レビューした基点・報告の Document ID が、本文が `[merge-ready]` で始まる `--kind progress` の作業ログに残ったこと。
4. 1回限りの再委譲を確かめるときは、判定の中身と関係しない無効を外から起こす（例: 監視プロセスが最初の探索の `handoff.md` に禁止項目を書き足し、親の形式検査で無効にさせる）。親がスキルの `scripts/review.ts retire-attempt` で最初の試行を `parent/attempts/` へ移し、無効の理由と同じ入力の指紋の確認を `parent/attempts.md` に記録させ、スクリプトが委譲し直してよいと返したときだけ、別の担当 ID の新しい担当へ同じ依頼本文で1回だけ委譲し直したこと（`parent/agents.md` に試行 1・2 の担当 ID と時刻があること）、委譲し直した担当と反証が最初の試行の出力を読んでいないこと、報告に両方の試行が omp 内部の再試行と分けて載ったことを、セッション記録と作業ディレクトリで確かめる。利用枠の上限を起こすために利用枠のリセットや意図的な大量実行はしない。

## 独立性の限界

探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。

通常運用では2つの探索ロールに異なるモデルを設定する。比較評価のために探索のロールを同じモデルに揃えた実行では、報告の独立性の限界の節に、その実行の探索2担当は同じモデルの設定でありモデルの違いによる独立性は無いことを書き添える（報告の雛形に記入欄がある）。
