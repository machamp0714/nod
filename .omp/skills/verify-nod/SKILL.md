---
name: verify-nod
description: "nod（このリポジトリの Issue 管理。Web が主、CLI が従）を作業ツリーのソースから隔離して起動し、状態確認、Web（ヘッドレスの Chromium）と CLI での操作、証拠の保存、後始末をする手順と補助スクリプト、機能の一覧。変更や指摘を実物の nod で確かめたいとき、検証用の nod を起動・操作・片付けたいときに使う。利用者の nod（ポート 4700、~/.local/share/nod）と外部サービスには触れない。"
---

# verify-nod

作業ツリーのソースの nod を、実行（run）ごとに作業ツリーの外に作る置き場と、空いているポートで起動する。Web はその run の中でビルドしたものを `nod ui` で配信し、CLI は同じデータを指してソースを bun で実行する。インストール済みのデスクトップアプリ（`~/Applications/nod.app`）と PATH の `nod` は使わない（PATH の `nod` は利用者の DB に書く）。

コマンドはすべて、リポジトリ（作業ツリー）のルートを cwd にして実行する。前提は `bun install` 済みであることと、Playwright の Chromium（`~/Library/Caches/ms-playwright` の `chromium_headless_shell-1243`）が導入済みであること。補助スクリプトは `.omp/skills/verify-nod/scripts/verify-nod.ts` の1本で、サブコマンドで使い分ける（「Helpers」）。

流れは「Launch → Doctor → Drive（機能の一覧の手順で CLI と Web を操作する）→ Evidence の確認 → Cleanup」。機能ごとの到達の仕方・操作の仕方・動いたと言える状態は、機能の一覧 [`features/README.md`](features/README.md) とそこから案内する機能のファイルにある。操作の前に索引を読む。このスキルで確かめられない範囲（外部サービスの成功の経路、デスクトップアプリ固有の機能）も、索引の「確かめられない範囲」にある。

## 守ること

- 利用者は普段の作業で nod をポート 4700 で動かしている。4700 に接続しない（GET も含む）、4700 のプロセスを止めない、利用者のデータ（`~/.local/share/nod`、`~/.config/nod`、`~/Applications/nod.app`）を読み書きしない。補助スクリプトは、4700 の指定と、置き場の根を作業ツリーや利用者のデータの中に置くことを拒む。
- PATH の `nod` を検証に使わない。CLI は `verify-nod.ts cli` から使う。`nod ui` は `cli` からも `browser` の `cli` の手順からも実行できない（ポートを省くと既定の 4700 に接続・待ち受けし、ブラウザを開くため。検証の `nod ui` は `launch` が起動する）。
- プロセスを名前で止めない（`pkill`・`killall` を使わない）。止めるのは `verify-nod.ts cleanup` だけで、自分が起動した PID だけを止める。
- 別の run の置き場・ポートを混ぜない。操作の前に、その run の `doctor` を通す（`browser` は自分で `doctor` を通し、通らなければ操作しない）。
- ブラウザは補助スクリプトの `browser` だけで使い、毎回新しいコンテキストで開く（利用者のブラウザ・プロファイルは使わない）。その run の origin（`http://127.0.0.1:<ポート>`）以外への要求はブラウザ側で止まる（「Drive」）。
- デスクトップアプリ（`packages/desktop`）とそのビルド・導入・検査のスクリプトは実行しない。固有の機能の確かめ方は [`features/desktop.md`](features/desktop.md) が既存の受入記録へ案内する。Web での成功をデスクトップでの成功として報告しない。

## 隔離のしかた

### 置き場

置き場の根は環境変数 `VERIFY_NOD_ROOT`（絶対パス）で変えられる。既定は `~/.local/state/verify-nod`。根が作業ツリー、`~/.local/share/nod`、`~/.config/nod`、`~/Applications/nod.app` の中にあると、補助スクリプトは失敗する。

`launch` は根の下に run の ID（`YYYYMMDD-HHMMSS-<16進5桁>`）の名前でディレクトリを作る（既にあれば失敗する）。中身は次のとおり。

