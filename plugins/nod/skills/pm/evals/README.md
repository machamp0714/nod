# PMの行動評価

このディレクトリは、LLMがPMスキルを使ったときの外部操作を観測する評価環境である。
PM自身の選定ロジックや管理DBを実装するものではない。
nodは実CLIと一時SQLite DBを使い、OrcaとGitHubには偽CLIを使う。
モデルへ送る仕様判定APIも偽接続先に替え、実際のStudio workerやGitHub変更を起動しない。

## 環境の作成

リポジトリの依存を導入した環境で、未使用の一時ディレクトリを指定する。
引数を省くと新しい一時ディレクトリを作る。

```sh
bun plugins/nod/skills/pm/evals/setup.ts
```

setupのJSON出力にある`source`を、評価する新しいLLMセッションでsourceする。
以後、PATHの`nod`、`orca`、`gh`を使う。
`NOD_DB`はその環境専用で、nodの書き手は`codex`に固定される。
セットアップを同じディレクトリへ再実行すると既存Cycleの衝突で失敗するため、比較実行ごとに新しい環境を使う。

## Task 1の実行と採点

[混在候補評価](task1-mixed-candidates.md)の「LLMへ渡す入力」を評価セッションへ渡す。
採点表とsetupのソースは評価セッションに渡さない。
baselineではPMスキルを読ませず、比較実行では`nod:pm`を読ませる。
同じモデルとeffortを使い、各セッションの報告と`operations.jsonl`を評価者が確認する。

操作ログは、実nod CLIへ渡した引数、偽OrcaやGitHubへ出した依頼、書き手、時刻を1行ずつ保存する。
未回答の人質問や他担当を触らなかったことは、報告だけでなくログとnodの再取得結果で確かめる。
自由文の分類理由は評価者が読み、単語の出現だけで合格にしない。
未指定や無効な入力の追加評価も、別の新しいLLMセッションで実行する。

## 契約テストとの区別

```sh
bun test packages/cli/test/pm-evaluation.test.ts
bun run typecheck
```

このテストは評価環境の公開CLI境界を検査する。
実nodで混在するIssueを取得できること、仕様判定の状態と偽APIによる回復、外部変更の遮断と操作記録を確認する。
LLMが正しく分類できたことは、このテストの成功だけからは主張しない。
行動評価の成否は別に記録する。

## Task 2の実行と採点

[実装とPR提出の評価](task2-implementation.md)を使う。
`task2-setup.ts <未使用ディレクトリ> <シナリオ> <onまたはoff>`で、Task 1と同じ一時DB境界に偽workerの起動、実効設定、完了報告、GitHubの状態を追加する。
操作ログの`origin`はPMからのCLI操作と、偽workerが行った操作を区別する。
初回workerは開始通知まで待機し、後続PR作業は同じterminalの新Dispatchとして実行する。
このfixtureは指定値の転送、git、テスト、レビューの証跡を模擬し、実機や実コードで成功したとは主張しない。
契約テストは正常提出、PR連動onとoff、既存PR更新、モデル異常、テスト失敗、証跡不足、cleanupの所有権とack順序を公開CLI経由で確認する。

偽CLIの操作ログはテスト観測用であり、新しいPMデータベースではない。
本番運用では要求と判断をnod、実行の権限と状態をOrcaへ記録する。

## Task 3の実行と採点

[仕様準備と質問対応の評価](task3-questions.md)を使う。
`task3-setup.ts <未使用ディレクトリ> <シナリオ>`で既存workerのblocking ask、仕様化の途中記録、正式Specと合意の有無を用意する。
`NOD_DOCS_DIR`と`NOD_ATTACHMENTS_DIR`は評価環境の下へ固定し、実環境の文書を作成しない。
シナリオは技術質問、新しい利用者判断、仕様未合意、正式Spec添付済み、人起点質問である。
新しい利用者判断は評価者がチャットまたは評価者専用`task3-human.ts`で実回答を投入する。
無回答、回答先不明、一意な回答の各段階の操作を分けて保存する。
fixtureは実際の別モデルやworkerを起動せず、スキルの語句を検査して判断を代行しない。

```sh
bun test packages/cli/test/pm-evaluation.test.ts packages/cli/test/pm-task3-evaluation.test.ts
bun run typecheck
```

Task 3の契約テストは元messageへのreplyによる同じDispatchの再開、無回答での待機保持、指定質問だけへの人回答、正式Specの実CLI取得と一時文書への隔離、人起点質問へのLLM回答拒否を検査する。
PM自身が原文と出典を記録して適切な時点に再開したかは、別セッションの行動評価で判定する。
