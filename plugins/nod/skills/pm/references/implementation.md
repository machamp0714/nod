# 実装依頼と提出の手順

S01ではSprintからの新規自律実行を開始しない。
この手順は移行前からある個別委任の権限と現在の所有者を照合した引継ぎ用である。
Sprintの合意、採択、開始、実行監督が製品機能として接続済みとは扱わない。

以下の`ORCA`には、このセッションで手引きを取得した実行ファイルを使う。
現行の`orchestration`ガイドに加え、`references/coordinator-loop.md`、`references/placement-and-remote.md`、`references/messaging-and-gates.md`を読む。
`ORCA orchestration worker-start --help`も読み、同じterminalの再利用に必要なworktree指定を確認する。
コマンド例のselector、ID、handleは読取結果から取り、本文は安全に引数へ渡す。

## 着手条件と依頼内容

[候補の確認手順](candidates.md)で、対象Issueの本文、現在の担当と状態、未回答質問、依存、仕様判定、既存実行を新規着手直前に再取得する。
実装可能で[並行と待機](parallel.md)の起動条件を満たすIssueを1件ずつ選び、実装担当、Studioの正確な接続先とリポジトリ、モデルとeffortを確定する。
管理外実行や通信断があれば、二重起動せず停止する。

依頼は次の順序で自足したTask specにする。

| 必須項目 | 渡す内容 |
| --- | --- |
| 対象 | Issue ID、Workspace、Sprint参照、対象ファイルまたはコンポーネント |
| 要求 | 既存specの内容。specがなければ本文の要求と完了条件の全文。既存planも使う |
| 制約と担当範囲 | 変更できる場所、触らない場所、互換性、競合する作業、運用操作の禁止 |
| 実行場所 | Studio、専用worktree、作業ブランチ。Airへの代替実行をしない |
| 設定 | agent、`モデル:effort`、ユーザー指定または合意済み選定方針と選定理由 |
| 開始条件 | PMが要求値と実効値を照合してDispatchへ開始を通知するまで、実装、ファイル変更、`nod issue start`を行わない |
| 実装と検証 | 開始後に`nod:implement <IssueID>`を使い、合意済み境界の必要なテスト、commit、手順内の初回独立レビュー（役割別の担当への委譲と、マージ可否・merge-readyの記録）まで実施する |
| 完了証拠 | Run、Task、Dispatch、worktree、terminal、現在commit、受け入れ証拠、実行コマンドとテスト結果、初回独立レビューの結果Document IDと監査Document ID・作業ログ、レビューの作業ディレクトリ`<W>`、起動した3担当（Standards探索・Spec探索・反証）の定義名と担当ID、レビューの基点と対象commit、最終状態と確定した要対応の点数、確認が残る事項（要求の出典・確かめる担当・理由）、マージ可否と不可の理由（現在のheadと基点の照合を含む）、merge-readyの状態と`[merge-ready]`で始まる`--kind progress`の作業ログ |
| 終了条件 | 初回レビューの指摘を勝手に修正せず報告。PRを含む依頼なので先にDoneにせず、push、PR、nodへの提出はPMからの後続依頼を待つ。Orcaの`worker_done`後はidleにする |

新たな仕様や計画を作ること自体を着手条件に増やさない。
PMは実装ファイルを変更しない。

## 起動とモデルの照合

各副作用の前後に[永続記録と再開](recovery.md)のintentとcheckpointを残す。
新規Taskを先に作ってIDをnodへ保存し、worker-startにはそのTaskを渡す。
操作相関IDを副作用前に保存し、応答喪失ではrequest-showと既存Task/Dispatchを照合する。

新規起動前に[並行と待機](parallel.md)でIssueを予約として記録する。
起動試行中とモデル照合待ちも予約を保持し、同じIssueに重ねてworkerを起動しない。

Studio側が指定agentとモデル転送に対応することを、現行ガイドが定める接続先の能力情報で確認する。
能力を表すJSONの場所を推測しない。
確認できなければRunやworkerを増やさず、[質問の手順](questions.md)で番号選択肢、推奨、理由、決定後の動作を人に提示する。
既存Runがある場合は対応を照合して使い、新規のPMセッションならRunを1つ作る。

