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

### Task 2のbaseline

新しい独立エージェントが、モデルの照合後の実装依頼から、既存実装者へのPR依頼と実nodの`in_review`確認まで進めた。
元のterminalを再利用し、初回レビューの重複起動と人の承認、マージはなかった。
ただし親が実操作を照合すると、再利用後の旧Dispatchにもreleaseを送り、最終Deliveryをackしてからreleaseする2つのOrca契約逸脱があった。
評価エージェント自身の「完了」報告だけでは合格にせず、Task 2担当へ手順と偽CLIの契約検出を補強するよう戻した。
偽CLIは初期版でこの2操作を受理していたため、baselineを後片付けの適合証拠には用いない。
報告は[evaluations/task2-baseline.md](evaluations/task2-baseline.md)、実操作は[evaluations/task2-baseline.operations.jsonl](evaluations/task2-baseline.operations.jsonl)に保存した。

### Task 2の行動確認

新しい独立エージェント2名が、スキルを読んで8つの一時環境を実際に操作した。
normal/onとnormal/offでは元のterminalを1回再利用し、新PRを各1件作成、既存PR環境はcreateせずeditを1件発行した。
現在commit、必要なテスト、受け入れ、初回独立StandardsとSpec、PRのHEAD、nodの`in_review`を照合した。
最終Dispatchだけをreleaseしてからackし、旧Dispatchのreleaseと初回レビューの重複起動はなかった。

モデル不一致と実効値nullでは待機workerを保持して開始通知を送らず、非対応環境ではRunも作らなかった。
テスト失敗とレビュー証拠欠落ではPRへ進めず、同じIssueに理由と後続工程を記録した。
この2環境のsettled実装者とDeliveryは後続所有者未決のまま保持しており、後片付け済みとは扱わない。
これらの停止条件を観測したことと、実装から提出までの成功を区別する。
停止報告は[evaluations/task2-stopped-with-skill.md](evaluations/task2-stopped-with-skill.md)、各環境の実操作は同ディレクトリの`task2-*.operations.jsonl`に保存した。

契約テストは初回setup未実装で0 pass、1 fail、1 errorだった。
所有権とack順序、PR selector、補完依頼でPRを作らない境界も、失敗を確認してから補修した。
親側の最終確認は15 pass、0 fail、152 assertions、型検査と差分検査の成功である。
モデル適用、git、テスト、画面、レビューは偽workerの状態をPMが照合したもので、実機転送や実コードの検証ではない。

### Task 3のbaseline

Task 2までのスキルを読む新しい独立エージェントが、API-1の技術質問へ本文の12pxを根拠に元messageへreplyし、working復帰を確認した。
API-2の未決仕様は質問を作成して停止し、needs-specと未合意を維持した。
この主要な保護と返信はbaselineでも合格だった。
人への選択肢はA/Bであり、仕様が求める番号付きではなかったため、新手順では全工程の1/2選択肢と推奨、理由、決定後の動作を共通書式にした。
報告と実操作は[evaluations/task3-baseline.md](evaluations/task3-baseline.md)と[evaluations/task3-baseline.operations.jsonl](evaluations/task3-baseline.operations.jsonl)に保存した。

### Task 3の完了確認

スキルあり5環境を新しい独立エージェント2名が実操作した。
仕様未合意ではneeds-specを維持し、正式Specと実回答、仕様とテスト境界の合意を確認した環境だけto-spec最終工程で解除した。
両環境でAPI-1の既決質問を元messageへreplyし、仕様化中も監督した。
人起点API-7の質問にはチャット原文を保存しただけで代理answerを発行しなかった。

PM起点API-1の質問は番号選択肢、推奨、理由、決定後の動作を記録した。
無回答と曖昧な「それでお願いします」では元workerをawaiting_inputに保ち、一意なチャット実回答の原文と出典を保存した後だけ、同じ質問IDへcodexとして転記して元askへreplyした。
nod回答は評価者だけが一時DBへ明示投入し、PMがansweredBy=meの原文と日時を再取得して、answerを重ねず同じworkerへ渡した。
両窓口で同じDispatch、terminal、worktreeと実効設定を維持し、working復帰を確認した。
新worker、PRは作成していない。

報告は[evaluations/task3-spec-with-skill.md](evaluations/task3-spec-with-skill.md)と[evaluations/task3-answer-with-skill.md](evaluations/task3-answer-with-skill.md)、実操作は同ディレクトリの`task3-*.operations.jsonl`に保存した。
担当の最終契約検証はTask 1から3の21 pass、0 fail、195 assertions、親側はTask 3の6 pass、0 fail、43 assertionsと型検査成功を確認した。
初回はsetup/helper未作成の失敗、テスト側のlabels型誤認、型検査2件の不整合を検出し訂正した。
Task 3の4 Stepを満たした。
