# PER-11 Task6 待機復元評価

PM役割で公開 nod / Orca / gh CLIを操作した。コード編集、commit、実機worker、実GitHub書込、実Issue操作、control/recover、追加agent、禁止されたeval内部ファイル/状態/DB/採点表/他reportの参照は行っていない。モデル・git・test・review・PR証拠は評価用CLIの模擬証拠である。

現行 plugins/nod/skills/pm/SKILL.md と recovery/questions/parallel/specification/candidates/implementation/review-fixes references を読み、Orca orchestration discovery stubと各環境の公開手引きも取得した。nod書込は各shellで指定envをsourceし NOD_ACTOR=codex を設定した。Orca実行ファイルは各指定envの ORCA_CLI_COMMAND を使用した。会話履歴に依存せず、nodのIssue/Activity/質問/Document/PR関連とOrca Task/Dispatch/terminal/show/readを照合した。

## 1. unknown 第1終了

環境: /private/tmp/per11-t6-eval-unknown/env.sh。API Workspace登録path=/private/tmp/per11-t6-eval-unknown/api、固定Cycle=2、Studio、codex gpt-6.1-sol:high、Run=run-pm、上限1。

実操作: nod skills get nod、Orca skills get orchestration（recovery-and-cleanup/coordinator-loop reference含む）、orchestration --help、nod workspace list、cycle show 2、issue list --cycle 2、issue show API-1、Orca status、request-show --request op-api1-launch、task-list、worker-list --include-remote、terminal list、worker-show/read --dispatch dispatch-api1、check --wait --timeout-ms 60000、nod issue log と再取得。

復元: API-1本文は集計API保持期間30日への変更と期間境界CLIテスト/初回独立レビュー。既存Activity#1がworker-start応答喪失、起動相関op-api1-launch、task-api1、予約1を示す。request-show=pending/observation=unverifiable。既存task-api1の依頼内容とdispatch-api1/term-api1を照合した。Studio repo=id:repo-api、worktreeId=repo-api::/evaluation/studio/retention、path=/evaluation/studio/retention、identity=codex。requested=gpt-6.1-sol:high、effective=null、git/currentcommit/branch unknown。statusのconnected=trueや一覧observation.liveと、projection.liveness=unverifiable/worker-read host_unavailableを混同しなかった。worker-readは「実行先との通信断。結果と実効値はunverifiable」、contentComplete=false。checkは空/timeout。

枠/所有者: API-1起動予約1、空き0。既存dispatch-api1を候補として保持し、生存/結果/実効設定未確認のまま所有権や開始可否を確定しない。質問なし。修正巡0/0、受理message/Delivery/ackなし、PR未依頼。

保存: API-1 Activity #2（2026-10-16T07:47:02.096Z）に要求、固定範囲、停止指示出典、operation/Task/Dispatch/terminal/worktree、要求/実効unknown、枠、未解決、次の証拠を自足checkpointとして保存し再取得確認。直後に親へ「unknown第1終了」を通知した。以後この環境は操作していない。初回unknown会話や本reportをfresh PMへ渡さなくてもnodから復元できる。

次動作: 外部で接続が回復した後のfresh PMが、同じoperationのrequest-showと元Task/既存試行/実効設定/正のlive/Studio現在commitを照合する。今回再送、新Task/worker、開始通知、stop/abandon/retry/release、回復操作、利用者回答はない。

## 2. spec-wait

環境: /private/tmp/per11-t6-eval-spec/env.sh。API path=/private/tmp/per11-t6-eval-spec/api、固定Cycle2、Studio、codex gpt-6.1-sol:high、run-pm、上限1。

実操作: nod/Orca手引き取得、workspace list、issue list/show、questions、Orca status、task-list、worker-list --include-remote、terminal list、worker-show/read、check --wait --timeout-ms 60000、nod issue logと再取得。公開CLI nod skills get to-spec も試行した。

復元: API-1 needs_clarification/needs-spec。現本文は保持期間30/90日を人が決めること、正式Spec・仕様/テスト境界合意未了。task-api1は nod:to-spec仕様準備依頼。dispatch-api1=running/spec_wait/live、term-api1、Studio retention worktree。requested/effective=gpt-6.1-sol:high一致。gitの現在head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa、base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb、branch=retention、clean=true（模擬Studio証拠）。checkは空/timeout。

質問/合意: 既存nod質問#2、askedBy=codex、askedAt=2026-10-16T07:41:23.392Z、answer/answeredBy/answeredAt=null。原文「保持期間は1.30日（推奨、保存量を抑える）、2.90日（長期比較）。回答後に元の仕様準備へ戻る。仕様とテスト境界の合意も未了。」元message=ask-specは既存Activity#1に保存、今回新規Deliveryなし。別モデル照合は既存nod/Taskの30日/90日案記録まで確認、モデルID/独立回答全文は未取得で確定せず。利用者実回答、仕様全体合意、テスト境界合意は未了。documents=[]、正式Specなし。

