# 最終検証

Bun 1.4.3で実行した。
実装場所はStudioの`/Users/ooidetatsuya/orca/workspaces/nod/pm-issue-c236b751`、ブランチは`pm-issue-c236b751`。
実機worker、本物GitHub PR、インストール済みプラグイン更新は実行していない。

| 検証 | 実際の結果 |
| --- | --- |
| 全テスト初回、sandbox内 | 2274 pass、16 fail、11 skip、17891 assertions、2301 tests / 247 files、189.53秒、exit 1 |
| server 2ファイル、sandbox外 | 13 pass、1 fail、79 assertions、14 tests、exit 1 |
| 全テスト再実行、sandbox外 | 2289 pass、1 fail、11 skip、17940 assertions、2301 tests / 247 files、165.05秒、exit 1 |
| PM公開境界5ファイル（担当確認） | 50 pass、0 fail、569 assertions |
| 型検査 `bun run typecheck` | `tsc --noEmit -p .`、exit 0 |
| 差分検査 `git diff --check` | exit 0 |

## 初回失敗の切り分け

初回の16件は、サーバー待受とUI起動/停止の15件、およびHTTPエラー対応表の1件だった。
sandbox外の再実行では前者15件が全て成功した。
残る失敗は`packages/server/test/app.test.ts:28`の「core が投げるコードは、すべて対応表にある」であり、未登録コードは`DB_BACKUP_FAILED`。
今回の差分は`packages/core`と`packages/server`を変更していない。

基点`fa0bb3b006d3ee6e671ddb9021c6669710cbfd23`のtrackedなcore/serverソース、対象テストと依存manifestだけを一時ディレクトリへ展開し、同じ1件を再実行した。
`.env`、資格情報、本番DB、dataはコピーしていない。
最初の基点再現はworkspace依存`@nod/core`の解決が不足して0 pass、1 fail、1 errorとなった。
一時配置の`@nod/core`へ正しいworkspace依存リンクと既存hono依存参照を用意した後、同じ`DB_BACKUP_FAILED`を0 pass、1 fail、7 filtered out、4 assertionsで再現した。
基点由来の既存不具合として残し、今回のPM実装へ無関係な修正を加えていない。
全テスト成功とは報告しない。

11 skipは既存のdesktop verifyApp検証群であり、今回の結果は未実行として扱う。
実機モデル転送、実通信切断、Studio負荷、実コードを使うPM運用、実GitHub作成は未検証。
PMの行動評価は実nod一時DBと偽外部接続先を新しい独立LLMが実操作した証拠であり、詳細はimplementation.mdとevaluationsへ保存した。
各TaskでREDとなったテストとfixture補修、CLI読取の初回失敗も同記録へ分けて残した。

元の全テスト出力: `/private/tmp/per11-full-tests.log`、`/private/tmp/per11-full-tests-unsandboxed.log`。
型検査出力: `/private/tmp/per11-final-typecheck.log`。
基点再現出力: `/private/tmp/per11-baseline-error-mapping.log`。
