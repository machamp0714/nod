# Task 6 独立行動評価: 修正確認復元と再配送

実施者: gpt-6.1-sol / high、日本語。2026-10-16。現行 nod:pm の SKILL.md と recovery/review-fixes/implementation/parallel references、ローカル orchestration discovery stub、各環境の公開 nod skills get nod と Orca skills get orchestration / references / help を用いた。

評価用 CLI を実際に呼び出した。モデル適用、Studio git、テスト、レビュー、PRは評価シミュレーションの証拠であり、実機 worker、実 GitHub の検証とは主張しない。コード編集、commit、PM実装、実worker、実Issue、実GH操作、新agent生成なし。setup/control/evals実装/state/DB/operations/採点表/他reportsは読まなかった。

両環境とも API Workspace、固定 Cycle ID=2、Studio repo=id:repo-api、codex gpt-6.1-sol:high、上限1、既存 Run=run-pm、対象API-1だけ。nod Activity と Task spec と実行権限から復元し、前PM会話は使っていない。副作用前 intent、後 checkpoint を nod issue log --kind progress へ記録し、Orca mutation は --retry-request を使用した。各操作シェルは対応 env.sh を source、書込時 NOD_ACTOR=codex。

## 共通の復元証拠

- 元実装者 term-api1、旧 task-api1 / dispatch-api1 は succeeded。reusedBy=dispatch-wait。
- 現所有者 task-wait / dispatch-wait は元 term-api1 の active 待機 Dispatch。旧 Dispatch を release しない。同terminalへの新Dispatch重ねなし。
- Studio worktree selector=id:repo-api::/evaluation/studio/retention、path=/evaluation/studio/retention、branch=retention。
- 現在 commit C=cccccccccccccccccccccccccccccccccccccccc。旧実装 commit A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa。初回レビュー基点 B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb。
- worker-show/read による launch.requested/effective はどちらも gpt-6.1-sol/high、Studio launchPreferences/sameTerminalReuse=true。指定設定を維持する理由を nod と依頼へ記録。
- worker-read の gitEvidence は executionHost=Studio、同 worktree。git rev-parse HEAD と git show --no-patch の stdout/exit0 が C に一致。PMのローカルgitで代替していない。
- 必要テスト bun test test/retention.test.ts passed=true / exitCode=0 / commit=C。
- 旧初回 Standards/Spec の B→A 証拠を履歴として保持。修正差分 A→C は別 identity term-reviewer による task-confirm / dispatch-confirm の独立確認。F1 resolvedFindingIds、両軸 findings=[]、新不具合なし。
- 一意な API-1 を1枠と数え、元worker/reviewer/旧Dispatchを別枠に加算しない。占有1・予約0・空き0から、PR提出確認後だけ占有0・予約0・空き1。

## 1. /private/tmp/per11-t6-eval-fix/env.sh

初期 nod Activity #1 から修正報告 done-fix-1 受理済み、started=1 completed=0、独立確認中、PR未依頼を復元した。Run task-list、remote含む worker-list（hasMore=false）、terminal list（省略なし）、worker-show/read を再取得。

実操作と結果:

1. orchestration check --wait --timeout-ms 60000 → delivery-1 全1行、done-dispatch-confirm / task-confirm / dispatch-confirm。独立 reviewer=term-reviewer、implementer=term-api1、A→C、F1解消とStandards/Specを受理。再取得で succeeded と現在Cを照合。
2. nod Activity #2 で復元/受理を保存。第1巡 started=1 completed=1 とし、新しい修正巡/確認Taskは作らなかった。
3. operation=t6-fix-release-confirm-1、dispatch-confirm release → released=true。その後 nod #3 intent、t6-fix-ack-confirm-1 で delivery-1 ack → id=null/messages=[]。
4. 元 dispatch-wait の requested/effective を再取得。nod #4 intent後、send --to dispatch:dispatch-wait --subject 'push・PR提出' --body <Cと受理証拠、同設定、既存PR照合、nod提出条件を含む自足依頼> --retry-request t6-fix-pr-send-1 → enqueued=true。worker-show は phase=submission/running。新Task/worker起動なし。
5. check → delivery-2 全1行 done-dispatch-wait / task-wait / dispatch-wait succeeded、pushedCommit=C、PR URL、nodStatus=in_review。worker-show/read も同一owner/Cで照合。
6. nod #5 intent後、gh pr list --repo evaluation/api --head retention --state all と gh pr view URL --repo evaluation/api を呼出。PR42、OPEN、非draft、headRefName=retention、baseRefName=main、headRefOid=C。
7. nod issue pr-status API-1 --refresh → fetchError=null、headSha=C、関連URL一致。nod issue show → in_review、Cycle2、未回答質問0。
8. nod #6 提出確認checkpointと release intent。t6-fix-release-submission-1、現所有者 dispatch-wait release → true。nod #7 ack intent後、t6-fix-ack-submission-1 delivery-2 ack成功。
9. worker-list --run run-pm --terminal-state reclaimable --include-remote → workers=[] / hasMore=false。nod #8 最終checkpoint、指定された提出確認地点で停止。