| パス（run の中） | 中身 | 後始末 |
| --- | --- | --- |
| `data/nod.db`、`data/documents/`、`data/attachments/` | DB・Document・添付（`NOD_DB`・`NOD_DOCS_DIR`・`NOD_ATTACHMENTS_DIR`） | 消す |
| `home/`、`tmp/` | 検証の nod の `HOME`・`TMPDIR`。`tmp/` には `browser` のブラウザの一時的なプロファイル（`playwright_chromiumdev_profile-*`）も作られる | 消す |
| `config/` | `toggl.json`（`NOD_TOGGL_CONFIG` の指す先。作らない＝トークンなし）、`gh-unavailable`（`NOD_GH` の指す先。作らない）、`vite-env/`（空。web のビルドの `NOD_VITE_ENV_DIR`） | 消す |
| `repo/` | Workspace として登録する空の git リポジトリ | 消す |
| `bin/` | 検証の nod の `PATH`。`git`（`/usr/bin/git` へのシンボリックリンク）だけを置く | 消す |
| `web/` | この run でビルドした web（`vite build --outDir`） | 消す |
| `logs/` | `web-build.log`、`init.log`、`ui.stdout.log`（`nod ui --json` の出力）、`ui.stderr.log` | 消す |
| `state.json` | 状態ファイル（runId、launch した作業ツリー、Workspace、PID、URL、ポート、dbPath、起動した argv） | 消す |
| `evidence/` | 証拠。`launch.json`（起動時の状態と状態確認の結果）、`cleanup.json`（後始末の記録）、`<機能の ID>/`（`cli --evidence` と `browser` の記録。「Evidence」） | **残す** |

Workspace は run ごとに1つ、キー `V<16進5桁を大文字>`・名前 `verify-nod-<runId>`・パス `<run>/repo` で登録する。キーは run の ID の末尾と同じ文字で、状態確認の照合に使う。

### ポート

`nod ui --port 0` で起動し、OS が空いているポートを選ぶ。補助スクリプトはポートを指定させない。起動したポートが 4700 なら起動を失敗にし、`doctor --port 4700` は接続せずに拒む。

### 環境変数（許可リスト）

検証の nod（server と CLI）には、親の環境を引き継がず、次の11項目だけを渡す（`nodEnv()`）。bun はすべて `process.execPath` の絶対パスに `--no-env-file` を付けて呼ぶ（`.env` を読まない）。

| 変数 | 値 | 何を止めるか |
| --- | --- | --- |
| `PATH` | `<run>/bin`（`git` だけ） | nod が名前で実行するコマンドのうち、`git` だけが見つかる。server は固定の名前の `gh` を実行するが見つからない（このマシンの `gh` は `/opt/homebrew/bin` と `/usr/local/bin`）。`nod ui` がブラウザを開く `open`（`/usr/bin/open`）も見つからない |
| `HOME`、`TMPDIR` | `<run>/home`、`<run>/tmp` | `~/.config/nod/env` などホームの下の既定の場所を読まない |
| `NOD_DB`、`NOD_DOCS_DIR`、`NOD_ATTACHMENTS_DIR` | `<run>/data/...` | 利用者の DB・Document・添付 |
| `NOD_TOGGL_CONFIG` | `<run>/config/toggl.json`（無いファイル） | Toggl（トークンが無いので未設定の扱い） |
| `NOD_GH` | `<run>/config/gh-unavailable`（無い絶対パス） | CLI からの GitHub |
| `NOD_ORCA` | `0` | Orca |
| `TYPESAFE_API_KEY` | 空文字 | 仕様要否判定（Typesafe API）。未設定だと `~/.config/nod/env` を読むので、空文字を明示する |
| `NOD_ACTOR` | `verify-nod`（`cli --actor` で変えられる） | 書き手を親のエージェント環境から判定させない |

親の環境にある `CODEX_HOME`・`CODEX_THREAD_ID`・`ORCA_*`・`NOD_WORKTREE`・`NOD_BRANCH`・`OMPCODE`・`CLAUDECODE`・API キー類は渡らない。web のビルドと `git init` には `PATH`・`HOME`・`TMPDIR`・`NOD_VITE_ENV_DIR`（空のディレクトリ）だけを渡す。

外部サービスに依る機能（仕様要否判定、GitHub の PR 状態、Toggl、Orca）は、この隔離では成功の経路に到達できない。未設定・無効のときの表示の確かめ方と、成功の経路に要るものは [`features/external-services.md`](features/external-services.md) にある。

## Launch

```sh
./.omp/skills/verify-nod/scripts/verify-nod.ts launch
```

空の置き場から次の順に進める（2026-11-25 の実測で全体が約2秒）。

1. 根の下に run のディレクトリと上の表のディレクトリを作り、`state.json` を書く。
2. `packages/web` で `bun --no-env-file packages/web/node_modules/vite/bin/vite.js build --outDir <run>/web --emptyOutDir` を実行する（ログは `logs/web-build.log`。チャンクの大きさの警告が出るが成功）。
3. `<run>/repo` を `git init` し、そこでソースの CLI の `--json init --key V… --name verify-nod-<runId>` を実行する（マイグレーションもここで済む）。
4. `bun --no-env-file packages/cli/src/main.ts --json ui --port 0 --no-open --web-dir <run>/web` を別のプロセスグループで起動する。補助スクリプトが終わっても server は動き続ける。stdout は `logs/ui.stdout.log` に出る。
5. `nod ui` の出力が `reused=false` で、`dbPath` が `<run>/data/nod.db` であることを確かめ、PID・URL・ポートを `state.json` に書く。
6. 「Doctor」の確認をすべて行い、結果を `evidence/launch.json` に書く。

