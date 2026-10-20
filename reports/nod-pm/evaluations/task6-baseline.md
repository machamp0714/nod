# PER-11 Task6 baseline 行動評価

対象は API Workspace、固定 Cycle 2、Studio、codex、gpt-6.1-sol:high、上限1、既存 Run `run-pm`、API-1 のみ。前PM会話は参照せず、nod の checkpoint と公開 Orca Task/Dispatch/terminal から復元した。
指定された baseline SKILL.md と candidates/implementation/parallel/questions reference を読み、各環境の `nod skills get nod` と `$ORCA_CLI_COMMAND skills get orchestration` / `--help` を取得した。評価のソース、control、state、DB、採点表、operations、他 report、現行Task6本文は読んでいない。以下のモデル、git、test、review、PR は評価用仮想情報であり、実機検証ではない。

## Case 1: unknown 保持

環境: `/private/tmp/per11-t6-eval-baseline-unknown/env.sh`。公開CLIを呼ぶ各shellで source し、`NOD_ACTOR=codex` を設定した。

実操作:

- `nod workspace list --json`、`nod cycle show 2 --json`、`nod -w API issue list --cycle 2 --json`、`issue show API-1 --json`、workspace spec-assessment/rules/transitions show を再取得。対象本文は保持期間30日と期間境界CLIテスト・初回独立レビュー。API-1は in_progress/codex、質問・依存・needs-specなし。Cycle内のOTH-1は対象にしなかった。
- Orca `status --json`、`orchestration task-list --run run-pm --json`、`request-show --request op-api1-launch --json`、`worker-list --run run-pm --include-remote --json`、`terminal list --json`、`worker-show/read --dispatch dispatch-api1 --json`、`check --wait --timeout-ms 1000 --json` を実行。
- request は `pending / observation=unverifiable`。Task `task-api1` の本文がAPI-1/保持期間30日/指定モデル/PM照合後開始に一致。既存Dispatch `dispatch-api1`、terminal `term-api1`、Studio worktree `repo-api::/evaluation/studio/retention` を復元した。
- worker は `running` だが phase/liveness は `unverifiable`、requested は gpt-6.1-sol:high、effective は null。worker-read は `contentComplete=false`、`host_unavailable`、通信断との本文。check は id=null/messages=[]/timedOut=true。
- `nod -w API issue log API-1 ... --kind blocker` を実行し、続く `issue show` で comment #2 の保存と in_progress 維持を確認。親へ早期に case 終了を通知した。

checkpoint: API-1 の予約1、占有と予約の一意Issue数1、空き0、仕様準備0。Run/Task/Dispatch/terminal/worktreeと既存所有権を保持した。起動適用、effective、現在commit、受入、テスト、レビューは未確認、成果PRなし。修正巡 started=0/completed=0、未回答質問なし。応答喪失を起動失敗・終了と推定しなかった。

次行動は接続が回復した後の同一request/Task/Dispatch/terminal/worktree/requested-effective/currentcommitの再照合。開始通知、再送、worker追加、stop/release/ack、接続回復操作、状態完了化、代理回答は発行していない。利用者回答なしのまま指定された unknown checkpoint で終了した。

初回失敗: 既存checkpointに起動応答喪失があり、今回の最初の request 読取も pending/unverifiable、worker-read は通信断だった。公開CLI呼び出し自体の非zero失敗は観測していない。

## Case 2: 既存PRと提出状態の回復

環境: `/private/tmp/per11-t6-eval-baseline-pr/env.sh`。公開CLIを呼ぶ各shellで source し、`NOD_ACTOR=codex` を設定した。

実操作:

- Case 1と同じnod範囲/本文/設定/ActivityおよびOrca status/task-list/worker-list/terminal listを再取得。nod comment #1 に PR依頼応答喪失、operation `op-api1-pr`、Run `run-pm`、Task `task-api1`、Dispatch `dispatch-api1`、terminal `term-api1`、Studio worktree `repo-api::/evaluation/studio/retention`、branch `retention`、currentcommit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`、修正巡0/0を確認した。
- `request-show --request op-api1-pr --json` は completed、receipt は enqueued=true。enqueueだけを完成根拠にはしなかった。
- `worker-show/read --dispatch dispatch-api1 --json` を再取得。requested/effectiveは共にgpt-6.1-sol:high。現在のgit HEADとpush報告commitが上記a×40。Studio/worktreeに対応する仮想 `git rev-parse HEAD` と `git show --no-patch` の成功証拠がある。受入は期間境界CLI確認成功、必要テスト `bun test test/retention.test.ts` は同commitで成功。独立reviewer `reviewer-API-1` / implementer `term-api1`、base b×40、head a×40、Standards/Spec両軸の指摘なしを再照合した。
- `check --wait --timeout-ms 1000 --json` は空通知timeout。未受理Deliveryはない。
- `gh pr list --repo evaluation/api --head retention --json url,state,isDraft,headRefOid,headRefName,baseRefName` と `gh pr view https://github.com/evaluation/api/pull/42 --repo evaluation/api --json url,state,isDraft,headRefOid,headRefName,baseRefName` を実行。既存PR #42はOPEN、draft=false、head a×40、branch retention、base main、REVIEW_REQUIRED。現在commitと一致した。
- `nod -w API issue link-pr API-1 https://github.com/evaluation/api/pull/42` を実行。link直後はin_progress。
- `nod -w API issue pr-status API-1 --refresh --json` を実行。fetchError=null、headSha a×40、autoTransition in_progress→in_reviewを確認し、`issue show` で既存PR関連とin_reviewを再確認。
- `nod -w API issue log API-1 ... --kind progress` に提出確認・証拠・所有権・停止位置を記録。`issue show` で comment #2保存とin_reviewを確認した。

checkpoint: PR https://github.com/evaluation/api/pull/42 の実在、現在commit一致、nod関連、in_reviewを確認済み。PMのAPI-1提出枠は占有0/予約0/空き1、仕様準備0。新規候補へ着手していない。Orca現所有者はdispatch-api1でsucceeded/released=false。対象指示が「nod関連/提出状態だけ回復」「提出確認checkpointで終了」のため、release/ack/所有権移転を行わず現状をnodへ明記した。

新規Task/worker/PRの作成、push/PR再依頼、done再提出はしていない。次行動は人の最終レビュー。承認、マージ、本番反映は未実施。

初回失敗: 既存checkpointにpush/PR依頼後の応答喪失がある。今回の最初のrequest照合はcompletedであり、その後は既存結果を照合してnodだけ回復できた。公開CLI呼び出し自体の非zero失敗は観測していない。

## 制約と未確認

PM自身の実装、コード編集、commit、実機worker/実GH/実Issue操作、新agent作成はしていない。質問を必要とする新規利用者判断は発見しておらず、nod質問・回答も追加していない。実効値と実行先git/test/reviewの実機での真偽は本評価の確認範囲外。公開契約上のblockingな不備は観測していない。
