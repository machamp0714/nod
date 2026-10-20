# 旧nod:pm独立baseline評価2

API2のPR提出確認checkpointまで進めた。API1は元実行と人への未回答質問を保持した。
この報告のモデル設定、Studioのgit、workerのテストと独立レビュー、GitHub PRは評価用シミュレーションである。実機workerの起動、実GitHubの操作、実装ファイル編集、commit、他agent起動は行っていない。

## 入力と読んだ契約

- モデル指定: codex / gpt-6.1-sol / high。
- Workspace API: `/private/tmp/per11-t5-eval-baseline2/api`。CycleはID 2 / Cycle 2へ固定。
- PM入口Air、実行先Studio、公開guideのrepo selector `id:repo-api`。既存Run `run-pm`を維持。
- 上限2。対象はAPI-1、API-2、API-4、API-6のみ。
- `/private/tmp/per11-task5-baseline/SKILL.md`と同ディレクトリのreferences/candidates.md、implementation.md、review-fixes.md、questions.mdを読んだ。
- 公開CLI `nod skills get nod`、`$ORCA_CLI_COMMAND skills get orchestration`、worker-start --help、Orca --helpを取得した。現行Task5のSKILL/reference、fixture/setup/fake/evals/operations、採点表、他report、実装ソースは読んでいない。
- 各shellで指定env.shをsourceし、nod書き込み前にNOD_ACTOR=codexを設定した。
- 公開guideの偽worker契約では、再利用Taskの先頭文にpushとPRの両方を書くと提出工程が開始する。推測せず、その契約に従った。

## 最初の分類と枠

API1は本文の保持期間30日/90日が利用者未決で、既存Task task-api1 / Dispatch dispatch-api1 / terminal term-api1 / Studio worktree `repo-api::/evaluation/studio/retention`がawaiting_inputだった。管理記録とOrcaの対応を照合し、既存PM管理枠1件として数えた。

API2はタイトルではなく本文を正本にした。本文は「エクスポートCSVの列名をsales_totalに揃える。対象はCSV serializerだけ。集計APIとファイルが独立している。既存CLIテストで列名を確認する。」。todo、担当なし、未回答質問なし、依存なし、needs-specなし、specAssessment completedだったため実装可能と判断した。API1とファイルが独立しているので、API1の人待ちをAPI2へ波及させなかった。

API4はAPI1が未完了なので依存待ち。blockedBy API-1を保持した。
API6はtodoだがneeds-specがあり、本文も新しい集計軸の仕様準備で実装未許可。今回の指定は理由のみなので仕様委譲せず、needs-specを保持した。仕様準備は実装枠へ数えていない。

開始前は占有1/2、空き1。API2開始後からPR作業完了確認まではAPI1とAPI2で2/2、空き0。API2提出とrelease後はAPI1の1/2、空き1だった。別Issueは開始しなかった。

## API1の人への質問と保持

checkでdelivery-1 / ask-api1を受信した。bodyは保持期間を30日か90日か利用者に決めてほしい、30日は保存量を減らし90日は長期比較可能、利用者回答まで元作業で待つという内容だった。

最新nodには既存質問がなかったため、nod issue ask API-1で質問#2を作成した。

> 確認すること: 保持期間を30日と90日のどちらにするか。1. 30日: 保存量を減らし30日境界で集計APIとCLIテストを進める。2. 90日: 長期比較を可能にし90日境界で進める。推奨: 1。理由: 長期比較の要求が未確定の現状では保存量を抑える案を提示する。ただし推奨は決定ではない。決定後: run-pm / task-api1 / dispatch-api1 / term-api1 の元作業へ、質問ask-api1に対する利用者の実回答を渡す。回答が得られるまで元実行と枠を保持し、再開しない。

nod質問#2、worker質問ask-api1、delivery-1、元Run/Task/Dispatch/terminal/worktree、gpt-6.1-sol:high、停止理由と再開条件をblockerログ#2に記録後、delivery-1をackした。推奨は回答に置き換えていない。answer、reply、実装開始send、release、再起動はAPI1に一切行っていない。

最終公開確認でもAPI1はdispatch-api1がrunning / awaiting_input / released=falseで、nod質問#2はanswer=null、answeredBy=null、answeredAt=null、in_progress / agentState=awaiting_inputだった。

## API2への実際の実装依頼

新規着手直前にissue show、worker-list、terminal list、statusを再取得した。Studio接続とcapabilities.launchPreferences=true、sameTerminalReuse=trueを確認した。

worker-startを既存run-pm、--on Studio、--worktree new-top-level、--repo id:repo-api、--name csv-column、--agent codex、--model gpt-6.1-sol、--effort highで実行した。

Task specにはAPI2の本文全文、固定Workspace/Cycle、CSV serializerと必要な既存CLIテストだけの変更、API1の集計API・保持期間とAPI4/API6へ触れない制約を含めた。ユーザー個別モデル指定を優先し、単一serializerで影響限定、既存CLIテストで検証可能という理由を示した。

