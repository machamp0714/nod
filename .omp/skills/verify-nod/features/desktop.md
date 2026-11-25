# デスクトップアプリ固有の機能（動かさない）

nod のデスクトップアプリ（`packages/desktop`。macOS 用の Tauri v2 のアプリ）は、内部で `nod ui` を sidecar として起動し、同じ Web をネイティブのウィンドウに出す。画面の中身は verify-nod の Web と同じだが、ウィンドウ、sidecar の起動と監督、OS の通知、OS からのドラッグ＆ドロップ、配布物（署名・build-info）はデスクトップアプリにだけある。**verify-nod はデスクトップアプリを起動せず、これらの機能には到達しない。** 確かめるときは、既存の受入記録とその手順に従い、verify-nod の Web の成功をデスクトップの成功として報告しない。

## Sub-features

- `desktop-window` ネイティブのウィンドウ。閉じると非表示でアプリと sidecar は残り、Dock で再表示、Cmd+Q で終了（sidecar も止まる）。メニューの「再読み込み」「ブラウザで開く」、外部リンクは既定のブラウザで開き、ウィンドウは自分の sidecar の origin 以外へ遷移しない。
- `desktop-sidecar` sidecar の起動と監督。4700 が空いていれば 4700、使用中なら空いているポート。異常終了で 1・2・4 秒の間隔で最大3回再起動し、超えると失敗画面と「再試行」。ログインシェルの環境の取得、孤児回収（`sidecar.pid`）、ログ。
- `desktop-notifications` OS の通知。Workspace の設定の「デスクトップ通知」の「通知を ON にする」と OS の許可、個別リマインダーと Due date の通知、通知のクリックで Issue を開く。
- `desktop-native-dnd` OS のドラッグ＆ドロップ。Board のカードのドロップがネイティブのウィンドウで HTML の D&D に届くこと、Document の本文への画像ファイルのドロップ。
- `desktop-package` 完成品（`nod.app`）の検査。署名、sidecar の entitlements、arm64、build-info と同梱の nod の版の一致、隔離したデータでの起動（`/api/workspaces` が 200）、schema 版の一致。
- `desktop-web-side` Web の側から見えるデスクトップの部分。通常のブラウザでは「デスクトップ通知」の「通知を ON にする」が無効で、「デスクトップアプリで確認できます」と案内される。verify-nod で確かめてよいのはこれだけ。

## How to get to it (user POV)

- 利用者は `~/Applications/nod.app` を起動する（Finder・Dock）。端末の `nod` は `~/.local/bin/nod` のラッパーで、アプリの中の nod を実行する。どちらも利用者の nod で、verify-nod では使わない（`../SKILL.md` の「守ること」）。
- ビルドと検査は `bun run desktop:build`（`packages/desktop/dist/nod.app` を作り、最後に `packages/desktop/scripts/verify-app.ts` で検査する）、導入は `bun run desktop:deploy`。
- Web の側は、Workspace の設定（`/workspaces/<キー>/settings`）の「デスクトップ通知」の欄（`region "デスクトップ通知"`）。

## Driving it with verify-nod.ts

Preconditions:

- verify-nod はデスクトップアプリ、`desktop:build`・`desktop:deploy`、`packages/desktop/scripts/*`、`packages/desktop/test/board-drag-status-smoke.ts` を実行しない。デスクトップ固有の機能を確かめる依頼は、下の受入記録の手順と前提（実機の macOS、ビルドした `.app`、OS の権限、利用者の手操作や Orca Computer Use）で、利用者の nod と分けて行う。
- `desktop-web-side` だけは、`$S launch` した run（`S=./.omp/skills/verify-nod/scripts/verify-nod.ts`、`R` に `runId`）で、`$S doctor $R` が通れば確かめられる。

