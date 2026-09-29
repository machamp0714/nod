# nod

LLM（Claude Code、Codex）が作業し、人が判断するための個人用 Issue 管理ツール。
LLM は CLI（`nod`）で Issue を起票し、着手し、確認を依頼し、完了を報告する。
人は Web UI で、確認依頼への回答、レビュー、Triage を行う。
用語と UI は Linear に合わせ、データは SQLite に保存する。

## 使い方

```sh
bun install
cd packages/cli && bun link   # nod コマンドを使えるようにする
cd <リポジトリ> && nod init    # Workspace として登録する（キーはリポジトリ名から作る）
```

LLM には `skills/nod` を Agent Skill として読ませる（例：`~/.claude/skills/nod` にシンボリックリンクを張る）。
DB は `~/.local/share/nod/nod.db` に作られ、`NOD_DB` で場所を変えられる。
`nod issue pr-status --refresh` は `gh pr view` で PR の状態を読み取る。`NOD_GH` は gh の代わりに起動するコマンドを指定するテスト用の口で、通常は設定しない。
`nod issue pr-diff --refresh` は `gh pr view` と `gh api`（compare、GET のみ）で PR の HEAD に固定した差分を読み取って保存する（ファイル 300 件・5 MB まで。`--file <パス>` でファイルごとの差分を出す。一覧の `--json` は patch を含まない）。

### PR 連動（#66）

Workspace ごとに `nod automation set --pr-review on` で有効にする（既定は無効。設定は人だけ）。
有効なら、`nod issue pr-status --refresh`・Web の PR 状態の更新・`nod automation run`（保存済みの PR 状態で評価し、gh は呼ばない）で、
in_progress の Issue の PR が open（draft 以外）かマージ済みなら in_review に進める。マージ済みでも done にはせず、完了候補として人の承認を待つ。
レビューの判定（reviewDecision）は条件にしない。draft・未マージで閉じた PR・取得の失敗では進めない。Triage・アーカイブ済み・in_progress 以外は対象外。
PR は作業中に `nod issue link-pr <id> <url>` で紐付ける（ステータスは変えない）。
同じ Issue・同じ PR URL では一度だけ進め（`auto_transitions` に記録）、現在の PR を付けたあとに一度でも in_review になった Issue（`nod issue done` 済み・差し戻し後）は進めない。
PR を付け直せば、新しい PR では再び対象になる。
誤って進んだときは `nod automation undo <id>` で、Issue がまだ in_review なら元の状態に戻す（人だけ）。取消も event と記録に残り、同じ PR では再び進めない。

### コミット連動（#68）

Workspace ごとに `nod automation set --commit-review on` で有効にする（既定は無効。設定は人だけ）。
`nod git sync [--dry-run] [--since <日数>] [--ref <rev>] [--limit <n>]` は、Workspace のパスで `git log <ref>`（既定 HEAD・直近30日・最大1000コミット。fetch はしない）を読み、
コミットメッセージの close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved（大文字小文字は問わない）に続くこの Workspace の Issue ID を拾う。
`Fixes API-1, API-2 and API-3` のように複数書ける。backlog / todo / in_progress の Issue を in_review にし、done にはしない。Triage・needs_clarification・in_review・done・canceled・アーカイブ済みは対象外。
`--dry-run` は誰でも（LLM も）使え、実行は人だけで、無効な Workspace では実行できない（`AUTOMATION_DISABLED`）。
同じ Issue・同じコミットでは一度だけ進め、コミットのあとで一度でも in_review になった Issue（差し戻し後など）は進めない。取消は PR 連動と同じく `nod automation undo <id>`。
単一の実行ファイルは `bun run build` で `dist/nod` に作られる。

### 人だけが行える操作と、その限界

Triage の受け入れ・却下・重複、Workspace の作業規約の登録・変更・削除などは人だけが行え、LLM が実行すると `FORBIDDEN_FOR_LLM` になる。
LLM かどうかは書き手（`NOD_ACTOR`、なければ `CLAUDECODE=1` なら `claude-code`、どちらもなければ `me`）で判定する。
これは LLM の誤操作を防ぐための取り決めで、権限の仕組みではない。
`NOD_ACTOR=me` を付けて CLI を実行したり、ローカルの API（`nod ui` の server。書き手は常に `me`）を curl などで直接呼んだり（Origin のない同じマシンからの要求は受け付ける）、DB を直接書き換えたりすれば回避できる。
LLM には、書き手を変えて回避せず人に依頼するよう手引き（`skills/nod`）で指示している。

### Web UI

```sh
bun run web:build   # packages/web/dist に web をビルドする（web を変えたら再実行する）
nod ui              # http://127.0.0.1:4700 で server を起動し、ブラウザで開く。Ctrl+C で止める
nod ui --port 4800  # ポートを変える（0 なら空いているポート）
nod ui --no-open    # ブラウザを開かない
```

`nod ui` がすでに起動していれば、新しく起動せずにそれを開く。
単一の実行ファイル（`dist/nod`）は web を含まないため、`nod ui --web-dir <リポジトリ>/packages/web/dist` でビルド済みの web を渡す。

## server（開発時）

```sh
bun run server                # http://127.0.0.1:4700 で API を起動する
NOD_PORT=4800 bun run server  # ポートを変える
```

DB は `nod` と同じく `NOD_DB` か `~/.local/share/nod/nod.db` を使う。
web の開発サーバーは `/api` をこの server に転送する。
