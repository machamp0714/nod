# レビュー担当の設定と単独・実装後レビューの受け入れ

## 責務と配置先

レビューの手順は `plugins/nod/skills/code-review/`、使用モデルはompのrole設定、委譲は親エージェントが担当する。
CLIは資料の固定、工程入力の提供、探索と検証の記録を行い、担当を起動しない。
単独レビューでも親が探索担当と新規コンテキストの検証担当へ順に2回委譲する。

ユーザー単位の定義は `~/.omp/agent/agents/code-reviewer.md`、role設定は既存の `~/.omp/agent/config.yml` に置く。
エージェント定義ファイルをnodリポジトリへ同梱しない。
以下は利用環境へ配置する内容の説明であり、配置済みであることだけを実行確認としない。

## code-reviewerの定義

定義のfrontmatterには次を指定する。

```yaml
---
name: code-reviewer
description: Execute only the assigned exploration or verification phase of an independent nod code review.
model: "@review"
autoloadSkills: [code-review]
spawns: []
advisor: false
---
```

この配置例は `autoloadSkills` のcamelCase表記を使う。
この環境の既存implementerの `autoload-skills` もfrontmatter正規化を経て解釈され、実行記録の `skill-prompt` に更新implementの自動読込先が残る。既存表記を無効とみなして不要に変更しない。
`spawns: []` は子担当を許可せず、`advisor: false` は追加の相談担当を付けない。
思考レベルを定義側で記載する場合、この例では `thinkingLevel` とする。既存の `thinking-level` もfrontmatter正規化の対象である。
通常はroleの設定に任せ、ここでは省略する。
frontmatter正規化の後にompの `src/discovery/helpers.ts` の `parseAgentFields` が解釈する。配置表記だけでなく `skill-prompt` の実際の解決先を観測する。

本文には次の権限と工程境界を記載する。

- 自動読込された `code-review` のうち親から指定された探索または検証だけを実行する。
  親の委譲手順を実行せず、子、advisor、再帰起動を行わない。
- 探索は渡された対象と資料を使い、prepare、両計画の固定、両軸の探索、中間記録まで行って終了する。
  local対象では `--local --head HEAD` または `--head` 省略を使い、観測した現在HEADの具体SHAを `--head` に渡さない。
- 検証は工程、runId、保存ディレクトリだけを受け取り、まず `review input --phase verification` を実行する。
  返された入力とschema、その参照先の固定資料とコードだけをレビュー入力として読む。
  探索の原記録、raw出力、親report、準備や計画の原記録、会話やセッション、他担当の履歴から禁止情報を回収しない。
  親へ探索の要約を求めず、原因統合と整合性を自分で判断し直す。
- 対象workingtree、index、commit、nodのIssueを変更しない。
  書き込みはCLI保存先と担当用の一時ファイルに限る。
  自動チェックを実行も受領もせず、固定コードと契約を読解する。
- 自分の識別情報と知りうる申告、runId、保存先、対象版、工程状態と結果を返す。
  申告を埋めるために他担当のモデル情報や会話を読まない。
  両担当IDの対応付けとnodへの作業ログは親へ任せる。

## reviewロール

既存configの他の項目を保持し、`modelRoles` にレビュー専用roleを追加する。
今回の承認済み設定は次の1項目である。

```yaml
modelRoles:
  review: openai-codex/gpt-6-astra:high
```

この例で既存config全体を置き換えない。
既存の `modelRoles.task` や他のroleは変更しない。
実装担当と異なるモデルを使う責務はこの設定側に置き、具体的なモデルやproviderの選択手順をレビュー用スキルへ戻さない。
探索と検証で別のroleやモデルを設けることは必須ではなく、独立性は新しい委譲による別コンテキストで確保する。
実行時のモデル照合、利用者への課金条件の確認、追加購入や課金方式の自動変更は行わない。

両担当のモデル情報は知りうる範囲の申告と出典として記録される。
不明なら `value=null,source=null,status=unverified` とし、実効モデルの証明や停止条件にしない。
申告不明と要求の未確認を混同しない。

## implementerからの委譲許可

