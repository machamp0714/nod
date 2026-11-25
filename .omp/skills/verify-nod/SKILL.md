---
name: verify-nod
description: "nod（このリポジトリの Issue 管理。Web が主、CLI が従）を作業ツリーのソースから隔離して起動し、状態確認と後始末をする手順と補助スクリプト。変更や指摘を実物の nod で確かめたいとき、検証用の nod を起動・確認・片付けたいときに使う。利用者の nod（ポート 4700、~/.local/share/nod）と外部サービスには触れない。"
---

# verify-nod

作業ツリーのソースの nod を、実行（run）ごとに作業ツリーの外に作る置き場と、空いているポートで起動する。Web はその run の中でビルドしたものを `nod ui` で配信し、CLI は同じデータを指してソースを bun で実行する。インストール済みのデスクトップアプリ（`~/Applications/nod.app`）と PATH の `nod` は使わない（PATH の `nod` は利用者の DB に書く）。

コマンドはすべて、リポジトリ（作業ツリー）のルートを cwd にして実行する。前提は `bun install` 済みであること。補助スクリプトは `.omp/skills/verify-nod/scripts/verify-nod.ts` の1本で、サブコマンドで使い分ける（「Helpers」）。

## 守ること

- 利用者は普段の作業で nod をポート 4700 で動かしている。4700 に接続しない（GET も含む）、4700 のプロセスを止めない、利用者のデータ（`~/.local/share/nod`、`~/.config/nod`、`~/Applications/nod.app`）を読み書きしない。補助スクリプトは、4700 の指定と、置き場の根を作業ツリーや利用者のデータの中に置くことを拒む。
- PATH の `nod` を検証に使わない。CLI は `verify-nod.ts cli` から使う。
- プロセスを名前で止めない（`pkill`・`killall` を使わない）。止めるのは `verify-nod.ts cleanup` だけで、自分が起動した PID だけを止める。
- 別の run の置き場・ポートを混ぜない。操作の前に、その run の `doctor` を通す。

## 隔離のしかた

### 置き場

置き場の根は環境変数 `VERIFY_NOD_ROOT`（絶対パス）で変えられる。既定は `~/.local/state/verify-nod`。根が作業ツリー、`~/.local/share/nod`、`~/.config/nod`、`~/Applications/nod.app` の中にあると、補助スクリプトは失敗する。

`launch` は根の下に run の ID（`YYYYMMDD-HHMMSS-<16進5桁>`）の名前でディレクトリを作る（既にあれば失敗する）。中身は次のとおり。

| パス（run の中） | 中身 | 後始末 |
| --- | --- | --- |
| `data/nod.db`、`data/documents/`、`data/attachments/` | DB・Document・添付（`NOD_DB`・`NOD_DOCS_DIR`・`NOD_ATTACHMENTS_DIR`） | 消す |
| `home/`、`tmp/` | 検証の nod の `HOME`・`TMPDIR` | 消す |
| `config/` | `toggl.json`（`NOD_TOGGL_CONFIG` の指す先。作らない＝トークンなし）、`gh-unavailable`（`NOD_GH` の指す先。作らない）、`vite-env/`（空。web のビルドの `NOD_VITE_ENV_DIR`） | 消す |
| `repo/` | Workspace として登録する空の git リポジトリ | 消す |
| `web/` | この run でビルドした web（`vite build --outDir`） | 消す |
| `logs/` | `web-build.log`、`init.log`、`ui.stdout.log`（`nod ui --json` の出力）、`ui.stderr.log` | 消す |
| `state.json` | 状態ファイル（runId、Workspace、PID、URL、ポート、dbPath、起動した argv） | 消す |
| `evidence/` | 証拠。`launch.json`（起動時の状態と状態確認の結果）、`cleanup.json`（後始末の記録） | **残す** |

Workspace は run ごとに1つ、キー `V<16進5桁を大文字>`・名前 `verify-nod-<runId>`・パス `<run>/repo` で登録する。キーは run の ID の末尾と同じ文字で、状態確認の照合に使う。

### ポート

`nod ui --port 0` で起動し、OS が空いているポートを選ぶ。補助スクリプトはポートを指定させない。起動したポートが 4700 なら起動を失敗にし、`doctor --port 4700` は接続せずに拒む。

### 環境変数（許可リスト）

検証の nod（server と CLI）には、親の環境を引き継がず、次の11項目だけを渡す（`nodEnv()`）。bun はすべて `process.execPath` の絶対パスに `--no-env-file` を付けて呼ぶ（`.env` を読まない）。

| 変数 | 値 | 何を止めるか |
| --- | --- | --- |
| `PATH` | `/usr/bin:/bin` | server は固定の名前の `gh` を実行する。このマシンの `gh` は `/opt/homebrew/bin` と `/usr/local/bin` にあり、この PATH では見つからない。`git` は `/usr/bin/git` を使える |
| `HOME`、`TMPDIR` | `<run>/home`、`<run>/tmp` | `~/.config/nod/env` などホームの下の既定の場所を読まない |
| `NOD_DB`、`NOD_DOCS_DIR`、`NOD_ATTACHMENTS_DIR` | `<run>/data/...` | 利用者の DB・Document・添付 |
| `NOD_TOGGL_CONFIG` | `<run>/config/toggl.json`（無いファイル） | Toggl（トークンが無いので未設定の扱い） |
| `NOD_GH` | `<run>/config/gh-unavailable`（無い絶対パス） | CLI からの GitHub |
| `NOD_ORCA` | `0` | Orca |
| `TYPESAFE_API_KEY` | 空文字 | 仕様要否判定（Typesafe API）。未設定だと `~/.config/nod/env` を読むので、空文字を明示する |
| `NOD_ACTOR` | `verify-nod`（`cli --actor` で変えられる） | 書き手を親のエージェント環境から判定させない |

