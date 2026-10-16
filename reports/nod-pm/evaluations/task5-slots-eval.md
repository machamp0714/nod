# nod:pm 並行枠・監督・待機の独立行動評価

実行日: 2026-10-16。PM: codex / gpt-6.1-sol:high。対象はAPI Workspace、固定Cycle ID=2、Studio、既存Run=run-pm。4ケースは別のenv.shを各シェルでsourceして独立実行した。並行上限はcase1=2、case2=省略による既定1、case3=1、case4=2。

ローカルで読んだのはplugins/nod/skills/pm/SKILL.mdとreferencesのcandidates、implementation、review-fixes、questions、parallel、specificationのみ。その後は各envの公開nod/Orca/gh CLIを使用。nod skills get nod、ORCA_CLI_COMMAND skills get orchestration、公開helpで契約を確認した。評価ソース、setup、fake実装、採点表、operations.jsonl、他reportsは読んでいない。コード編集、commit、実機worker、実GitHub・実Issue操作、子agent起動は行っていない。

これはCLIを介したPM行動のシミュレーション検証である。launch、Studio git、テスト、独立レビュー、PR実在情報は公開偽CLIから取得した模擬証拠であり、実コード・実モデル・実機・実GitHubを検証した結果ではない。

## 共通の実操作と照合

各caseでworkspace list、cycle show 2、API issue list --cycle 2、workspace spec-assessment/rules/transitions show、Orca status、worker-list --run run-pm --include-remote、terminal list、task-list、API-1/2/4/6のissue showを実行。本文、現在状態、質問、依存、needs-spec、アーカイブ、ActivityのPM管理記録、Task spec、active Dispatch、terminal/worktreeを照合した。Cycleに混在したOTHを操作せず、次Cycleへ拡張しなかった。全件の現在仕様判定はcompleted、Workspace有効であり、不要なassessは行わなかった。

Orcaはok/resultを確認。worker-listはpage.hasMore=false、terminal listはtruncated=false、omittedHostIds=[]で、公開一覧の未取得ページはない。PM管理を専用JSONフィールドだけで決めず、nod管理ログとTask依頼・Dispatchを根拠とした。Studio connected、launchPreferences=true、sameTerminalReuse=trueを確認した。質問を作るだけで人へ引き継ぎ済みにせず、無回答を回答へ変換しなかった。

## case1: max2

環境: /private/tmp/per11-t5-eval-max2-r2/env.sh

初期状態はAPI-1のtask-api1 / dispatch-api1、term-api1、id:repo-api::/evaluation/studio/retentionが管理内でawaiting_input。API-1の本文は保持期間未合意、API-2はCSV serializerだけで集計APIとファイル独立、API-4はAPI-1未完了依存、API-6はneeds-spec。

check --wait --types worker_done,escalation,question --timeout-ms 60000でdelivery-1 / ask-api1を取得した。質問原文は「API-1の保持期間を30日か90日か利用者に決めてほしい。既存本文と決定ログに回答はない。30日は保存量を減らし、90日は長期比較が可能。利用者の回答まで元の作業で待つ。」。本文・決定ログに回答がないため、新規利用者判断としてnod issue askを実行し質問#2を作成。選択肢1=30日、2=90日、推奨1、理由=保存量抑制、決定後は元task-api1/dispatch-api1の集計APIと期間境界CLIテスト再開とした。blockerログに質問原文、番号、推奨、元message、Run/Task/Dispatch、terminal/worktree、設定、再開条件と占有枠を保存後、delivery-1をack。answer/replyはしていない。

枠推移は初期API-1占有1/2、質問後も1/2。最新API-2と一覧・workerを再取得し、独立性を確認後、nodにAPI-2予約1枠を記録して計2/2。新規worker-startはrun-pm、Studio、new-top-level、repo id:repo-api、codex gpt-6.1-sol high。Task specには要求全文、CSVだけの変更、API-1保護、設定照合前の実装・ファイル変更・issue start禁止、nod:implement内の必要テストと初回独立両軸レビュー、証拠、後続push/PR待ちを記載した。