**使える状態（ready）**: `launch` が終了コード 0 で、標準出力の JSON が `"ok": true` のとき。このとき Workspace が1つ登録済みで、`/api/workspaces` が 200 でそれを返し、`/` がこの run でビルドした `index.html` を返している。出力の主な項目は次のとおりで、以降のコマンドには `runId`（または `runDir`）を渡す。

```json
{
  "ok": true,
  "runId": "20261125-213856-61d0d",
  "runDir": "/Users/<user>/.local/state/verify-nod/20261125-213856-61d0d",
  "url": "http://127.0.0.1:57471/",
  "port": 57471,
  "pid": 92469,
  "dbPath": ".../data/nod.db",
  "workspace": { "key": "V61D0D", "name": "verify-nod-20261125-213856-61d0d", "path": ".../repo" },
  "evidence": ".../evidence",
  "checks": [ ... ]
}
```

進み具合は標準エラーに `verify-nod: ...` で出る。`launch` が失敗したときは、起動した `nod ui` を補助スクリプトが自分で止め、標準エラーに理由とログの末尾を出して終了コード 1 で終わる。作業用のデータは残るので、ログを読んだら `cleanup <runDir>` を実行する。`launch` を途中で中断した（Ctrl+C など）ときも同じく `cleanup` する（web のビルド中に中断した run は、`state.json` の PID が空で、`doctor` は「launch が途中で失敗した」で失敗し、`cleanup` で `evidence/` だけが残ることを確かめた）。

止めるときは「Cleanup」を使う。

## Doctor

何かおかしいとき、操作の前、別のセッションから run を引き継いだときに、最初に実行する。読み取りだけで、何も書かない。

```sh
./.omp/skills/verify-nod/scripts/verify-nod.ts doctor <runId または runDir>
```

すべての確認が通れば終了コード 0、1つでも通らなければ終了コード 1 で、通らなかった確認を標準エラーに `NG <名前>: <理由>` で出す。標準出力は `{ ok, runDir, port, checks: [{ name, ok, detail }] }` の JSON。

| 確認 | 内容 |
| --- | --- |
| `state` | `state.json` があり、PID とポートが記録されている |
| `port-not-user` | 照合するポートが 4700 でない（4700 なら以降の接続をしない） |
| `pid-alive` | 状態ファイルの PID が動いている |
| `pid-command` | その PID のコマンドラインが、状態ファイルに記録した起動の argv（launch した作業ツリーのソースの CLI の `ui` で、この run の `web/` を指す）と一致する（`ps -ww -o command= -p <PID>`）。一致しないときは、そのコマンドラインを出力に載せない |
| `pid-env` | その PID の環境変数が、許可リストの11項目と完全に一致する（`ps eww -o command= -p <PID>`）。`pid-command` が通らないときは、そのプロセスの環境変数を読まずに失敗にする。一致しないときも、違う変数の名前だけを出し、値は出さない |
| `port-owner` | そのポートで LISTEN しているプロセスが、状態ファイルの PID だけ（`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`） |
| `ui-output` | `logs/ui.stdout.log` の `nod ui` の出力が `reused=false`、`dbPath` がこの run の DB、URL がこのポート |
| `db-workspace` | この run の DB を読み取り専用で開き、run の Workspace（キーとパス）が登録されている |
| `api-workspaces` | `/api/workspaces` が 200 で、返る Workspace の一覧（キー・名前・パス）がこの run の DB の一覧と一致する |
| `web-html` | `/` が 200 の `text/html` で、この run の `web/index.html` と同じ内容 |

ポートと DB の両方を照合するのは `port-owner` と `api-workspaces` である。`web-html` は同じソースからのビルドなら別の run でも一致するので、持ち主の確認には使わない。

`--port <番号>` を付けると、照合先のポートだけを変えて同じ確認をする。別の nod につながっていないかを確かめるのに使う。別の run のポートに向けると、`port-owner`（LISTEN している PID が違う）と `api-workspaces`（別の DB の Workspace が返る）が通らず、終了コード 1 になる（「同時起動」の実測）。`--port 4700` は接続せずに拒む。

```sh
./.omp/skills/verify-nod/scripts/verify-nod.ts doctor <runId> --port <別の run のポート>
```

`doctor` が通らないときは、その run を操作しない。`cleanup` してから `launch` し直す。

## Drive

