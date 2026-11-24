# nod

**人が判断し、AIエージェントがスクラムを進め、振り返りを次の働き方に反映する開発基盤。**

nodは、AIエージェントを中心としたスクラムの計画、実行、振り返りを支えるデスクトップアプリです。
人が目的や方針を判断し、エージェントが実装や検証などの実務を進めます。
スプリントの成果と進め方を振り返り、そこで得た知見をエージェントへの指示、スキル、開発手順、モデルの割り当てに反映することで、次のスプリントの働き方を改善していきます。

## 解決したい課題と設計の意図

AIとの対話だけで開発を進めると、仕様の決定、実装の途中経過、人への質問が会話の中に混在します。
セッションや担当エージェントが変わるたびに、どこまで決まり、何が未完了なのかを説明し直すことになり、スプリントとしての継続的な改善も難しくなります。

nodは、作業の単位をIssueに揃え、要求、仕様書、実装計画、判断の根拠、テスト結果を一つの文脈として紐付けます。
人はデスクトップアプリから全体像を把握し、未確定の仕様の決定や、AIが発見した追加作業の採否といった判断に集中できます。
エージェントはCLIから同じ情報を読み書きし、前の担当が残した記録と人の回答を確認して作業を引き継ぎます。

さらに、計画から完了までの記録が構造化されて残るため、スプリントの振り返りで「成果物」と「エージェントの進め方」の両方を検証できます。
振り返りの結果をエージェントの定義や手順書へ戻すことで、場当たり的な依頼ではなく、チームの開発基盤として育てていくことを意図しています。

## スクラムにおける人とAIの分担

計画から実行、レビュー、振り返りまでの各段階で、人とAIエージェントの役割を次のように分けています。

| 段階 | 人が行うこと | AIエージェントが行うこと | nodに残るもの |
| --- | --- | --- | --- |
| 要求の整理 | 目的と優先順位を決める | 要望をIssueに整理し、受け入れ条件を具体化する | 要求、完了条件、親子関係、依存関係 |
| 仕様と計画 | 選択肢を検討し、方針を決める | 不明点を質問し、仕様書と実装計画を作る | 質問への回答、仕様書、TaskとStep |
| 実装と検証 | 必要な判断や追加指示を返す | 実装、テスト、進捗報告を行う | 作業ログ、判断根拠、検証結果 |
| レビューと完了 | 変更内容と受け入れ条件を確認する | 規約と仕様への適合をレビューし、指摘に対応する | レビュー結果、PRへのリンク、完了報告 |
| 振り返りと改善 | 成果と進め方を評価し、改善方針を決める | 作業記録や判断待ちの経緯を集約する | 指示、スキル、開発手順、モデル割り当ての改定内容 |



## 主な機能

これらの開発サイクルを回すために、nodは次の機能を備えています。

- **Issueと依存関係の管理**：Workspaceごとに作業を管理し、Project、親子関係、依存関係、優先度で整理します。
- **判断待ちの可視化**：AIからの質問と人の回答をIssueに残し、未回答や依存先の未完了を着手条件に反映します。
- **文脈の引き継ぎ**：仕様書、実装計画、作業ログ、テスト結果をIssueに集約し、担当が変わっても同じ前提から再開できるようにします。
- **人向けのデスクトップアプリとAI向けのCLI**：同じ作業情報を、人は画面から、エージェントはCLIから読み書きします。
- **開発ワークフローのスキル**：バックログ作成から仕様検討、計画、実装、コードレビューまでの手順を定義し、エージェント間で揃えます。
- **GitHubとの連携**：PRをIssueに紐付け、レビュー、CI、マージ状態や差分を取得します。

## Ompによるエージェント管理と改善サイクル

