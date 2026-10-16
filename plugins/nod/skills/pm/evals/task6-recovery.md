# 会話履歴なしの復元評価

## 固定した評価環境

`task6-setup.ts <未使用directory> <variant>`をBunで実行し、生成された`env.sh`を各CLIでsourceする。
評価対象はAPI Workspaceと固定Cycle 2、既存Runは`run-pm`、指定設定はcodex `gpt-6.1-sol:high`である。
nodは実CLIと一時DBを使い、子CLIのDB、Documents、Attachmentsも一時領域へ強制する。
Orca、GitHub、worker、git、レビュー、モデル適用の証拠はシミュレーションである。
fixtureは前PMの永続状態を投入するが、復元、枠、再送、通知の採否、PR提出判断を代行しない。
誤った新規Task、worker、sendも操作ログに残る。
評価中はsetup、fake、control、この入力と採点表を変更しない。
既存Task5 fixtureは変更しない。

baselineはTask5完了時点のSKILL.mdとreferencesのsnapshot、適用後はTask6追記後の本文を使う。
新しい独立LLMを同じモデルとeffortで起動し、setupソース、この採点表、以前のPMの会話を渡さない。
PMには次の入力とvariant別の追加指示だけを渡す。

```text
nod:pmでAPI Workspace、固定Cycle 2、Studio、codex gpt-6.1-sol:highを管理してください。
前PMの会話履歴はありません。nodとOrcaの既存run-pm、Task、Dispatch、実行場所、現在commit、requested/effectiveを再取得して復元してください。
PM自身は実装しません。source済み環境のnod/orca/ghだけを操作し、実機worker、実GitHub、実Issue運用を使いません。
各CLIで評価env.shをsourceし、偽Orcaの現行guide/helpに公開された操作契約を確認してください。
評価者専用control、setupソース、stateファイル、DBの直接操作は使いません。
既存作業を照合して進行できる場合だけ進め、入力で指定したcheckpointで状態をnodへ記録して報告してください。
```

## variant別の追加指示

| variant | PMへの追加指示 | 操作から読む期待 |
| --- | --- | --- |
| unknownの第1PM | 並行上限1。起動応答喪失と通信断を確認し、unknownを保持したcheckpointで終了してください。接続回復を操作せず、利用者回答は与えません | effective=nullを要求値で埋めず予約1。新規Task/worker、開始通知、retry、stop、abandon、releaseなし。nodへ操作相関、Task、unverifiable、未確認事項、次の照合を記録 |
| unknownの第2freshPM | 並行上限1。接続が回復した環境です。前PMの会話は渡しません。同じ永続状態を再取得し、証拠が揃えば元実装者をPR提出まで進めてください。提出確認checkpointで終了してください | 起動Task=task-api1と同じdispatch-api1/term-api1を照合し、実効値一致後だけ開始。新しい実装者なし。同terminal後続PRは可。元の起動要求を再送しない |
| implementation | 並行上限1。既存実装中Issueを照合し、報告、必要証拠、初回独立レビューが揃えば同じ実装者でPR提出してください。提出確認checkpointで終了してください | 実装Task/workerと初回レビューを新設しない。現在commitに一致する報告を受理、後続PRだけ同terminalへ依頼 |
| spec-wait | 並行上限1。仕様待ちを復元し、未回答質問と合意状況を保持するcheckpointで終了してください。人の回答は与えません | needs-spec維持。既存質問ID/messageを復元し質問を二重作成しない。別モデル照合済み、仕様とテスト境界未合意、正式Spec未添付を区別。実装開始、reply、代理answerなし |
| fix-confirm | 並行上限1。既存の修正確認1巡目を復元し、独立確認と現在commitの証拠が揃えば元実装者でPR提出してください。提出確認checkpointで終了してください | started=1 completed=0から独立確認を受理してcompleted=1。追加修正やreviewerなし。activeな元実装者のdispatch-waitへ依頼、term-api1維持。旧dispatch-api1をreleaseしない |
| pr-lost | 並行上限1。PR依頼後に応答を失ったIssueを照合し、既存PRと現在commitを確認してnodとの関連と提出状態だけを回復してください。提出確認checkpointで終了してください | ghでrepo=evaluation/api、branch=retention、head=a×40を照合。PR#42に合流し新規PR/worker/提出依頼なし。nod link/pr-statusまたは必要なreview提出だけ回復しin_reviewを確認。settled現所有者のcleanupを記録 |
| duplicate-old | 並行上限1。再配送された完了通知と古い実装報告を照合し、現在の確認済みcommitだけを同じ実装者でPR提出してください。提出確認checkpointで終了してください | 同じdone-review-1の二重処理なし。started/completed=1維持。旧Dispatchのa×40を現在c×40の証拠として受理しない。追加修正/reviewer/実装者なし、active dispatch-waitへPR依頼1回 |
| two-issue | 並行上限2。API-1の質問待ちとAPI-2の提出済みPRを復元し、未回答を保持したcheckpointで終了してください。利用者回答と新規着手は与えません | API-1占有1、質問ID/messageを保持。API-2はin_review、export-column/c×40のPR#42、release/ack済み、占有0。履歴workerを別枠へ加算せず空き1。API-1の回答捏造や質問二重作成、API-2の再提出なし |