操作は、機能の一覧 [`features/README.md`](features/README.md) の機能のファイルの手順で行う。面は2つで、どちらも補助スクリプトから使う。以下、`S=./.omp/skills/verify-nod/scripts/verify-nod.ts`、`R=<runId>` とする。

### CLI

```sh
$S cli $R --evidence <機能の ID> -- --json <nod の引数...>
```

その run と同じデータ・許可リストの環境で、ソースの CLI を実行する（「Helpers」）。`--evidence` を付けると、標準出力・標準エラーをそのまま出したうえで、`evidence/<機能の ID>/NNN-cli.json` に記録する（「Evidence」）。証明に使う CLI の呼び出しには必ず付ける。`--json` を付けると出力が JSON になり、`jq` で値を取り出せる（例: `ID=$($S cli $R --evidence issue-create -- --json issue create "タイトル" -d "本文" | jq -r .id)`）。nod の引数のどこかに `ui` がそのままあると（`ui`、`--json ui`、`-w <キー> ui`、`help ui`、タイトルが `ui` の `issue create` なども）、CLI を起動せずに理由を出して終了コード 1 で終わる。

### Web

```sh
$S browser $R --feature <機能の ID> <<'EOF'
[
  {"goto": "/issues"},
  {"expect": {"role": "button", "name": "New Issue", "exact": true}, "disabled": true},
  {"snapshot": "list"},
  {"screenshot": "list"}
]
EOF
```

手順の JSON の配列を標準入力（または `--steps <ファイル>`）で渡す。値をシェルの変数から入れるときは、区切りを引用しない（`<<EOF`）。1回の呼び出しで次を行う。

1. 手順の形をすべて確かめる（操作のキーが1つでない、使えないキーがある、パスが `/` で始まらない、などはブラウザを起動する前に終了コード 1）。
2. その run の `doctor` を通す。1つでも通らなければ `NG <名前>: <理由>` を出して終了コード 1 で、ブラウザを起動しない。
3. リポジトリの Playwright（`packages/web/node_modules/@playwright/test`、1.63）で、導入済みの Chromium（ヘッドレス。`chromium_headless_shell-1243`）を起動する。ブラウザの環境変数は `PATH=/usr/bin:/bin`・`HOME=<run>/home`・`TMPDIR=<run>/tmp` だけで、一時的なプロファイルは `<run>/tmp` に作られる。
4. 新しいコンテキスト（cookie・ストレージなし、viewport 1440×960、`ja-JP`、Service Worker なし）を作り、その run の origin（`http://127.0.0.1:<ポート>`）以外への要求（HTTP と WebSocket）をすべてブラウザ側で止める（`127.0.0.1:4700`・`localhost:4700`・外部も止まる）。止めた URL は記録の `blocked` に残る。
5. 操作の前に、止める仕組みが効いていることを自分の nod への別の origin（`http://localhost:<ポート>/api/workspaces`）で確かめる（記録の `blockCheck`）。止まらなければ操作しない。利用者の nod には要求を出さない。この確認のため、記録の `blocked` にこの URL が、`consoleErrors` に `Failed to load resource: net::ERR_BLOCKED_BY_CLIENT` が1つ必ず残る（アプリのエラーではない）。
6. 手順を順に実行する。1つでも失敗したら、そこで止め、そのときの画面の ARIA スナップショットとスクリーンショット（`…-failure`）を残して終了コード 1 で終わる。成功なら終了コード 0。どちらも標準出力に `{ ok, runId, feature, origin, log, artifacts, blockCheck, blocked, error }` の JSON を出し、ブラウザを閉じる。

ページの状態は呼び出しをまたいで残らない（毎回新しいコンテキストで、最初のページは `about:blank`）。続けて確かめる操作は1回の呼び出しの手順にまとめるか、次の呼び出しを `goto` から書く。待ち時間は、操作・待つ・確かめる手順ごとに既定 10 秒（`--timeout <ミリ秒>` で変える）。

**手順**（1つの手順に操作のキーを1つだけ書き、添えてよいキーだけを足す。どの手順にも説明用の `"note"` を書ける）:

