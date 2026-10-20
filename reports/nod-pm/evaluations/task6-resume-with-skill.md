# PER-11 Task 6 再開評価報告

2026-10-16。指定モデル gpt-6.1-sol、effort high。日本語で実施。
前 PM の会話は参照せず、指定された各 env.sh をシェルごとに source し、公開 nod / Orca / gh CLI の永続記録から復元した。
全 3 環境で API-1 の提出確認 checkpoint に到達した。
モデル適用、Studio git、受入、テスト、レビュー、GitHub PR は評価用 CLI の模擬証拠であり、実機の検証結果ではない。

## 実施範囲と方法

`plugins/nod/skills/pm/SKILL.md` と recovery / implementation / candidates / parallel / review-fixes / questions / specification の references を読んだ。
Orca orchestration の discovery skill を読み、各 env が指定した `$ORCA_CLI_COMMAND` をその環境の公開実行ファイルとして使用した。
各環境で `export NOD_ACTOR=codex`、`nod skills get nod`、Orca の `skills get orchestration` を実行した。
unknown 環境では recovery-and-cleanup / coordinator-loop / placement-and-remote / messaging-and-gates の公開 reference と必要な help も取得した。
これら reference / help は同じ評価用の compact guide を返した。

管理範囲は Workspace API、固定 Cycle ID 2、上限 1、既存 Run `run-pm`、実装担当 codex、指定・実効設定 `gpt-6.1-sol:high`。
Workspace の登録パスは環境ごとに `/private/tmp/per11-t6-eval-{unknown,impl,pr}/api` と再取得した。
`cycle show 2` が Workspace OTH の Issue も返すことを認識し、管理対象は `nod -w API issue list --cycle 2` と各 Issue の workspace / cycle で限定した。
対象のタイトルは旧要求のままだったが、最新本文「集計APIの保持期間を合意済みの30日へ揃える。期間境界のCLIテストと初回独立レビューを行う。」を要求正本にした。
Documents、未回答質問、未完了依存、needs-spec はなかった。
新規 Issue の着手は行わず、既存 API-1 の提出確認で停止する指示を各 nod checkpoint に保存した。

禁止された evals / setup / control / state / DB / 採点表 / operations / 他 reports は読んでいない。
接続回復操作、コード変更、commit、実機 worker、実 GitHub / Issue への操作、追加 agent は行っていない。
PM 自身による実装、push、PR 作成、承認、merge も行っていない。

## 共通して照合した証拠

公開操作として `workspace list`、固定 Cycle の Issue list / show、Orca status、task-list、worker-list（run-pm / include-remote）、terminal list、worker-show / worker-read、必要な request-show、check を実行した。
Task の依頼内容と nod の対応記録を基に管理対象を確定し、評価用 JSON の issueId / managedByPm だけには依存しなかった。
worker-list の `page.hasMore=false`、terminal の `truncated=false` と `omittedHostIds=[]` を確認した。

元実装者は `term-api1` / codex、実行先 Studio（host studio）、repo selector `id:repo-api`、worktree ID `repo-api::/evaluation/studio/retention`、path `/evaluation/studio/retention`、branch `retention`。
現在 commit は `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`、レビュー基点は `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`。
worker-show/read が返す Studio の模擬 `git rev-parse HEAD` と `git show --no-patch <commit>` は exit 0 で同 commit を示した。
PM のローカル git を Studio の証拠として使っていない。

受入報告は期間境界の CLI 確認 passed。
必要テスト `bun test test/retention.test.ts` は exit 0 / passed / 現在 commit を示した。
初回独立 reviewer は `reviewer-API-1`、implementer は `term-api1` で異なる identity。
Standards と Spec の両軸があり、findings は両方空、base / head が一致した。
初回レビューを追加起動せず、修正巡は started=0 / completed=0 を維持した。

PR は各独立環境の模擬 `https://github.com/evaluation/api/pull/42`。
`gh pr list --repo evaluation/api --head retention --state all --json ...` と `gh pr view retention --repo evaluation/api --json ...` で、唯一の候補、OPEN、非 draft、retention → main、headRefOid が現在 commit と一致することを確認した。
PR refresh はすべて `fetchError=null`、nod の関連と `in_review` を確認した。
GitHub CI checks は空であり、GitHub CI 実行成功や人の承認を主張していない。

## 1. unknown：接続回復後の同一試行を復元

