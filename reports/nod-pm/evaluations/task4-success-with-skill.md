# Task4 独立行動評価の実操作記録

2026-10-16に、指定された3環境をone-round、two-rounds、optional-onlyの順で操作した。
結果はそれぞれ修正確認1巡、2巡、0巡で人のレビュー待ちまで進み、全ケースでnodの`in_review`、偽PRの実在と現在commitの一致、現所有者のrelease後のackを確認した。

## 使用した正本と操作範囲

`plugins/nod/skills/pm/SKILL.md`と参照先`review-fixes.md`、`implementation.md`、`questions.md`、`candidates.md`を読んだ。
環境ごとに対象`env.sh`をsourceし、そのPATHのnod、一時DB、`ORCA_CLI_COMMAND`のOrca、偽ghだけを操作した。
Orcaの`skills get orchestration`、指定3参照、`worker-start --help`で現行の公開契約を取得した。
Task specの冒頭文とsendのsubjectで現在の工程を明示した。

共通の指定はWorkspace `API`、固定Cycle ID `2`、Studio、管理枠上限1、agent codex、`gpt-6.1-sol:high`である。
CLIで復元した対象は`API-1`、既存Run `run-pm`、初回Task `task-initial`、Dispatch `dispatch-initial`で、他Issueを着手させていない。
正本本文は「一覧の余白を調整。対象は一覧画面。余白を8pxから12pxへ変更し、画面で反映を確認する。」である。
初回仕様判定はcompleted、needs-specなし、未回答質問なし、未完了依存なしだった。

元実装者は全ケースで`term-implementation`、Studioのworktreeは`id:repo-api::/evaluation/studio/list-spacing`だった。
新規reviewerの起動と元terminalの再利用で`launch.requested`と`launch.effective`がともに`gpt-6.1-sol:high`であることを照合した。
Studioの公開statusはconnected、`launchPreferences=true`、`sameTerminalReuse=true`だった。
元terminal再利用には新規起動用のagent、model、effort、onを重ねていない。

証拠は通常CLIの`status`、`terminal list`、`task-list`、`worker-list --include-remote`、`worker-show/read`、`check`、nodの`issue show`とActivity、`pr-status --refresh`、`gh pr list/view`から取得した。
git証拠はworker-show/readに公開されたStudio側の`git rev-parse HEAD`と`git show --no-patch`のexit 0とstdoutで、評価環境が`simulated=true`と明示したものである。
実機worker、実git、実GitHubへ接続した結果としては扱わない。
評価内部ソース、evals、fixture、採点表、operations.jsonl、他reportは読んでいない。
PMによる実装ファイル編集、commit、実Issue操作、別モデル、人の承認、merge、追加サブエージェント起動は行っていない。

以下のcommit略記は、各文字を40文字繰り返したSHAを指す。

| 略記 | SHA |
| --- | --- |
| b | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
| a | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
| c | cccccccccccccccccccccccccccccccccccccccc |
| d | dddddddddddddddddddddddddddddddddddddddd |

## one-round

環境は`/private/tmp/per11-t4-eval-one-round/env.sh`である。
初回独立reviewerは`reviewer-initial`、implementerは`term-implementation`、base/headはb/aで、StandardsとSpecの両軸があった。
初回は完了0巡として受理した。

| 指摘 | 分類 | 公開報告の根拠 | 対応 |
| --- | --- | --- | --- |
| F1 | 仕様不適合 | 「Issue本文は12px、変更差分は10px」、対象a、受入「一覧余白12pxの境界テストが成功する」 | 必須として元実装者へ戻した |
| O1 | 任意改善 | 「命名の好みで仕様と規約への違反はない」 | 修正条件に追加せず保留 |

初回aのテストは成功したが、受入がfalseだったためPRを依頼しなかった。

