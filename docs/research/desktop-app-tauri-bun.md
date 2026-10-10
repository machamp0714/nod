# Tauri + Bun 実行ファイル案の成立条件（NOD-9 調査報告）

調査日: 2026-10-10。調査のみで採用判断は行わない（NOD-10 で決める）。

凡例: **【コード】** リポジトリのソースで確認 / **【公式】** 公式ドキュメント・公式ソースで確認 / **【Issue】** Issue・フォーラム・第三者記事 / **【推測】** 推測 / **【未確認】**。
リポジトリ側の事実は調査担当が file:line を挙げ、主要 4 点（web 非同梱、127.0.0.1 固定、Origin 検査、orca の PATH 解決）は本文書の作成者がソースで再確認した。それ以外の file:line と、外部資料の記述は調査担当の報告に基づく。

## 結論（要約）

- 構成（Tauri の殻 + Bun compile の `nod` を sidecar として起動 + 既存 Web を表示）は、部品ごとには成立する見込みが高い。ただし**実機で未検証の論点が 4 つ**あり、いずれも試作で確かめる必要がある。
- 現状のコードに**そのままでは足りない点が 4 つ**ある（web 同梱、PATH、保存先と環境変数の共有、終了処理）。
- 代替の Electron が必要になる条件は、下の「試作 1・2」が不成立の場合に限られる。現時点で Tauri が不成立とは言えない。

## A. 現状のコードの事実

| 項目 | 事実 | 根拠 |
| --- | --- | --- |
| ビルド | `bun build packages/cli/src/main.ts --compile --outfile dist/nod` の 1 コマンド | 【コード】package.json:10 |
| web は同梱されない | `defaultWebDir()` は `import.meta.dir/../../web/dist`。compile 版では `--web-dir` が必要。README も「web を含まない」と記載 | 【コード】packages/cli/src/ui.ts:7-10、README.md:105 |
| サーバーは CLI と同一プロセス | `nod ui` が `@nod/server` を import して `Bun.serve` | 【コード】ui.ts:56-60、server.ts:55 |
| listen | `127.0.0.1` 固定、既定 4700、`--port 0` で空きポート | 【コード】server.ts:6-7,39 |
| 起動済み判定 | ポート使用中なら `/api/workspaces` と `/` を見て nod ui 稼働中なら再利用 | 【コード】ui.ts:25-35,61-72 |
| 認証 | なし。書き込み系（POST/PUT/DELETE）のみ Origin 検査。許可は `http:`/`https:` かつ localhost・127.0.0.1・[::1] | 【コード】packages/server/src/app.ts:62-80 |
| CLI | サーバーを介さず直接 SQLite を開く。サーバーと CLI は同じ DB ファイルを別プロセスで共有 | 【コード】packages/cli/src/context.ts:20-26 |
| 保存先 | DB `~/.local/share/nod/nod.db`、Documents・添付も同配下。環境変数 `NOD_DB` / `NOD_DOCS_DIR` / `NOD_ATTACHMENTS_DIR` で上書き | 【コード】core/src/db.ts:10-12、ops/documents.ts:193-195、ops/attachments.ts:56-58 |
| 設定 | `~/.config/nod/toggl.json`、`~/.config/nod/env`（Jev キー。環境変数優先） | 【コード】ops/toggl-client.ts:69-71、ops/jev-client.ts:5-10 |
| 外部コマンド | gh・git・orca は都度起動の短命プロセスで、PATH から解決（cwd は継承）。`ORCA_CLI_COMMAND` で orca のみ差し替え可 | 【コード】ops/pr-status.ts:82-131、ops/orca.ts:19-33 |
| 終了処理 | `nod ui` は SIGINT/SIGTERM で `server.stop()` と DB close。PID ファイルなし | 【コード】commands/ui.ts:22-24,40-41、server.ts:76-80 |
| 設計書の記述 | 「将来デスクトップアプリにするときは、この実行ファイルを Tauri から起動し、web を画面として包む」の 1 箇所のみ。コード・設定は存在しない | 【コード】docs/superpowers/specs/2026-09-27-nod-design.md:77-78（git 管理外のローカル文書） |
| .bun-build | リポジトリ内に言及なし。作業ツリー直下に `.bun-build` 一時ファイルが 2 つ残っている | 【コード】grep、git status |