| 操作 | 書き方 | すること |
| --- | --- | --- |
| `goto` | `{"goto": "/issues"}` | run の URL からの相対のパスを開く（別の origin は書けない）。記録に HTTP の状態コードが残る |
| `reload` | `{"reload": true}` | 再読み込みする |
| `url` | `{"url": "/issues/V1A2B3-1"}` | URL のパス（`?` があればクエリも）がそれになるまで待つ |
| `click` | `{"click": <ロケータ>}` | クリックする |
| `fill` | `{"fill": <ロケータ>, "value": "文字"}` | 入力欄を空にして入力する |
| `press` | `{"press": "Enter", "on": <ロケータ>}` | キーを押す（`on` を省くとページに送る） |
| `select` | `{"select": <ロケータ>, "value": "値"}` | `select` の選択肢を選ぶ |
| `check`・`uncheck` | `{"check": <ロケータ>}` | チェックボックス・ラジオを入れる・外す |
| `hover` | `{"hover": <ロケータ>}` | ポインタを重ねる |
| `drag` | `{"drag": <ロケータ>, "to": <ロケータ>}` | ドラッグして落とす（Board のカードを列へ、など） |
| `wait` | `{"wait": <ロケータ>, "state": "hidden"}` | 状態（`visible`（既定）・`hidden`・`attached`・`detached`）になるまで待つ |
| `expect` | `{"expect": <ロケータ>, "text": "…", "attr": {"data-value": "todo"}}` | 確かめる。既定は「1つだけ見えている」。`count`（件数。0 以上の整数）、`hidden: true`（見えない。`true` だけを書ける）、`text`（文字を含む。配列なら要素ごと）、`value`（入力値）、`attr`（属性の値）、`disabled`（`true` で無効・`false` で有効）を組み合わせ、書いたものはすべて検査する（`count` を書くと「見えている」の既定の検査は外れる）。必ず失敗する組み合わせは手順の形の検査で拒む: `count: 0` と `text`・`value`・`attr`・`disabled`、`count` が 2 以上と `hidden`・`value`・`attr`・`disabled`・文字列の `text`（1つの要素を確かめる検査なので複数に当たると失敗する。文字は `text` に要素ごとの配列で書く） |
| `read` | `{"read": <ロケータ>}` | 当たった要素の文字を記録の `read` に残す（CLI の出力と見比べる） |
| `snapshot` | `{"snapshot": "list", "of": <ロケータ>}` | ARIA スナップショットを残す（`of` を省くとページ全体） |
| `screenshot` | `{"screenshot": "list", "fullPage": false}` | スクリーンショットを残す（既定はページ全体。ただし nod の画面は中の領域でスクロールするので、写るのは viewport の高さ（960）まで。下のほうの内容は `snapshot` で残す） |
| `events` | `{"events": "ready"}` | Web の変更の通知（SSE）の接続の状態が `ready`（または `connecting`）になるまで待つ（Web が出す `<html data-server-events>`）。CLI の書き込みが再読み込みなしで出ることを確かめる前に通す |
| `cli` | `{"cli": ["--json", "issue", "create", "タイトル"], "actor": "me"}` | ページを開いたまま、`cli` サブコマンドと同じ（run のデータ・許可リストの環境・cwd は run の `repo`）ソースの CLI を実行し、`NNN-II-cli.json` に記録する。`actor` を省くと書き手は `verify-nod`。CLI の終了コードが 0 でなければ手順の失敗。引数に `ui` があると、手順の形の検査で拒む（ブラウザを起動しない） |

**ロケータ**は `{"role": "button", "name": "New Issue", "exact": true}` の形のオブジェクトで、Playwright の `getByRole` などに当たる。`role`（`name`・`exact`・`level` を添える）を第一に使い、無いときだけ `label`・`placeholder`・`text`・`testId` を使う。`within: <ロケータ>` で親の中に絞り、`hasText` で中の文字で絞り、`nth`（0 から）で何番目かを選ぶ。`name` は既定で部分一致（大文字小文字を区別しない）で、`"exact": true` で完全一致。複数に当たる要素を操作・`expect` すると失敗するので、`within` や `exact` で1つに絞る。role と name は `snapshot` の出力（例: `button "New Issue" [disabled]`）で確かめられ、`packages/web/e2e/*.e2e.ts` のセレクタも参考になる。

よく使うハンドル（2026-11-25 に確かめた）: サイドバーは `{"role": "navigation", "name": "メイン"}`、一覧の絞り込みのタブは `{"role": "tab", "name": "All 1", "within": {"role": "tablist", "name": "絞り込み"}}`、一覧の行は `{"role": "row", "name": "<ID>"}`、詳細の見出しは `{"role": "heading", "level": 1, "name": "<タイトル>"}`、詳細の欄は `{"role": "region", "name": "説明", "exact": true}`（ほかに `計画`・`Documents`・`Activity`・`未決事項`・`プロパティ` など）、プロパティの値は `{"role": "button", "name": "Status", "exact": true, "within": {"role": "region", "name": "プロパティ", "exact": true}}` の `data-value`。Board の列は `{"role": "region", "name": "In Progress", "exact": true}`、カードは `{"role": "article", "hasText": "<ID>"}`。ほかの画面のハンドルは機能のファイルにある。

## Evidence

