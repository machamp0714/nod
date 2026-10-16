# 実装依頼と提出の手順

以下の`ORCA`には、このセッションで手引きを取得した実行ファイルを使う。
現行の`orchestration`ガイドに加え、`references/coordinator-loop.md`、`references/placement-and-remote.md`、`references/messaging-and-gates.md`を読む。
`ORCA orchestration worker-start --help`も読み、同じterminalの再利用に必要なworktree指定を確認する。
コマンド例のselector、ID、handleは読取結果から取り、本文は安全に引数へ渡す。

## 着手条件と依頼内容

[候補の確認手順](candidates.md)で、対象Issueの本文、現在の担当と状態、未回答質問、依存、仕様判定、既存実行を新規着手直前に再取得する。
実装可能で空き枠がある1件だけを選び、実装担当、Studioの正確な接続先とリポジトリ、モデルとeffortを確定する。
管理外実行や通信断があれば、二重起動せず停止する。

依頼は次の順序で自足したTask specにする。

| 必須項目 | 渡す内容 |
| --- | --- |
| 対象 | Issue ID、Workspace、固定Cycle、対象ファイルまたはコンポーネント |
| 要求 | 既存specの内容。specがなければ本文の要求と完了条件の全文。既存planも使う |
| 制約と担当範囲 | 変更できる場所、触らない場所、互換性、競合する作業、運用操作の禁止 |
| 実行場所 | Studio、専用worktree、作業ブランチ。Airへの代替実行をしない |
| 設定 | agent、`モデル:effort`、ユーザー指定または合意済み選定方針と選定理由 |
| 開始条件 | PMが要求値と実効値を照合してDispatchへ開始を通知するまで、実装、ファイル変更、`nod issue start`を行わない |
| 実装と検証 | 開始後に`nod:implement <IssueID>`を使い、合意済み境界の必要なテスト、commit、手順内の初回独立レビューまで実施する |
| 完了証拠 | Run、Task、Dispatch、worktree、terminal、現在commit、受け入れ証拠、実行コマンドとテスト結果、独立reviewerのidentity、レビューの基点と対象commit、StandardsとSpecの結果 |
| 終了条件 | 初回レビューの指摘を勝手に修正せず報告。push、PR、nodへの提出はPMからの後続依頼を待つ。Orcaの`worker_done`後はidleにする |

新たな仕様や計画を作ること自体を着手条件に増やさない。
PMは実装ファイルを変更しない。

## 起動とモデルの照合

Studio側が指定agentとモデル転送に対応することを、現行ガイドが定める接続先の能力情報で確認する。
能力を表すJSONの場所を推測しない。
確認できなければRunやworkerを増やさず、必要な確認を人に提示する。
既存Runがある場合は対応を照合して使い、新規のPMセッションならRunを1つ作る。

```sh
ORCA status --json
ORCA orchestration run-create --objective "<Workspaceと固定CycleのIssue進行>" --json
ORCA orchestration worker-start --run <RunID> --spec "<上記の依頼全文>" --on <Studio接続先> --worktree new-top-level --repo <取得したStudioのrepo selector> --name <Issue IDを含めない作業名> --agent <codexまたはclaude> --model <指定モデルID> --effort <指定effort> --json
```

`--on`はworkerのplacementだけを選ぶ。
以後の読取、通知、後片付けはDispatchで宛先を指定し、`--on`を重ねない。
RunとTaskの正本はPM側に残る。
既存の専用worktreeを使う場合は、現行ガイドに従って正確なselectorを使い、別の新規terminalを追加する前に既存実行を照合する。

起動receiptの成功と`launch.requested`、`launch.effective`を確認する。
両方のモデルIDとeffortが指定値に一致することを確かめ、Issue、Run、Task、Dispatch、実行先、worktree、terminal、要求値、実効値、選定理由、工程「実装待機」をnodの作業ログへ残す。
対応が不明、値の欠落、不一致があれば、実装開始通知を送らない。
別モデル、別effort、Airの実装者への切り替えを黙って行わない。
起動失敗や結果不明は残存資源を確認し、現行のrecoveryガイドに従う。

一致した場合だけ、同じDispatchへ開始を通知する。

```sh
ORCA orchestration send --to dispatch:<DispatchID> --subject "実装開始" --body "<照合したモデル:effortと実効値、開始条件を満たしたこと、実装開始の依頼>" --json
```

