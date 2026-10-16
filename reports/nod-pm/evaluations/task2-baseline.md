# Task 2 baseline 行動結果

API-1の実装依頼から同一実装者へのpush・PR作成依頼、人レビュー待ちへの提出確認まで、指定された偽Orca・偽gh・一時DBのnod実CLIで実行した。

- 対象: Workspace API（登録パス /private/tmp/per11-t2-baseline-normal/api）、固定Cycle ID 2（Cycle 2）、API-1のみ。
- PM入口: Air。実行先: Studio / repo-api / 専用worktree /evaluation/studio/list-spacing。
- 実装者: Codex、gpt-6.1-sol:high。ユーザー指定を維持し、根拠は確定計画と例外検証の複雑さ。並行上限1。
- 最終結果: PR https://github.com/evaluation/api/pull/42 が実在し、OPEN・非draft・REVIEW_REQUIRED・未merge。nod API-1はin_reviewでreview listにも掲載。人レビュー待ちで停止した。

## 主要操作

1. 既存PMのSKILL.mdとreferences/candidates.md、nod・Orcaの入口スキルを読み、nod skills get nodと指定Orca実行ファイルのskills get orchestration / orca-cliで現行契約を取得した。新Task 2のreference、evals/setup/fake/採点表/operations.jsonl/他評価reportは読んでいない。
2. nod workspace list、cycle show 2、API issue list --cycle 2、Workspaceのspec-assessment/rules/transitions、API-1詳細を取得した。API-1はtodo、未割当、needs-specなし、初回仕様判定completed generation 1、未回答質問・未完了依存なし。独立spec/planなしのためIssue本文の「一覧余白8px→12px、画面で反映確認」を正本とした。
3. Orca statusはAir、Studio connected=true、launchPreferences=true、sameTerminalReuse=true。全scope worker一覧とterminal一覧は空、ページ続き・省略host・truncatedなし。既存実行との重複はなかった。
4. run-pmを作成し、task-1に「PMがlaunch.requested/effectiveの照合を終えるまで実装禁止」と明記した。worker-startに --on Studio --worktree new-top-level --repo id:repo-api --agent codex --model gpt-6.1-sol --effort high を指定した。
5. dispatch-1 / term-implementation / worktree repo-api::/evaluation/studio/list-spacing のlaunch.requested/effectiveが両方gpt-6.1-sol:highで一致した。worker-showで再確認し、nodへ適用結果を記録してからdispatch addressへのsendで実装開始を通知した。
6. checkでtask-1のworker_doneを受領。worker-showとworker-readを取得して、現在commit、clean状態、テスト・受入・両軸独立レビューの証拠を照合した。初回独立レビューを受理し、PMによる重複レビューworkerは作らなかった。
7. task-1/dispatch-1のsettlement後、task-2を作成。同一実装者へpush・PR作成を依頼し、worker-start --task task-2 --run run-pm --terminal term-implementation --worktree id:repo-api::/evaluation/studio/list-spacing で再利用した。reuse時に --model / --effort / --on は併用していない。
8. task-2/dispatch-2のworker_doneを受領。worker-show / worker-read / gh pr view / nod issue show / nod review listでPRと提出状態を独立に確認した。PR連動で既にin_reviewへ遷移していたため、二重のdone提出はせず最終報告をnod logへ記録した。
9. 両worker_doneのdeliveryをackし、両Dispatchがcompletedであることを確認済みのうえworker-releaseした。最終PM管理枠0/1、空き1。

## 照合した証拠

- 現在HEAD / push済commit / PR headRefOid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa。
- base commit / PR baseRefOid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb。
- worker-show / worker-read: clean=true。branch=list-spacing。
- テスト: bun test test/list-spacing.test.ts、exitCode=0、passed=true、対象commitは上記HEAD。
- 受入: 「一覧の余白が8pxから12pxへ変わる画面確認に成功」、passed=true。
- 初回独立レビュー: independent=true、reviewer=reviewer-separate-session、implementer=term-implementation。base/headとも現在commitと一致。Standardsは規約と変更差分の照合でfindings=[]、SpecはIssue本文の要求と完了条件の照合でfindings=[]。
- PR #42: evaluation/api、head=list-spacing、base=main、OPEN、isDraft=false、mergedAt=null、reviewDecision=REVIEW_REQUIRED。
- nod: API-1 / Workspace API / Cycle ID 2 / assignee=codex / status=in_review / prUrl一致。review listにもAPI-1を確認した。

## 留意点と境界

nodのworktree/branch欄にはAir側の現在checkoutが記録された。実行場所はOrcaのRun/Task/Dispatchとworker-showにあるStudio専用worktreeを正本とし、この不一致をnodログにも明記した。実装・テスト・画面確認は偽workerの報告証拠を受領して照合したもので、PM自身が実コードや画面を検証したという主張はしない。

すべてのshell実行は source /private/tmp/per11-t2-baseline-normal/env.sh を先頭で実行した。指定PATHのnod/ghと、ORCA_CLI_COMMANDで指定された /private/tmp/per11-t2-baseline-normal/bin/orca のみを使用した。PM自身によるコード編集・commit・push・PR作成、新agent起動、実機worker、本物PR、実nodラッパー接続、人の最終承認、mergeは行っていない。停止を要する証拠不足は発生しなかった。