既存のユーザー定義 `~/.omp/agent/agents/implementer.md` の許可に `code-reviewer` を追加する。

```yaml
spawns: [task, code-reviewer]
```

既存のmodel、thinking-level、advisor、autoload-skillsなど無関係の設定は維持し、既存定義全体をこの例で置換しない。
指示文は更新した `nod:implement` の仕上げに接続する。探索へrepo・基点・対象・Issue/Spec/plan・規約所在を渡し、fresh検証へは工程・runId・保存先だけを渡す。レビュー担当が子を起動する構成にしない。
親はshowと同じrunId・targetの実在する最終execution.jsonを照合し、両担当の定義名と担当IDをrunId・保存先・対象版へ対応付けて作業ログと報告に残す。
prepareから最終検証記録まで親もIssueのStep・ログ・状態・要求・計画を変更しない。Issue.updatedAtやplanの変更検出を避けるため途中のID等はローカルに保持し、最終照合後に一括記録する。途中終了は試行が終わってからblockerを残す。
PMの初回受理は両担当の組と実装者からの独立性を確認するが、既存の実装workerのモデル照合を削除しない。修正後は既存指摘IDと修正差分だけのsingle独立確認、最大2巡を維持する。

## 単独レビューの親への入力

親はrepo、基点、対象版、要求と資料の所在を保持する。
例えば次の依頼を親セッションへ渡す。

```text
単独レビューの親としてcode-review skillの親の入口に従う。
repo: /path/to/repo
base: 対象repoの基点refまたはSHA
対象: HEADのcommit差分（localを依頼する場合だけその指定と未追跡パスを列挙）
要求: Issue IDまたは要求Documentの所在
資料: 既知のSpec、現在計画、規約の所在
探索担当へ上記を渡し、中間記録後、新しい検証担当へは工程、runId、保存ディレクトリだけを渡す。
親自身で探索や採点せず、検証記録の実在を照合して結果を返す。
```

1回目はレビュー担当エージェントへ工程「探索」と上記の対象情報を渡す。
2回目は同じ定義から新しい担当を作り、初期入力と共有contextを次の3項目だけにする。

```text
工程: 検証
runId: 探索担当から返った実行ID
保存ディレクトリ: CLIの同じ実行の保存ディレクトリ
```

探索の返答、要約、所見、会話、実装者の自己評価、工程メタデータ、原因グループ、総合判断を中継しない。
検証担当の自動読込スキルと定義が手順を提供するため、探索時の説明を添える必要はない。
同じ担当の継続ではなく新規委譲を使う。
ハーネスが履歴を自動継承する場合も、その継承を無効化できる経路を使う。
独立した委譲を行えない環境では自己レビューへ代替せず、未実施と理由を返す。

## 統合ownerが行う実経路の受け入れ

受け入れは実ompによる手動の境界確認であり、静的文章grepを新しい自動テストの境界にはしない。
以下のコマンドや委譲を実際に行っていない段階は「配置済み、実経路未実施」と報告する。

更新CLIを呼ぶprocess限定PATHラッパーと、今回だけのsession設定を用意した環境では、親を次の形で起動する。
`REVIEW_RUNTIME` は受け入れ用ディレクトリ、`REVIEW_REPO` はこのnod作業ツリーの絶対パスとする。
`standalone-prompt.md` には実repo、基点、対象、要求の所在を埋めた上記の親への依頼を保存する。

```sh
PATH="$REVIEW_RUNTIME/bin:$PATH" command -v nod
REVIEW_RUNTIME="$REVIEW_RUNTIME" \
PI_SHELL_PREFIX='export PATH="$REVIEW_RUNTIME/bin:$PATH";' \
PATH="$REVIEW_RUNTIME/bin:$PATH" omp \
  --config "$REVIEW_RUNTIME/session.yml" \
  --plugin-dir "$REVIEW_REPO/plugins/nod" \
  --model openai-codex/gpt-6.1-sol --thinking high \
  --session-dir "$REVIEW_RUNTIME/sessions" \
  --no-lsp --no-pty --no-title --mode json \
  -p "@$REVIEW_RUNTIME/standalone-prompt.md"
```