親の環境にある `CODEX_HOME`・`CODEX_THREAD_ID`・`ORCA_*`・`NOD_WORKTREE`・`NOD_BRANCH`・`OMPCODE`・`CLAUDECODE`・API キー類は渡らない。web のビルドと `git init` には `PATH`・`HOME`・`TMPDIR`・`NOD_VITE_ENV_DIR`（空のディレクトリ）だけを渡す。

外部サービスに依る機能（仕様要否判定、GitHub の PR 状態、Toggl、Orca）は、この隔離では成功の経路に到達できない。

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
| `pid-command` | その PID のコマンドラインが、ソースの CLI の `ui` で、この run の `web/` を指している（`ps -ww -o command= -p <PID>`） |
| `pid-env` | その PID の環境変数が、許可リストの11項目と完全に一致する（`ps eww -o command= -p <PID>`） |
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

## Cleanup

```sh
./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup <runId または runDir>
```

1. `state.json` の PID が動いていれば、そのコマンドラインがソースの CLI の `ui` でこの run の `web/` を指していることを確かめてから SIGTERM を送り、止まるのを待つ（10秒で止まらなければ、もう一度コマンドラインを確かめて SIGKILL）。コマンドラインがこの run のものでなければ止めずに終了コード 1 で終わり、データも消さない（別の PID を記録した run で、その PID が止められず、データが残ることを確かめた）。
2. 表で「消す」とした `data/`・`home/`・`tmp/`・`config/`・`repo/`・`web/`・`logs/`・`state.json` を消す。
3. `evidence/cleanup.json` に、止めた PID と消したパスを追記する。

**証拠は `<run>/evidence/` に残る**（後始末のあと、run のディレクトリには `evidence/` だけがある）。何度実行してもよい。2回目以降は止めるものも消すものも無く、終了コード 0 で終わる。`VERIFY_NOD_ROOT` を変えて起動した run は、同じ `VERIFY_NOD_ROOT` を付けて runId で指定するか、runDir の絶対パスで指定する。根が launch のときと違うと、`<根>/<runId> がありません` で終了コード 1 になり、何も止めず何も消さない（`doctor`・`cli` も同じ）。シェルで `VERIFY_NOD_ROOT` を export したままにしていないかも確かめる。

```sh
VERIFY_NOD_ROOT=/tmp/verify-nod-alt ./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup <runId>
./.omp/skills/verify-nod/scripts/verify-nod.ts cleanup /tmp/verify-nod-alt/<runId>
```

残っている run は `list` で探す（`alive: true` は、記録した PID がその run のコマンドラインで動いていることを表す）。

## Helpers

補助スクリプトは `.omp/skills/verify-nod/scripts/verify-nod.ts`（実行可能。shebang は `#!/usr/bin/env -S bun --no-env-file`）。`bun --no-env-file .omp/skills/verify-nod/scripts/verify-nod.ts <サブコマンド>` でも同じ。`<run>` は `launch` の出力の `runId`（根の下を探す）か `runDir`（絶対パス）。

| サブコマンド | 使い方 |
| --- | --- |
| `launch` | 新しい run を作り、web をビルドし、Workspace を登録して `nod ui` を起動する（「Launch」） |
| `doctor <run> [--port <番号>]` | 読み取りだけの状態確認（「Doctor」） |
| `cli <run> [--actor <名前>] -- <nod の引数...>` | その run と同じデータ・同じ許可リストの環境で、ソースの CLI を実行する。cwd は `<run>/repo` なので、`-w` を付けなくても run の Workspace を使う。終了コードは CLI のもの |
| `cleanup <run>` | 起動したプロセスと作業用のデータを消し、`evidence/` を残す（「Cleanup」） |
| `list` | 根にある run の一覧（`runId`・`cleaned`・`pid`・`alive`・`url`） |
| `help` | 使い方を出す |

`cli` の例（2026-11-25 に確かめた）:

```sh
# 登録済みの Workspace（run の Workspace が1つ）
./.omp/skills/verify-nod/scripts/verify-nod.ts cli <runId> -- --json workspace list
# 書き手を me（人）にして実行する。既定の書き手は verify-nod
./.omp/skills/verify-nod/scripts/verify-nod.ts cli <runId> --actor me -- --json issue create "タイトル"
```

`--actor me` で作った Issue は `issue show --json` の `createdBy` が `me`、付けずに作った Issue は `verify-nod` だった。CLI の引数の形は `cli <run> -- <コマンド> --help` で確かめる（例: `issue create` のタイトルは位置引数で、`--title` は無い）。

server の環境を自分の目で見るときは、`ps eww -o command= -p <PID> | tr ' ' '\n' | grep =` で許可リストの11項目だけが出る。その PATH で `gh` が見つからないことは `env -i PATH=/usr/bin:/bin /bin/sh -c 'command -v gh'`（終了コード 1）で確かめられる。

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