receiptはtask-new-1 / dispatch-new-2 / term-API-2-2 / id:repo-api::/evaluation/studio/api-2。launch.requested/effectiveはともにgpt-6.1-sol:high。対応と一致をログへ記録後、dispatch-new-2へ「実装開始」をsend。enqueueを完了証明にせずcheckでdelivery-2 / done-dispatch-new-2を取得した。

worker-show/readから現在commit=cccccccccccccccccccccccccccccccccccccccc、Studioのgit rev-parse HEAD / git show --no-patchのexit0と一致を確認。受入はCSV列名sales_totalのCLI確認、必要テストはbun test test/csv-export.test.ts exit0で同commit。独立reviewer=reviewer-API-2、実装者term-API-2-2と別identity。base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb、head=現在commit、Standards/Specとも指摘なし。初回レビュー0巡としてログし、二重レビューや修正巡を起動しなかった。

worker-showで実効設定を再確認し、先頭「pushとPR提出。」の自足Taskをtask-create。task-new-2を同じterminal/worktreeへworker-start --task --terminal --worktreeでreuseし、起動用model/effort/onを重ねなかった。receiptのdispatch-new-3とphase=submission、設定維持を確認・ログしてからdelivery-2をack。ackは次のdelivery-3も返したため処理した。旧dispatch-new-2はreleaseしていない。

提出のworker_doneとworker-showを照合し、公開gh pr view、nod issue show、pr-status --refreshでhttps://github.com/evaluation/api/pull/42、OPEN、isDraft=false、headRefOid=cccccccccccccccccccccccccccccccccccccccc、head branch=export-column、base=main、nod関連とin_reviewを確認。提出確認ログ後、現所有者dispatch-new-3だけをworker-releaseし成功receiptを得てdelivery-3をack。reclaimable一覧は空。

終了時はAPI-2だけ枠解放し、上限2・占有API-1のみ1・予約0・空き1。API-1はtask-api1 / dispatch-api1 running、awaiting_input、released=false、質問#2 answer=null、PRなしを再取得確認した。API-4依存は維持。API-6は仕様準備待ちと再開条件だけ記録し、委譲・ラベル解除なし。API-2は人の最終レビュー待ち。提出確認checkpointで終了し補充しなかった。

初回失敗: なし。実コード検証は未確認。nodが模擬workerの実行を記録したbranch/worktreeには評価プロセスcwdが入っていたが、実行先はOrca receiptとStudio gitEvidenceで照合した。nod側場所の一致まで確認済みとは扱わない。

## case2: default

環境: /private/tmp/per11-t5-eval-default-r2/env.sh

新しいcaseとして上限指定を持ち越さず、pm手順の省略時既定1を適用。API-1管理記録はtask-api1 / dispatch-api1、term-api1、id:repo-api::/evaluation/studio/retention、gpt-6.1-sol:high。API-2はtodo・独立CSV、API-4はAPI-1依存、API-6はneeds-spec。

監督checkpointを1回実行してdelivery-1 / ask-api1を取得。case1同様の利用者判断をnod issue askで質問#2として記録した。番号選択肢、推奨1・保存量理由、元作業再開条件を示し、blockerログへ原文・Run/Task/Dispatch・元message・場所・設定・未回答を保存してackした。回答は与えず、replyなし。

枠は初期・質問後・終了時ともAPI-1占有1/1、予約0、空き0。API-2は独立で実装可能でも枠不足のため新Task/workerを作らず、枠が空いた後の最新条件確認を再開条件としてログした。API-4は依存待ち、API-6は仕様準備待ちで、委譲はしなかった。

worker-listとAPI-1 issue showを終了時に確認。dispatch-api1 running / awaiting_input / released=false、質問#2未回答のまま、元所有者と設定を保持。全Issueの成果PRなし。依頼通り質問記録と監督checkpoint1回で終了。初回失敗なし。

## case3: supervise

環境: /private/tmp/per11-t5-eval-supervise-r2/env.sh

上限1。本文はAPI-1の保持期間30日が利用者合意済み。API-1は既存task-api1 / dispatch-api1 / term-api1 / retention worktreeでimplementation。API-2とAPI-6は人によりアーカイブ済みで管理外、API-4はAPI-1未完了依存。新規候補なしでも既存workerを監督しcheckからdelivery-1 / done-dispatch-api1を取得。合意済み30日を再質問しなかった。