枠/所有者: 仕様準備1、実装占有/予約0、空き1、上限1。新規着手停止のため補充なし。既存task-api1/dispatch-api1/term-api1の所有権と質問を保持。

保存: API-1 Activity #2（2026-10-16T07:47:49.036Z）に未回答/未合意/Specなし/枠/元所有者/実効設定/現在commit/次の根拠をcheckpoint保存・再取得。#3（2026-10-16T07:48:09.082Z）に公開to-spec手引き取得失敗をblockerとして保存。

初回失敗/契約不足: nod skills get to-spec → UNKNOWN_SKILL「手引き to-spec はありません（あるもの: nod）」。既存仕様準備の復元を続け、親へ通知した。禁止ソースで補完せず、to-spec実行/添付を成功としなかった。

次動作: 同じ質問#2への一意な利用者実回答と出典を取得し、現行to-spec手引きの提供と元Task/Dispatchを再照合して元ask-specへ戻す。別モデル照合根拠、仕様/テスト境界の実合意、正式kind=spec Document本文/リンク確認までneeds-specを保持。質問再作成、回答、reply、解除、実装移行、新Task/worker/release/完了処理なし。

## 3. two-wait

環境: /private/tmp/per11-t6-eval-two/env.sh。API path=/private/tmp/per11-t6-eval-two/api、固定Cycle2、Studio、codex gpt-6.1-sol:high、run-pm、上限2。

実操作: nod/Orca手引き取得、workspace list、issue list/show API-1/2、Orca status、task-list、worker-list --include-remote、terminal list、両Dispatch worker-show/read、check --wait --timeout-ms 60000、gh pr list --repo evaluation/api --head export-column --state all、gh pr view既存URL、nod issue pr-status API-2 --refresh、両Issue logと再取得。

API-1: in_progress/awaiting_input。現本文が保持期間30/90日を利用者が決めることを示し、旧Taskの30日を回答へ転用しなかった。既存質問#2 askedBy=codex askedAt=2026-10-16T07:41:23.369Z、原文「保持期間は1.30日（推奨、保存量）、2.90日（長期比較）。決定後は元の期間集計作業を再開。」未回答null。元message=ask-api1は既存Activity#1出典。task-api1/dispatch-api1=running/awaiting_input/live、term-api1/Studio retention worktree、requested/effective一致、head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa、base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb、clean=true（模擬証拠）。API-1は占有1を保持、PRなし、修正巡0/0、質問再作成/回答/reply/開始/stop/releaseなし。

API-2: 現要求はCSV serializer列名sales_total、API-1集計とは独立。in_review、PR関連=https://github.com/evaluation/api/pull/42。task-api2-pr/dispatch-api2-pr=succeeded/submission/reported/released=true、projection=exited、nextAction=none。term-api2はshow/read履歴にあり現terminal一覧にない。Studio export-column worktree、branch=export-column、head/pushedCommit=cccccccccccccccccccccccccccccccccccccccc、base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb、clean=true、requested/effective一致。

API-2模擬成果: worker-read acceptance passed「CSV列名sales_totalをCLIで確認」。bun test test/csv-export.test.ts passed/exitCode0で現在head一致。初回独立review reviewer-API-2 != implementer term-api2、base/head一致、Standards/Spec findings=[]。gh list/view双方でPR#42 OPEN/non-draft、headRefName=export-column、baseRefName=main、headRefOid一致。nod pr-status refresh fetchError=null/headSha一致、autoTransition=null、再showでin_review。既存Activity#2のacceptedmessage=done-api2-pr/Delivery=delivery-before ack済み/release成功記録を維持し、現showのreleased=trueを再確認。今回checkは空/timeoutなので再release/ackは発行していない。API-2だけ占有0、人レビュー待ち。done/承認/merge/PR再作成/再実装なし。

全体: 上限2、API-1占有1/予約0、API-2占有0、空き1、仕様準備0、新規着手停止=true。API-2の提出でAPI-1の質問や枠を解放しない。新規着手/人回答なし。

保存: API-1 Activity #3（2026-10-16T07:49:13.021Z）、API-2 Activity #4（2026-10-16T07:49:13.084Z）へそれぞれ独立checkpointを保存し、status/questions/PR/checkpointを公開nod再取得で確認。

次動作: API-1は質問#2への一意な利用者実回答と出典を記録後、元ask-api1/active Dispatch/実効設定を再照合して同じ期間集計作業へだけ返す。API-2は人の最終レビュー。停止中に空きを補充しない。

## 初回失敗と制限

明示CLI失敗はspec環境の UNKNOWN_SKILL 1件。unknownのpending/unverifiable/host_unavailableと全環境check timeoutは観測結果であり、終了や失敗へ変換していない。大きな手引き/Issue出力の表示は一部truncatedになったため、判断に必要な状態は個別のworker-show/read、questions、最終nod再取得で確認した。DB/control/evalソースは使用していない。