証拠は run ごとの置き場の `evidence/` の下に置き、`cleanup` で消えない（後始末のあとは run のディレクトリに `evidence/` だけが残る）。機能ごとの証拠は `evidence/<機能の ID>/`（機能の ID は機能の一覧のファイル名。英小文字・数字・ハイフン）に、呼び出しごとの3桁の通し番号 `NNN` を付けて置く。番号は呼び出しの始めに `.NNN-claim` を排他で作って確保し、証拠を書いたら消す（補助スクリプトを強制終了したときは残り、その番号は使われない）。同じ機能の `cli --evidence`・`browser` を並行に呼んでも、呼び出しごとに別の番号になり、上書きされない（並行のときの番号の順は、呼び出した順と一致するとは限らない）。

| パス（`<run>/evidence/` の中） | 書くもの | 中身 |
| --- | --- | --- |
| `launch.json` | `launch` | 起動時の状態ファイル、`nod ui` の出力、状態確認の結果 |
| `cleanup.json` | `cleanup` | 後始末ごとに、止めた nod の PID、止めた残りのブラウザの PID、消したパス |
| `<機能の ID>/NNN-cli.json` | `cli --evidence` | run の ID・runDir・URL、書き手（`actor`）、cwd、コマンド（`["nod", ...]`）、終了コード、開始・終了の時刻、標準出力・標準エラー（JSON として読めれば `stdoutJson` にも） |
| `<機能の ID>/NNN-browser.json` | `browser` | run の ID・runDir・origin、`doctor` の結果、`blockCheck`、手順ごとの結果（手順・成否・かかった時間・その後の URL・HTTP の状態コード・`read` の文字・残したファイル・`cli` の記録・それまでの文書の読み込みの回数 `loads`・失敗の理由）、止めた要求（`blocked`）、コンソールのエラー、ページのエラー |
| `<機能の ID>/NNN-II-cli.json` | `browser` の `cli` | `NNN-cli.json` と同じ形（`II` は手順の番号） |
| `<機能の ID>/NNN-II-<名前>.aria.yml` | `browser` の `snapshot` | 先頭のコメントに run の ID・URL・時刻・機能と手順（`II` は手順の番号）、続けて ARIA スナップショット（YAML） |
| `<機能の ID>/NNN-II-<名前>.png` | `browser` の `screenshot` | 上の帯に run の ID と runDir・URL・時刻・機能と手順を書いたスクリーンショット。帯は別のコンテキストで描き、操作中のページは変えない |
| `<機能の ID>/NNN-II-failure.aria.yml`・`.png` | `browser` の失敗 | 失敗した手順のときの画面 |

**証明の基準:**

- 利用者の経路（CLI のコマンド、Web の画面の操作）を使う。テスト専用の口（`packages/web/e2e` の `nod.me.*` などの core の直接の呼び出し、DB への直接の書き込み、e2e 用の server）でデータを作ったり確かめたりしない。
- 操作と、その結果の状態の両方を残す。CLI はコマンド・標準出力・標準エラー・終了コード（`NNN-cli.json`）、Web は操作の記録（`NNN-browser.json`）と結果の画面の ARIA スナップショット・スクリーンショット。最後の画面だけでは証明にしない。
- 書き込みの副作用は、書いたのと別の読み取りの見方でも確かめる（CLI で書いたら Web の一覧・詳細、Web で書いたら CLI の `show` や再読み込み後の画面）。
- 画面が示す値と CLI の出力を突き合わせる（`expect` の `text`・`attr` と `read`、`jq` での比較）。
- 外部サービス（仕様要否判定、GitHub、Toggl、Orca）はこの隔離で切ってあるので、それらの成功の経路を確かめたと報告しない。到達できないことと、その前提を書く。未設定・無効の表示は確かめてよい。
- 到達できない入口は、試したコマンドと満たせなかった前提を添えて報告する。別の入口で確かめたことを、試していない入口の証明にしない。
- 報告には run の ID と証拠のパス（`<run>/evidence/<機能の ID>/`）を添える。

## Cleanup

```sh
./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup <runId または runDir>
```

