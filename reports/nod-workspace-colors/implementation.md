# Workspace色の実装報告（#9 / NOD-7）

Task 1・2を実装した。既存hashで衝突するAPI/WEBを含め、現在登録されているWorkspaceへ一意の色値を割り当てて保存し、既存の全WorkspaceBadgeへ反映する。

## 作業範囲

- worktree：`/Users/ooidetatsuya/orca/workspaces/nod/nod-workspace-colors`
- branch：`machamp0714/nod-workspace-colors`
- 開始：`e3041b0552120c56c85e502ae92254a1849b4c3a`（Bのb205cf7統合済み）
- 先行契約：`29f67dc7cf1d2bee4b4bf3e4900a44d61132e760`。PMへ通知しBへ受け渡した。
- 独立DBレビュー修正：`163171b82b6fcc7ded4bc91905d209ccaf1ffcae`。NULを含む不正値をINSERT/UPDATEで拒否する。
- 後続のbadge・専用テスト・本報告は、この報告を含むcommit。最終HEADはworker_doneへ記録する。

## 実装

coreに必須 `Workspace.color: string` と色割当を追加した。初期12色の後も決定的な24bit候補列から未使用色を生成し、12件・24件などの登録上限を作らない。登録済みpathへの再init、他Workspaceの追加・削除、再起動で色は変わらない。削除後は空き色を再利用する。

v2 migrationは既存行をcreated_at/id順で一度だけ割り当て、既存Issue・ラベル・参照・イベント・連番を保持する。同一transactionでALTER/backfill/制約/user_versionを更新し、失敗時はまとめてrollbackする。並行登録はIMMEDIATE transactionとUNIQUE index、NULLと不正HEXはCHECK/triggerで守る。

`GET /api/workspaces` とCLI JSONへmapper経由で色を渡し、Web API型は既存のcore再exportを維持した。WebはWorkspaceBadgeからuseWorkspacesを参照し、Pageを変更していない。未知キー・未取得・不正色・取得失敗でhashへ戻さず、文字と透明の目印を残す。有効なキャッシュがあれば再取得失敗でもその色を保つ。

## 検証結果

全実行で一時 `NOD_DB`、`NOD_ORCA=0 NOD_ACTOR=codex` を指定した。meケースもテスト用DBだけを使った。

| 検証 | 結果 |
|---|---|
| 全 `bun test` | 405 pass、0 fail、64ファイル、9,749 assertions |
| `bun run typecheck` | 成功 |
| `bun run web:build` | 成功（既存の500kB chunk警告あり） |
| `bun run --cwd packages/web test:e2e workspace-colors.e2e.ts` | 20 pass、約25.5秒 |
| NUL修正の限定検証 | core/server/cliの関連6ファイル22件成功 |
| `git diff --check` | 成功 |
| ポート解放 | Playwright終了後、5199/4798/4797にLISTENなしをlsofで確認 |

主な回帰は1000件登録、30件の旧DB移行、旧DBの参照/連番保全、移行失敗rollback、並行open/init/remove、DB_BUSYと再試行、削除色再利用、API/CLI、全既存badge、list/boardのグループ見出し、遅延/503/欠損/不正値、SSE、実際の優先度変更による行順変化、検索と解除、再ロード。

変更前は保存色がundefined、色なしINSERTが成功、ブラウザのAPI色が保存値の紫でなく従来の橙となる失敗を確認した。migrationテストの最初のfixtureにはevents.created_atが不足しており、fixtureを修正して移行とrollbackを確認した。NULのINSERT/UPDATE両方でREDを確認し、byte長CHECK追加後GREENになった。

## レビュー・判断・共有文書

独立DBレビューはCritical/Importantなし、P3のNUL境界1件を修正済み。レビュー原本は `/Users/ooidetatsuya/orca/workspaces/nod/nod-project-status/reports/nod-project-status/review-d-29f67dc.md`。UIの独立レビューと統合時の受け入れ確認はPMの後続工程。

計画からの変更は、全coreエラーのHTTP対応を要求する既存テストに合わせた `WORKSPACE_COLOR_EXHAUSTED: 409` の追加と、PM指示による既存E2E基盤の利用。新しいポート基盤は作らなかった。旧計画のsort/order URL指定はUIが対応していないため使わず、優先度更新で実際の行順が変わることを検証した。

原本spec `/Users/ooidetatsuya/repo/nod/docs/superpowers/specs/2026-09-27-nod-design.md` は明示されたworktree外例外としてWorkspace表の列、Workspace色節、Workspace API行、既存badge表示だけを更新した。他段落を保全し、編集完了を通知してBへ所有権を返却済み。原本specはcommitしていない。

計画：`/Users/ooidetatsuya/orca/workspaces/nod/nod-workspace-colors/docs/superpowers/plans/2026-09-28-nod-workspace-colors.md`

日本語PR案：`/Users/ooidetatsuya/orca/workspaces/nod/nod-workspace-colors/reports/nod-workspace-colors/pr-draft.md`

## 残作業・制限

Task 3のA/B最新変更との統合、全E2E、build済みdistの実配信確認はPM指示まで未実施。A最新405615dは取り込んでいない。色値の一意性は保証するが、近い色を人が判別できる保証はなく、有限RGB候補の完全枯渇は明示エラーになる。

実DBアクセス、#21/NOD-19、docs/linear-usecases.mdの変更・commit・stash、push、PR作成、main merge、他担当serverの停止はしていない。追加のdocs/superpowers force addも行っていない。