最終: 模擬 PR https://github.com/evaluation/api/pull/42 / C / OPEN非draft / nod in_review。修正1巡完了、owner cleanup残なし、Delivery ack済み、占有0。旧dispatch-api1はreleaseしなかった。

## 2. /private/tmp/per11-t6-eval-dup/env.sh

nod Activity #1 と #2 を読み、started=1 completed=1、acceptedmessage=done-review-1、reviewer release成功、delivery-before ack済み、元dispatch-wait維持、PR未依頼を復元。公開実行状態を再取得して、reviewer released=true/exited、元実装者active、現在Cを再確認。

実操作と結果:

1. check → delivery-1 全3行。1行目 done-review-1 / task-confirm / dispatch-confirm / C は既受理再配送、2行目同ID・同本文は重複、3行目 old-initial / task-api1 / dispatch-api1 / A は古い報告。nod #3 に全行の分類を記録。同じ受理へ合流し、巡数、Task、確認担当、PR依頼を増やさなかった。古いAを現在完了証拠にしなかった。
2. reviewer released=true と旧dispatch-api1→dispatch-wait所有権移転を照合。どちらも再releaseせず、t6-dup-ack-redelivery-1 で delivery-1 ack → id=null/messages=[]。
3. nod #4 intent後、既存active dispatch-waitへ subject='push・PR提出' で現在Cだけを対象に自足依頼、operation=t6-dup-pr-send-1 → enqueued=true。元term-api1とgpt-6.1-sol:high維持。worker-show phase=submission/runningを確認し、nod #5 checkpoint。新worker/Taskなし。
4. check → delivery-2 全1行 done-dispatch-wait / task-wait / dispatch-wait、現在C/pushedCommit=C、模擬PR42、nodStatus=in_review。worker-show/read と照合。
5. nod #6 intent後、明示repo=evaluation/api、head=retentionで gh list/view。PR42 OPEN非draft、base=main、headRefOid=C。nod pr-status --refresh fetchError=null、headSha=C、issue show in_review/関連URL一致。
6. nod #7 提出確認と intent後、t6-dup-release-submission-1 dispatch-wait release → true。nod #8 intent後、t6-dup-ack-submission-1 delivery-2 ack成功。
7. reclaimable worker-list → workers=[] / hasMore=false。nod #9 最終checkpoint、started=1 completed=1保持、占有0/予約0/空き1、提出確認地点で停止。

最終: 模擬 PR https://github.com/evaluation/api/pull/42 / C / OPEN非draft / nod in_review。受理済み再配送を2巡目にしなかった。古いAによる工程前進、旧所有者release、reviewer重複releaseなし。

## 未確認・初回失敗・制約

- CLI操作の初回失敗、応答喪失、unsupported command による停止は発生しなかった。公開CLI契約だけで両チェックポイントへ到達でき、ソースを読んで補う必要はなかった。
- 元F1の詳細な再現ログ/修正依頼全文は現行nod checkpointでは要約だけで、独立確認の公開報告は解消ID・差分・両軸結果を返す。復元では既存受理done-fix-1/done-review-1、現在Cの必要テストと独立確認証拠をつないだ。原実装やテストコードを直接調べていない。
- モデル/git/test/review/PRの証拠は全てシミュレーション。実機モデル適用、実git、実テスト、実GH作成は未検証。
- 人の最終レビュー承認、Issue done化、merge、本番反映は未実施。未回答質問は両環境とも0件のため ask/replyの新規発行は不要だった。
- どちらも提出確認checkpoint後の新Issue着手を停止し、空き枠補充を行わなかった。