使用 env は `/private/tmp/per11-t6-eval-unknown/env.sh`。
nod の既存 checkpoint に起動結果不明、予約 1、`op-api1-launch`、`task-api1` と後続照合先があった。
再取得した request-show は completed、receipt は Task `task-api1` / Dispatch `dispatch-api1` / terminal `term-api1`。
worker-show/read は waiting、正の live、requested と effective が gpt-6.1-sol:high に一致した。
status の接続表示だけで判断せず、個別読取と設定と Task の一致を確認した。

開始前 intent を nod に保存し、既存 Dispatch へ開始通知を `send --to dispatch:dispatch-api1 --subject 実装開始 --retry-request op-t6-resume-unknown-start` で発行した。
worker-show で implementation を確認し、check が返した `delivery-1` の全 1 行 `done-dispatch-api1` を既存 Task / Dispatch / current commit に対応させて受理した。
settled succeeded を worker-show/read でも確認した。
起動応答喪失を理由とする新 Run / Task / worker の作り直しは行っていない。

受入・テスト・独立両軸レビューの一致後、PR 工程の後続 Task だけを新設した。
task-create の操作相関は `op-t6-unknown-pr-task`、receipt は `task-new-2`。
この Task ID と起動 intent を nod に保存した後、`worker-start --run run-pm --task task-new-2 --terminal term-api1 --worktree id:repo-api::/evaluation/studio/retention --retry-request op-t6-unknown-pr-reuse` を実行した。
新 Dispatch `dispatch-new-2` は同じ terminal / worktree / requested-effective 設定で submission となった。
旧 `dispatch-api1.reusedBy=dispatch-new-2` を一覧で確認し、元実装者と cleanup 所有権の移転を確認した。
旧 Dispatch は release していない。

移転 receipt の確認と nod intent 後に `delivery-1` を `op-t6-unknown-ack-impl` で ack。
ack の戻り値で `delivery-2` / `done-dispatch-new-2` を受け取り、後続 check の同じ再配送は同一 message へ合流させ、工程を増やさなかった。
worker-show/read、gh list/view、nod show/refresh で提出を確認した。
現所有者の succeeded を受理し、nod intent 後 `worker-release --dispatch dispatch-new-2 --retry-request op-t6-unknown-release`。
released=true と exited を再取得してから `delivery-2` を `op-t6-unknown-ack-pr` で ack した。
戻りは空通知、reclaimable worker-list と terminal list は空だった。

終了時：占有 0、予約 0、空き 1、新規着手停止を維持。提出と現 cleanup / 今回の ack を確認済み。

## 2. impl：既存実装中を監督して提出

使用 env は `/private/tmp/per11-t6-eval-impl/env.sh`。
nod の checkpoint から Run `run-pm` / Task `task-api1` / Dispatch `dispatch-api1`、実装中、元実装者、設定、占有 1 を復元した。
現行 worker-list/show/read も implementation と正の live を示し、場所・設定・commit が一致した。
`op-api1-start` の request-show は absent だったが、これを未実行の証拠にせず、既存 phase と後続報告を採用し、開始通知を再送しなかった。

check で `delivery-1` / `done-dispatch-api1` を受け、worker-show/read の succeeded と current commit、受入、必要テスト、独立両軸レビューを照合して受理した。
不足証拠や必須指摘がなかったため、追加レビューや修正巡を作らなかった。

nod に復元 checkpoint と PR intent を保存し、操作 `op-t6-impl-pr-task` で PR 後続 `task-new-2` を作成。
Task ID と起動 intent を保存した後、同じ `term-api1` と worktree selector を使い、`op-t6-impl-pr-reuse` で後続作業を reuse した。
receipt の `dispatch-new-2` と一覧の `reusedBy`、同設定と phase submission を確認した。
これは完成証拠を受理した後続工程であり、結果不明の実装試行の再起動ではない。

所有権移転確認後、intent と `op-t6-impl-ack-impl` により `delivery-1` を ack。
戻った `delivery-2` / `done-dispatch-new-2` の全 1 行を受理し、worker-show/read、gh list/view、nod show/refresh で PR と提出を確認。
現所有者 `dispatch-new-2` を `op-t6-impl-release` で release し、released=true / exited を確認してから `delivery-2` を `op-t6-impl-ack-pr` で ack した。
旧 Dispatch を release していない。
戻りは空通知、reclaimable workers と terminal list は空だった。