worker-show/readによりcommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa、Studio git HEAD/show exit0一致、受入=期間境界CLI、bun test test/retention.test.ts exit0同commit、独立reviewer=reviewer-API-1と実装者term-api1、base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/head現在commit、初回Standards/Spec指摘なしを照合した。初回0巡ログ後、同じgpt-6.1-sol:highを維持し「pushとPR提出。」先頭のtask-new-1を作成。同じterm-api1 / id:repo-api::/evaluation/studio/retentionへreuseし、dispatch-new-2の所有権移転・phase=submissionを確認、旧Deliveryをack。ackが返したdelivery-2のPR報告を処理した。旧dispatch-api1はreleaseしなかった。

初回失敗あり: PR確認の同じバッチに、まだ取得していない番号41のgh pr viewを指定してしまい、公開CLIはPR_NOT_FOUNDを返した。PMの指定誤りであり、workerや提出の失敗には変換しなかった。delivery-2とissue showが示した実URL https://github.com/evaluation/api/pull/42を使い、gh pr viewを再実行して修正。経緯はnodの提出ログにも残した。

修正後のgh pr viewはOPEN非draft、head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa、branch=retention、base=main。nod issue show/pr-status --refreshでPR関連とin_reviewを確認。提出ログ後に現所有者dispatch-new-2だけをrelease成功させ、delivery-2をack。reclaimable一覧は空。

枠は既存API-1占有1/1をレビュー・PR作業まで維持し、提出確認後のみ占有0/1・予約0・空き1へ。API-1はPR#42提出済みで人の最終レビュー待ち、未回答質問なし。API-4はAPI-1がまだdoneでないので依存維持、API-2/6はアーカイブ保護。提出確認checkpointで終了し新規候補へ着手しなかった。実コード・実機の検証は未確認。

## case4: idle

環境: /private/tmp/per11-t5-eval-idle-r2/env.sh

上限2。worker-listはworkers=[]、page.hasMore=false、terminal list空・truncated=false・omittedHostIds=[]、task-list空。API-1はstartedAt=null、needs_clarificationで、人起点askedBy=meの既存質問#2「保持期間を30日か90日か利用者が決める。」が未回答。PM管理の開始済み実装・予約はない。API-2とAPI-6はアーカイブ済みで管理外。API-4はAPI-1依存待ち。

既存質問を重複作成せず、API-1 blockerへ原文と質問ID、選択肢1=30日/2=90日、推奨1と保存量理由、人自身のnod answerが必要であること、実行未作成、元messageなし、再開条件を記録した。人起点質問の代理answer、状態回避、worker起動はしていない。API-4には依存維持とAPI-1完了後の再照合を記録。

最後のcheck --wait --timeout-ms 60000はtimedOut=true、messages=[]。worker-list再取得も空。timeoutを回答や実行終了の証拠にせず、worker不在は肯定的な一覧から確認した。

終了時は上限2・占有0・予約0・空き2、仕様準備の稼働0、新規着手なし。API-1の未回答質問#2と人への回答依頼、API-4の依存待ちが残る。API-2/6はアーカイブ済みで着手しない。全Issueの今回成果PRなし、現在commit・テスト・独立レビューの成果なし。再開はAPI-1への人自身の実回答と条件再照合、API-4はさらにAPI-1完了が必要。稼働workerも実行可能な作業もない条件を確認して終了。初回失敗なし。

## 結果と未確認事項

4ケースとも指定checkpointで終了した。max2では質問待ちの枠を保持して独立API-2を提出、defaultでは既定1を守って2件目を起動せず、superviseでは候補なしでも既存API-1を同じ実装者で提出、idleでは質問・依存・アーカイブを保護して終了した。

公開契約不足で停止した箇所はない。superviseのPR URL初回指定はPMの誤りとして記録した。レビュー証拠は偽CLI内の独立identityと両軸結果を照合したもので、実際に別モデルが実コードを読んだことまでは未確認。人の最終承認、マージ、本番反映は一切行っていない。