- **ウィンドウと sidecar（`desktop-window`・`desktop-sidecar`）。** 仕様は `packages/desktop/README.md` の「動作の要点」「ログと診断情報」「中止条件」にある。起動・監督・孤児回収・ログの自動テストは `cd packages/desktop/src-tauri && cargo test`（README の「ビルドと検査」）。ウィンドウの表示・Dock・メニューは実機の操作でしか確かめられず、verify-nod には手順が無い。到達できない（前提: 実機で起動した `.app`）と報告する。
- **OS の通知（`desktop-notifications`）。** 受入記録は `packages/desktop/docs/notifications-acceptance.md`（NOD-19）。自動の検証（`packages/desktop/test/notification-delivery.test.ts` などの実 DB・実 Rust の worker・偽の OS の受け口のテスト、`cargo test`）と、専用の bundle ID でビルドした検証用のアプリでの実機の確認（許可の画面、バナー、クリック）を分けて記録している。記録は「偽の OS の許可や通知の送信は、OS の実際の許可画面・バナー・クリックの証拠に使わない」とし、OS の設定での許可の取り消し、実スリープからの復帰などは未検証として残している。確かめるときは記録の「配布形態での実機確認」の項目と証拠の置き場に従う。verify-nod の Web では到達できない（前提: 実機の macOS と OS の通知の許可）。
- **OS のドラッグ＆ドロップ（`desktop-native-dnd`）。** 受入記録は `packages/desktop/docs/board-drag-acceptance.md`（NOD-51）。修正前は、実機で利用者がドラッグしても HTML の `drop` が0件で保存されなかった（Tauri の既定のハンドラがネイティブの drag を消費していた）。「実Desktopでの再検証」の手順（ビルド、データを専用のディレクトリに隔離し `NOD_ORCA=0` で起動、ドロップ、API の保存値と再読み込み、Hidden columns、Document への画像ファイルのドロップ）と、手動起動のハーネス `packages/desktop/test/board-drag-status-smoke.ts`（macOS と Orca Computer Use の権限が要り、loopback と隔離した Workspace を確かめ、移動の前後と再読み込み後の API とネイティブの画面を保存する。自動の入力が届いたか確かめられないときは、実手操作の前の状態と観測の記録を渡す手動モード）がある。記録の冒頭のとおり「ブラウザ E2E の成功だけでは Desktop の受入を満たさない」。verify-nod の [`issue-status`](./issue-status.md) の Board のドラッグ（ヘッドレスの Chromium）は、Web の HTML の D&D の証明で、ネイティブのウィンドウのドロップの証明ではない。
- **完成品の検査（`desktop-package`）。** `packages/desktop/scripts/verify-app.ts <nod.app のパス>` が、署名・entitlements・arm64・build-info・版・schema と、同梱の nod を一時ディレクトリの隔離したデータ（`PATH=/usr/bin:/bin`、`HOME`・`NOD_DB` などを一時ディレクトリへ、`NOD_ORCA=0`）で `ui --port 0` 起動して `/api/workspaces` の 200 を見る。ビルドした `.app` が前提で、`desktop:build` の最後に実行される。verify-nod はビルドも検査も行わない（verify-nod の「Doctor」は、同じ考え方をソースから起動した nod に当てたもの）。
- **Web の側の表示（`desktop-web-side`）。** 次の1回の呼び出しで、通常のブラウザでは通知を有効にできないことを確かめる。Workspace のキーは `launch` の出力の `workspace.key` と同じで、run の `state.json` から読む（1行目）。

  ```sh
  K=$(jq -r .workspace.key "$($S doctor $R | jq -r .runDir)/state.json")
  $S browser $R --feature desktop <<EOF
  [
    {"goto": "/workspaces/$K/settings"},
    {"expect": {"role": "region", "name": "デスクトップ通知", "exact": true}, "text": "アプリ設定：OFF"},
    {"expect": {"role": "region", "name": "デスクトップ通知", "exact": true}, "text": "OS の通知許可：デスクトップアプリで確認できます"},
    {"expect": {"role": "button", "name": "通知を ON にする", "exact": true, "within": {"role": "region", "name": "デスクトップ通知", "exact": true}}, "disabled": true},
    {"snapshot": "desktop-notifications", "of": {"role": "region", "name": "デスクトップ通知", "exact": true}}
  ]
  EOF
  ```

  終了コード 0 で `"ok": true`。`evidence/desktop/001-04-desktop-notifications.aria.yml` に「通知の有効化・許可要求は、この Mac の nod デスクトップアプリで行ってください。」と `button "通知を ON にする" [disabled]` がある。これは「通常のブラウザでは有効にできない」ことの観測で、デスクトップアプリの通知が動くことの証明ではない。

## Gotchas

- Web（verify-nod のヘッドレスの Chromium）での成功を、デスクトップアプリでの成功として報告しない。デスクトップ固有の項目は「到達できない（デスクトップアプリを動かさない）」と、案内した受入記録を添えて報告する。
- `bun run desktop:deploy` は利用者の `~/Applications/nod.app` と `~/.local/bin/nod` を置き換え、稼働中のアプリに終了を依頼する。検証で実行しない。
- `board-drag-acceptance.md` のハーネスの例は `--origin http://127.0.0.1:4700` を使う。このマシンの 4700 は利用者の nod なので、そのまま実行しない（ハーネス自体も verify-nod の範囲外）。
- デスクトップアプリの sidecar は 4700 が空いていれば 4700 を使う。利用者のアプリが動いている間に別の `.app` を起動すると、ポートやデータ（既定の保存先は CLI と同じ `~/.local/share/nod/`）がぶつかりうる。受入記録は専用の bundle ID とデータの隔離で行っている。
- `verify-app.ts` は `bun test`（`packages/desktop/test/verify-app.test.ts`）からも使われる。リポジトリのテストが通ることは、実機の受入の代わりにならない。