```sh
ORCA status --json
ORCA orchestration run-create --objective "<WorkspaceとSprint参照のIssue進行>" --retry-request <Run作成の操作相関ID> --json
ORCA orchestration task-create --run <RunID> --spec "<上記の依頼全文と操作相関>" --retry-request <Task作成の操作相関ID> --json
nod -w <Workspace> issue log <IssueID> "<RunとTask ID、起動操作相関、予約、起動前intent>" --kind progress
ORCA orchestration worker-start --run <RunID> --task <記録済みTaskID> --on <Studio接続先> --worktree new-top-level --repo <取得したStudioのrepo selector> --name <Issue IDを含めない作業名> --agent <codexまたはclaude> --model <指定モデルID> --effort <指定effort> --retry-request <起動の操作相関ID> --json
```

`--on`はworkerのplacementだけを選ぶ。
以後の読取、通知、後片付けはDispatchで宛先を指定し、`--on`を重ねない。
RunとTaskの正本はPM側に残る。
既存の専用worktreeを使う場合は、現行ガイドに従って正確なselectorを使い、別の新規terminalを追加する前に既存実行を照合する。

起動receiptの成功と`launch.requested`、`launch.effective`を確認する。
両方のモデルIDとeffortが指定値に一致することを確かめ、Issue、Run、Task、Dispatch、実行先、worktree、terminal、要求値、実効値、選定理由、工程「実装待機」をnodの作業ログへ残す。
対応が不明、値の欠落、不一致があれば、実装開始通知を送らない。
別モデル、別effort、Airの実装者への切り替えを黙って行わない。
新しい利用者判断が必要なら[質問の手順](questions.md)で相談し、実回答を元の実行へ対応させる。
起動失敗や結果不明は残存資源を確認し、現行のrecoveryガイドに従う。

一致した場合だけ、同じDispatchへ開始を通知する。

```sh
ORCA orchestration send --to dispatch:<DispatchID> --subject "実装開始" --body "<照合したモデル:effortと実効値、開始条件を満たしたこと、実装開始の依頼>" --retry-request <開始通知の操作相関ID> --json
```

enqueueの成功を実装開始や完了の証明とせず、開始通知送信済みとして記録し、worker報告を監督する。
開始を確認できてからnodへ工程「実装中」と対応するDispatchを記録する。

## 初回レビューを受け取る

Orcaの`check`でDeliveryを受け取り、全メッセージを処理する。
workerの質問は[質問の手順](questions.md)で既決の技術質問と新しい利用者判断に分け、元messageへの回答と実回答待ちを記録する。
対象のRun、Task、active Dispatch、Issue、実行場所に一致する`worker_done`だけを受け入れる。
`worker-show`、`worker-read`と実行先のgit証拠で現在commitを照合する。
gitの証拠は、実装先で取得した`git rev-parse HEAD`と`git show --no-patch <commit>`の結果を含める。
必要な証拠を読取操作で得られなければ、現在commitを確認済みと扱わない。

PRへ進む条件を次の表で確認する。

| 証拠 | 条件 |
| --- | --- |
| 受け入れ | 正本の完了条件ごとの結果と根拠があり、現在commitに対応する |
| テスト | 必要なコマンド、成否、対象commitが分かり、すべて成功。未実行や失敗を成功扱いしない |
| 初回レビュー | 作業ログや短い結果だけで受理せず、結果Documentの参照先の監査Document（両方`kind=doc`）を読む。同じrunId・基点・head SHA・最終状態・点数・指摘・確認事項が対応することを確かめる。起動した3担当（Standards探索・Spec探索・反証）の定義名とIDが実装者と異なり、3担当の有効結果がそろっていることを監査で確かめる。受け入れ確認担当の結果や受け入れ証拠の再照合の節が無いことは欠落として扱わない。再委譲した場合は最初の無効試行と有効な試行を区別する。監査の反証の原文が作業ディレクトリの原本とsha256で一致し、原判定から点数・確認事項を再確認できること。Severityは既存の影響度からの表示だけで、再採点しない。対象SHAが現在commitと一致し、修正後は既存指摘と修正差分の独立確認へつなぐ |
| マージ可否と現在のheadと基点 | 結果に短い結論、監査にマージ可否・不可の理由・現在のheadと基点の照合（レビューした基点）がある。監査の原文・対応表・確認事項・現在のheadと基点の照合から親の10節の8どおりにマージ可否を確かめる（完了・確定した要対応0件・確認が残る事項0件・現在のheadと基点がレビューした版と同じ。CIの結果は条件に含めない）。merge-readyは可のときだけ付き、不可なら付いていない。操作は`[merge-ready]`で始まる`--kind progress`の作業ログにある。点数とラベルは自動マージの指示ではない |
| 指摘 | 仕様不適合、規約違反、不具合がない。判断の余地がある改善提案と混同しない |
| 現在commit | 受け入れと必要テストが実行先gitの現在commitに一致する。修正なしなら初回レビューの対象版とも一致し、修正ありなら初回レビューから現在commitまでの修正差分と指摘解消が独立確認でつながる |

