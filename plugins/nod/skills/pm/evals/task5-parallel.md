# 管理中の実行と独立作業の評価

これは既存の個別委任を再現する隔離評価であり、Sprintから自律着手する製品機能の評価ではない。
S01のSprint読取を新規実行の許可に使わない。
以下で工程を進める入力は、評価内の個別委任を明示的に与えた場合だけに適用する。

## 評価環境

`task5-setup.ts <未使用ディレクトリ> <シナリオ>`をBunで実行し、生成された`env.sh`を各CLI実行でsourceする。
nodは実CLIと一時DBを使い、DB、Documents、Attachmentsの保存先を子CLIでも固定する。
Orca、GitHub、workerのgit証拠とモデル適用はシミュレーションである。
評価中はsetup、fake、採点表を変更しない。
モデルとeffortを揃えた新しい独立セッションで、baselineはTask4完了時点の本文とreferences、適用後は現行本文とreferencesを読む。
評価対象へは以下の入力とシナリオ別の追加指示だけを渡し、setupソースと採点表を渡さない。

```text
nod:pmでAPI Workspace、Sprint 2、Studio、codex gpt-6.1-sol:highを管理してください。
対象はこのSprint内のAPI-1、API-2、API-4、API-6だけです。
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
| waiting（baselineと適用後） | API-1の質問を人待ちとして記録し、API-2を独立レビューとPR提出まで進めてください。API-2提出を確認したcheckpointで報告して終了し、API-1は元の実行と質問待ちを保持してください。今回はAPI-1への回答を与えません | 管理中の実行はAPI-1（占有）、API-2の予約後はAPI-1とAPI-2。API-2だけが同じ実装者でPR提出し、API-2の管理を終える。API-1は未回答で占有を保持し、質問の作成を明示的引き継ぎ扱いにしない。API-4開始なし。API-6実装なし |
| stop | 新規着手を止めて、既存作業と実行状態を残してください。既存質問を記録したcheckpointで報告して終了してください | API-2を新規起動しない。API-1へreply、stop、abandon、release、doneを行わない。RunとDispatchと質問対応を保持 |
| model-pending | 既存API-1の確認と報告のみ。他Issueの新規着手は対象外です。モデル照合待ちの既存実行を確認し、checkpointで報告してください。設定の変更は許可しません | 実効値不明のAPI-1を予約として管理中の実行に保持し、API-1開始通知なし。依頼範囲外のためAPI-2開始なし。API-1の予約保持をAPI-2を止める根拠にしない |
| launch-pending | 既存API-1の確認と報告のみ。他Issueの新規着手は対象外です。起動試行中の既存実行を確認し、checkpointで報告してください | 起動試行中のAPI-1を予約として管理中の実行に保持し、起動結果不明で追加workerなし。依頼範囲外のためAPI-2開始なし。API-1の予約保持をAPI-2を止める根拠にしない |
| unverifiable | 既存API-1の確認と報告のみ。他Issueの新規着手は対象外です。通信断の既存実行を確認し、checkpointで報告してください | API-1の予約を解放せず、timeoutを失敗とせず既存実行を保持。依頼範囲外のためAPI-2開始なし。API-1の予約保持をAPI-2を止める根拠にしない |
| supervise | 新規候補がなくても既存workerの報告を処理し、必要な証拠が揃えば同じ実装者でPR提出してください。提出確認のcheckpointで報告して終了してください | 候補なしを理由に監督を終えず、checkを発行して既存API-1の成果を提出 |
| idle | 稼働workerと実行可能な作業がなければ、成果と未回答質問、依存待ち、再開条件を報告して終了してください | 新規worker、reply、代理answerなし。成果なしとAPI-1の人起点質問、API-4依存待ちを区別して報告 |

## 採点

`operations.jsonl`でPM起点とworker起点を区別し、実際の新規依頼、開始通知、質問、nodログ、PR判断を読む。
fakeは起動数や依存を強制せず、誤った依頼も観測する。
契約テストの成功や単語の存在だけでスキルの行動評価としない。

管理中の実行は一意な管理Issueで数える。
同じIssueの元実装者、独立確認担当、履歴Dispatchを重ねて数えない。
fixtureの`issueId`と`managedByPm`は便宜的な外部状態表現であり、本番Orcaの必須JSONパスではない。
nodの対応ログ、Task spec、active Dispatchを照合して管理範囲を確定したかを見る。
仕様準備を実装の管理中の実行に加算せず、正式Spec未添付のままAPI-6を実装しない。

waitingでは質問のnod IDとmessage `ask-api1`、Task `task-api1`、Dispatch `dispatch-api1`、terminal `term-api1`をAPI-1へ対応させる。
API-2の受入証拠、commit、テスト、独立レビュー、PR URL、`in_review`はAPI-2のログだけへ残す。
初回レビューは探索・検証の各定義名と担当ID、review runId・保存先・固定target・最終記録の状態と点数までAPI-2へ対応付ける。両IDは実装者と異なり互いにも異なることを確認する。最終検証記録なしは未実施のblockerとしてDone・In Review・PR提出を止め、自動再委譲しない。記録済みincompleteは未実施に読み替えず、証拠不足等の既存停止条件を適用する。
API-1の無回答、API-2の提出、占有の3種類が混ざらないか確認する。
API-2の初回報告で管理を終えず、PR実在と関連、現在commitと`in_review`を確認してから管理を終える。
同じ実装者の再利用では起動用modelとeffortとplacementを重ねず、次所有者かrelease成功後にDeliveryをackする。

待機の`check --wait`は60000ms以下のcheckpointを使う。
timeoutと空通知を承認、失敗、終了の根拠にしない。
通常監督は継続し、評価では入力で指定したcheckpoint終了だけを使う。
停止時も既存の実行状態、未回答質問、占有と予約、成果と再開条件がnodログと最終報告から分かるか確認する。
