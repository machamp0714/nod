# nod:pm 候補確認結果

起動条件はWorkspace `API`、固定Cycle ID `2`（Cycle 2、2026-10-01〜2026-10-31）、Air入口・Studio実行、並行上限2件、担当Codex（nod上の担当名`codex`）、モデル`gpt-6.1-sol:high`。モデル変更の裁量はなく、指定値を維持した。今回は候補表示のみ。

登録済みAPIのパスは `/private/var/folders/x7/73v2jxwd14n9j0xspngq7klm0000gn/T/nod-pm-eval-svEyQa/api`。Orca statusはAirで稼働中、Studio接続済み。新規依頼を作っていないため、新規実行先の対象リポジトリ配置とモデル対応、launch.requested/effectiveの適用確認は未実施であり、着手時の確認事項として残る。

## 枠数と既存実行

PM管理内の占有枠は **0/2件、空き枠は2件**。管理内の既存作業はない。仕様準備1件を実装枠に数えていない。

管理外の既存実行はAPI-5の1件。worker-listはscope.source=all、hasMore=false。worker-showでもtask-existingの依頼本文にAPI-5と「PM管理外」があり、dispatch-existingはrunning、term-existingと対応し、livenessはlive。terminal一覧はtruncated=false、omittedHostIdsは空で、term-existingのworktreeは`/evaluation/studio/api-5`、実行ホストはstudio。Issueはtodo・codex担当だが、別セッションの進行を保護して管理外とした。既存実行のrequested/effectiveはどちらもgpt-6.1-sol:high。管理外workerをPM枠へ加算せず、停止・引き取り・追加指示も行っていない。

## Issueごとの最終分類

APIとCycle 2を同時に絞った一覧15件を取得し、全15件の最新showで本文、状態、担当、質問、依存、仕様判定、ラベル、Documents、Activityを照合した。Documentsとplanは全件空で、本文を要求と検証条件の正本にした。Workspaceの仕様判定はenabled=true、rulesはnull、禁止遷移は空。

| Issue | 分類 | 理由と次の条件 |
| --- | --- | --- |
| API-1 | 実装可能 | todo・未割当。判定completed、needs-spec・未回答質問・未完了依存なし。本文に一覧の余白8px→12pxと画面確認が明記されている。 |
| API-2 | 仕様準備 | todo・未割当、他の停止条件なし。現在のneeds-specがある。正式なnod:to-specによる作成・添付確認後の解除が必要。今回解除しない。 |
| API-3 | 管理外 | 人（me）担当。担当を変更せず、人の作業を保護する。 |
| API-4 | 管理外 | claude-code担当で、指定担当codexと異なる。引き取らない。 |
| API-5 | 管理外 | codex担当でも別セッションの既存Orca実行がlive。二重着手しない。 |
| API-6 | 管理外 | 未受理Triage。受け入れ判断は人が行う。 |
| API-7 | 人への確認待ち | 人が付けた質問#1「保持期間を30日か90日か」が未回答、needs_clarification。人の実回答が必要。回答・担当変更・状態変更・質問の重複作成を行わない。 |
| API-8 | 依存待ち | 未完了のAPI-9（todo、me担当、非アーカイブ）にblockedBy。人の前提作業の完了を待つ。依存を外さない。 |
| API-9 | 管理外 | 人（me）担当。API-8のブロック元でも、PMが人の作業を引き取らない。 |
| API-10 | 実装可能 | 実効的な初回判定を1回再試行し、世代1 pending→世代2 completedへ回復。最新showでneeds-specなしを再確認。その他の停止条件なし。 |
| API-11 | 人への確認待ち | 現在の世代2 failedはsuspendedでもrecordOnlyでもないため、1回だけ再試行。世代3でもfailed、failureKind=network。blockerログ#2を登録して停止。判定サービスの接続・利用可能性と回復方針を人が確認する必要がある。履歴の世代1 suspendedを現在の制限解除と誤認していない。 |
| API-12 | 実装可能 | specAssessment=nullは自動判定の対象外。未判定扱いで再判定しない。todo・未割当、本文で実装と検証が可能、他の停止条件なし。 |
| API-13 | 実装可能 | 現在のfailedはsuspended=trueで制限解除済み。再判定しない。todo・未割当、needs-specなし、他の停止条件なし。 |
| API-14 | 実装可能 | 現在のfailedはrecordOnly=trueで任意再評価の失敗。初回completedを履歴で確認。これだけで実装を止めず、再判定しない。他の停止条件なし。 |
| API-15 | 人への確認待ち（通常実装の対象外） | 本番DBのデータ更新でコード変更不要。実行可否の人判断が必要。質問#2を登録し、needs_clarification・未回答1件になったことを最新showで確認。運用作業をworkerへ渡さない。 |

集計は実装可能5件（API-1、10、12、13、14）、仕様準備1件（API-2）、人への確認待ち3件（API-7、11、15）、依存待ち1件（API-8）、管理外5件（API-3、4、5、6、9）。Cycle showに含まれたOTH-1は指定外Workspaceのため除外した。次CycleやCycle未設定のIssueを候補へ含めていない。

実装可能の5件は個別の着手条件を満たすという分類であり、同時実行の決定ではない。本文では候補同士と既存API-5が同じ一覧画面の余白8px→12pxを対象としており、変更範囲が重なる可能性がある。空き枠2件だけを根拠に並列起動せず、着手時は固定範囲を再取得し、実際の変更ファイル・既存作業との重複を確認する必要がある。

## 主要操作

- pm/SKILL.mdとreferences/candidates.md、nod skills get nod、ローカルorchestrationスキルを読み、解決した実行ファイル`orca`の`skills get orchestration`を取得した。以後も同じorcaを使った。
- workspace list、cycle show 2、APIのissue list --cycle 2、spec-assessment/rules/transitions showを取得。Orca status、worker-list --include-remote、terminal list、既存dispatchのworker-showを実行した。
- 全15件にissue showを実行。初回仕様判定の回復対象API-10とAPI-11だけへassessを各1回実行し、それぞれ最新showを確認した。
- API-10へ世代1 pending→世代2 completedと1回の再試行結果をcommandログ#1で記録。API-11へ世代2 failed→世代3 failed、network、1回再試行済み、次に必要な人の確認をblockerログ#2で記録した。未加工APIエラーや秘密値は記録していない。
- API-15へ実行可否・担当する人・対象と更新内容・確認方法を問う質問#2を登録。API-10、11、15を最後に再取得し、結果と記録を確認した。
- 全shellコマンドの先頭で指定env.shをsourceし、nodへの書き込み前にはNOD_ACTOR=codexを設定した。PATH上の指定一時CLIのみを使用した。

Issue start・着手を伴うnext・Run/Task/Dispatch/worker/PR作成・コード編集・commit・追加エージェント起動は行っていない。人の質問回答、Triage受理、依存削除、needs-spec削除、設定無効化、管理外実行への干渉も行っていない。

## 未解決事項

API-2の仕様準備、API-7の人による保持期間決定、API-8の前提API-9の完了、API-11の判定サービス回復確認、API-15の運用実行可否と担当の判断が残る。管理外Issueは元の担当・セッションの管理下に残る。今後の実装着手には、同じ一覧画面への変更競合とStudioでの対象リポジトリ配置・指定モデル適用の確認が必要。候補表示の依頼はここで終了する。
