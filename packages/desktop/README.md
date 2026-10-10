# @nod/desktop

nod の macOS 用デスクトップアプリ（Tauri v2）。内部で既存の `nod ui` を sidecar として起動し、Web 画面をウィンドウに表示する。
Apple Silicon（arm64）専用。ad-hoc 署名で、公証・自動更新・配布はしない。ビルドと配置は手元の Mac だけで行う。

- 受入条件・中止条件・旧配置の保持は、このアプリの切替時に定めた条件（nod の Issue の解決コメント）を正本とする。ここには要点を再掲している。
- 保存先は CLI と同じ（`~/.local/share/nod/`、`~/.config/nod/`）。アプリ用のデータ移行はない。
- CLI の実体は `nod.app/Contents/MacOS/nod`。`~/.local/bin/nod` のラッパーがそれを実行する。アプリが終了していても CLI は同じデータで動く。

## ビルドと検査

```sh
bun run desktop:build    # ルートで実行。packages/desktop/dist/nod.app を作る
bun run packages/desktop/scripts/verify-app.ts <nod.app のパス>   # 完成品の検査だけを単体で実行する
bun test packages/desktop/test                                    # ビルド・検査・配置のテスト
cd packages/desktop/src-tauri && cargo test                       # 起動・監督・孤児回収・ログのテスト
```

`desktop:build` は次を順に行う。

1. web のビルド（`bun run web:build`）。
2. CLI の compile（`bun build --compile --target=bun-darwin-arm64`）。これが sidecar になる。
3. Tauri のビルド（`.app` まで。ad-hoc 署名される）。
4. `Contents/Resources/build-info`（アプリ版・commit・dirty・ビルド日時・schema 版）の書き込み。
5. sidecar 自身へ entitlements（JIT 系の 3 種。`scripts/entitlements.plist`）を付けて署名し、続けて `.app` を `--deep` なしで再署名する。
6. 検査。署名の検証、sidecar の entitlements、arm64、build-info と同梱バイナリの版の一致、隔離データでの起動（`/api/workspaces` が 200）、DB の schema 版と build-info の一致。

検査に通ったものだけが `packages/desktop/dist/nod.app` に置かれる。通らなければ成果物は作られない。
`dist/`・`build/`・`src-tauri/target/`・`src-tauri/binaries/` は git 管理外。

版は `packages/desktop/package.json`、`src-tauri/tauri.conf.json`、`packages/cli/package.json` で一致させる（一致しないとビルドが中止される）。

## 導入（初回も更新も `desktop:deploy`）

```sh
bun run desktop:deploy    # ルートで実行する
```

### 前提

- 作業ツリーに未コミットの変更がない（build-info の commit を確定させるため。あれば中止する）。
- 手動の `nod ui` が動いていない（動いていれば、止めずに中止する。自分が起動していないプロセスは止めない）。
  端末で `ps -axo pid,ppid,command | grep 'nod ui'` を実行して確認し、自分で止める。
  アプリ自身の sidecar は親が `nod-desktop` で、`--port` と `--no-open` が付く。
- 本番の `~/.local/bin/nod` を書き換える。初回は、旧配置（`~/.local/share/nod-app`）と旧ラッパーを退避する。

### 流れ

1. 前提を確認する（上記）。
2. `desktop:build` を実行し、検査に通ること、成果物の build-info が HEAD と一致することを確認する。
3. 稼働中のアプリがあれば、通常の終了（AppleScript の quit）を依頼し、停止を待つ（上限 30 秒）。止まらなければ中止する。強制終了はしない。
4. 旧 `~/Applications/nod.app` を `~/.local/share/nod-app-archive/nod-<UTC 時刻>-<版>.app` へ退避し、新しい `.app` を置く（隔離属性が付かない `ditto --noqtn` で複製する）。
5. `~/.local/bin/nod` を、`.app` 内バイナリを実行するラッパーへ書き換える。内容が同じなら何もしない。旧ラッパーは `nod-wrapper-<UTC 時刻>` として退避先へ置く。
6. アプリを起動し、build-info の版、sidecar の `/api/workspaces` が 200 であること、`nod --version`（ラッパー経由）が一致することを確認して表示する。
7. 成功したら、初回のみ旧配置 `~/.local/share/nod-app` を退避先へ移す（データ・DB は動かさない）。退避した `.app` は最新 3 件を残し、古いものを消す。

DB の migration 前バックアップは、アプリ（sidecar）が DB を開くときに core が自動で取る。deploy は DB を操作しない。

### 環境変数と引数による差し替え

配置先・ラッパー・退避先などは、引数か環境変数で差し替えられる（隔離したディレクトリでの通しの試験に使う）。引数が優先される。

