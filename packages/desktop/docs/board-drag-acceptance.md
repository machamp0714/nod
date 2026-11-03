# Board D&D の受入検証

NOD-51 の正本は Issue 本文と合意済み仕様 Document 824、決定は Document 823、実装時の証拠と最終結果は Document 825 である。
この文書は修正前の実測と、同じ境界を再検証する手順を記録する。
ブラウザ E2E の成功だけでは Desktop の受入を満たさない。

## 修正前の実測

2026年11月3日、Studio の macOS 27.0.1（26A434）、arm64、nod 0.1.0、schema 50で確認した。
基点は `4007c76cab47139b1d893e66defc2c85baa4d8ab`。
保存した `baseline.app` の build-info はこのcommit、dirty=falseである。
データは専用のDB、Document、添付、設定、ログへ隔離し、Orca連携を無効化した。

Issues Board の Todo にある DRG-1「Native drag source」を In Progress へ、利用者が実際にドラッグした。
PM経由の質問371への回答は「何も起きませんでした」だった。
観測用リスナーはカード上の `dragstart@503,266` と In Progress 内の `dragend@844,372` を受信したが、HTML `drop` は0件だった。
APIはstatus=todo、更新時刻と作成のみのactivityを維持し、画面もTodo列のままだった。
実手操作後のsmokeは期待in_progress／実際todoで失敗した。

Orcaの自動dragは入力到達を確認できなかったため、それ以前の自動smokeの失敗は製品再現の証拠から除外した。
AX取得に失敗した試行も成功扱いにしない。
権限回復やエラーを含む経緯はDocument 825へ残している。

Tauriの既定ハンドラはネイティブdragを消費する。
アプリは設定ファイルの静的windowではなく `shell.rs` の動的 `WebviewWindowBuilder` を使うため、そこで `disable_drag_drop_handler()` を指定してHTML D&Dへ渡す。
共有Boardとサーバーの更新処理は変更しない。

## 実Desktopでの再検証

1. 作業ツリーのcommitとdirty状態を記録し、`bun run desktop:build` を実行する。
   完成品検査、署名、build-info、OSとアプリ版を保存する。
2. `NOD_DB`、`NOD_DOCS_DIR`、`NOD_ATTACHMENTS_DIR`、`NOD_TOGGL_CONFIG`、`NOD_DESKTOP_LOG_DIR`を同じ専用ディレクトリ配下へ指定し、`NOD_ORCA=0`で実アプリを起動する。
   `/api/workspaces`のpathとsidecarが開いたDBも照合する。
3. Todoカードと通常のIn Progress列を用意する。
   APIの前状態、操作前の画面、掴む場所と落とす場所を記録する。
4. 実際のDesktopでドロップし、操作の到達、移動したカード、APIの保存状態を確認する。
   再読み込み後も表示とAPIが一致することを確認する。
5. 空の移動先をHidden columnsから選び、同じ保存・表示・再読み込みを確認する。
6. Desktop全体の設定変更による回帰として、Document本文へ実画像ファイルをドロップし、画像の保存、本文保存、再読み込みを確認する。

手動起動のハーネスは `packages/desktop/test/board-drag-status-smoke.ts` を使う。
自動入力の到達を確認できない場合は、実手操作の前状態と実利用者の観測記録を渡せる。
手動モードの外部観測を、ハーネスが独立検証した入力と扱わない。

```sh
bun packages/desktop/test/board-drag-status-smoke.ts \
  --origin http://127.0.0.1:4700 --issue DRG-1 \
  --data-dir packages/desktop/build/dnd-acceptance/baseline-data \
  --window-id <実ウィンドウID> \
  --before <実操作前のAPIのJSON> --manual-observation <実操作の記録.md> \
  --output <未使用の証拠ディレクトリ>
```

既定の期待値はin_progress／In Progress。
Hidden Doneの検証には `--status done --column Done` を指定する。
ハーネスはloopbackと隔離Workspaceを確認し、移動前後・再読み込み後のAPIとnative画面を保存する。
保存済みの移動先データや既存の出力先を再利用しない。

## 自動回帰と証拠の扱い

`packages/web/e2e/board-drag-status.e2e.ts`は実サーバーと一時DBで、通常列、Hidden列、再読み込み、通信失敗と復旧、拒否、同じ状態、Needs Clarification、共有画面とSprint着手保護を確認する。
既存の `sprint-review-regressions.e2e.ts` は読取り専用Boardと保存中の保護、`document.e2e.ts` は画像ドロップを確認する。
ブラウザ内の画像イベントはHTML側の回帰であり、OSからの実ファイル入力の証拠にはしない。

作業時の原記録は `packages/desktop/build/dnd-acceptance/` 配下に保持する。
実機の未実測項目、試験エラー、ビルド警告、独立レビューの指摘はDocument 825で区別し、必要項目が未完了のまま完了を宣言しない。