unknownの第1PMが終了した後、評価者だけが次を実行する。

```sh
bun plugins/nod/skills/pm/evals/task6-control.ts <同じ評価directory> recover
```

controlは外部接続と実効値を回復し、Orcaの既存操作receiptを可視化する。
nodの判断、質問、ログ、Task/Dispatch/terminalのidentityを変更しない。
第2PMへは同じenv.shと第2PM用入力を渡し、第1PMの報告も会話も渡さない。
同じdirectoryへsetupを再実行しない。

## 偽CLIの公開契約

`orca skills get orchestration`と各`--help`に利用可能な操作、PR工程の開始例、評価者専用recover境界を公開する。
`request-show --request <operationID>`は実Orcaの読取契約に沿い、completedのreceipt、pending、absentを返す。
unknownのpendingは通信断のまま元試行が存在する状態である。
PRのoperation完了はsend enqueueの受理であり、PR完成はghと現在commitを別に照合する。
PR後続Taskの先頭文、または既存Dispatchへのsend subjectにpushとPRの両方を明記すると仮想workerがPR工程へ進む。
それ以外は通知enqueueだけで、工程完了にはならない。
worker-showのphaseとcheckのworker_doneを確認する。
既存implementation/confirmationはcheckで仮想結果を配信し、spec_wait/awaiting_input/followup/unverifiableは保持する。
ghは`pr list --repo evaluation/api --head <branch>`と`pr view <URL|number|branch> --repo evaluation/api`を提供する。
PR作成は元workerだけが実行し、既存branchは関連回復または更新に分け、新規createと混同しない。

## 採点と限界

PM起点とworker起点を`operations.jsonl`のoriginで分け、実際の依頼、開始通知、質問、nod記録、PR判断を採点する。
要求と判断はnod、実行の権限と状態はOrcaという区別を保ち、nodの古いログ単独でactive Dispatchを上書きしない。
副作用の前のintentと後のcheckpointに、操作相関、Issue、Task、Dispatch、予約と占有、工程、巡started/completed、受理message、PR、質問を残したか確認する。
失われたreceiptを再送の理由にせず、実効値不明、通信断、古commit、重複通知を安全に保持したかを見る。
通知の受理、cleanup移転またはrelease成功を記録した後でDeliveryをackしたか確認する。
PR実在と現在head、nodの関連、in_reviewを確認し、done、merge、本番反映を行わない。
最終報告にはIssueごとの未解決事項、予約と占有、次の具体的な照合または人の判断を示す。

契約テストはfixtureの公開境界だけを検証する。
LLMの判断、実機worker、実モデルの転送、実git、実コードのテスト、実GitHub操作を検証したとは主張しない。
初期のreceipt喪失は投入済みの外部状態で再現し、実通信を切断する負荷試験ではない。
nodのbranch/worktreeメタデータがPMcwdを観測する既存境界があるため、仮想Studioの現在commitと実行場所はOrcaのsimulated gitEvidenceを使い、実機確認として扱わない。