| 引数 | 環境変数 | 既定 |
|------|----------|------|
| `--applications-dir` | `NOD_DEPLOY_APPLICATIONS_DIR` | `~/Applications` |
| `--wrapper` | `NOD_DEPLOY_WRAPPER` | `~/.local/bin/nod` |
| `--archive-dir` | `NOD_DEPLOY_ARCHIVE_DIR` | `~/.local/share/nod-app-archive` |
| `--legacy-dir` | `NOD_DEPLOY_LEGACY_DIR` | `~/.local/share/nod-app` |
| `--app-src` | `NOD_DEPLOY_APP_SRC` | `packages/desktop/dist/nod.app` |
| `--build-command` | `NOD_DEPLOY_BUILD_CMD` | `bun run desktop:build` |
| `--db` | `NOD_DB` | `~/.local/share/nod/nod.db`（`backups/` の増加の確認に使う） |
| `--quit-timeout-ms` | `NOD_DEPLOY_QUIT_TIMEOUT_MS` | 30000 |
| `--launch-timeout-ms` | `NOD_DEPLOY_LAUNCH_TIMEOUT_MS` | 30000 |
| `--keep` | `NOD_DEPLOY_KEEP` | 3 |

例（本番を触らない通し）:

```sh
NOD_DB=/tmp/x/nod.db NOD_DEPLOY_APPLICATIONS_DIR=/tmp/x/Applications NOD_DEPLOY_WRAPPER=/tmp/x/bin/nod \
NOD_DEPLOY_ARCHIVE_DIR=/tmp/x/archive NOD_DEPLOY_LEGACY_DIR=/tmp/x/legacy bun run desktop:deploy
```

アプリは起動時に環境変数 `NOD_DB`・`NOD_DOCS_DIR`・`NOD_ATTACHMENTS_DIR`・`NOD_TOGGL_CONFIG` を sidecar へ引き継ぐ（ログインシェルの環境経由）。
ログの場所は `NOD_DESKTOP_LOG_DIR` で変えられる。

### 失敗時の挙動

| 失敗した段階 | 結果 |
|--------------|------|
| 前提（未コミット・手動 `nod ui` が稼働中） | 何もせず中止 |
| ビルド・検査 | 何も入れ替えず中止 |
| アプリが終了しない | 強制終了せず中止。自分で終了して再実行する |
| 入れ替え中のエラー | 退避した旧 `.app` とラッパーを元へ戻して中止 |
| 起動の確認に失敗し、この実行で migration（`backups/` の増加）が走っていない | 旧 `.app` とラッパーへ自動で戻す |
| 起動の確認に失敗し、migration が走った | 自動では戻さない（旧版では DB を開けない可能性がある）。「手動の切り戻し」を行う |

## 利用時の更新（Finder での入れ替え）

`desktop:deploy` を使えないときの手動の代替手順。端末は必須ではない。ラッパー（`~/.local/bin/nod`）は更新で書き換えない。

1. アプリを Cmd+Q で終了する（ウィンドウを閉じるだけでは終了しない）。
2. 手動の `nod ui` が動いていれば止める（migration を伴う更新では必須。旧版と新版が同じ DB を開かないようにするため）。
3. Finder で `~/Applications/nod.app` を別の場所（例: `~/.local/share/nod-app-archive/`）へ退避する。名前に版か日時を付ける。
4. 新しい `nod.app` を `~/Applications` へ置く。
5. 起動して、「nod について」の版と、既存の Issue が見えることを確認する。

注意:

- 隔離属性（`com.apple.quarantine`）が付いた `.app` は Gatekeeper に止められ、起動できない。ダウンロード・AirDrop・メッセージ経由の `.app` は使わず、同じ Mac 内のコピーだけで入れ替える。
  付いてしまった場合は `xattr -dr com.apple.quarantine <nod.app>` で外せる。
- ad-hoc 署名のため、内容が変わるたびに macOS の許可が失効する。入れ替え後、保護フォルダ（`~/Documents`・`~/Desktop`・`~/Downloads`）配下の Document を最初に開いたとき、許可を再度求められうる（試作で `~/Documents` について実測）。
  iCloud（Obsidian）配下は試作で許可ダイアログが出なかった。DB の Document に保護フォルダ配下のものは現状 0 件。
- 初回・更新直後の一度の許可ダイアログは想定内。通常起動のたびに許可や端末での介入が要る場合は、中止条件に当たる。

## 手動の切り戻し（異常系）

保証は DB のバックアップ時点への復元まで。Document（Markdown ファイル）・添付・設定（`~/.config/nod/`）は戻らない。復元のコマンドや画面はない。

1. アプリを終了する（Cmd+Q）。手動の `nod ui` も止める。
2. 退避した旧 `.app` を `~/Applications/nod.app` へ戻す（今の `nod.app` は別名で残す）。旧配置・旧ラッパーへ戻す場合は退避先 `~/.local/share/nod-app-archive/` の `nod-app-<UTC 時刻>` と `nod-wrapper-<UTC 時刻>` を元の場所へ戻す。
3. 旧版で起動する。DB を開けない場合（`SCHEMA_TOO_NEW`。新しい版が DB の schema を進めた後）だけ、次へ進む。
4. `~/.local/share/nod/backups/` から、戻したい世代（`nod-<UTC 時刻>-<連番>-v<元の schema 版>.db`。最新 5 世代）を選び、`~/.local/share/nod/nod.db` へ置き換える。
   置き換える前に、現在の `nod.db`・`nod.db-wal`・`nod.db-shm` を別の場所へ退避する。
