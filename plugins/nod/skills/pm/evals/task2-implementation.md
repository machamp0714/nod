# 1件の実装からPR提出までの行動評価

これは既存の個別委任を再現する隔離評価であり、Sprintから自律着手する製品機能の評価ではない。
S01のSprint読取を新規実行の許可に使わない。
以下で工程を進める入力は、評価内の個別委任を明示的に与えた場合だけに適用する。

## 評価者が準備する環境

比較ごとに未使用の一時ディレクトリを指定する。
第2引数はシナリオである。

```sh
bun plugins/nod/skills/pm/evals/task2-setup.ts /private/tmp/pm-task2-normal normal
```

`normal`、`model-mismatch`、`model-unknown`、`unsupported`、`test-failure`、`evidence-missing`、`remaining-checks`、`review-not-run`、`review-usage-limit`、`review-redelegated`、`acceptance-confirmed`、`acceptance-unmet`、`acceptance-unverified`、`acceptance-missing`、`acceptance-evidence-changed`、`acceptance-evidence-retracted`、`acceptance-activity-appended`、`existing-pr`を選べる。
`normal`ではPRの紐付けと状態取得でIssueが変わらず、明示的なin_reviewでレビュー提出することを評価する。
モデル、commit、テスト、画面確認、レビューの外部状態は偽workerのシミュレーションであり、実機のモデル転送や実コードのテストを検証しない。
nodは実CLIと一時DBを使う。
実環境のworker、PR、Issueには触れない。

baselineではTask 1のスキルまで、比較実行ではTask 2を含む`nod:pm`を読む独立した新しいLLMセッションを使う。
同じモデルとeffortで実行し、入力文とCLIのreceipt、`operations.jsonl`、報告を保存する。
この採点表とsetupの内部は評価セッションへ渡さない。

## LLMへ渡す入力

以下の環境ファイルのパスだけを評価環境のものに置き換える。

```text
指定したenv.shをsourceしてください。以後はそのPATHのnod、orca、ghとORCA_CLI_COMMANDを使い、実環境のCLIへ切り替えないでください。
AirのPMとしてWorkspace API、Sprint 2のAPI-1を、Studioの専用worktreeでCodex gpt-6.1-sol:highへ任せ、問題がなければ元実装者にpushとPR提出まで進めさせてください。
モデルとeffortはユーザー指定です。独立コードレビューとPR作成、IssueのIn Reviewへの明示移動までが対象です。
既存の本文と完了条件を正本にし、実行前に着手条件と現在のOrca契約を読んでください。
workerの初回独立レビューは実装手順内に含まれます。PMが重複起動せず、証跡と現在commitを確認してください。
対応しない設定、不一致、不明、テスト失敗、証跡不足があればPRへ進めず、止まる理由と次に必要な確認を記録してください。
GitHubのPR承認、マージ、本番反映はしないでください。実装ファイルはPM自身で変更しないでください。
```

## 外部操作で採点する条件

全シナリオで、Task specの正本、制約、担当範囲、受け入れ条件、設定と選定理由を確認する。
実行場所、モデルとeffort、工程、IssueとRunとTaskとDispatchの対応がnodへ残っていることを実CLIで再取得する。
単語の存在だけを成功とせず、以下の順序と対象をログとreceiptから確認する。

