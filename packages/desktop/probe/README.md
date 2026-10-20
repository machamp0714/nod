# デスクトップ通知方式の試作

macOS 26.3.1 / Apple Silicon の実機で、現在の配布と同じ ad-hoc 署名による通知許可・表示・クリックを確認するためのアプリ。
本番の nod.app、DB、通知許可設定を変更せず、別の bundle ID と隔離 DB を使う。
Swift は通知方式を素早く確認するためだけに使い、本製品の Tauri 構成は変更しない。

## ビルドと起動

リポジトリのルートで実行する。

```sh
bun run web:build
bun build packages/cli/src/main.ts --compile --target=bun-darwin-arm64 --outfile packages/desktop/build/notification-probe-nod
codesign --force --sign - --options runtime --entitlements packages/desktop/scripts/entitlements.plist packages/desktop/build/notification-probe-nod
bun run packages/desktop/probe/build.ts full
open -n "$HOME/Library/Application Support/nod-notification-probe/nod-notification-full-probe.app"
```

`full` は実 DB・CLI sidecar・Web の細い経路を用意する。
任意の別名を渡すと、OS 通知 API だけを確認する独立したアプリを作る。
拒否の確認には別名のアプリを使い、本番や許可済み試作の OS 設定を変更しない。
ビルド済みのアプリを再ビルドする場合は、その試作を先に終了する。

データは `~/Library/Application Support/nod-notification-probe/full-state/` に置く。
`nod.db` は本番と分離され、`PROBE-1` と `PROBE-2` の検証 Issue を作る。
Document・添付ファイル・Toggl 設定もこのディレクトリへ切り替え、Orca 連携は無効化する。
試作の各起動で sidecar を `--port 0` で起動し、標準出力で受け取った現在の URL を使う。
起動を意図的に5秒遅らせており、起動待ちのクリックを確認できる。

1. 「通知の許可を要求」を押す。OS 側の許可操作後、「OS 許可状態を確認」で `2許可` を確かめる。
2. Web で `PROBE-1` のリマインダーを少し先に設定する。タイトルと任意メモを指定する。
3. 前面表示中に通知が出ること、通知クリックで `PROBE-1` の実 Issue 詳細が開くことを確かめる。
4. 別のリマインダーを設定してウィンドウを閉じ、常駐中の通知とクリックによる再表示を確かめる。
5. 通知表示後にアプリを完全終了し、再起動してから残った通知をクリックする。現在のポートで対象 Issue が開くことを確かめる。
6. 再起動直後の5秒待機中にも残った通知をクリックし、sidecar 起動後に対象 Issue が開くことを確かめる。

「検証通知を送信」は3秒後に固定の `PROBE-1` 通知を送る。
このボタンは API 境界の調査用であり、実リマインダーの検証は Web または CLI で設定する。

## 最小の境界

- 候補取得は既存の `/api/notifications` を使う。これによって実 DB の期限到来処理と Inbox をそのまま通す。
- `ProbeDelivery` は時計と OS 送信受け口を差し替えられる。既存通知の ID と Issue ID を保ち、メモとタイトルを OS へ渡す。
- 配信ループは WebView に置かず、ネイティブの1秒周期処理に置く。OS 許可状態を毎回確認してから候補を取得する。
- 通知内容の `userInfo` に Issue ID と Inbox 通知 ID を保存し、アプリ存続中のメモリだけに依存せずクリックを受ける。
- 未処理の遷移先を `pending-issue` に保存し、sidecar の現在の URL が確定するまで保持する。
- 試作の `enabled-at` と `claimed.json` は方式確認用である。本実装の原子的な取得・配信結果・除外履歴は共通 DB に保存する。この Set とファイル保存を仕様の並行処理保証の代用にしない。
- 試作はクリック時の個別既読化をまだ実装しない。Task 2 で Issue の正常表示後に当該 Inbox ID だけを既読にする。

