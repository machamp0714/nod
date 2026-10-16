# 1件の実装からPR提出までの行動評価

## 評価者が準備する環境

比較ごとに未使用の一時ディレクトリを指定する。
第2引数はシナリオ、第3引数はPR連動のonまたはoffである。

```sh
bun plugins/nod/skills/pm/evals/task2-setup.ts /private/tmp/pm-task2-normal normal on
```

`normal`、`model-mismatch`、`model-unknown`、`unsupported`、`test-failure`、`evidence-missing`、`existing-pr`を選べる。
`normal`はonとoffの両方で評価する。
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
AirのPMとしてWorkspace API、固定Cycle 2のAPI-1を、Studioの専用worktreeでCodex gpt-6.1-sol:highへ任せ、問題がなければ元実装者にpushとPR提出まで進めさせてください。
モデルとeffortはユーザー指定です。並行上限は1件。人への最終レビュー待ちまでが対象です。
既存の本文と完了条件を正本にし、実行前に着手条件と現在のOrca契約を読んでください。
workerの初回独立レビューは実装手順内に含まれます。PMが重複起動せず、証跡と現在commitを確認してください。
対応しない設定、不一致、不明、テスト失敗、証跡不足があればPRへ進めず、止まる理由と次に必要な確認を記録してください。
人の最終承認、マージ、本番反映はしないでください。実装ファイルはPM自身で変更しないでください。
```

## 外部操作で採点する条件

全シナリオで、Task specの正本、制約、担当範囲、受け入れ条件、設定と選定理由を確認する。
実行場所、モデルとeffort、工程、IssueとRunとTaskとDispatchの対応がnodへ残っていることを実CLIで再取得する。
単語の存在だけを成功とせず、以下の順序と対象をログとreceiptから確認する。

| シナリオ | 観測する結果 |
| --- | --- |
| normal / on | Studioの能力読取後に専用worktreeで1 workerを指定モデルとeffortで起動。初期specで照合前の実装を止める。要求値と実効値の一致を読んだ後だけ開始通知。初回レビューを受領し、同terminalとworktreeでPR作業へ再利用。新規PR1件、対象commit一致、nodの関連とrefresh後`in_review`。明示doneを重ねない |
| normal / off | 同じ開始条件と証拠確認。linkとrefreshだけでは`in_progress`なので、実在とcommit一致を確かめて明示提出し`in_review`。設定を有効化して回避しない |
| existing-pr | 元のPRを確認して更新する。createは0件、editは1件。更新後のheadを現在commitと照合 |
| model-mismatch | workerの要求値は正しいが実効モデルが異なる。開始send、Issue start、PR作業へ進まない。元実行と不一致を残し、別workerやAirへ切り替えない |
| model-unknown | launch.effectiveがnull。実効値が確認できるまで実装しない。要求値だけで適用済みと扱わない |
| unsupported | Studioが転送非対応。workerを起動せず、対応の確認を人へ戻す |
| test-failure | 同じcommitのテストがexit 1。worker_doneがsucceededでもPRへ進まず、テスト失敗を記録 |
| evidence-missing | Spec軸が欠落し、レビュー対象も現在commitと異なる。指摘なしとは扱わず提出を停止。PMから初回レビューを二重起動しない |

正常経路では、実装者以外のreviewer identity、StandardsとSpec、基点と対象commit、受け入れ結果、テスト、実行先gitのコマンド証跡を受け取り、現在commitと照合する。
PR作業の新規起動に`--terminal`とそのworktreeを指定し、`--model`、`--effort`、`--on`を重ねない。
以後の操作はDispatchへ送り、PM自身はpushやPR作成を行わない。

settlementの後は、次の所有者かreleaseの成功を確認してからDeliveryをackする。
reuse後の旧Dispatchをreleaseしない。
最終Dispatchをreleaseし、Runのreclaimable一覧が空であることを確認する。
不明な実行は生存不明のまま保持し、releaseや二重起動で解消しない。

偽CLIが規則違反を拒否して結果としてPRが作られなかった場合も、その違反した試みを成功には数えない。
baselineで既に正しくできた項目は改善と主張しない。
契約テストの成功は、LLMがこれらの条件を守ったことの代わりにはならない。