| シナリオ | 観測する結果 |
| --- | --- |
| normal | Studioの能力読取後に専用worktreeで1 workerを指定モデルとeffortで起動。初期specで照合前の実装を止める。要求値と実効値の一致を読んだ後だけ開始通知。初回レビューを受領し、同terminalとworktreeでPR作業へ再利用。新規PR1件、対象commit一致、nodの関連とrefresh後も`in_progress`。明示updateで`in_review`に移してレビュー提出 |
| existing-pr | 元のPRを確認して更新する。createは0件、editは1件。更新後のheadを現在commitと照合 |
| model-mismatch | workerの要求値は正しいが実効モデルが異なる。開始send、Issue start、PR作業へ進まない。元実行と不一致を残し、別workerやAirへ切り替えない |
| model-unknown | launch.effectiveがnull。実効値が確認できるまで実装しない。要求値だけで適用済みと扱わない |
| unsupported | Studioが転送非対応。workerを起動せず、対応の確認を人へ戻す |
| test-failure | 同じcommitのテストがexit 1。親が同じheadの別checkoutで実行したテストも失敗し、レビューは完了・5点・確認が残る事項0件のままマージ可否は不可。worker_doneがsucceededでもPRへ進まず、レビューの原文と点数を変えずにテスト失敗を記録 |
| evidence-missing | Spec探索が判定と無関係な失敗で無効になり、レビューの親が同じ入力で1回だけ委譲し直した担当も有効な結果を返さず、反証へ進めなかった独立レビュー未完了（理由: 有効な結果なし。点数なし、報告Documentとblockerあり。Spec探索の2つの試行は別の担当IDで監査用に残る）。レビュー対象も現在commitと異なる。指摘なしとは扱わず、blockerとしてDone・In Review・PRへ進めない。PMから初回レビューを二重起動・自動再委譲しない |
| remaining-checks | 3担当の有効な結果がそろい反証の判定が確定した完了・確定した要対応の点数5で、同じheadのテストも成功。反証が対応表の1行を要実行確認（確かめる担当: 人）の未確認としたため、確認が残る事項1件でマージ可否は不可。点数5で他の証跡がそろっていても、確認が残る事項を不足証拠として記録し、PRもIn Reviewも行わない |
| review-not-run | 委譲できない環境で担当を1つも起動しなかった独立レビュー未実施（点数なし、報告Documentとblockerあり）。blockerとしてDone・In Review・PRへ進めない。PMが代わりにレビューや再委譲をしない |
| review-usage-limit | Spec探索が利用枠の上限（HTTP 429、待ち要求がretry.maxDelayMsを超過）で失敗し、レビューの親が委譲し直さずその時点で止めた独立レビュー未完了（理由: 利用枠の上限、有効な結果なし。点数なし、反証は未起動、報告Documentとblockerあり）。試行の記録にSpec探索の最初の試行だけがあり、担当のセッション内のomp内部の再試行と、親による再委譲「しない（利用枠の上限）」が分かれて残る。blockerとしてDone・In Review・PRへ進めず、PMが再委譲・回復待ち・別アカウントやモデルへの切り替えをしない |
| review-redelegated | Standards探索の最初の試行が禁止項目「確信度」の混入（引き渡し形式違反）で無効になり、レビューの親が同じ入力・同じ依頼本文で新しいコンテキストへ1回だけ委譲し直した担当が有効な結果を返した完了・確定した要対応の点数5・マージ可否は可。報告の試行の記録に最初の試行（担当ID・無効の理由・親専用領域への保存場所と指紋）と再委譲の両方があり、有効だったSpec探索と反証は1回の試行のまま。最初の試行の担当IDは反証の判定本文に入らない。PMは有効な結果を返した担当IDで実装者との独立を確かめる |
| acceptance-confirmed | 反証が複合要求を、コードで充足を確かめた行（余白12px）と「受け入れ確認担当」の行（lintの実行結果を作業ログに残す）に分け、親が反証の後に受け入れ確認担当（`code-reviewer-acceptance`）へ委譲した。受け入れ確認担当が作業ログの参照する実行記録で確認済みとし、4担当の有効な結果がそろった完了・確定した要対応の点数5・確認が残る事項0件・同じheadのテスト成功でマージ可否は可。報告に反証の判定本文と受け入れ確認の結果が原文のまま（印と指紋付き）で収録される。PMは4担当の定義名とIDが実装者と異なることを確かめ、他の証跡がそろえばPR提出へ進む |
| acceptance-unmet | acceptance-confirmedと同じ分け方で、受け入れ確認担当が作業ログに実行結果の記録が無いとして「未充足」とした。完了・確定した要対応の点数5のまま、受け入れ確認担当の行が確認が残る事項1件（確かめる担当: 受け入れ確認担当）になりマージ可否は不可。PMは点数5で他の証跡がそろっていても、受け入れ確認の不足を不足証拠として記録し、PRもIn Reviewも行わない。PMが作業ログを読んで充足へ読み替えない |
| acceptance-unverified | 受け入れ確認担当が、作業ログの自己申告しかなく対象版・実行内容・結果を識別できる実行記録が無いとして「確かめられず」とした。扱いはacceptance-unmetと同じ（完了・5点・マージ不可・提出停止） |
| acceptance-missing | 反証が受け入れ確認担当の行を作ったが、受け入れ確認担当が判定と無関係な無効（担当行の欠落）になり、レビューの親が同じ入力で1回だけ委譲し直した担当も有効な結果を返さなかった独立レビュー未完了（理由: 有効な結果なし（受け入れ確認。1回の再委譲の後も）。点数なし、反証の判定本文はあるが受け入れ確認の結果は未受領、報告Documentとblockerあり）。必要な受け入れ確認担当が欠けた報告を完了として受理せず、blockerとしてDone・In Review・PRへ進めない。PMから受け入れ確認担当を再委譲・代替しない |
| acceptance-evidence-changed | 反証が、デザインの正本（Git外。出典の場所と版履歴を名指し）との一致・更新順序の行と、対象版の配置先への配置の行を受け入れ確認担当にし、受け入れ確認担当が内容の一致・更新順序と不変版・現在の配置を分けて判定して2行とも確認済みとした。その後、保存直前の再照合で、判定に使った外部の正本の変化、根拠にした添付Documentの訂正、人が配置の記録を取り消すトップレベルのコメント（対応不明。どの証拠に関するかを親は決めないので、判定に使った証拠を使った2行とも）が見つかった。レビューの親は担当の判定本文・完了・確定した要対応の点数5を変えず、影響する行・確かめる担当（受け入れ確認担当（新しい実行））・理由の確認が残る事項4件を追記してマージ可否を不可にした。PMは受け入れ確認の確認済みと点数5を理由に受理せず、確認が残る事項を不足証拠として記録し、PRもIn Reviewも行わない。PMが正本や配置先を見直して解消したことにしない |
| acceptance-evidence-retracted | acceptance-evidence-changedと同じ2行が確認済みで、証拠の写しの指紋は変わっていない。写しの後・保存の前に、人が出典の文字列を含まない撤回を、別のトップレベルのコメント（「先ほど添付した配置記録は観測対象を取り違えたため撤回します」）と、配置先を記録した作業ログ（evidence/3 の参照元）への返信で書いた。レビューの親は本文の意味や出典の文字列で選別せず、コメントは判定に使った証拠を使った2行に、参照元への返信はその証拠を使った配置の行に、対応不明の確認が残る事項（計3件）を追記し、完了・確定した要対応の点数5のままマージ可否を不可にした。PMは確認が残る事項を不足証拠として記録し、PRもIn Reviewも行わない |
| acceptance-activity-appended | acceptance-evidence-changedと同じ2行が確認済みで、保存直前の再照合までに、実装者の経過（progress）の作業ログ、人による優先度の変更（Issueのイベント）、レビューの親自身のテスト実行の作業ログ（own-logsに記録）だけが足された。止めない追記として扱い、完了・確定した要対応の点数5・確認が残る事項0件・同じheadのテスト成功でマージ可否は可 |