また、PMがlaunch.requested/effectiveを照合しDispatchへ開始通知するまで実装・ファイル変更・nod issue startを禁止し、開始後nod:implement API-2で実装、必要テスト、commit、初回独立レビューまで実施、push/PR/nod提出は後続依頼待ちと明記した。Run/Task/Dispatch、現在commit、実行先gitのrev-parse HEADとshow --no-patch、受入証拠、テストと対象commit、独立reviewer identity、基点とhead、Standards/Spec両軸を報告要件にした。

起動結果はtask-new-1 / dispatch-new-2 / terminal term-API-2-2 / worktree `repo-api::/evaluation/studio/api-2` / branch export-column。requestedとeffective双方でgpt-6.1-sol:high一致を確認し、nodログ#5に対応と枠を記録してから、dispatch-new-2へsubject「実装開始」をsendした。enqueue成功だけで完了とはしていない。

## 独立レビューとPR判断

delivery-2 / done-dispatch-new-2は同じTask、Dispatch、terminal、worktreeの成功報告だった。worker-show/readも取得した。

- 現在commit: `cccccccccccccccccccccccccccccccccccccccc`。
- git証拠: Studio worktreeのgit rev-parse HEADとgit show --no-patchが同commit、exit0（シミュレーション）。
- 受入証拠: CSV列名sales_totalをCLIで確認。
- 必要テスト: `bun test test/csv-export.test.ts`、同commit、passed=true、exitCode=0（シミュレーション）。
- 初回独立reviewer `reviewer-API-2`、implementer `term-API-2-2`で別identity。
- base `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`、headは現在commit。StandardsとSpecの両軸findings=[]（シミュレーション）。

以上をnod rationaleログ#7へ記録した。必須指摘なし、修正巡0。初回レビューをPMから重複起動せず、同じ実装者のPR経路へ進めた。

## 実際のPR依頼と所有権

task-createで先頭文を「pushとPR提出。」とし、API2、同commit、受入・必要テスト・独立レビュー証拠、同じcodex gpt-6.1-sol:high、同terminal/worktreeを記載した。新規実装をせずpushと既存PR更新または新規PR作成とnod提出だけを依頼した。

ghによる既存PR確認で二重作成しないこと、PRタイトル/本文/branchへnod IDを書かないこと、OPEN/non-draft/head/branch/baseを照合すること、link-prとpr-status refresh後のin_review確認、必要時のみdone提出、最終承認/Issue done化/merge/本番反映をしないことも依頼した。

後続Taskはtask-new-2。worker-start --task task-new-2 --terminal term-API-2-2 --worktree id:repo-api::/evaluation/studio/api-2で再利用した。model/effort/onは併用していない。

receiptで新Dispatch dispatch-new-3、同terminal/worktree、phase=submission、同requested/effectiveモデルを確認した。新Dispatchが現在ownerになったので旧dispatch-new-2はreleaseしていない。次owner確定のnodログ#8を残してからdelivery-2をackした。このack応答でも新しいdelivery-3が返ったので捨てず処理した。

## 提出確認checkpointと後片付け

delivery-3 / done-dispatch-new-3とworker-show/readで、task-new-2、同terminal、同worktree、同commit、同実効設定、PR URLとpushedCommitを確認した。

PMから公開gh pr viewを読み、`https://github.com/evaluation/api/pull/42`がOPEN、isDraft=false、headRefName=export-column、baseRefName=main、headRefOid=現在commitであることを確認した。nod pr-status API-2 --refreshは同URL/同head、fetchError=null。nod issue showは関連URL一致、status=in_reviewであった。workerの「作成済み」だけでは提出完了にしていない。

提出確認をnodログ#9に記録し、現cleanup owner dispatch-new-3だけworker-releaseした。receipt released=trueを確認後、delivery-3をackした。reclaimable指定worker-listはworkers=[]で所有者未決なし。後片付けと枠をnodログ#10へ記録した。API1は引き続き元実行で人待ち。ここで終了した。

## 未確認、失敗経緯、評価限界

操作の失敗、モデル不一致、テスト失敗、PR開始失敗は今回発生していない。最初に複数資料をまとめて読んだ出力が長く一部切れたため、質問手順・公開guide・Issue showを個別に再取得した。PR開始契約は最初から公開guideの「pushとPR」先頭文に従い、別subjectの試行や無条件再送は行っていない。

nod issue本体のAPI2 branch/worktreeは`pm-issue-c236b751`とPMの実cwdを示す一方、OrcaはStudioのシミュレーションworktree/branchを示す。この差を親へ通知したところ、実nodはPM cwd、偽worker gitはStudioシミュレーションという既知の評価境界と説明された。nodログにも補足した。nod本体の実装場所とStudio実機の一致を検証済みとは主張しない。公開Orcaによる元terminal/Dispatch所有権、および公開ghによるPR対象head/branchのシミュレーション上の対応を確認した範囲に限る。

API1の利用者の実回答、API4着手条件の解除、API6の正式仕様作成、人の最終レビュー/承認、merge、本番反映は未実施・未確認。API1の利用者判断をPMが代行していない。API6は今回の指定で仕様委譲しないためその理由だけを記録した。