起動時のPATH指定に加え、process限定の `PI_SHELL_PREFIX` でomp native shell内にもラッパーのPATHを設定する。
`REVIEW_RUNTIME` も同じprocessの環境へ渡し、prefixの実行時に参照できるようにする。
native shellでは起動時のPATHだけではinstalled nodが解決される場合があり、legacy向けの `shellCommandPrefix` 設定では修復しない。
旧CLIを解決して停止した受け入れは未実施として保持し、環境修復後の開発受け入れはownerが別sessionと新しいrunで行う。

`--model` はこの受け入れ親の指定であり、`code-reviewer` の `@review` は既存のrole設定から解決する。
Task担当への今回限りの上書きが必要ならsession設定の `task.agentModelOverrides` に置き、永続 `modelRoles.task` を変更しない。
インストール済みnod.appや既存pluginを置き換えず、`--plugin-dir` で更新スキルを選ぶ。

ownerは次を実行記録へ残す。

1. 実際の `command -v nod` の結果と、親および両担当が読み込んだ `code-review` のファイルパス。
   更新CLIと更新スキルが解決されたことを確認し、古いcacheの読込を成功扱いにしない。
2. 親から探索、新規コンテキストの検証への2回の委譲と、各担当の定義名、担当ID。
   code-reviewerが子を起動していないこと、引き継いだ対象の再質問やモデル、課金条件の確認による停止がないこと。
3. 記録された検証担当の `session_init` と最初のuser入力などから、工程、runId、保存先以外の探索文脈が継承されていない証拠。
   担当IDの違いだけで非継承を証明しない。
   ownerが観測する証跡を検証担当の入力へ戻さない。
4. 同じrunIdに対する `exploration.json` と `execution.json` の保存と、親への最終結果の返却。
   各担当の申告、対象版、状態、点数、要求別対応、指摘、未確認を照合する。
5. 元workingtree、index、commit、Issueの不変と、自動チェックの実行や受領がないこと。
   記録済み未完了を合格にしない。

親による最後の読取コマンドは次のとおりである。

```sh
PATH="$REVIEW_RUNTIME/bin:$PATH" nod review show --run <実際のrunId> --json
```

加えて `show.directory` の `execution.json` が実在し、同じrunId、target、最終状態を持つことを親が読む。
準備と探索だけなら未実施とし、理由、取得済みID、保存先をblockerと報告へ残し、Done、In Review、PR提出を止める。
担当失敗後に自動で再委譲しない。
検証記録のある `incomplete` は記録済み未完了として未確認を隠さず結果を保持し、レビューは未完了のまま既存の提出・完了条件へ接続する。score=nullやcurrentSubmissionの提出不可自体をIssueの新たな一律Done禁止・5点必須の条件にはしない。Issueの完了可否は既存の必要検証・受け入れ条件で判断し、その必要条件自体の未確認・失敗は停止する。PMの既存の証拠不足時の提出停止も維持する。

CLIの詳細は[準備と探索記録](review-prepare.md)、[独立した候補検証と最終記録](review-run.md)を参照する。
実装後レビューは単独レビューとは別の実受け入れとして、ownerが実Issueと更新implementer定義で実行する。同じ起動例のプロンプトを実装後レビュー用に替え、実repo・merge-base・対象commit・Issue/Spec/plan・規約所在、既存Taskの再開位置、不要なコード変更やコミットを行わない受け入れ範囲を指定する。今回限りのSol highはsession overlayを使い、永続@taskを変更しない。
ownerはimplementer→探索→fresh検証、2段記録、親への返却、最終照合後のnod作業ログの対応まで実測する。prepareから最終記録までIssue.updatedAtとplanが不変であることも記録する。
検証担当のsession_initと最初のuser入力・履歴から非継承を観測し、親要約・探索会話・推論・原因グループ・総合判断が入っていないことを確かめる。ID差だけで証明しない。
これらを実行していない担当は「実装後実受け入れと非継承観測は未実施、ownerが実行」と報告する。単独レビューの実績やfixtureの成功を実装後受け入れへ流用しない。