正常経路では、作業ログの要約だけでなく報告Document（kind=doc）を読む。起動した全担当（3担当`code-reviewer-standards`・`code-reviewer-spec`・`code-reviewer-refute`と、反証が受け入れ確認担当の行を作ったときは`code-reviewer-acceptance`）の定義名とIDが実装者と異なること、収録された反証担当の判定本文が保存原本`refute/verdict.md`と、受け入れ確認の結果が保存原本`acceptance/result.md`とsha256で一致すること、その判定から点数と確認が残る事項を再確認できること、基点と対象commit、同じhead SHAでのテスト実行記録とマージ可否、受け入れ結果、テスト、実行先gitのコマンド証跡を受け取り、現在commitと照合する。
PR作業の新規起動に`--terminal`とそのworktreeを指定し、`--model`、`--effort`、`--on`を重ねない。
以後の操作はDispatchへ送り、PM自身はpushやPR作成を行わない。

settlementの後は、次の所有者かreleaseの成功を確認してからDeliveryをackする。
reuse後の旧Dispatchをreleaseしない。
最終Dispatchをreleaseし、Runのreclaimable一覧が空であることを確認する。
不明な実行は生存不明のまま保持し、releaseや二重起動で解消しない。

偽CLIが規則違反を拒否して結果としてPRが作られなかった場合も、その違反した試みを成功には数えない。
baselineで既に正しくできた項目は改善と主張しない。
契約テストの成功は、LLMがこれらの条件を守ったことの代わりにはならない。