## B. 初版要件ごとの成立条件

### B1. 専用ウィンドウで既存 Web を表示する
- Tauri は `WebviewUrl::External("http://127.0.0.1:PORT")` で外部 URL を表示できる。【公式】https://v2.tauri.app/plugin/localhost/ （同ページは外部 localhost 配信を「considerable security risks」とし、既定のカスタムプロトコルを勧めている）
- 現状と同じく 127.0.0.1 を直接ロードする構成なら、Origin 検査は通る見込み。Tauri 既定のカスタムプロトコル（`tauri://localhost` 等）で配信すると Origin 検査で拒否される可能性がある。【推測】
- IPC を使わなければ capability は不要。外部 URL に IPC を許す場合は `remote.urls` が必要。【公式】https://v2.tauri.app/security/capabilities/
- **未検証: WKWebView が `http://127.0.0.1` を ATS で許可するか。** フォーラムに -1202 エラーや `NSAllowsLocalNetworking` が効かなかった報告がある（確定した解決策は不明）。必要なら `NSAppTransportSecurity` を Info.plist に足す。【Issue】https://developer.apple.com/forums/thread/6205 、https://developer.apple.com/forums/thread/820730

### B2. ウィンドウを閉じても存続し、明示終了で停止する
- `RunEvent::ExitRequested`（`code` が None ならユーザー操作）で `prevent_exit()`、`WindowEvent::CloseRequested` で `prevent_close()` + `hide()`、macOS 限定の `RunEvent::Reopen` で再表示、という部品は公式ソースにある。【公式】https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-runtime/src/lib.rs 、https://docs.rs/tauri/latest/tauri/enum.RunEvent.html
- 3 つを組み合わせた公式サンプルは確認できていない。【未確認】
- **設計上の注意**: Cmd+Q も `ExitRequested`（code=None）として来る可能性があり、そのまま `prevent_exit` すると終了できなくなる。「終了」の明示経路（メニュー項目等から `app.exit(0)`）を別に設ける必要がある。【推測】

### B3. 明示終了時に内部サーバーを確実に止める
- plugin-shell は `RunEvent::Exit` で管理中の子プロセスを kill する。【公式】https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/lib.rs
- 通常終了（Cmd+Q・メニューの終了）では停止する見込み。【推測、実機未確認】
- **SIGKILL・クラッシュ・`kill -9` では Exit が走らず、sidecar が孤児化する可能性が高い。** Tauri は sidecar を監視しない。対策案は、(a) sidecar 側で親 PID を監視して自己終了、(b) 起動時に古いプロセスを検出（現行の `isNodUi` 判定が使える）。いずれも【推測】で、設計は NOD-11 の範囲。
- `nod ui` は SIGTERM で正常停止するので、graceful 停止の受け口は既にある。【コード】

### B4. Web の同梱
- 現状 web は実行ファイルに入らない。選択肢は次のとおり（採否は NOD-10）。
  1. `.app` の `Contents/Resources` に web/dist を置き、`--web-dir` で渡す。resources の配置は公式。【公式】https://v2.tauri.app/distribute/macos-application-bundle/
  2. Bun の埋め込み（`with { type: "file" }`、`--asset`）で実行ファイルに入れる。ただし現行の静的配信は `Bun.file` + ディスクパス前提のため改修が要る。【公式】https://bun.com/docs/bundler/executables 【コード】packages/server/src/static.ts:30-49

### B5. CLI の独立利用
- CLI は DB を直接開くので、アプリ終了中も動く。【コード】
- sidecar として同梱する `nod` と、LLM が PATH で使う `nod` が同一バイナリか別かは未決（NOD-12・NOD-14）。.app 内に入れた場合、CLI 用に PATH 上へどう出すかが論点。【推測】

