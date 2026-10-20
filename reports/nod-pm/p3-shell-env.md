# P3任意改善の修正と検証

2026-10-16 17:08 JSTにユーザーが選択肢1「任意改善を修正する」を選択した。
同じ元実装者セッション、指定モデル`gpt-6.1-sol:high`、Studioの`/Users/ooidetatsuya/orca/workspaces/nod/pm-issue-c236b751`で作業を継続した。
開始時にHEADが`79c4a5104a5b2c27ec6f96e7728490c446e1b6c2`でcleanであることを確認した。
最終Standardsレビュー全文とPER WorkspaceのPER-11最新ログを読み、指摘と実装の対応を再確認した。

## 変更と指摘の解消

`evals/shell-env.ts`へシェル値の引用とenv.shのexport生成をまとめた。
Task 1〜6のsetupが同じ関数を使い、Task 2の`ORCA_CLI_COMMAND`も同じ引用処理で追記する。
既存のexport対象変数の一覧も一箇所へまとめ、DB、Documents、Attachments、偽CLIの各値と未定義値の扱いを保持した。
各Taskの状態遷移、質問、PR、モデル照合、workerの処理は変更していない。
Standards P3の重複と、Task 2だけが単一引用符入りパスを壊す差異を解消した。
独立レビュー全体の再実行は行わず、既存指摘と今回の差分を照合した。

実際のCLI起動では、Bun 1.4.3が`BUN_OPTIONS`内の空白入りpreloadパスを分割することも見つかった。
単一引用符、二重引用符、backslashによるパス引用でも同じ問題が残ることを一時環境で確認した。
偽APIのmodule内容を変えず、data URLとして`BUN_OPTIONS`へ渡す方式に変更した。
変数を削除したり、実APIへ切り替えたりせず、子nodにも同じ偽APIが適用される。

## REDからGREENへの経緯

1. 先に、特殊文字入りの一時ディレクトリでTask 2のenv.shをsourceする回帰テストを追加した。
   初回は元のexport行の引用が閉じず、0 pass、1 fail、4 assertionsとなった。
2. 引用とexportを共通化するとsourceと環境値の照合は成功したが、偽CLI起動でBunが空白を分割した。
   0 pass、1 fail、17 assertionsのまま、成功扱いにしなかった。
3. 偽APIのdata URL preloadを実測して適用し、同じテストが1 pass、0 fail、18 assertionsとなった。
4. 6 Taskとsh/zshへ広げた初回は8 pass、4 failだった。
   Task 3のDocument実パス取得でbackslash入り親パスを扱えない既存制約と、Task 4の偽GitHubが提供しないhelpをテスト側が要求した誤りを分けた。
   Documentディレクトリの事前作成も試したが制約は解消せず、その変更は取り消した。
   Task 4は公開契約の`pr list`へ訂正した。
   Task 3はbackslashを除き、単一・二重引用符、空白、ドル式、backtick、セミコロン、コメント、pipe、redirect、日本語を含むパスでsourceを検査した。
   他の5 Taskではbackslashも含めて検査した。
5. 最終の特殊パス回帰は12 pass、0 fail、292 assertionsとなった。

テストは生成env.shを実際にsourceし、環境値を取得する。
偽Orca status、実nod一時DBのIssue読取、偽GitHub読取またはhelpを呼び出す。
入力をコマンド置換や別コマンドへ変換すると作られる3種類の印が、隔離cwd内に存在しないことも検査する。
単なる文字列一致や構文検査だけを成功根拠にしない。
shまたはzshが存在しない環境では、そのshellのケースだけをskipする。
今回のStudioでは両方を実行し、skipはなかった。

## 最終検証

使用Bunは1.4.3。

| 検証 | 実際の結果 |
| --- | --- |
| PM関連6ファイル（既存50件と追加12件） | 62 pass、0 fail、0 skip、861 assertions、20.35秒、exit 0 |
| `bun run typecheck` | `tsc --noEmit -p .`、exit 0 |
| `git diff --check` | exit 0 |

変更は評価fixtureの環境生成だけなので、PM関連群で変更先をすべて検査した。
全2301件とLLM行動評価全件は再実行していない。
この結果をPMの選定・依頼・質問判断の新しいLLM評価とは呼ばない。
直前の全体テストの既存`DB_BACKUP_FAILED`失敗は対象外として維持する。

## 維持する状態と残件

6 Task・27 Stepはdone、PER-11はin_progressを維持する。
Task 3の既存Document実パス取得のbackslash親パス制約は未修正である。
今回の共通シェル引用と、Document保存先を実パスへ解決する処理の制約は区別する。
実機worker、本物GitHub、実機モデル転送、既存の過去ack履歴の再検証は行っていない。
push、PR作成、merge、issue done、グローバル導入は行っていない。

テスト出力は`/private/tmp/per11-p3-red.log`、`per11-p3-after-quote.log`、`per11-p3-path-matrix-final.log`、`per11-p3-pm-tests.log`へ保存した。
修正後commitとStudio実作業場所はPER-11のnodログに記録する。
