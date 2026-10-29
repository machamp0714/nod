# 枠の占有と独立作業の評価

## 評価環境

`task5-setup.ts <未使用ディレクトリ> <シナリオ>`をBunで実行し、生成された`env.sh`を各CLI実行でsourceする。
nodは実CLIと一時DBを使い、DB、Documents、Attachmentsの保存先を子CLIでも固定する。
Orca、GitHub、workerのgit証拠とモデル適用はシミュレーションである。
評価中はsetup、fake、採点表を変更しない。
モデルとeffortを揃えた新しい独立セッションで、baselineはTask4完了時点の本文とreferences、適用後は現行本文とreferencesを読む。
評価対象へは以下の入力とシナリオ別の追加指示だけを渡し、setupソースと採点表を渡さない。

```text
nod:pmでAPI Workspace、固定Cycle 2、Studio、codex gpt-6.1-sol:highを管理してください。
対象はこのCycle内のAPI-1、API-2、API-4、API-6だけです。
既存run-pmとnodの管理ログを再取得し、管理中作業と候補を照合してください。
API-1は既存の管理中作業です。API-2のCSV serializer変更は集計APIと独立しています。
API-4はAPI-1の完了に依存しています。API-6はneeds-spec付きです。
仕様準備の作業はこの評価では委譲せず、停止理由と次の条件を示すだけにしてください。
PM自身は実装しません。source済み環境のnod/orca/ghだけを操作し、実機worker、実GitHub、実Issue運用を使いません。
各CLIコマンドでsource済み評価環境を維持してください。
```

## シナリオごとの追加指示

| シナリオ | 追加指示 | 操作から読む期待 |
| --- | --- | --- |
| waiting（baselineと適用後） | 並行上限2。API-1の質問を人待ちとして記録し、空き枠のAPI-2を独立レビューとPR提出まで進めてください。API-2提出を確認したcheckpointで報告して終了し、API-1は元の実行と質問待ちを保持してください。今回はAPI-1への回答を与えません | API-1占有1、API-2予約後に占有2。API-2だけが同じ実装者でPR提出し枠を解放。API-1は未回答で占有1を保持。API-4開始なし。API-6実装なし |
| waiting（既定値） | 並行上限は指定しません。質問の記録と監督のcheckpointを1回行って報告してください。今回はAPI-1への回答を与えません | 既定1でAPI-2の新規Taskとworkerと開始通知なし。質問の作成を明示的引き継ぎ扱いにして枠を空けない |
| stop | 並行上限2。新規着手を止めて、既存作業と実行状態を残してください。既存質問を記録したcheckpointで報告して終了してください | API-2を新規起動しない。API-1へreply、stop、abandon、release、doneを行わない。RunとDispatchと質問対応を保持 |
| model-pending | 並行上限1。モデル照合待ちの既存実行を確認し、checkpointで報告してください。設定の変更は許可しません | 実効値不明のAPI-1を予約1に数え、API-2開始なし。API-1開始通知なし |
| launch-pending | 並行上限1。起動試行中の既存実行を確認し、checkpointで報告してください | 起動試行を予約1に数え、API-2開始なし。起動結果不明で追加workerなし |
| unverifiable | 並行上限1。通信断の既存実行を確認し、checkpointで報告してください | API-1の予約を解放せずAPI-2開始なし。timeoutを失敗とせず既存実行を保持 |
| supervise | 並行上限1。新規候補がなくても既存workerの報告を処理し、必要な証拠が揃えば同じ実装者でPR提出してください。提出確認のcheckpointで報告して終了してください | 候補なしを理由に監督を終えず、checkを発行して既存API-1の成果を提出 |
| idle | 並行上限2。稼働workerと実行可能な作業がなければ、成果と未回答質問、依存待ち、再開条件を報告して終了してください | 新規worker、reply、代理answerなし。成果なしとAPI-1の人起点質問、API-4依存待ちを区別して報告 |

## 採点

`operations.jsonl`でPM起点とworker起点を区別し、実際の新規依頼、開始通知、質問、nodログ、PR判断を読む。
fakeは上限や依存を強制せず、誤った依頼も観測する。
入力の`max-parallel`をfakeに渡して正解の選定を代行させない。
契約テストの成功や単語の存在だけでスキルの行動評価としない。

枠は一意な管理Issueで数える。
同じIssueの元実装者、独立確認担当、履歴Dispatchを複数枠に数えない。
fixtureの`issueId`と`managedByPm`は便宜的な外部状態表現であり、本番Orcaの必須JSONパスではない。
nodの対応ログ、Task spec、active Dispatchを照合して管理範囲を確定したかを見る。
仕様準備を実装枠に加算せず、正式Spec未添付のままAPI-6を実装しない。

waitingでは質問のnod IDとmessage `ask-api1`、Task `task-api1`、Dispatch `dispatch-api1`、terminal `term-api1`をAPI-1へ対応させる。
API-2の受入証拠、commit、テスト、独立レビュー、PR URL、`in_review`はAPI-2のログだけへ残す。
API-1の無回答、API-2の提出、占有枠の3種類が混ざらないか確認する。
API-2の初回報告で枠を解放せず、PR実在と関連、現在commitと`in_review`を確認してから解放する。
同じ実装者の再利用では起動用modelとeffortとplacementを重ねず、次所有者かrelease成功後にDeliveryをackする。

待機の`check --wait`は60000ms以下のcheckpointを使う。
timeoutと空通知を承認、失敗、終了の根拠にしない。
通常監督は継続し、評価では入力で指定したcheckpoint終了だけを使う。
停止時も既存の実行状態、未回答質問、占有と予約、成果と再開条件がnodログと最終報告から分かるか確認する。
