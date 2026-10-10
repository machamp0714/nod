# Tauri と Bun によるデスクトップ版の成立条件

調査日: 2026-10-10。対象ソース: `133abdee39d75bce4348e5e6b2ddb162cae4615c`。
公式資料とソースを読む調査のみで、アプリの実装、ビルド、署名、実機試験は行っていない。
調査基点以後の Orca 未送信入力に関する作業中の変更は対象外であり、実装計画時に最新差分との再照合が必要である。

## 結論

Tauri v2 の専用ウィンドウと Bun の実行ファイルを組み合わせる案は、初版候補として成立する見込みがある。
ただし「現在の `nod ui` をそのまま起動して表示する」だけでは、プロセス所有権、GUI 起動時の環境、API の保護、CLI と DB の版ずれを満たせない。
以下は採用決定ではなく、資料から確認できた機構と、nod 側で設計・検証する条件を分けた調査結果である。

初版の前提は macOS・自分用、既存画面・機能・データ・CLI・Orca 連携の維持、閉窓後も存続、明示終了で自身が所有するサーバーを停止、CLI の独立利用、`.app` の手動入れ替えである。
自動更新、通知、メニューバー常駐、ログイン時起動、グローバルショートカットは対象外とする。

## 資料から確認できた機構と成立条件