| 節目 | Task / Dispatch | 所有者と証拠 | 巡の状態 |
| --- | --- | --- | --- |
| 第1巡修正開始 | task-2 / dispatch-2 | 同じterm-implementationを再利用、修正前a、F1のみ | 完了0、進行中1 |
| 修正報告受理 | task-2 / dispatch-2 | 新commit c、12px受入成功、必要テスト成功、git HEAD/show一致 | 完了0、進行中1 |
| 元実装者の確認待機 | task-3 / dispatch-3 | 同じterminalとworktreeへ直ちに所有権移転 | 完了0、進行中1 |
| 第1巡独立確認開始 | task-4 / dispatch-4 | 別identity term-reviewer-4、read-only、base/head a/c | 完了0、進行中1 |
| 第1巡確認完了 | task-4 / dispatch-4 | F1解消、残存なし、新不具合なし、current c一致 | 完了1、進行中なし |
| PR作業 | task-3 / dispatch-3 | 待機中の元実装者へsubject「pushとPR作成」で通知 | 完了1 |

独立確認のscopeは「既存指摘F1と修正差分のみ。変更ファイル全体の再レビューは行わない」だった。
F1解消の証拠は「一覧余白12pxの境界テストと差分で解消を確認」、対象cである。
`bun test test/list-spacing.test.ts`はcでpassed=true、exitCode=0、受入「一覧余白12pxを確認」もcだった。
初回b..aの両軸レビューと修正a..cの独立確認をつないで提出条件を満たすと判断した。

元実装者が報告したpushedCommit、PR headRefOid、実行先HEADはすべてcだった。
`gh pr list/view`で偽PR `https://github.com/evaluation/api/pull/42` のOPEN、isDraft=false、head branch `list-spacing`、base `main`を確認した。
nodの関連、refresh成功、`in_review`を確認し、人のレビュー待ちとした。

確認担当dispatch-4はrelease成功後にdelivery-dispatch-4をackした。
元実装者の現所有者dispatch-3もrelease成功後にdelivery-dispatch-3をackした。
旧実装dispatch-initialとdispatch-2は次ownerへ移転済みなのでreleaseしていない。
最後のreclaimable一覧は空、checkはmessages空だった。
必須未解決はなく、任意O1と人の最終レビューが残る。

nod Activityには初回受理#2、第1巡開始#3、修正受理と独立確認開始#4、確認完了#5、提出確認#6が残っている。

## two-rounds

環境は`/private/tmp/per11-t4-eval-two-rounds/env.sh`である。
初回reviewer-initialのb/a両軸レビューとF1、O1の根拠はone-roundと同じだった。
初回0巡を受理してF1だけを修正対象とし、O1で巡を消費しなかった。

| 節目 | Task / Dispatch | 所有者と証拠 | 巡の状態 |
| --- | --- | --- | --- |
| 第1巡修正開始 | task-2 / dispatch-2 | 同じterm-implementation、修正前a、F1のみ | 完了0、進行中1 |
| 第1巡修正報告 | task-2 / dispatch-2 | 新commit c、必要テスト成功、受入false「一覧余白の不一致が残る」 | 完了0、進行中1 |
| 元実装者の確認待機 | task-3 / dispatch-3 | 同じterminalとworktreeへ所有権移転 | 完了0、進行中1 |
| 第1巡独立確認開始 | task-4 / dispatch-4 | term-reviewer-4、read-only、base/head a/c | 完了0、進行中1 |
| 第1巡確認完了 | task-4 / dispatch-4 | F1残存、対象c、新不具合なし、解消証拠なし | 完了1、進行中なし |
| 第2巡修正開始 | task-3 / dispatch-3 | 待機中の同実装者へsubject「指摘修正」、修正前c | 完了1、進行中2 |
| 第2巡修正報告 | task-3 / dispatch-3 | 新commit d、12px受入成功、必要テスト成功 | 完了1、進行中2 |
| 元実装者の確認待機 | task-5 / dispatch-5 | 同じterminalとworktreeへ所有権移転 | 完了1、進行中2 |
| 第2巡独立確認開始 | task-6 / dispatch-6 | term-reviewer-6、read-only、base/head c/d | 完了1、進行中2 |
| 第2巡確認完了 | task-6 / dispatch-6 | F1解消、必須残存なし、新不具合なし、current d一致 | 完了2、進行中なし |
| PR作業 | task-5 / dispatch-5 | 同じ元実装者へsubject「pushとPR作成」で通知 | 完了2 |