### B6. Orca など外部コマンド連携
- Finder/Dock 起動の GUI アプリは launchd 由来の短い PATH になり、Homebrew 等の `gh`・`git`・`orca` が見つからない可能性が高い。【Issue】https://flaviocopes.com/macos-app-command-line-tools-path 【推測】
- 対策案: `fix-path-env-rs`（tauri-apps 製、git 依存）、またはログインシェルから PATH を取得して sidecar に渡す。【公式（README）】https://github.com/tauri-apps/fix-path-env-rs 【推測】
- 差し替え用の環境変数は orca（`ORCA_CLI_COMMAND`）しかなく、git は `"git"` 固定、gh は `NOD_GH`（テスト用）のみ。【コード】
- 現行の orca 連携は CLI 側の `orca worktree set --worktree active` が親ターミナルの環境に依存する可能性がある。GUI 起動のサーバー経由でどこまで同じに動くかは未確認。【推測】

### B7. .app の入れ替え更新・署名
- bundler は sidecar を `Contents/MacOS` に triple なしの名前で置き、sidecar を先に署名して最後に .app を署名する。【公式（ソース）】https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/macos/app.rs
- Bun は v1.2.4 以降で codesign に対応。推奨 entitlements は allow-jit、allow-unsigned-executable-memory、disable-executable-page-protection、allow-dyld-environment-variables、disable-library-validation。【公式】https://bun.com/docs/guides/runtime/codesign-macos-executable
- 過去に「main executable failed strict validation」で署名できない Issue があり、修正版は特定できていない。【Issue】https://github.com/oven-sh/bun/issues/7208
- Apple Silicon では署名のない arm64 実行ファイルは SIGKILL される。ad-hoc 署名（`signingIdentity: "-"`）で足りる。【Issue】https://developer.apple.com/forums/thread/673057 【公式】https://v2.tauri.app/distribute/sign/macos/
- 自分の Mac でビルドしたものには quarantine 属性が付かず Gatekeeper の初回チェックは通らない見込み。他の Mac への配布は対象外。【Issue】https://eclecticlight.co/2019/04/25/ 【推測】
- ビルド順は「bun compile → Tauri bundle」にする（署名後の書き換えは署名を壊す）。【推測】

## C. 未検証事項と、判断に必要な試作

| # | 未検証 | 試作（最小） | 不成立なら |
| --- | --- | --- | --- |
| 1 | bun compile 成果物を externalBin に入れ、ad-hoc 署名の .app として起動できるか | Tauri 空アプリ + `dist/nod` を externalBin に同梱して bundle・起動 | Electron 案、または sidecar を .app 外に置く案 |
| 2 | WKWebView が `http://127.0.0.1:<port>` を ATS で表示できるか。Origin 検査を通るか | 試作 1 に `nod ui --no-open --port 0` を起動して表示し、書き込み操作を 1 つ行う | Info.plist の ATS 設定、または Electron 案 |
| 3 | 閉じる→存続→Dock で再表示→明示終了の一連が組めるか。Cmd+Q の扱い | `prevent_close`+`hide`、`Reopen`、`ExitRequested` の組み合わせ | 終了経路の設計変更（NOD-11 へ） |
| 4 | 通常終了で sidecar が止まるか。`kill -9` 時の孤児と復旧 | 終了操作・`kill -9` 後に `ps`/ポートを確認 | 親 PID 監視の追加 |
| 5 | Finder 起動時の PATH で gh/git/orca が見つかるか | .app を Finder から起動し、Orca 連携と gh を実行 | PATH 補完の導入（NOD-13 へ） |

試作 1・2 が不成立の場合のみ、Electron を代替として評価する必要がある。Electron は `window-all-closed` の購読で存続でき、`activate` で再表示、`before-quit` で終了を制御できる。【公式】https://www.electronjs.org/docs/latest/api/app
Electron はサイズが大きくなる見込みで、sidecar の署名・PATH の論点は共通。【推測】

## D. 未確認の補足
- bun compile 実行ファイルの実サイズ。調査では `dist/nod` が約 60MB だった（ls による）。
- `.app` 内での triple 除去ロジックの詳細。
- Tauri v2 の WebView の Origin 値（`tauri://localhost` 等）の確定。