| 領域 | 一次資料で確認できたこと | nod に必要な条件・判断 |
| --- | --- | --- |
| Bun の同梱 | Tauri は任意言語の実行ファイルを `externalBin` として同梱でき、CPU ごとの target triple を付ける。Bun は `--compile` で単一実行ファイルを生成でき、`bun:sqlite` も扱える。[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)、[Bun executables](https://bun.sh/docs/bundler/executables) | 当人の Mac の CPU と対応 macOS を固定し、Tauri・Bun の版をビルドで固定する。ローカルに Bun を別途インストールする方式にしない。 |
| ウィンドウと存続 | Tauri に終了要求の抑止 API、macOS の再表示イベント、子プロセスの終了 API がある。[終了要求](https://docs.rs/tauri/latest/tauri/struct.ExitRequestApi.html)、[macOS RunEvent](https://docs.rs/tauri/latest/x86_64-apple-darwin/tauri/enum.RunEvent.html)、[shell API](https://v2.tauri.app/reference/javascript/shell/) | 閉窓、Dock からの再表示、メニュー終了・Cmd+Q を区別する。終了を一律に抑止して Cmd+Q まで無効にしない。起動した子のハンドルと準備完了を管理し、正常停止を待つ。 |
| 多重起動 | Tauri に Single Instance プラグインがある。[Single Instance](https://v2.tauri.app/plugin/single-instance/) | 二重クリック時は既存ウィンドウを表示する。これは `nod ui` や DB の所有者判定を代替しない。 |
| 同梱 Web | Tauri はビルド済み frontend の配置先を設定でき、独自プロトコルも使える。[設定](https://v2.tauri.app/reference/config/) | Tauri が静的ファイルを配信するか、Bun が同梱 Web と API を同一 origin で配信するかを決める。前者は相対 API URL、SSE、添付ファイル URL の接続先変更が必要。 |
| Finder/Dock 起動 | GUI アプリはシェル設定ファイルの PATH を継承しないと公式資料に明記されている。[macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/) | `orca`・`gh`・`git` の探索方針と明示設定を用意し、存在し続ける cwd を渡す。ユーザーのシェルを起動して環境を取り込む方式は、遅延・副作用・タイムアウトを含めて別途判断する。 |
| API の保護 | Tauri capabilities は WebView からの Tauri API 公開を制限する。外部 URL への権限付与は追加設定が必要。localhost 配信プラグインは公式にセキュリティ上の注意がある。[capabilities](https://v2.tauri.app/security/capabilities/)、[localhost](https://v2.tauri.app/plugin/localhost/) | capabilities を設けても、独立した Bun HTTP API は自動で保護されない。loopback 限定、接続先の同一性確認、許可 origin、必要なら起動ごとの認証情報を設計する。 |
| `.app` の配布 | Tauri は macOS 上で `.app` を生成でき、実行ファイルと Resources を格納する。[macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/) | DB・Documents・添付・認証設定はバンドル外に保持する。入れ替え前の終了、初回マイグレーション、バックアップ、旧 CLI の取り扱いを決める。 |
| 署名 | Tauri は Developer ID と公証、および ad-hoc 署名を案内している。ad-hoc では初回許可が不要になるわけではない。[Tauri signing](https://v2.tauri.app/distribute/sign/macos/) | 自分の Mac でビルドしたものと、ブラウザ経由で取得する成果物を区別する。後者をターミナルなしで開く導線を実物で確認する。 |

## 現行ソースとの対応

### 既存資産を維持できる根拠

ルートの [package.json](../../package.json) は既に `bun build --compile` で CLI を生成する。
[CLI context](../../packages/cli/src/context.ts) は core の `openDb()` を直接呼ぶため、CLI の基本操作は HTTP サーバーの稼働に依存しない。
[DB 管理](../../packages/core/src/db.ts) の既定保存先は `~/.local/share/nod/nod.db` で、WAL、busy timeout、transaction によるマイグレーションがある。
アプリから同じ保存先・設定を使えば既存データを移さず共有できる、というのがソースからの推論である。
同時利用の全経路や新旧バイナリ間の互換性が確認できたわけではない。

[サーバー](../../packages/server/src/server.ts) は `127.0.0.1` 限定で、`port: 0` による空きポート起動に対応し、実際の URL を返す。
停止時はタイマーを解除して HTTP 接続と DB を閉じる。
[ui コマンド](../../packages/cli/src/commands/ui.ts) は SIGINT・SIGTERM を受けて停止するため、正常停止の材料がある。
ただしデスクトップ起動用の準備完了通知、バージョン通知、所有権通知は別途必要である。

### 現行のままでは不足する箇所

1. **既存サーバーの再利用**: [startUi](../../packages/cli/src/ui.ts) はポートが使用中なら `/api/workspaces` の配列と HTML で nod と推定する。DB パス、実行バイナリの版、起動主体は検証しない。デスクトップ版は専用の空きポートで所有する案、または明示的な handshake 後だけ接続する案を比較する。接続しただけの既存 `nod ui` をアプリ終了時に止めない。
2. **Web の参照先**: [API client](../../packages/web/src/api/client.ts) と [SSE 接続](../../packages/web/src/api/useServerEvents.ts) は `/api` の相対 URL を使う。Tauri 同梱 frontend と HTTP API を分けるなら URL 解決、CORS/CSP、SSE の認証方式を一緒に決める。組み込み EventSource は fetch と同じ任意ヘッダー設定を前提にできないため、選んだ認証方式を接続実装と照合する。
3. **API の入口**: [app](../../packages/server/src/app.ts) は POST・PUT・DELETE でローカル HTTP(S) origin と `Sec-Fetch-Site` を確認する。Tauri の独自 origin は現行許可条件と合わない可能性がある。一方、localhost の任意ポートを許可する現在の条件は、アプリ専用 API の呼出元識別にはならない。GET も `syncCycles` を通るため、書き込みメソッドだけを見て保護範囲を決めない。
4. **外部コマンド**: [Orca runner](../../packages/core/src/ops/orca.ts) は既定で `orca` を実行し、`ORCA_CLI_COMMAND` による変更も受ける。[共通 runner](../../packages/core/src/ops/pr-status.ts) は親の環境を継承し、cwd を明示しない。アプリの cwd と PATH を設計しないと Finder 起動時の連携維持を保証できない。
5. **認証設定**: gh の認証は gh 自身に任せる。[Jev client](../../packages/core/src/ops/jev-client.ts) は環境変数を優先し、未設定なら `~/.config/nod/env` を実行せず解析する。[Toggl client](../../packages/core/src/ops/toggl-client.ts) は `~/.config/nod/toggl.json` を既定とする。GUI 起動時にも同じ利用者の設定を使えることを確認する必要がある。秘密ファイルの内容は本調査では読んでいない。
6. **同梱ファイル**: [defaultWebDir](../../packages/cli/src/ui.ts) 自体が compile 後の仮想パスに注意し、`--web-dir` の明示を求めている。既存 build は Web 全体を自動同梱するものではない。Resources の絶対位置を解決して渡すなどの設計が必要になる。

## 終了・更新・版ずれで決めること

以下は資料の保証ではなく、初版要件から導いた設計上の条件である。

- サーバー所有者は PID の値だけでなく、保持した子プロセスハンドルや起動識別子で判断する。正常終了の猶予、タイムアウト時の強制停止、起動失敗時の後始末を定義する。アプリが異常終了したときの残存子プロセス対策は、正常終了処理とは別に検証する。
- ウィンドウの破棄と非表示のどちらを採るか、再表示時の画面状態を決める。閉窓後も Bun を稼働させ、明示終了で所有サーバーだけを停止する。
- CLI の独立利用を維持するには、配布済み `nod` と `.app` 同梱版の関係を決める。既存 CLI を独立配布し続ける案と、安定したランチャーから同梱 CLI を起動する案がある。後者でもアプリを起動せず CLI を実行できる必要がある。
- 現行 DB は新しい schema を旧版で開くと `SCHEMA_TOO_NEW` を返す。これは安全側の拒否であり、更新後に古い CLI を継続使用できる保証ではない。`.app` と CLI の版表示・互換性確認、バックアップ、戻せる範囲を仕様化する。同じ schema 番号でも API や動作の互換性は別問題である。
- データは従来の場所に保持する案が最も移行範囲を小さくする。保存先の変更を選ぶなら、DB だけでなく Documents・添付・設定・環境変数指定を含め、二重の正本を作らない移行規則が必要になる。

## 署名と実機試作で残る不確実性

Apple は Gatekeeper が開発者の識別や公証を確認すること、および未確認アプリの許可手順を案内している。
配布経路によって初回起動が変わるため、自分用でも `.app` のダウンロード・入れ替え・起動を一連で確認する。[Apple の案内](https://support.apple.com/en-us/102445)

Bun は JavaScript エンジンのための entitlements を案内している。
Tauri の外側の署名だけで sidecar の要件まで満たしたとは判断できない。
選んだ Bun 版、署名方式、hardened runtime の組合せで同梱実行ファイルが動くことを試作で確かめる。[Bun の署名手順](https://bun.sh/guides/runtime/codesign-macos-executable)

採用判断に必要な最小試作は次の4群に絞れる。

| 試作 | 判断できること |
| --- | --- |
| Release `.app` を Finder/Dock から起動し、閉窓・再表示・Cmd+Q・連打起動・サーバー異常終了を試す | 起動と所有権の設計、終了動作、復旧時の案内が実現できるか。dev モードだけでは判定しない。 |
| 既存 Web の主要操作、SSE、添付表示・アップロード、外部リンク、日本語入力を実機で試す | WKWebView と現在の画面の互換性、同梱方法と API 保護が両立するか。 |
| Finder 起動から Orca・gh・git・Jev・Toggl を実行する | PATH、cwd、既存認証の利用、権限ダイアログ、エラー表示が成立するか。外部操作はテスト用データと必要な許可の下で行う。 |
| テスト用 DB で CLI とアプリを併用し、旧版 `nod ui` 存在中の起動、`.app` 入れ替え、新旧 CLI、バックアップ復元を試す | データ共有、競合時の動作、版ずれの拒否、更新と復旧が仕様通りになるか。 |

Electron の比較調査が必要になるのは、必須の既存 UI が WKWebView で成立しない、Chromium 固有機能が避けられない、または Tauri と Bun の署名・起動管理を許容できる複雑さに収められないと判明した場合である。
これは代替検討を始める条件であり、Electron なら PATH、プロセス所有権、DB の版ずれが解消するという判断ではない。
現時点で Tauri 案を排除する一次資料上の必須条件違反は確認していないが、上記の実機試作は未実施である。