enqueueの成功を実装開始や完了の証明とせず、worker報告を監督する。
nodへ工程「実装中」と対応するDispatchを記録する。

## 初回レビューを受け取る

Orcaの`check`でDeliveryを受け取り、全メッセージを処理する。
対象のRun、Task、active Dispatch、Issue、実行場所に一致する`worker_done`だけを受け入れる。
`worker-show`、`worker-read`と実行先のgit証拠で現在commitを照合する。
gitの証拠は、実装先で取得した`git rev-parse HEAD`と`git show --no-patch <commit>`の結果を含める。
必要な証拠を読取操作で得られなければ、現在commitを確認済みと扱わない。

PRへ進む条件を次の表で確認する。

| 証拠 | 条件 |
| --- | --- |
| 受け入れ | 正本の完了条件ごとの結果と根拠があり、現在commitに対応する |
| テスト | 必要なコマンド、成否、対象commitが分かり、すべて成功。未実行や失敗を成功扱いしない |
| 初回レビュー | 実装者と別のreviewer identity、基点、対象commitが明示され、StandardsとSpecの両軸が揃う |
| 指摘 | 仕様不適合、規約違反、不具合がない。判断の余地がある改善提案と混同しない |
| 現在commit | 受け入れ、テスト、両軸レビューの対象が、実行先gitの現在commitに一致する |

PMは`nod:implement`に含まれる初回`nod:code-review`を重複起動しない。
証跡が不足すれば不足した項目を記録し、提出を停止する。
テスト失敗や指摘があれば、元実装者へ戻す後続工程に渡し、Task 2の指摘なし経路ではPR依頼を出さない。
未確定のDeliveryをackして結果を捨てず、受理したsettlementには次の所有者または後片付けを決めてからackする。
不足証拠の取得、指摘対応、PR作業をPMが実装として肩代わりしない。

## 同じ実装者へPR作業を渡す

現在commitの条件が揃ったら、実装報告をnodへ記録し、同じagentへPR作業だけを依頼する。
その時点の実効設定を`worker-show --dispatch`で再取得し、元の`モデル:effort`と一致していることを確認する。
不明、不一致、元agentの再利用が非対応なら提出を止め、別の実装者を黙って起動しない。

```sh
ORCA orchestration worker-show --dispatch <実装DispatchID> --json
ORCA orchestration task-create --spec "<同じIssue、現在commit、受け入れとテストと独立レビュー証拠、同じモデル:effort、pushと既存PR更新またはPR作成、nodへの提出だけの依頼>" --json
ORCA orchestration worker-start --task <PR作業TaskID> --terminal <確認した元agentのhandle> --worktree <そのterminalの正確なworktree selector> --json
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
- PR連動が有効でもlinkだけで提出済みとせず、refresh後の`in_review`を確認する。取得失敗、別commit、draftなら提出完了としない。
- PR連動が無効で、関連とPRの実在を確認しても`in_progress`なら、`nod issue done <IssueID> --summary "<検証結果と提出要約>"`で人のレビュー待ちへ提出する。既に`in_review`ならdoneを重ねない。
- 人の最終承認、Issueのdone化、マージ、本番反映を行わない。PR URL、pushしたcommit、検証結果、nodの提出状態を報告してsettleする。

## 提出確認と終了

PR作業の報告も新しいactive Dispatchと照合する。
PMは`gh pr view <PR URL> --json url,state,isDraft,headRefOid,headRefName,baseRefName`とnodの`issue show`、`pr-status --refresh`で、実在、現在commit、対象branch、関連、`in_review`を再確認する。
タイトルやURLだけ、workerの「作成済み」だけでは完了にしない。
nodへ対象commit、PR URL、両軸レビューとテストの参照、提出状態を残す。
取得が不明なら`unverifiable`として保持し、再送で新PRを作らない。

受理したsettlement後、同じagentへ直ちに次のDispatchを渡すか、人が保持を求めた場合の`worker-retain`、または`worker-release --dispatch <PR作業DispatchID>`のいずれかを行う。
terminalの直接closeを後片付けの代わりにしない。
releaseまたは次所有者の決定が成功したreceiptを確認してから、その報告のDeliveryをackする。
先にackして、後からreleaseする順序にしない。
Runの`worker-list --terminal-state reclaimable --include-remote --json`で所有者未決のterminalが残っていないことを確認する。
提出先、対象commit、テストとレビュー、残る人の判断を報告する。