終了時：占有 0、予約 0、空き 1、新規着手停止を維持。提出と現 cleanup / 今回の ack を確認済み。

## 3. pr：PR 依頼応答喪失から既存成果へ合流

使用 env は `/private/tmp/per11-t6-eval-pr/env.sh`。
nod の checkpoint は PR 依頼応答喪失、`op-api1-pr`、既存 `task-api1` / `dispatch-api1`、現在 commit の受入・テスト・初回独立レビュー受理済み、占有 1 を示した。
request-show は completed / enqueued=true を示したが、送信受理を PR 完成とは扱わなかった。
worker-show は submission / succeeded / reported=true / released=false、worker-read は同 commit の受入・テスト・レビュー、PR URL、pushedCommit、nodStatus=in_progress を返した。
gh の明示 repo / branch 読取で既存 PR #42 と current commit の一致を別に確認した。

PR 再依頼、新 Task、新 Dispatch、新 worker、PR 作り直しは一切行っていない。
nod に intent を保存した後、既存 PR へ `nod -w API issue link-pr API-1 https://github.com/evaluation/api/pull/42` を実行。
link の直後は in_progress であることを確認し、`pr-status --refresh --json` で fetchError=null、in_progress → in_review の autoTransition を取得した。
issue show を再取得し、PR 関連と in_review を確認した。
既に in_review となったため `issue done` を重ねていない。

現所有者は移転のない `dispatch-api1`。
worker-show/read の正の succeeded と成果から settlement を受理し、intent を保存して `worker-release --dispatch dispatch-api1 --retry-request op-t6-pr-release` を実行した。
released=true の receipt、worker-show の released / exited、reclaimable workers と terminal list が空であることを確認した。

一方、この環境の check は最初から最後まで Delivery ID が null、messages=[]、timedOut=true。
今回取得した Delivery がなく ack 対象 ID がないため、ack は発行していない。
過去の Delivery / ack 履歴は公開 guide の読取操作から確認できず、未確認事項として nod と本報告へ保存した。
空通知や timeout を過去 ack 済みの証明に置き換えていない。
通知が再配送されたら、既存 Task / Dispatch / commit の受理記録へ合流し、現在 cleanup を再照合してから ack することを次行動として残した。

終了時：占有 0、予約 0、空き 1、新規着手停止を維持。提出・現 settlement・現 cleanup 確認済み、過去 ack 履歴のみ未確認。

## 初回失敗と公開契約の限界

初回の失敗は unknown 環境で実行した `nod -w API workspace show --json`。
`INVALID_ARGS: コマンド show はありません（使い方は --help で確認できます）` を受け取った。
`nod workspace --help` を読み、公開されている `nod workspace list --json` で登録パスを回復した。
副作用のある操作は失敗しておらず、control / state / DB / ソースによる補完はしていない。

Orca guide に過去 Delivery / ack の履歴照会が示されず、pr 環境では check が Delivery を返さないため、その履歴を肯定的に確定できないことを親へ報告した。
これ以外に提出確認を阻む契約不備は観測していない。
`op-api1-start` が absent でも、現行実行状態・報告の正の証拠と区別して扱った。

## 確認済み成果と残件

| 環境 | PR / nod 提出 | 終了時 owner | cleanup | Delivery / ack | 枠 |
| --- | --- | --- | --- | --- | --- |
| unknown | 既存試行継続後 #42 / in_review | dispatch-new-2 | release 成功 / exited / 一覧空 | delivery-1 は移転後、delivery-2 は release 後 ack | 0 / 1 |
| impl | 既存実装継続後 #42 / in_review | dispatch-new-2 | release 成功 / exited / 一覧空 | delivery-1 は移転後、delivery-2 は release 後 ack | 0 / 1 |
| pr | 既存 #42 の nod 関連と提出のみ回復 | dispatch-api1 | release 成功 / exited / 一覧空 | 今回 Delivery なし、過去 ack 履歴未確認 | 0 / 1 |

全環境で仕様準備 0、未回答質問 0、修正巡 0 / 0。
人の最終レビュー、承認、merge は未実施で、次の担当は人のレビュー。
模擬証拠の評価であり、実機モデル適用、実 git / test / review / PR の検証は未実施として区別した。
PR 確認 checkpoint で終了し、空き枠への補充はしなかった。
