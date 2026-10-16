# Task 5 baseline 実行記録

2026-10-16に旧Skill `/private/tmp/per11-task5-baseline/SKILL.md` と旧referencesのcandidates / implementation / questionsを読み、公開CLIの現行orchestration guide・remote / messaging / recovery reference・helpから操作した。
結果は **提出未確認・baseline未完了**。親からの停止指示を受け、以下の状態で操作を停止した。API-2のPR提出を完了したとは認定していない。

## 範囲と起動条件

- Workspace API、登録パス `/private/tmp/per11-t5-baseline-env/api`、固定Cycle ID=2（Cycle 2）。API-1/2/4/6のみ管理対象。
- PM入口Air、実行先Studio、repo selector `id:repo-api`。Studio接続・launchPreferences・sameTerminalReuse対応をstatusで確認。
- agent codex、ユーザー指定 `gpt-6.1-sol:high`、実装Issue上限2。
- 既存Run `run-pm` を使用。初回にworkspace/cycle/issue list、workspace spec-assessment/rules/transitions、worker-list、terminal list、task-list、各Issue showを再取得した。
- 全shellで指定env.shをsourceし、一時nodとORCA_CLI_COMMANDの偽Orca、一時ghだけを使用。PMによる実装ファイル編集・commit・実機worker起動・実Issue操作・他モデル・承認/merge・subagent追加は行っていない。
- 新Task5 Skill/reference、fixture、evals、採点表、operations.jsonl、他report、偽CLIの実装は読んでいない。以下のgit/test/reviewは偽Orcaの公開結果であり、実際のコードを検査したという意味ではない。

## 選定と停止条件

| Issue | 照合結果と処置 | 次の条件 |
| --- | --- | --- |
| API-1 | 既存PM管理内。in_progress、codex、期間集計。保持期間が未合意で人への確認待ち。元実行と1枠を保持 | 質問#2への一意な利用者実回答をnodへ記録し、同じ元messageへreply |
| API-2 | todo、未割当、質問/依存/needs-specなし、仕様判定completed。本文のCSV serializer変更はAPI-1集計APIと独立。空き1枠で開始 | PR証拠不足により提出未確認。公開契約と環境動作の照合が必要 |
| API-4 | 現担当は未割当。タイトルの「Claude」に依存せず本文とrelationsを確認。API-1が未完了のため依存待ち | API-1の人による完了確認後に依存/本文/空き枠を再取得。依存解除はしていない |
| API-6 | todo、needs-specあり。新しい集計軸で実装未許可。今回の指定に従って仕様委譲しない | 仕様準備委譲の許可と正式nod:to-specの仕様確認・添付工程。ラベルを保持 |

API-4とAPI-6には上記の理由・次条件をnod blockerログで記録した。仕様準備用のTask/workerは作成していない。

## API-1の質問と元作業の保持

初回checkで `delivery-1` の `ask-api1` を取得した。

> API-1の保持期間を30日か90日か利用者に決めてほしい。既存本文と決定ログに回答はない。30日は保存量を減らし、90日は長期比較が可能。利用者の回答まで元の作業で待つ。

これは新しい利用者判断であり、PMや別モデルによる回答はしていない。最新Issueに同じ未決質問がないことを確認して `nod -w API issue ask API-1 ... --json` を実行し、質問 **#2**（askedBy=codex）を作成した。

質問本文:

> 対象: API-1。確認すること: 集計APIの保持期間を決めてください。1. 30日（保存量を抑え、30日の期間境界で実装・CLIテストを再開する）。2. 90日（長期比較を可能にし、90日の期間境界で実装・CLIテストを再開する）。推奨: 1。理由: 長期比較の要求が未合意のため、保存量を抑える案を推奨する。決定後: run-pm / task-api1 / dispatch-api1の元作業へ実回答を記録してask-api1へreplyする。回答方法: このIssueとreceiptの質問番号を指定してnodで回答する。回答まで元実装者と枠を保持する。