PMは`nod:implement`に含まれる初回独立レビューを重複起動しない。通常の実装後レビューも[親の手順0.1節](../../code-review/references/parent.md#01-通常レビューも隔離した親から開始する)の新しい隔離親セッションから行い、実装者やPMの既存セッションから3担当を直接起動する経路で代替しない。
初回レビューの最終状態は次のように扱う。

- `未実施`（担当を1つも起動しなかった: 委譲できない環境、差分なし、秘密情報を含み得るファイル、担当用の限定 clone を作れない）と`未完了`（3担当のどれかの有効な結果が無い。利用枠の上限で止めた場合と、判定と無関係な無効でレビューの親が1回だけ委譲し直した後も有効な結果が無い場合。探索の片方が無効で反証へ進めない場合を含む）: 独立レビュー未実施・未完了のblockerとして記録し、Done・In Review・PRへ進めない。レビューの親の手順内の1回限りの再委譲のほかに、PMから再委譲・再レビューや別の担当での代替を自動で行わず、利用枠の回復を待って流し直さない。原因（利用枠の上限ならそのこと）と再開条件を人へ戻す。報告が`完了`と書いていても、監査で3担当のどれかの有効な結果が欠けていれば同じく未完了のblockerとして扱う。
- `完了`: 照合した点数と要対応を、次の指摘の扱いへ渡す。確認が残る事項（コードレベルで結論を出せない未確認（コード要求の中身を決める要求資料の不足・結論に必要な依存の契約の不足・要求間の矛盾・採否を確定できない候補）と、保存直前の再照合で見つかった要求資料・未コミット変更の変化）があれば、点数が5でも各事項の要求の出典・確かめる担当・理由を不足証拠として記録し、提出を停止する。合格・指摘なし・確認済みへ読み替えず、PMが要求資料や差分を見直して解消したことにしない。確かめ直すには新しいレビューが要る。

証跡が不足すれば不足した項目を記録し、提出を停止する。
有効なレビュー結果があっても、必要なテスト（実装者の報告）が失敗または実行できなければ、レビューの原文と点数を変えずに受け入れと提出を止め、原因を記録する。
CIの結果はマージ可否に含めず、PMもCIの結果を待つ・照合する・記録する手順を置かない。CIが落ちたPRのマージを止めるのはGitHubの必須ステータスチェック（ブランチ保護・ルールセット）の役割である。

テスト失敗や必須指摘があれば、[指摘修正と独立確認](review-fixes.md)へ渡し、その時点ではPR依頼を出さない。テストを実行できない場合は、原因と再開条件を人へ戻す。
任意改善だけなら、確認が残る事項が無く他の提出証拠が揃っていることを確認し、修正巡を消費せず次節へ進む。
未確定のDeliveryをackして結果を捨てず、受理したsettlementには次の所有者または後片付けを決めてからackする。
不足証拠の取得、指摘対応、PR作業をPMが実装として肩代わりしない。

初回レビューの報告の保存後にPMが同じIssueへ書く記録（受理、intent、checkpoint、PR作業、提出の記録など）は通常どおり書き、idを記録・受け渡ししない。

## 同じ実装者へPR作業を渡す

現在commitの条件が揃ったら、実装報告をnodへ記録し、同じagentへPR作業だけを依頼する。
完了後に別途PR作成を依頼した場合も、依頼済みのPR作業とOrcaの所有権処理を継続し、レビュー依頼時に明示的にIn Reviewへ戻す。doneを理由に実装を始め直さない。
その時点の実効設定を`worker-show --dispatch`で再取得し、元の`モデル:effort`と一致していることを確認する。
不明、不一致、元agentの再利用が非対応なら提出を止め、別の実装者を黙って起動しない。
修正確認を終えた元実装者がactiveな確認待機Dispatchを持つ場合は、その現所有者へsendでPR作業を渡す。
以下の新Taskとreuseは、現在の元実装者がsettle済みの場合に限る。
いずれもPR依頼前のintent、Task作成後、送信後のcheckpointを残す。

```sh
ORCA orchestration worker-show --dispatch <実装DispatchID> --json
ORCA orchestration task-create --spec "pushとPR提出。<同じIssue、現在commit、受け入れとテストと独立レビュー証拠、レビューの作業ディレクトリ<W>、同じモデル:effort、既存PR更新またはPR作成、基点ブランチの必須チェックの設定の読み取り、nodへの提出だけの依頼>" --retry-request <PR Task作成の操作相関ID> --json
nod -w <Workspace> --json issue log <IssueID> "<PR作業Task ID、元実装者、対象commit、起動操作相関、intent>" --kind progress
ORCA orchestration worker-start --task <PR作業TaskID> --terminal <確認した元agentのhandle> --worktree <そのterminalの正確なworktree selector> --retry-request <PR作業起動の操作相関ID> --json
```

reuseの`--terminal`には`--model`と`--effort`を併用しない。
remoteの場合も、新しいhostを選ばず、現行契約で取得した元agentとworktreeを使う。
開始receiptの新TaskとDispatchへの所有権移転を確認し、その後の通知は新Dispatch宛てにする。
再利用が成功した旧Dispatchにはcleanup所有権が残らないため、旧Dispatchを後からreleaseしない。
PR作業のDispatchがsettleした時点で、その現所有者だけにreleaseまたは次の所有者を決める。
新Dispatchと元実装者の対応、設定の維持、対象commit、工程「PR作業」をnodに残す。

PR依頼には次の終了条件を明記する。

- 対象commitをpushし、`gh`で対象repo、branchに関連する既存PRを確認する。既存PRがあれば更新し、二重作成しない。
- PRのタイトル、本文、ブランチ名へnodのIssue IDを書かない。GitHubへの操作は`gh`を使う。
- PRのURLと`headRefOid`、branch、base、openかつdraftではないことを確認し、pushした現在commitと照合する。
- `nod issue link-pr <IssueID> <PR URL>`で関連づけ、`nod issue pr-status <IssueID> --refresh --json`で取得結果と状態を確認する。
- PRの紐付けと状態取得はIssueの状態を変えない。取得失敗、別commit、draftならPR作業の完了としない。
- 関連とPRの実在、現在commitの検証を確認したら、PRの`baseRefName`のブランチの必須チェックの設定を読み取る（`gh api repos/{owner}/{repo}/branches/{base}` の `.protected` と `.protection.required_status_checks`、`gh api repos/{owner}/{repo}/rules/branches/{base}` の `required_status_checks` の規則）。結果は次のどれか1つとして報告に書く。これはマージ可否・merge-ready・In Review・Doneの条件ではなく報告事項で、CIの結果を待つ・照合する・記録する手順は置かない。
  - 設定あり（必須チェックを1件以上読めた）: チェック名と読めた出典（ブランチ保護・ルールセット）。片方を読めなかったなら、そのことも書く。
  - 未設定（両方を読めて、保護なし、または保護の必須チェックが0件か強制がoffで、ルールセットにも必須チェックが無い）: 「このリポジトリは必須チェックが設定されておらず、CI が落ちていても GitHub はマージを止めない」。
  - 確認できない（認証・権限・通信の失敗、JSONでない・想定外の形、保護ありで必須チェックの設定が見えない、のどれかがあり、必須チェックを1件も読めなかった）: 設定を読めず、設定の有無を確認できないことと理由。未設定の文は書かない。
- merge-readyが付いていれば、ラベルを付けた最新の`[merge-ready]`の記録の判定したhead SHAとレビューした基点を、PRの`headRefOid`と`baseRefName`に比べる。headが違う（修正ありの追加コミットで判定が古い）、基点が違う（基点が変わった）、記録が無い・読めない・レビューした基点がブランチ名でない（記録の不足）、PRのheadか基点を読めない（照合できない）なら`nod issue update <IssueID> --remove-label merge-ready`で外し、理由・判定したhead SHA・現在のhead・レビューした基点・現在の基点を、本文を`[merge-ready]`で始めて`--kind progress`に記録する。同じなら付けたままにする。この経路ではmerge-readyを付けない（新しいheadと基点のマージ可否は新しいレビューでだけ決まる）。
- 提出の条件が揃っていれば、`nod issue update <IssueID> --status in_review`で明示的にIn Reviewへ移し、レビュー提出として報告する。提出しただけではDoneにしない。
- GitHubのPR承認、マージ、本番反映は依頼された範囲に従う。マージを依頼された場合も、GitHubの必須ステータスチェック・ブランチ保護・ルールセットを回避しない（`gh pr merge --admin` を使わない、保護やルールセットを一時的に外さない、必須チェックを迂回する手段を使わない）。PR URL、pushしたcommit、検証結果、必須チェックの設定を読んだ結果、merge-readyの状態、nodの提出状態を報告してsettleする。

## 提出確認と終了

PR作業の報告も新しいactive Dispatchと照合する。
PMは`gh pr view <PR URL> --json url,state,isDraft,headRefOid,headRefName,baseRefName`とnodの`issue show`、`pr-status --refresh`で、実在、現在commit、対象branch、関連、`in_review`を再確認する。
PR作業の報告にある基点ブランチの必須チェックの設定を読んだ結果（設定あり・未設定・確認できない）を確かめて、人への報告に含める。確認できないときは設定の有無を確認できないことと理由を書き、未設定と書かない。報告に無ければ、PMが同じ`gh api`の読取で確かめてよい（設定を変更しない）。
merge-readyが付いていれば、ラベルを付けた最新の記録（[親の手順](../../code-review/references/parent.md)の11節の、本文が`[merge-ready]`で始まる`--kind progress`の作業ログ）の判定したhead SHAとレビューした基点が、上で読んだ現在のPRの`headRefOid`と`baseRefName`と同じかを確かめる。headが違う（判定が古い）、基点が違う（基点が変わった）、記録が無い・読めない・レビューした基点がブランチ名でない（記録の不足）、PRのheadか基点を読めない（照合できない）なら`nod issue update <IssueID> --remove-label merge-ready`で外し、理由・判定したhead SHA・現在のhead・レビューした基点・現在の基点を、本文を`[merge-ready]`で始めて`--kind progress`に記録する。新しいheadと基点のマージ可否は新しいレビューでだけ決まる。PMはラベルを付けない。ラベルを自動マージ・承認の代わりにしない。
タイトルやURLだけ、workerの「作成済み」だけではレビュー提出済みと判断しない。
nodへ対象commit、PR URL、初回レビューの報告Document IDとmerge-readyの記録の参照、提出状態を残す。
取得が不明なら`unverifiable`として保持し、再送で新PRを作らない。
PR作成後の応答喪失では[既存PRへの合流](recovery.md#pr結果不明から既存成果へ合流する)を先に行い、branchと現在headが一致する既存PRへの関連と提出状態だけを回復する。

受理したsettlement後、同じagentへ直ちに次のDispatchを渡すか、人が保持を求めた場合の`worker-retain`、または`worker-release --dispatch <PR作業DispatchID>`のいずれかを行う。
terminalの直接closeを後片付けの代わりにしない。
releaseまたは次所有者の決定が成功したreceiptを確認してから、その報告のDeliveryをackする。
先にackして、後からreleaseする順序にしない。
Runの`worker-list --terminal-state reclaimable --include-remote --json`で所有者未決のterminalが残っていないことを確認する。
提出先、対象commit、テストとレビュー、残る人の判断を報告する。

## レビュー提出後の再開と完了

mergeとIssueの完了条件（検証・反映など）を確認した人または権限のあるエージェントが `nod issue done <IssueID> --summary "<完了条件と検証結果>"` で明示的にDoneにする。PR不要の依頼は必要な検証・完了条件を満たして直接Doneにできる。PMのPR承認・マージ・本番反映を代行しない方針は維持し、この運用によって権限を追加しない。マージする人・エージェントは、GitHubの必須チェックを`gh pr merge --admin`や保護・ルールセットの一時解除で回避せず、マージの前に基点ブランチの必須チェックの設定を読み取り、設定あり・未設定・確認できないのどれかを報告に書く。
指摘対応は `nod issue start <IssueID>` でIn ReviewからIn Progressへ戻し、既存の着手条件と独立レビュー等の品質条件を守る。merge-readyが付いていれば外し、理由（追加コミットで判定が古い）と判定したhead SHAを、本文を`[merge-ready]`で始めて`--kind progress`に記録する。新しいheadのマージ可否は新しいレビューでだけ決まる。
draftは原則In Progressのまま。mergeせずcloseして継続するならIn Progress、中止なら理由付きCanceled、後回しならTodo/Backlogに明示的に移す。reopen後はレビュー再開ならIn Review、修正ならIn Progressにする。
PRの作成・紐付け・状態取得・取得失敗・merge・close・reopenでIssue状態を自動変更しない。PRなし・draftでも明示的なIn Review設定は可能で、PRの存在・mergeをシステムの必須条件にはしない。