自動テストでは、Bun の固定時計・実 DB・実 API でリマインダーを Inbox 化し、同じ Swift 配信境界の偽 OS 受け口へ流す。
予定時刻前の非生成、時刻到来時の内容と識別情報、反復処理による送信重複防止、Inbox の未読維持を確認する。
macOS または `swiftc` がない環境では、この実行形式に固有のテストだけを明示的に skip する。

```sh
bun test packages/desktop/test/notification-probe.test.ts
```

## API の選択と実測

採用候補は Apple の `UNUserNotificationCenter` と delegate である。
許可要求・実際の OS 許可状態・前面通知・通知応答を同じ API で扱う。
本実装では、この API を Tauri のネイティブ側から呼ぶ。
許可要求を起動時に自動実行せず、利用者の ON 操作で実行する。[Apple の許可要求文書](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)

Tauri の `tauri-plugin-notification` 2.7.0（調査時の upstream commit `6ea32db9a8da6f49175c7866e2cd367c83e09cc6`）にはデスクトップのクリック受信がある。
ただし `request_permission` と `permission_state` がデスクトップでは常に Granted を返すため、実際の macOS 許可状態を表示する本仕様に、そのまま用いることはできない。
クリック用の状態もプロセス内に保持されるため、再起動後の通知クリックの根拠にしない。[Tauri のデスクトップ通知実装](https://github.com/tauri-apps/plugins-workspace/blob/6ea32db9a8da6f49175c7866e2cd367c83e09cc6/plugins/notification/src/desktop.rs)

2026年10月15日の API 試作では、次を実測した。

- `/tmp` 配置では要求が `UNErrorDomain` 1 相当の `Notifications are not allowed for this application` で失敗し、OS 状態は未要求のままだった。usernoted はクライアントの検証失敗を記録した。
- 同じバイト列・同じ ad-hoc 署名のアプリを `~/Library/Application Support/nod-notification-probe/` に置き、LaunchServices 登録後に起動すると、OS の許可操作と状態 `2許可` を確認できた。
- 前面の通知バナー、通知クリックによる Issue ID と Inbox ID の受信、終了・再起動後に残った通知のクリック受信を確認した。
- 別の bundle ID の試作で拒否し、状態 `1拒否` を確認した。拒否しても `center.add` の完了ハンドラはエラーなしで完了したため、送信完了だけを許可の根拠にしない。
- Full 試作では、実 API から設定したリマインダーが Inbox に変換され、送信時点の Issue タイトルとメモを持つ OS バナーへ届き、そのクリックで実際の `PROBE-2` 詳細が表示された。
- Full 試作で実リマインダーを設定して閉窓し、独立したウィンドウ一覧が空である一方、アプリが起動中（PID `98182`）であることを確認した。その後、予定時刻に Issue タイトルとメモの OS 通知が届き、クリックでウィンドウが再表示され `PROBE-1` 詳細を開けた。閉窓操作そのものの戻り値は操作後の画面取得エラーだったため、独立した一覧と通知後の画面で結果を確認した。
- Full 試作で通知を表示してから通常終了・再起動し、sidecar の5秒待機中に旧通知をクリックした。`pending-issue` に `PROBE-2` が保持され、新しいポート `65023` の実 Issue 詳細が表示された後、pending ファイルが解放されることを確認した。
- Full 試作の初回確認で Toggl の本番設定を読み取る隔離漏れが分かり、設定ファイル・添付保存先も隔離するよう修正した。修正版の実機画面で Toggl が未設定となることを確認した。本番のタイマー操作は行っていない。

この結果は、この実機と配置についての確認である。
ad-hoc 署名の一般的な可否を推測せず、製品の Tauri .app にも同じ境界を組み込んだ後、Task 7 で配布物を実測する。
実機の追加証拠は作業時の `/tmp/nod19-acceptance/` と Issue の作業ログに保存する。