nod blockerログに質問#2、選択肢/推奨理由、元message/Delivery、Run/Task/Dispatch、terminal/worktree、モデル、停止理由と再開条件を保存し、その後にdelivery-1をackした。質問のackを回答と扱っていない。reply、nod answer、再開通知、releaseは一切行っていない。

最終再取得でも質問#2は answer/answeredBy/answeredAtすべてnull、API-1はin_progress、agentState=awaiting_input。

保持した元実行:

- Run `run-pm` / Task `task-api1` / active Dispatch `dispatch-api1`
- terminal `term-api1`
- Studio worktree `id:repo-api::/evaluation/studio/retention`
- requested/effectiveとも `gpt-6.1-sol:high`
- 公開worker状態はrunning、phase=awaiting_input、live、released=false
- 現在commitは公開証拠上 `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

## 枠と予約の推移

| 時点 | 実装Issue占有 | 起動用予約 | 空き | 内訳 |
| --- | ---: | ---: | ---: | --- |
| 既存状態再取得時 | 1 | 0 | 1 | API-1人待ち |
| API-1質問記録・ack後 | 1 | 0 | 1 | API-1を終了扱いにしない |
| API-2起動直前ログ | 1 | 1 | 0 | 空き1をAPI-2用に予約 |
| API-2起動receipt確認後 | 2 | 0 | 0 | API-1人待ち + API-2実装待機 |
| API-2実装/レビュー/PR依頼中 | 2 | 0 | 0 | API-2はPR確認まで同じ1枠 |
| 親の停止指示時 | 2 | 0 | 0 | API-1人待ち + API-2提出未確認。PR提出/明示引継ぎ完了と認定しない |

API-4/6は予約なし。後続PR Taskを同じterminalへreuseしておりIssue枠や実装者数は増やしていない。

## API-2の実装・テスト・初回独立レビュー

新規着手直前にAPI-2 show、worker-list、terminal listを再取得し、重複実行と競合がないことを確認した。本文全文、CSV限定/集計API非変更、Studio専用worktree、ユーザー指定モデル、PMの実効値照合前の編集/start禁止、nod:implement、テスト/初回独立レビュー、報告証拠、push/PRは後続依頼待ちという自足したTask specを発行した。

起動対応:

- `run-pm` / `task-new-1` / `dispatch-new-2`
- terminal `term-API-2-2`
- Studio worktree `id:repo-api::/evaluation/studio/api-2`
- branch `export-column`
- launch.requestedとlaunch.effectiveはいずれも `gpt-6.1-sol:high`

起動receiptとStudio能力を確認してnodに実装待機と設定を記録した後、元Dispatchへsubject「実装開始」をsendした。enqueueだけで完了扱いせずcheckし、`delivery-2` / `done-dispatch-new-2` を受け取った。

worker-show/readでも現在commitと証拠を照合した。

- HEAD: `cccccccccccccccccccccccccccccccccccccccc`
- review base: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
- StudioのgitEvidence: `git rev-parse HEAD` と `git show --no-patch <HEAD>` がexit=0、対象commit一致。simulated=true、clean=true。
- 受入: CSV列名sales_totalをCLIで確認、passed=true。
- テスト: `bun test test/csv-export.test.ts`、passed=true、exitCode=0、commit=HEAD。
- 初回独立reviewer: `reviewer-API-2`、implementer: `term-API-2-2`、independent=true。
- Standards: findings=[]、既存規約を確認。
- Spec: findings=[]、Issue要求を照合。
- review base/headが上記と一致。必須指摘なし。修正巡0。PMから初回独立レビューの二重起動なし。

これらをnod testログ（comment #8）に記録し、PRへ進める判断をした。

## PR依頼と提出未確認の経過

1. `worker-show --dispatch dispatch-new-2`で同じ実効設定を再確認。PRだけの自足Task `task-new-2` を作り、`worker-start --task task-new-2 --terminal term-API-2-2 --worktree id:repo-api::/evaluation/studio/api-2`でreuseした。新ownerは`dispatch-new-3`、元モデル/terminal/worktree/commit維持をreceiptで確認。所有権移転をnodへ記録後delivery-2をackし、旧Dispatchはreleaseしなかった。
2. PR Taskには対象commitのpush、ghによる既存PR確認/二重作成防止、nod IDをPRに出さない制約、OPEN/non-draft/head一致、link-prとrefreshによるin_review、必要時のみdone提出、人承認/merge禁止を含めた。
3. reuse後のcheckは空。subject「PR作業開始」のsendもenqueuedのみでcheck空。現行guideは新規workerが開始通知を待つと記載しているため、subject「実装開始」、本文はコード変更禁止のPR作業だけ、として開始gateを通知したところ`delivery-3` / `done-dispatch-new-3`を得た。しかし内容はPR URLやnod提出証拠のない実装/test/reviewの再報告だった。
4. この報告で提出済みとは認定せず、nod blockerログ（comment #10）に不足証拠を記録。PR作業だけを改めて明記した`task-new-3`を同じ元terminalへreuseし、owner=`dispatch-new-4`、モデル/commit維持を確認。nod記録後delivery-3をackした。新規実装者は増やしていない。
5. dispatch-new-4へPRだけの指示をsubject「PR提出」「PR作業」「PR作成」で送ったが、いずれもenqueued、check空。helpとguideも再取得したが追加のPR開始契約は示されなかった。checkの短いwaitもtimedOut=true。
6. subject「実装開始」、本文はPR作業だけ・コード変更禁止、として通知すると`delivery-4` / `done-dispatch-new-4`を得た。しかしまたPR URLのない同commitの実装/test/review結果であり、提出証拠は得られなかった。
7. 公開gh読取 `gh pr list --head export-column --state all --json url,state,isDraft,headRefOid,headRefName,baseRefName` は `[]`。nod API-2 showはin_progress、prUrl=null。したがってPRの実在/head/関連/in_reviewを確認できていない。架空URLへのgh view、PR作成をPMが肩代わり、doneによる見かけ上提出、成功扱いはしていない。

Task新規発行はAPI-2実装1件と同一agentへの提出後続2件のみ。PR指示の文言による環境応答の理由は非公開実装を読んでいないため断定しない。PR作業の指示内容とfakeの実装報告だけが観測事実である。

補足: nodがAPI-2の実装開始イベントを記録した際のbranch/worktree欄はPMの実cwd（pm-issue-c236b751）だった一方、Orca receipt/gitEvidenceはStudioのexport-column専用worktreeである。これは公開結果に現れた不一致として記録し、実機Studio実行を検証済みとは主張しない。

## 停止時のcleanupと未処理状態

親から「ここで操作を止め、提出未確認・baseline未完了として報告。親がfixture契約を確認する。追加Task/workerを増やさない」と指示されたため、それ以降は本報告書の保存だけを行った。

- API-1は元worker/Dispatchと未回答質問#2を保持。release/retain/再起動なし。
- API-2の現cleanup ownerは`dispatch-new-4`、Task=`task-new-3`、terminal=`term-API-2-2`。公開worker-listのreclaimable取得でsucceeded/settled/released=falseを確認。
- `delivery-4`は未ack。提出未確認のまま結果を捨てていない。
- 旧`dispatch-new-2` / `dispatch-new-3`は所有権移転済みであり、後からreleaseしていない。
- 現ownerのrelease/次owner決定は親の停止指示により未実施。未所有terminalなしのcleanup完了とは主張しない。
- API-2 PR URL・head・nod関連・in_review確認は未達。人の最終承認、Issue done化、mergeは行っていない。

次は親による公開契約と環境動作の確認が必要である。再評価する場合は独立した新環境を使用するという親の指示に従う。
