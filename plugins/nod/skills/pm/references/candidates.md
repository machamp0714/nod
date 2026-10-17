# 候補の確認手順

以下の`ORCA`は、`orchestration`スキルで解決して手引きを取得した実行ファイルに置き換える。
新たなシェル変数や別のOrca実行ファイルへ切り替えない。
コマンドの引数は安全に渡し、本文や質問をシェルとして展開しない。

## 対象範囲の再取得

```sh
nod workspace list --json
nod cycle show <固定CycleID> --json
nod -w <Workspace> issue list --cycle <固定CycleID> --json
nod -w <Workspace> workspace spec-assessment show --json
nod -w <Workspace> workspace rules show --json
nod -w <Workspace> workspace transitions show --json
ORCA status --json
ORCA orchestration worker-list --include-remote --json
ORCA terminal list --json
```

CycleはWorkspaceに属さないため、`cycle show`に出た全件を対象にしない。
`issue list`で指定Workspaceと固定Cycleを同時に絞り、候補の`workspace`と`cycle.id`も照合する。
必要なら`--status`で状態を明示し、既存の管理記録にあるIssueは`show`で別に確認する。
`--ready`は補助的な絞り込みであり、担当、needs-spec、通常のコード実装か、管理外セッションの保護を置き換えない。

OrcaのJSONは`ok`と`result`を確認する。
worker一覧は通常`result.workers`にあり、`scope`でRunに限定されていないか確認する。
Runに限定されていて管理外実行を照合できない場合は、現行手引きに沿って対象Runや接続先も読む。
`page.hasMore`の間は、その`page.nextCursor`を変えずに`--cursor`へ渡す。
通常terminalも確認し、タイトルだけで担当や生存を確定せず、IssueのActivity、記録済みworktreeとterminal、Taskの依頼内容を照合する。
terminal一覧の`truncated`や`hostScope.omittedHostIds`がある場合は、手引きの読取操作で不足分を確認する。
読み取り不足や通信断を「既存実行なし」に変えない。
管理外のセッションへ指示を送り、停止、引き取り、追加worker起動を行わない。

## Issueごとの照合

対象Issueについて次を読み、判定前の古い一覧だけに依存しない。

```sh
nod -w <Workspace> issue show <IssueID> --json
```

`status`、`assignee`、`snoozedUntil`、`archivedAt`、`blockedBy`、`questions`または`openQuestions`、`labels`、`specAssessment`、Documents、Activityと既存実行を確認する。
必要なkind=specやplanがあれば内容を読む。
specやplanがなければ、本文の要求と完了条件を正本にする。
短文であることや文書がないことだけでは、新たな仕様化、計画化、承認を増やさない。

| 分類 | 条件と保護 |
| --- | --- |
| 管理外 | 指定範囲外、未受理Triage、人担当、選定した実装担当と異なる担当、管理外の既存セッション、完了やアーカイブ済みなど。未割当または選定担当と一致するtodoだけを新規候補にする。同じ担当名でも別セッションの仕事を奪わない |
| 人への確認待ち | 未回答の人の質問、未決の利用者判断、実効的な仕様判定失敗、スヌーズや遷移制限など。質問には人の実回答が必要。LLMが書き手やDBを変えて回答、受理、制限回避を行わない |
| 依存待ち | 未完了のブロック元がある。依存先を外したり、完了条件を満たさないまま完了扱いしたりしない |
| 仕様準備 | 他の着手条件を満たし、現在のラベルにneeds-specがある。既存specがあっても正式な`nod:to-spec`の仕様作成と添付確認前に解除しない |
| 実装可能 | 範囲内のtodo、未割当または選定した実装担当、未回答質問や未完了依存なし、管理外実行なし、仕様判定の着手制限なし、needs-specなし。本文または既存specからコード実装と検証が可能 |

本番操作、有料の予想生成などコード実装以外の仕事は、通常の実装候補から外して人へ戻す。
人への相談は[質問の手順](questions.md)で番号選択肢、推奨、理由、決定後の動作を添える。
needs-spec付きの進行を任されている場合は[仕様準備の手順](specification.md)へ渡す。
管理外や人待ちと確定したIssueへ、副作用のある再判定や担当変更を使って着手条件を作らない。
実効的な初回判定の回復は、次の手順で候補ごとに行う。

## 初回仕様判定の回復

Workspaceの現在の`enabled`と、Issueの現在の`specAssessment`を照合する。
履歴の`history`にあるpendingやfailedだけを見て止めない。

| 現在の状態 | 扱い |
| --- | --- |
| nullまたは省略 | 自動判定の対象外。未判定扱いで再試行しない |
| Workspaceが無効、または`suspended=true` | 判定による着手制限は解除済み。再判定で制限を作らない |
| `recordOnly=true` | 初回判定後の任意再評価。pendingやfailedでも、これだけで実装を止めない |
| 有効、suspendedでもrecordOnlyでもなく、pendingまたはfailed | 初回判定が実効的に未完了または失敗。同じIssueを1回だけ再判定する |
| completed | 判定完了。現在のneeds-specラベルを別に確認する |

必要な1回の再判定は、同じIDへ行う。
再試行前後の世代と結果を記録し、応答が不明な呼び出しを無条件に再送しない。

```sh
nod -w <Workspace> issue assess <IssueID> --json
nod -w <Workspace> issue show <IssueID> --json
```

回復したら最新ラベルを含めて分類し直す。
実効的なpendingやfailedが残れば、同じIssueへ安全な失敗種別、世代、1回再試行済みであること、次に必要な確認を`nod issue log <IssueID> "<停止理由>" --kind blocker`で残し、着手を止める。
秘密値や未加工のAPIエラー本文を記録しない。
再作成、繰り返しassess、設定無効化、needs-spec削除で回避しない。