5. `nod.db-wal` と `nod.db-shm` を削除する（古い WAL が復元した DB に適用されるのを防ぐ）。
6. 旧版を起動し、`nod issue list` などで内容を確認する。

初版の `.app` は schema 版を上げる migration を同梱しない（現行 main の 39 のまま）。そのため、旧ラッパーへ戻すだけで復帰できる想定。schema を上げる版を入れた後は、旧版へ戻すときに 4〜5 が必要になる。

## 中止条件

次のいずれかを検知したら、切替を取りやめ、手動運用（`nod ui`）を続ける。

- 保存内容の欠落・破損、保存成功の誤表示、意図しない本番の更新。
- migrate 前バックアップの失敗、または手動復元の失敗。
- 別プロセスの誤停止、手動 UI の巻き添え、再起動の上限超過、通常終了後の sidecar 残留、次回起動時の孤児回収の失敗。
- Finder 起動、主要操作、必須の外部連携が再現性をもって使えない。
- 更新後に起動できない、または通常起動のたびに許可の要求・端末での介入が要る。

中止しない: 表示崩れ・フォーカス・ウィンドウ位置、単発の外部サービス障害、データを失わず復帰できる単発のクラッシュ、初回・更新直後の一度の許可ダイアログ（同じ現象が通常操作で繰り返されるなら中止側）。

**中止条件を検知したら、直ちに DB を上書き復元しない。** 書き込みを止め（アプリと手動 `nod ui` を終了する）、現状（`nod.db`・`-wal`・`-shm`・`documents/`・`attachments/`・ログ）を退避してから、復元時点以降の損失を確認する。

## 旧配置の保持

旧 `~/.local/share/nod-app` と旧ラッパーは、次をすべて満たすまで削除しない。

- 切替から 14 日以上経っている（14 日は運用上の提案値）。
- 入れ替え更新を実機で 1 回通している。
- その間に、中止条件に当たる不具合がない。

`desktop:deploy` は旧配置を `~/.local/share/nod-app-archive/nod-app-<UTC 時刻>` へ退避する（消さない）。退避した旧 `.app` は最新 3 件だけを残す。

## ログと診断情報

- ログ: `~/Library/Logs/io.github.machamp0714.nod/nod.log`（1 ファイル最大 2 MiB、`nod.log.1`〜 で最大 5 ファイル）。
  時刻、アプリ版、起動単位の識別子、処理段階、環境取得の成否と所要時間、sidecar の PID・ポート・終了コード、SIGTERM/SIGKILL などを記録する。環境変数の一覧・トークン・Issue や Document の本文は記録しない。
- 孤児回収の記録: 同じディレクトリの `sidecar.pid`（PID・開始時刻・実行パス）。アプリが終了すれば消える。
- 画面から: メニューの「ヘルプ」>「ログを開く」「診断情報をコピー」。起動に失敗したときの画面にも同じボタンがある（「再試行」「終了」も）。
- 診断情報の内容: アプリ版と commit、起動単位、状態、失敗した段階と原因の分類・要約、sidecar の終了コード・PID・ポート、OS、ログの場所。
- ウィンドウの位置とサイズは `~/Library/Application Support/io.github.machamp0714.nod/window-state.json` に保存される（`NOD_DESKTOP_LOG_DIR` では変わらない）。

## 版の確認

```sh
nod --version                       # ラッパー経由。.app 内の sidecar の版
cat ~/Applications/nod.app/Contents/Resources/build-info   # 版・commit・dirty・ビルド日時・schema 版（JSON）
```

アプリでは、メニュー「nod」>「nod について」に同じ版（と commit）が出る。`nod --version` と build-info の version は一致する（ビルドの検査項目）。

## 動作の要点

- ウィンドウを閉じる（赤いボタン、Cmd+W）と非表示になるだけで、アプリと sidecar は存続する。Dock のクリックで再表示する。Cmd+Q で終了し、sidecar も止まる（SIGTERM、3 秒待って残れば SIGKILL）。
- 二重に起動しても、既存のウィンドウが前面に出るだけ。
- sidecar は 4700 が空いていれば 4700、使用中（手動の `nod ui` など）なら空きポートを使う。
- sidecar が異常終了したときは、1・2・4 秒の間隔で最大 3 回まで自動で再起動する。上限を超えると失敗画面を出す。「再試行」で数え直す。
- Finder から起動しても `gh`・`git`・`orca` を使えるよう、ログインシェル（`$SHELL -ilc`）の環境を取得して sidecar へ渡す（上限 5 秒。失敗時は sidecar を起動せず失敗画面）。sidecar の cwd は `$HOME`。
- 外部リンクは既定のブラウザで開く。ウィンドウは自分の sidecar の origin 以外へ遷移しない。
- メニュー「表示」>「再読み込み」（Cmd+R）は現在のページだけを読み直し、sidecar は再起動しない。「ブラウザで開く」（Cmd+Shift+O）は現在の URL を既定ブラウザで開く。開発者ツールは Cmd+Option+I。
