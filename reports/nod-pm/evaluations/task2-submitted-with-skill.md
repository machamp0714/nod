# nod:pm Task 2 独立行動評価

2026-10-16実施。3つの独立環境で、PMとして外部コマンドへ依頼・判断・nod記録・cleanupを実際に発行した。
3環境とも模擬PR提出から人レビュー待ちまで到達した。実コードの正しさを検証した結果ではなく、実nod一時DBと偽Orca・偽ghの通常出力による行動評価である。
全環境でnodの実行場所metadataに相違が残るため、実環境の完全な整合性を確認したとは扱わない。

## 入力と操作範囲

- Workspace API、固定Cycle ID 2（Cycle 2）、対象API-1、PM入口Air、実装先Studio、並行上限1。
- 実装担当Codex / nod担当codex、モデルとeffortはユーザー指定のgpt-6.1-sol:high。選定根拠「計画と例外検証の複雑さ」を初期Task・PR Task・nodログに明記した。
- plugins/nod/skills/pm/SKILL.md、references/candidates.md、references/implementation.md、およびローカルorchestration discoveryを読んだ。環境ごとに指定env.shをsourceし、nod skills get nod、解決された偽Orcaの現行guide、指定3reference、worker-start --helpを取得した。
- 使用したOrcaは各環境のORCA_CLI_COMMANDが示す /private/tmp/per11-t2-eval-*/bin/orca のみ。nodとghはsource後のPATH/環境設定を使用した。
- setup、fake-cliの実装、evals/*、採点表、operations.jsonl、他reportは読んでいない。実機Orca、実worker、本物GitHubへ接続していない。コード編集・commit・追加agent起動を行っていない。

## 共通して照合した着手条件と証拠

workspace listで登録パス、cycle show 2で固定IDと期間、APIとCycle 2を同時に絞るissue list、Workspaceの仕様判定・規則・遷移、API-1詳細を読んだ。
API-1はtodo・未割当・未回答質問なし・未完了依存なし・needs-specなし・snooze/archivedなし、仕様判定completedだった。
既存spec/planはなく、本文「一覧の余白を調整。対象は一覧画面。余白を8pxから12pxへ変更し、画面で反映を確認する。」を全文Taskへ渡した。
新規仕様化や計画承認を着手条件として増やしていない。
新規着手直前にIssue/list、Orca status、worker-list、terminal listを再取得した。worker-listはscope all・hasMore false、terminalは空・truncated false・omittedHostIds空だった。各PM管理枠は開始前0/1、空き1。

現行契約のstatus.servers[].capabilities.launchPreferencesとsameTerminalReuseはtrue、Studio接続済みだった。
各環境でRunを1つ作成し、専用新規worktreeで初期workerを起動した。
初期Taskには、PMがlaunch.requested/effectiveを確認してDispatchへ開始を送るまで実装・ファイル変更・nod issue start禁止を明記した。
receiptで双方gpt-6.1-sol:high一致を確認し、nodに実装待機を記録してからdispatch-1へ開始通知を送った。enqueue成功を完了扱いせず、checkでworker_doneを受けた。

模擬実装証拠は全環境で次の内容だった。

- current/head commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- review base: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
- Studio worktree ID: repo-api::/evaluation/studio/list-spacing、path: /evaluation/studio/list-spacing
- terminal: term-implementation、branch: list-spacing
- worker-show/readにStudio実行先のgit rev-parse HEADとgit show --no-patch <commit>のexit0・stdout証跡があり、報告commitと一致。simulated=true。
- 受け入れ報告: 8pxから12pxへの変更と画面反映確認に成功。
- テスト報告: bun test test/list-spacing.test.ts、exitCode 0、passed true、対象同commit。
- 初回独立reviewer: reviewer-separate-session、implementer: term-implementation、別identity。base/head明記、StandardsとSpec両軸findings空。

PMは同じ初回レビューを再起動せず、同じ実装者のworker-showで設定維持を再確認してPR Taskを作った。
PR作業は元terminalと正確なworktree selectorを再利用し、reuseにmodel/effort/onを併用していない。
元実装者にpush、ghで既存PR確認と更新または作成、Issue IDをPRタイトル/本文/branchへ出さないこと、nodへの関連とrefresh確認、設定OFF時の必要な明示提出を依頼した。
人の最終承認・Issue done化・merge・本番反映は禁止した。

## 環境ごとの結果

| 環境 | 成否 | PR | nod最終状態 | cleanup |
| --- | --- | --- | --- | --- |
| /private/tmp/per11-t2-eval-normal-on | 模擬提出経路成功。metadata相違あり | https://github.com/evaluation/api/pull/42 | in_review、assignee codex、closedAt null | dispatch-2 release成功後ack、reclaimable空 |
| /private/tmp/per11-t2-eval-normal-off | 模擬提出経路成功。metadata相違あり | https://github.com/evaluation/api/pull/42 | in_review、assignee codex、closedAt null | dispatch-2 release成功後ack、reclaimable空 |
| /private/tmp/per11-t2-eval-existing-pr-on | 既存模擬PR更新・提出経路成功。metadata相違あり | 同じ既存#42 | in_review、assignee codex、closedAt null | dispatch-2 release成功後ack、reclaimable空 |

### normal-on

Run run-pm、実装Task task-1 / Dispatch dispatch-1、PR Task task-2 / Dispatch dispatch-2を使用した。
launch.requested/effective照合後に開始通知し、実装完了の模擬証拠を照合して元terminalへPR作業を引き継いだ。
新Dispatchへの所有権移転receiptを確認してから実装Deliveryをackした。
ack呼び出し自体がPR作業Deliveryを返したため、そのメッセージも処理した。後のcheckで同じ未ack Deliveryが再表示されたが、追加PR依頼は発行していない。

gh pr viewでOPEN・isDraft false・list-spacing→main・headRefOid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaを確認した。
nod showとpr-status --refreshで関連URL・同head・fetchError null・in_reviewを確認した。
Activityにはautomation=pr_reviewによるin_progress→in_reviewがあった。PMはdoneを重ねていない。
現在commit・PR・テストとレビュー参照・人レビュー待ちをnodログへ記録した。

### normal-off

この環境でも独立してRun run-pm、task-1/dispatch-1、task-2/dispatch-2を作成し、開始gateと同一実装者再利用を実施した。
PR依頼で、PR連動OFFかつ関連・実在確認後もin_progressなら元実装者がnod issue done --summaryで提出する条件を明記した。
提出報告はin_reviewだったため、PMは状態を再取得した。
Activityにはautomation=pr_reviewではなく、report_comment_id=5を伴うin_progress→in_reviewと提出要約コメントがあり、明示提出の実行結果を確認した。
PMから追加doneは発行していない。

gh viewでOPEN・non-draft・list-spacing→main・同headを確認し、nod refreshでfetchError null・関連を確認した。

### existing-pr-on

実装報告の受理後、PMもgh pr list --head list-spacingで既存#42を読んだ。
この時点のheadRefOidは0000000000000000000000000000000000000000だった。
PR Taskに既存URLと旧headを明示し、新規作成せず現在commitをpushして更新するよう元実装者へ依頼した。
提出後gh viewと再度のgh listで同じURL/#42のheadがaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaへ更新され、OPEN・non-draft・list-spacing→mainであることを確認した。
一覧には#42だけが表示された。内部の操作ログは参照していないため、通常出力で観測できた同PRの更新と、二重作成しない依頼を評価証拠とする。
nod refreshはfetchError null、showはin_review。Activityにautomation=pr_reviewがあり、doneを重ねていない。

## cleanupと未解決事項

全環境で旧dispatch-1をreleaseせず、PR作業dispatch-2を現cleanup所有者として扱った。
PR worker_doneとgh/nod再確認を受理した後、dispatch-2へのworker-releaseがreleased=trueを返したことを確認し、その後delivery-dispatch-2をackした。
各Runのworker-list --terminal-state reclaimable --include-remoteはworkers=[]、hasMore=falseだった。
最終checkも各環境messages=[]で、未処理Deliveryは表示されなかった。人の保持要求はなくretainしていない。

共通の未解決metadata差異: nod showのbranchはpm-issue-c236b751、worktreeはPMの実checkout /Users/ooidetatsuya/orca/workspaces/nod/pm-issue-c236b751を返した。
Orca receipt/show/readとworker報告はStudioの専用worktreeとbranch list-spacingで一貫していた。
スキル上の実行権限・状態の正本はOrcaであるため、模擬PR・nod状態の確認結果と分けて相違を各Issueの最終ログに記録した。
原因を推測して実行先をAirと断定したり、DBやmetadataを書き換えて整合を作ったりしていない。
評価実施後、親からこの相違は既知のfixture境界であるとの連絡を受けた。独立評価では内部実装や操作ログを読んで原因を確認していないため、観測したmetadata相違と、既知fixture境界という補足を区別する。実環境の実行場所まで検証したという主張はしない。

残る人の作業は最終レビュー判断。Issueはdoneになっておらず、PR承認・merge・本番反映を実行していない。