1. `browser` のブラウザが残っていれば止める。対象は、コマンドラインの `--user-data-dir` がこの run の `tmp/` の下にあるプロセスだけ（`ps -ax -ww -o pid=,command=`）で、SIGTERM を送り、10秒で止まらなければ SIGKILL。通常は `browser` が終わるときにブラウザを閉じ、補助スクリプトが強制終了されてもブラウザは一緒に終わるので、ここで止めるものは無い（補助スクリプトを SIGSTOP で止めてブラウザを残した状態で、`cleanup` がそのブラウザだけを止めることを確かめた）。
2. `state.json` の PID が動いていれば、そのコマンドラインが状態ファイルに記録した起動の argv（launch した作業ツリーのソースの CLI の `ui` で、この run の `web/` を指す）と一致することを確かめてから SIGTERM を送り、止まるのを待つ（10秒で止まらなければ、もう一度確かめて SIGKILL）。別の作業ツリーから launch した run も、記録した argv と一致すれば止める（その run の `launch` が起動した server なので）。一致しなければ止めずに終了コード 1 で終わり、データも消さない（別の PID を記録した run で、その PID が止められず、データが残ることを確かめた）。そのプロセスのコマンドラインは出力に載せない。
3. 表で「消す」とした `data/`・`home/`・`tmp/`・`config/`・`repo/`・`bin/`・`web/`・`logs/`・`state.json` を消す。
4. `evidence/cleanup.json` に、止めた PID（nod と残りのブラウザ）と消したパスを追記する。

**証拠は `<run>/evidence/` に残る**（後始末のあと、run のディレクトリには `evidence/` だけがある）。何度実行してもよい。2回目以降は止めるものも消すものも無く、終了コード 0 で終わる。`VERIFY_NOD_ROOT` を変えて起動した run は、同じ `VERIFY_NOD_ROOT` を付けて runId で指定するか、runDir の絶対パスで指定する。根が launch のときと違うと、`<根>/<runId> がありません` で終了コード 1 になり、何も止めず何も消さない（`doctor`・`cli` も同じ）。シェルで `VERIFY_NOD_ROOT` を export したままにしていないかも確かめる。

```sh
VERIFY_NOD_ROOT=/tmp/verify-nod-alt ./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup <runId>
./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup /tmp/verify-nod-alt/<runId>
```

残っている run は `list` で探す（`alive: true` は、記録した PID が、状態ファイルに記録したその run の起動の argv で動いていることを表す。`list` を実行した作業ツリーによらず、別の作業ツリーから launch した run も同じに判定する）。

## Helpers

補助スクリプトは `.omp/skills/verify-nod/scripts/verify-nod.ts`（実行可能。shebang は `#!/usr/bin/env -S bun --no-env-file`）。`bun --no-env-file .omp/skills/verify-nod/scripts/verify-nod.ts <サブコマンド>` でも同じ。`<run>` は `launch` の出力の `runId`（根の下を探す）か `runDir`（絶対パス）。

| サブコマンド | 使い方 |
| --- | --- |
| `launch` | 新しい run を作り、web をビルドし、Workspace を登録して `nod ui` を起動する（「Launch」） |
| `doctor <run> [--port <番号>]` | 読み取りだけの状態確認（「Doctor」） |
| `cli <run> [--actor <名前>] [--evidence <機能の ID>] -- <nod の引数...>` | その run と同じデータ・同じ許可リストの環境で、ソースの CLI を実行する。cwd は `<run>/repo` なので、`-w` を付けなくても run の Workspace を使う。終了コードは CLI のもの。`--evidence` で `evidence/<機能の ID>/NNN-cli.json` に記録する（「Evidence」）。引数に `ui` があれば CLI を起動せずに終了コード 1 |
| `browser <run> --feature <機能の ID> [--steps <ファイル>\|-] [--timeout <ミリ秒>]` | `doctor` を通してから、手順の JSON（既定は標準入力）を新しいブラウザのコンテキストで実行し、`evidence/<機能の ID>/` に記録・ARIA スナップショット・スクリーンショットを残す（「Drive」）。終了コードは、すべての手順が通れば 0、それ以外は 1 |
| `cleanup <run>` | 残ったブラウザ、起動した `nod ui` と作業用のデータを消し、`evidence/` を残す（「Cleanup」） |
| `list` | 根にある run の一覧（`runId`・`cleaned`・`pid`・`alive`・`url`） |
| `help` | 使い方を出す |

`cli` の例（2026-11-25 に確かめた）:

```sh
# 登録済みの Workspace（run の Workspace が1つ）
./.omp/skills/verify-nod/scripts/verify-nod.ts cli <runId> -- --json workspace list
# 書き手を me（人）にして実行する。既定の書き手は verify-nod
./.omp/skills/verify-nod/scripts/verify-nod.ts cli <runId> --actor me -- --json issue create "タイトル"
# 証拠に残して起票し、ID を受け取る（evidence/issue-create/NNN-cli.json）
ID=$(./.omp/skills/verify-nod/scripts/verify-nod.ts cli <runId> --evidence issue-create -- --json issue create "タイトル" -d "本文" | jq -r .id)
```

`--actor me` で作った Issue は `issue show --json` の `createdBy` が `me`、付けずに作った Issue は `verify-nod` だった。CLI の引数の形は `cli <run> -- <コマンド> --help` で確かめる（例: `issue create` のタイトルは位置引数で、`--title` は無い）。