エージェントの管理と実行は [Omp](https://omp.sh/docs/agents-and-roles) に集約しています。  
nodはスプリントやIssue、仕様、人の判断、振り返りの記録を担い、Ompは実務を行うエージェントの定義とモデルの割り当てを担います。

Ompでは、**agent**に役割ごとの指示と使用できるツールを定義し、**role**に使用するモデルを定義します。
agentからroleを参照する仕組みになっているため、作業手順や指示を保ったまま、割り当てるモデルだけを切り替えることができます。
たとえば、実装担当のagentは`@task`を参照し、コードレビューを分担する3つのagent（Standards探索、Spec探索、反証）はそれぞれ`@review-standards`、`@review-spec`、`@review-refute`を参照して、それぞれの特性に合ったモデルをあらかじめ割り当てて運用します。
コードレビューの3つのagentの配置は[コードレビュー担当エージェントの配置](docs/code-review-agents.md)を参照してください。

スプリントの振り返りでは、機能の完成度だけでなく、エージェントがどこで判断に迷ったか、手戻りがなぜ起きたかを確認します。
その分析をもとに、Omp上のagentの指示、nodのスキルや開発手順、roleへのモデル割り当てを見直します。
改定した設定を次のスプリントで試し、人とエージェントの協働の仕方を継続的に改善していきます。

### pstack を OMP で使う（移行中）

[pstack](https://github.com/cursor/plugins/tree/main/pstack) のスキルを、上流の本文を保ったまま OMP で使えます。Claude Code・Codex 向けのプラグインには入りません。pstack（生成したスキル・読み替え表 `pstack-omp`・`poteto-agent`）は、通常の `omp` が OMP の標準の設定（`extensions`・`skills.customDirectories`・`skills.manualSkills`）で読み込みます。

```sh
bun scripts/pstack-omp/cli.ts sync    # scripts/pstack-omp/pin.json のコミットを取得し、OMP 向けのコピーを生成する
bun scripts/pstack-omp/cli.ts apply   # omp/content と生成物を nod のデータ置き場へ写し、~/.omp/agent/config.yml に3つの読み込みの設定を入れる
bun scripts/pstack-omp/cli.ts status  # 適用の状態、いまのプロジェクトで通常の omp が使う tdd、いまのプロジェクトの名前のぶつかりを表示する
bun scripts/pstack-omp/cli.ts remove  # config.yml を適用の前に戻し、写しを消す
```

`apply` は、`omp/content`（読み替え表 `pstack-omp` と `poteto-agent`）と生成物（`manifest.json` とスキルの外のリンク先の文書を含む）を `<データ置き場>/pstack-omp/omp` に写し、写しの全ファイルの sha256 と、設定ファイルを戻すための記録を `harness.json`（利用者だけが読み書きできます）に書きます。続けて、OMP が global の設定として読むファイル（`config.yml`。無くて `config.yaml` が在ればそれ。どちらも無ければ `config.yml` を作ります）に、3つの読み込みの設定を入れます: `extensions` の末尾に写しの `content`、`skills.customDirectories` の先頭に写しの中の生成したスキルの置き場（pstack の `tdd` が利用者の置き場の `tdd` より優先されます）、`skills.manualSkills` に読み込む全スキル（スキルの一覧から外れ、`skill://poteto-mode`・`/skill:poteto-mode` のように名前で呼べます）。既にある値とほかのキーは保ち、再適用で項目を重ねず、設定がそのとおりなら書き換えません。新しく始める `omp` のセッションから効きます。利用者の置き場（`<agentDir>/agents`・`<agentDir>/skills`・`~/.agent/skills`・`~/.agents/skills` と、OMP が読む設定ファイルの `skills.customDirectories`・`extensions` の置き場）に、今回置く定義や生成したスキルと同じ名前のものがあれば止まります（`tdd` だけは止めず、pstack の `tdd` が優先されると知らせます。`disabledProviders` で外した provider の置き場も検査します）。利用者の置き場に在るのに読めない定義やスキルのファイルがあれば、同じ名前かを確かめられないので、そのファイルを知らせて止まります。OMP の版が固定の記録と違うと `sync` と `apply` は止まります。途中で失敗したときは、写しと設定ファイルを前のままにします。

`remove` は、適用の後に設定ファイルが変わっていなければ適用の前のバイト（コメントも）に戻し、変わっていれば管理対象の項目（写しの中を指す `extensions`・`skills.customDirectories` の項目と、適用が `skills.manualSkills` に足した名前）だけを外して、ほかの値を残します（適用が作ったキーは、外して空になれば消します）。続けて写しを消します。次に始める `omp` のセッションから、pstack は読み込まれません。適用と解除は繰り返しても結果が変わらず、OMP の版が違っても `remove` は行えます。写しが別の OMP の設定の置き場（`PI_CODING_AGENT_DIR`）に適用したものなら、`apply` と `remove` は写しを消さずに止まります。名前つきの profile（`OMP_PROFILE`・`PI_PROFILE`）や `~/.omp` でない設定の根（`PI_CONFIG_DIR`）を選んでいると、OMP がどの置き場の設定を読むかを決められないので、`apply`・`remove`・`status` は止まります（`sync` は行えます）。

旧管理配置（写しの専用ランチャー `bin/omp` と制御の置き場 `control/` を使っていた配置、`config.yml` に制御の拡張と読み込みの設定を入れていた配置）から `apply` か `remove` を実行すると、写しの専用ランチャー・制御の拡張・規則・サンドボックスのプロファイルは写しの置き換えか削除で無くなり、`config.yml`・`config.yaml` からは旧管理値（写しの中を指す `extensions`・`skills.customDirectories` と、旧の記録が足した `skills.manualSkills` の名前）だけを取り除いて、利用者の値を保ちます。旧の記録があり、その後 `config.yml` が変わっていなければ、旧の適用の前のバイトに戻します（`apply` はそれを適用の前として記録するので、続く `remove` で旧の適用の前に戻ります）。記録が無くて `skills.manualSkills` の名前を外せないときは外さず、残った名前を知らせます。

pstack 専用の制限（専用ランチャー、制御の拡張、サンドボックス、ツールや bash の deny）は置きません。何を制限するかは別に決めます。通常の OMP・GitHub の既存のルール（`config.yml` の既存の値、ブランチ保護など）は変えません。

`status` は、適用の状態（写しの全ファイルと記録の sha256 の照合、OMP が読む設定ファイルの3つの読み込みの設定、旧管理配置の残り、生成物の pin、OMP の版）を表示し、どれかが欠けていれば何が欠けているかと、`apply` し直すか `remove` するよう案内します。続けて、通常の omp が実行したディレクトリで実際に読むスキルを、OMP 19.1.0 と同じ置き場・読み込みの条件・同じ名前の優先の順で集め、裸の名前 `tdd` を取るものを表示します（pstack の `tdd` なら、利用者やプロジェクトの `tdd` が `<名前空間>/tdd` の名前になることも添えます）。置き場は `skills.customDirectories` と、provider の `native`（プロジェクトの `.omp/skills`、`<agentDir>/skills`）・`omp-plugins`（`extensions` のパッケージの `skills/`）・`claude`（`~/.claude/skills` は `enabledProviders`・`skills.enableClaudeUser`・`CLAUDE_CONFIG_DIR` で有効にしたときだけ。プロジェクトの `.claude/skills`）・`agents`（プロジェクトの `.agent/skills`・`.agents/skills`、`~/.agent/skills`・`~/.agents/skills`）・`codex`・`opencode`・`github`・`omp-managed` の置き場です。プロジェクトの置き場は、実行したディレクトリから git の作業ツリーの根まで（git の外ならホームの手前まで、ホームの外ならファイルシステムの根まで。`.omp/skills` は一時ディレクトリの手前まで）遡った祖先です。`enabled: false` のスキルと、`description` が無いと読まない置き場の `description` の無いスキルは数えず、`disabledProviders`・`enabledProviders`（path で範囲を決めた項目は、実行したディレクトリで解きます）・`skills.enabled`・`skills.enable*`・`skills.ignoredSkills`・`skills.includeSkills`・`disabledExtensions` の `skill:<名前>` を OMP と同じく当てます。そのうえで、実行したディレクトリのプロジェクトの置き場にある、今回の定義やスキルと同じ名前のもの（エージェント定義は OMP と同じくファイルシステムの根まで遡って最も近い `.omp/agents`。git の根より上やホームの `~/.omp/agents` も含みます）を表示します。設定は OMP が global の設定として読むファイルの値で決め（読めなければ OMP の既定の設定で選んだと添えます）、プロジェクトの設定の層は見ません。入れたプラグイン（`~/.omp/plugins/node_modules`）・プラグインの登録（`installed_plugins.json`）・Agent Plugins の形のパッケージ（根に `plugin.json`）・skillshare の `skills.lock.json` から読むスキルは中を調べず、選んだ `tdd` より先に読まれうるときは、そこに `tdd` があればそちらが使われることを添えます。写しや設定が読めなくても、`status` は止まらずに読めないことを表示します。

利用者の本設定を変えずに試すときは、一時的な置き場を指してください（例: `PI_CODING_AGENT_DIR=/tmp/omp-agent NOD_DATA_DIR=/tmp/nod-data bun scripts/pstack-omp/cli.ts apply` の後、同じ `PI_CODING_AGENT_DIR` を付けて `omp` を起動します）。

## 使い始める

### 必要なもの

- Apple Silicon搭載のMac
- Bun、Git、Rust、Xcode Command Line Tools
- AIと協働する場合は、Ompの実行環境とモデル提供サービスの認証
- GitHub連携を使う場合は、認証済みのGitHub CLI（`gh`）

### デスクトップアプリの導入

nodはmacOS向けのTauri v2アプリです。
現在はソースから手元のMacでビルドして使用します。

```sh
git clone https://github.com/machamp0714/nod.git
cd nod
bun install
bun run desktop:deploy
```

導入処理はアプリをビルドして`~/Applications/nod.app`に配置し、起動します。
CLI用の`~/.local/bin/nod`も、アプリ内の実行ファイルを呼び出すラッパーとして配置します。
導入には未コミットの変更がない作業ツリーが必要です。
既存アプリやCLIの置き換えを含む手順は、[デスクトップアプリの導入説明](packages/desktop/README.md#導入初回も更新も-desktopdeploy)を参照してください。

別のターミナルで、管理したいリポジトリをWorkspaceとして登録します。

```sh
cd /path/to/your-project
nod init
nod issue create "検索結果を更新日時順に表示する"
nod issue list
```

Workspaceは管理対象のリポジトリに対応します。
Issueの要求と完了条件は、デスクトップアプリまたはCLIから記入します。

### AIエージェントへの手引きの組み込み

CLIの基本的な操作手引きは[`skills/nod`](skills/nod/SKILL.md)に、開発工程ごとの手順は[`plugins/nod/skills`](plugins/nod/skills)にまとまっています。
これらをOmpの各agentの指示やスキルに組み込むことで、すべてのエージェントが共通の手順でnodを操作できるようになります。
利用するモデルの選択は、Ompのrole側で管理します。

プラグイン0.8.0では、コードレビューを3担当に統一し、親の定型処理・区間別計測を同梱スクリプトへ集約しています。受け入れ確認担当の定義・ロール・起動許可は新版の配布と同時に外します。移行対象と確認方法は[配布時の移行](docs/code-review-agents.md#配布時の移行受け入れ確認担当の定義とロールを外す)を参照してください。ブラウザ・デザイン・実環境・作業手順の検証は別フローで扱います。

プラグイン0.9.0では、コードレビューがCIの結果を照合しなくなりました。マージ可否（merge-readyラベル）は、レビューが完了し、確定した要対応0件・確認が残る事項0件で、現在のheadと基点がレビューした版と同じかだけで決まります。CIが落ちたPRのマージを止めるのはGitHubの必須ステータスチェック（ブランチ保護・ルールセット）の役割です。implement・PMはそれを回避せず、提出・マージの報告に基点ブランチの必須チェックの設定を読んだ結果（設定あり・未設定・確認できない）を書きます。

プラグイン0.10.0では、コードレビューの親が使うtokenを減らしました。親は担当の起動から終了までをompのevalの1つのセルで待ち、手順書を常に読む本体（`parent.md`）と異常時だけ読む付録（`parent-details.md`）に分けて読み、担当の入力境界の確認を同梱スクリプトの`check-boundary`で行います。担当は渡されたSKILL.mdを読み直しません。使用量の集計には読み取り量と生成量が加わりました。to-specは仕様書の執筆を主担当の執筆と照合に戻し、執筆依頼スクリプトを削除しました。

プラグイン0.10.1では、コードレビューの親が担当へ委譲するときに渡す共通のcontextを、最初から固定の1文にしました。ompのtaskは空のcontextを拒否するため、空のcontextで担当を起動すると失敗し、起動し直すことになります。固定の1文を最初から渡すことで、この無駄がなくなります。

プラグイン0.10.2では、差分のファイル名が秘密情報を含み得る名前（`.env.example`などを含む）に当たっても、コードレビューが未実施で止まらなくなりました。秘密情報をLLMに読ませないようにするのはハーネスの責務とし、レビューから秘密候補の検査と、担当が秘密候補を読まない規則を削除しました。

プラグイン0.10.3では、コードレビューが報告を保存し終えた後に、最終状態にかかわらず作業ディレクトリの依存の写し（`deps/`）と担当用の限定clone（`repo/`）を片付けるようになり、レビューごとに数百MBが残らなくなりました。片付けた結果は`parent/cleanup.md`に記録されます。監査と結果のDocumentやそのほかの記録は、これまでどおり残ります。

プラグイン0.10.4では、コードレビューの反証がSpec探索の「充足」の行を確かめ直さなくなりました。反証は、Spec探索の「未充足」「未確認」の行と、要対応の候補に合わせて「充足」から「未充足」に変えた行だけを判定本文に書き、親のスクリプトがSpec探索の対応表に重ねて確定した対応表を監査記録に残します。Spec探索は「充足」の行を同じ要求資料の連続する要求でまとめ、証拠を固定版の場所だけで書きます。反証は対応表に行を足したり除いたりしなくなり、見落とし探しでは候補の結び付いていない要求（「充足」として載っているだけの要求を含む）も優先して見ます。

エージェントからnodのCLIを実行する際は、環境変数`NOD_ACTOR`で書き手を明示します。
Ompのagentに対応する書き手名を設定し、誰がどの判断や作業を行ったかを記録します。

## 技術アーキテクチャ

[技術アーキテクチャ図（draw.io形式）](docs/images/nod-architecture.drawio)

デスクトップアプリはTauri v2を採用し、React製の画面を内蔵WebViewに表示します。
アプリが同梱CLIの`nod ui`をsidecarとして起動し、画面はlocalhost上のHono APIと通信します。
Tauri側がsidecarの起動、終了、異常終了時の再起動を管理します。

ターミナルやエージェントから使うCLIは、共通処理を直接呼び出します。
デスクトップアプリとCLIは同じSQLiteデータベースを参照し、仕様書や添付資料はローカルファイルとして管理します。
保存先を共有しているため、デスクトップアプリを終了していてもCLIから作業を継続できます。

図のAIサービス欄には、利用しているサービス名を記載しています。
サービスそのものと推論に使うモデルは区別しており、Ompのroleに対して各サービスで提供されるモデルを割り当てます。

外部サービスへの接続境界と経路は、用途ごとに次のように分かれています。

| 接続先 | 接続元と経路 | 用途と渡す情報 |
| --- | --- | --- |
| Claude Code / Codex / Google Antigravity | Ompでroleに割り当てたモデルへ接続 | エージェントに渡した依頼や、作業で参照する文脈をもとに推論する |
| GitHub | nodの共通処理からGitHub CLI（`gh`）を実行 | Issueの取り込みと公開、PRの状態と差分の取得を行う。公開時はIssueのタイトルと本文を送る |
| TypeSafe / Jev | nodの共通処理からHTTPSで接続 | 仕様要否判定が有効な場合にIssue本文を送る |
| Toggl Track | nodの共通処理からHTTPSで接続 | 打刻の取得、開始、停止などの時間記録を操作する |

Orcaはローカル側の連携ツールとして図示しています。
リモート実行環境を使う場合の接続は、Orca側が管理します。

## CI

[CIのワークフロー](.github/workflows/ci.yml)は、すべてのPR（基点ブランチで絞りません）とmainへのpushで、`test`・`typecheck`・`lint`の3つのチェックを実行します。
PRでは、PRのheadとその時点の基点を組み合わせた合成merge commitを検査します。
ランナーは`macos-latest`で、Bunの版は`.bun-version`で固定しています。`bun.lock`が無いと失敗し、依存は`bun install --frozen-lockfile`で入れます。
失敗したジョブを自動で再試行することはありません。

| チェック | 内容 |
| --- | --- |
| `test` | `cargo`と`swiftc`があることを確かめ、ルートで`bun run test`を実行し、JUnit形式の結果を許可するskipの一覧と照合する。テストと照合のどちらが失敗しても失敗になる |
| `typecheck` | ルートの`bun run typecheck`と、`packages/web`の`bun run typecheck`を実行する |
| `lint` | `bun run lint`（oxlintの既定の規則、`--deny-warnings`）を実行する。警告も失敗になる |

### 許可するskipの一覧

`test`は、実際にskipされたテスト（`test.todo`を含む）が[`test/allowed-skips.json`](test/allowed-skips.json)と完全に一致するときだけ成功します。照合は`scripts/check-test-skips.ts`が行います。
一覧の各項目は、`file`（テストファイル）、`name`（describeの名前を外側から並べ、最後にテストの名前を置いた配列）、`reason`（skipを許す理由）を持ちます。
次のどれかがあると失敗します。

- 一覧に無いskipや`test.todo`
- `describe.skip`のフックなど、名前で特定できないskip（一覧でも許可できません）
- 一覧にあるのに実行された項目や、結果に無い項目
- JUnitの結果ファイルの欠落や解析の失敗

失敗時の出力には`一覧に無い skip: <file> ["describeの名前","テストの名前"]`の形で項目が出ます。ファイルと配列をそのまま`file`と`name`に写し、`reason`を書き足します。
一覧は環境の都合で実行できないテストのためのもので、不安定なテストを外す逃げ道には使いません。
条件によってskipするときは、describeごとではなく`test.skipIf`でテストごとにskipします。

### Lintの規則を無効にするとき

[`.oxlintrc.json`](.oxlintrc.json)の`overrides`に項目を足し、規則の名前・理由・適用範囲をコメントで書いたうえで、`files`で適用範囲を必要なファイルだけに絞ります。
baselineや指摘を抑止するファイルは置きません。

### mainの保護とPRの運用

mainには従来のブランチ保護（ルールセットではないもの）を設定しています。

- `test`・`typecheck`・`lint`を必須チェックとし、GitHub Actionsのアプリに結び付けています。同じ名前のcommit statusでは満たされません。
- 管理者にも適用しています（enforce_admins）。
- strict（マージ前に基点の最新への追従を求める設定）は無効です。PRの実行の後に進んだmainとの組み合わせは、mainへのpushの実行が検査します。
- PRのレビュー承認の必須化と、PRを必須にする設定はありません。
- force pushとブランチの削除は禁止しています。

mainへの変更はPR経由に統一し、管理者による迂回の運用は設けません。これは設定ではなく運用の規則です。
必須チェックにより、チェックが成功していないcommitは管理者も含めてmainへ直接pushできませんが、成功済みのcommitの直接pushは設定上は可能です。
保護の設定より前に開いたPRも例外にせず、最新のmainを取り込んでCIを通してからマージします。

### 失敗したとき

PRのChecksから失敗したジョブのログを開き、失敗したステップを確認します。`test`のJUnitの結果は、実行のartifact`bun-test-junit`から取得できます。
次の項のコマンドで手元で再現し、原因を直してpushします。CIは自動で再試行しません。
不安定なテストを手動の再実行で通したときは、そのことをPRに書きます。

### 手元での実行

```sh
bun install --frozen-lockfile
bun run test
bun run lint
bun run typecheck
cd packages/web && bun run typecheck
```

`bun test`を直接使うと`--timeout`が付かず、既定のタイムアウトが5秒になるため、全体の実行には`bun run test`を使います（`bunfig.toml`の`timeout`はBunに読まれません）。

skipの照合まで手元で行うときは、JUnit形式の結果を出してから照合します。

```sh
bun run test --reporter=junit --reporter-outfile=/tmp/bun-test-junit.xml
bun scripts/check-test-skips.ts /tmp/bun-test-junit.xml test/allowed-skips.json
```

通知のテストの実行には、macOSと`cargo`・`swiftc`が必要です。無い環境では通知のテストがskipされ、照合では一覧に無いskipとして失敗します。
また、手元に`bun run desktop:build`の成果物があると、一覧にあるデスクトップアプリの成果物の検査が実行され、照合では一覧にあるのに実行された項目として失敗します。