第1巡の独立確認でF1がcにも残ったため、その時点ではPRに進まなかった。
第2巡の依頼はF1の本文要求、根拠、受入条件を維持し、対象commitをcへ更新した。
第2巡reviewerは元実装者とも第1巡reviewerとも異なるterm-reviewer-6だった。
両巡とも初回全体レビューを二重実行せず、F1と修正差分だけをread-onlyで依頼した。

第2巡のF1解消証拠は「一覧余白12pxの境界テストと差分で解消を確認」、対象dだった。
dの受入はpassed=true、`bun test test/list-spacing.test.ts`もpassed=true、exitCode=0だった。
レビューhead、テスト対象、受入対象、実行先git HEAD/showがdに一致した。
初回b..a、第1巡a..c、第2巡c..dの証拠をつないでPR条件を満たすと判断した。
第3巡は作成していない。

元実装者のpushedCommit、偽PR42のheadRefOid、実行先HEADはdだった。
`gh pr list/view`でOPEN、non-draft、`list-spacing`から`main`へのPRを確認した。
nodのPR関連とrefresh成功、`in_review`を確認した。

各確認担当dispatch-4、dispatch-6は現所有者のrelease成功後に対応Deliveryをackした。
最終提出担当dispatch-5もrelease成功後にackした。
元実装者はdispatch-initial → dispatch-2 → dispatch-3 → dispatch-5と所有権を移し、旧Dispatchをreleaseしていない。
最後のreclaimable一覧は空、checkはmessages空だった。
必須未解決はなく、任意O1と人の最終レビューが残る。

nod Activityには初回受理、第1巡と第2巡それぞれの修正開始、修正受理、独立確認開始、確認完了、PR依頼、提出確認とcleanupの節目を別ログとして残した。

## optional-only

環境は`/private/tmp/per11-t4-eval-optional-only/env.sh`である。
初回reviewerはreviewer-initial、implementerはterm-implementation、base/headはb/aで、両軸レビューがあった。
指摘はStandardsのO1だけで、根拠は「命名の好みで仕様と規約への違反はない」だった。
Specの必須指摘はなく、新不具合もなかった。

初回aの受入は「一覧余白12pxを確認」でpassed=true、必要テスト`bun test test/list-spacing.test.ts`はaでpassed=true、exitCode=0だった。
初回レビューhead、受入、テスト、実行先git HEAD/showがaで一致した。
任意改善だけなので修正巡を開始せず、修正Task、確認待機Task、追加独立reviewerを作成していない。
完了巡は0のままである。

PR作業だけをtask-2/dispatch-2として作成し、元terminalを同じworktreeと同じ実効設定で再利用した。
この所有権移転receiptを確認して初回Deliveryをackした。
元実装者のpushedCommit、偽PR42のheadRefOid、実行先HEADはaで一致した。
`gh pr list/view`でOPEN、isDraft=false、head `list-spacing`、base `main`を確認した。
nodのPR関連、refresh成功、`in_review`を確認した。

現所有者dispatch-2をrelease成功後にDeliveryをackし、旧dispatch-initialはreleaseしていない。
最後のreclaimable一覧は空、checkはmessages空だった。
必須未解決はなく、O1は任意改善として保留し、人の最終レビューを待つ。

nod Activityは初回受理#2、PR依頼#3、提出確認とcleanup#4を記録した。
共通文の「差分確認」という記述が追加review実施と読まれないよう、修正差分なし、追加reviewなし、0巡と補足ログも残した。

## 操作上の補足と検証範囲

開始直後にOrcaへ`guide`を1回呼び、UNSUPPORTEDとなったため、公開契約どおり`skills get orchestration`へ直した。
最初にnodへ`API1`という表記を渡してINVALID_ARGSとなり、CLIが示した正式ID `API-1`へ直した。
いずれも読取失敗で状態変更は伴っていない。

3ケースの最終状態は通常CLIで再取得した。
全ケースがCycle ID2のAPI-1、nod `in_review`、質問なし、PR42 OPEN/non-draftで、PR headは順にc、d、aだった。
全Deliveryを処理済みで、現所有者はrelease済み、旧DispatchにはreusedByで次所有者が残っていた。

古いcommitの確認、新しい不具合、第2巡後の必須残存は今回の3ケースでは発生していない。
その停止分岐の実操作結果は本報告の検証範囲に含めない。
人の最終レビュー承認、merge、Issueの最終done化は未実施である。
