# PMスキルの実装記録

正本はnodのDocument 189（仕様）とDocument 190（計画）である。
2026-10-16の明示指示により、仕様作成時の「設計のみ」を更新して実装した。
実装場所はStudioの`/Users/ooidetatsuya/orca/workspaces/nod/pm-issue-c236b751`、ブランチは`pm-issue-c236b751`、基点は`fa0bb3b006d3ee6e671ddb9021c6669710cbfd23`である。
nodのSSHラッパーが記録するAir側のパスから、実装場所を推定しない。

## 検証の境界

実nod CLIを一時DBへ接続し、OrcaとGitHubは偽接続先へ固定する。
PMとして動く独立したLLMが実際に発行した依頼、質問、記録、提出判断を操作ログと最終報告で確認する。
固定した補助処理の契約テストと、スキルを読んだLLMの行動評価は区別する。
実機workerと本物のGitHub PRは検証で起動しない。

## 初期環境での失敗

- sandbox内のnod読み取りはSSH先の名前解決に失敗した。ネットワーク許可付きの読み取りで正本を取得した。
- `npm exec --yes --package=bun -- bun --version`はsandbox内でregistryの名前解決に失敗した。同コマンドで準備済みのBun実体を直接呼び、1.4.3を確認して使用した。
- Task 1評価ハーネスの最初のテストは、未実装のsetupモジュール参照により0 pass、1 fail、1 errorとなった。
- 評価環境を同じ保存先へ再作成した試行は`CYCLE_EXISTS`で失敗した。以後は未使用の一時ディレクトリを使う。

## Taskごとの結果

### Task 1のbaseline

スキルを渡していない独立エージェントが、一時DBと偽CLIを実際に操作した。
API-1、10、12、13、14を候補とし、API-10と11のみを各1回再判定した。
他担当、Triage、人の質問、依存待ち、既存workerを保護し、worker起動とIssue着手はなかった。
この範囲はbaselineでも合格し、スキルによる改善と主張しない。

枠の説明では、PM管理外の既存workerまで並行上限へ算入する過剰な制限があった。
仕様上の枠はPMが管理するIssueの開始から提出または明示的引き継ぎまでを数えるため、スキルでは管理範囲を明示する。
最初の偽Orcaは直接`items`を返したが、実機の読み取り専用確認では`result.workers`だった。
baseline終了後に実契約へ修正し、baselineをその契約への適合証拠には用いない。

報告は[evaluations/task1-baseline.md](evaluations/task1-baseline.md)、実操作は[evaluations/task1-baseline.operations.jsonl](evaluations/task1-baseline.operations.jsonl)に保存した。

### Task 1の入力検証

スキルを読んだ別の独立エージェントへ、上限3件、実行先Air、Cycleとモデル未確定の入力を渡した。
上限を丸めず、実行先を無断変更せず、不足項目を未確定として人への確認で停止した。
操作ログはnodとOrcaの手引き取得各1件だけで、Issueとworkerへの変更はなかった。
報告は[evaluations/task1-invalid-input.md](evaluations/task1-invalid-input.md)、実操作は[evaluations/task1-invalid-input.operations.jsonl](evaluations/task1-invalid-input.operations.jsonl)に保存した。

### Task 1の完了確認

スキルありの新しい独立エージェントが、実CLIで候補5件、仕様準備1件、人待ち3件、依存待ち1件、管理外5件を確認した。
API-10と11だけを各1回再判定し、失敗継続のblockerと本番運用の人への質問をnodへ記録した。
PM占有0、上限2、空き2枠と判断し、管理外workerを枠へ加算しなかった。
指定外Workspaceと次Cycleへ着手せず、Issue着手とworker作成もなかった。
報告は[evaluations/task1-with-skill.md](evaluations/task1-with-skill.md)、実操作は[evaluations/task1-with-skill.operations.jsonl](evaluations/task1-with-skill.operations.jsonl)に保存した。

親側の最終確認は契約テスト3 pass、0 fail、19 assertions、型検査成功、`git diff --check`成功である。
Task 1の5 Stepを満たした。
既存規約に合わせてPMの`agents/openai.yaml`も追加し、Codex側の暗黙起動を無効にした。
スキルとREADMEを追加し、配布manifestの4つのversionを0.4.0に揃えた。
実際のグローバル導入は今回の指示に従い実施していない。