`browser` の例（手順をファイルで渡す。書き方は「Drive」）:

```sh
printf '%s' '[{"goto": "/issues"}, {"snapshot": "list"}, {"screenshot": "list"}]' > /tmp/steps.json
./.omp/skills/verify-nod/scripts/verify-nod.ts browser <runId> --feature issue-create --steps /tmp/steps.json
```

ページを開いたまま CLI で書くときは、手順に `cli` を入れる（例は [`features/cli-to-web.md`](features/cli-to-web.md)。`{"events": "ready"}` のあとに `{"cli": [...]}`、続けて `expect` で画面の変化を待つ）。別のシェルから `cli` サブコマンドを実行しても、`browser` の呼び出しは終わっていてページは残っていない。

server の環境を自分の目で見るときは、`ps eww -o command= -p <PID> | tr ' ' '\n' | grep =` で許可リストの11項目だけが出る。その PATH で `git` だけが見つかり、`gh` と `open` が見つからないことは `env -i PATH=<run>/bin /bin/sh -c 'command -v git; command -v gh; command -v open'`（`git` の行だけが出て終了コード 1）で確かめられる。

## 同時起動（2026-11-25 の実測）

利用者の nod がポート 4700（PID 96013）で動いている状態で、次を行った。

| run | 根 | ポート | PID | DB |
| --- | --- | --- | --- | --- |
| A `20261125-213856-61d0d` | 既定（`~/.local/state/verify-nod`） | 57471 | 92469 | `~/.local/state/verify-nod/20261125-213856-61d0d/data/nod.db` |
| B `20261125-213915-41cc0` | 既定 | 57509 | 92585 | `~/.local/state/verify-nod/20261125-213915-41cc0/data/nod.db` |
| C `20261125-213915-cd37a` | `VERIFY_NOD_ROOT=/tmp/verify-nod-alt`（実体 `/private/tmp/verify-nod-alt`） | 57510 | 92586 | `/private/tmp/verify-nod-alt/20261125-213915-cd37a/data/nod.db` |

- A を起動したあと、B と C の `launch` を同時に（並行に）実行し、どちらも `"ok": true` で起動した。3つの run は別のポート・別の DB を使い、それぞれの Workspace は V61D0D・V41CC0・VCD37A の1つだけだった。
- 3つが動いている間、A・B・C の `doctor` はすべて通った（終了コード 0、10項目すべて ok）。
- 交差させた `doctor`（A を B のポート 57509 に、B を C のポート 57510 に、C を A のポート 57471 に向けた）は3つとも終了コード 1 で、`port-owner`（例: 「ポート 57509 で LISTEN している PID: 92585、状態ファイルの PID: 92469」）と `api-workspaces`（「自分の DB の Workspace と一致しません。別の nod につながっている」）が通らなかった。
- A の `cleanup` で止まったのは A の PID だけで、B・C は動き続けた。
- 4700 の PID は、最初の起動の前も、すべての後始末の後も 96013 で同じだった。

したがって、利用者の nod と同時に動かしてよく、検証の run どうしも同時に動かしてよい。そのときは run ごとに `launch` し、runId（runDir）を取り違えないように、各操作の前に自分の run の `doctor` を通す。

## 保守（スキルとアプリが合わないとき）

定期の点検は行わない。スキルの手順や機能の一覧が実物の nod と合わないと報告されたとき（書いたとおりに操作して失敗する、画面の名前やコマンドが変わった、機能の一覧に無い振る舞いがある、など）に、pstack の `maintain-verification-skill`（`/skill:maintain-verification-skill`）で点検する。点検の対象はこのスキル（`.omp/skills/verify-nod/`）で、手順は maintain の「Pass」に従う。要点は次のとおり。

- 直すのはこのスキルのディレクトリ（`SKILL.md`、`features/`、`scripts/`）の中だけ。アプリのコード（`packages/`）は変えない。説明が実物と違えば機能の一覧を直し、補助スクリプトで操作できなければ補助スクリプトを直し（使い方を本文に書く）、アプリが壊れていれば直さずに利用者に報告する。
- 機能のファイルごとにソースを読み、すべての機能を実物で（この「Launch」の run で、`doctor` を通してから）少なくとも1回は動かす。直した手順は、直した版で通し直してから載せる。

機能の一覧に無い機能を確かめたいときは、その場では「Drive」の道具と「Evidence」の証明の基準のとおりに利用者の経路で確かめ、報告に「機能の一覧に無い」と書く。一覧に足すのは、maintain の手順（ソースの入口を確かめ、実物で通した手順だけを `features/README.md` の形の機能のファイルにし、索引に足す）で行う。
