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
同じ Issue・同じ PR URL では一度だけ進め（`auto_transitions` に記録）、現在の PR を付けたあとに一度でも in_review になった、または in_review から動いた Issue（`nod issue done` 済み・差し戻し後）は進めない。
PR を付け直せば、新しい PR では再び対象になる。
誤って進んだときは `nod automation undo <id>` で、Issue がまだ in_review で、自動遷移のあとに状態が変わっていなければ元の状態に戻す（人だけ。変わっていれば `INVALID_STATE`）。
戻すのは status だけで、自動遷移で外した作業状況（agent_state）は戻さない。取消も event と記録に残り、同じ PR では再び進めない。

### コミット連動（#68）

Workspace ごとに `nod automation set --commit-review on` で有効にする（既定は無効。設定は人だけ）。
`nod git sync [--dry-run] [--since <日数>] [--ref <rev>] [--limit <n>]` は、Workspace のパスで `git log <ref>`（既定 HEAD・直近30日・最大1000コミット。fetch はしない）を読み、
コミットメッセージの close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved（大文字小文字は問わない）に続くこの Workspace の Issue ID を拾う。
`Fixes API-1, API-2 and API-3` のように複数書ける。```` ``` ```` で囲まれたコードブロックの中と、Revert コミット（件名が `Revert "` で始まる、または本文に `This reverts commit`）は読まない。backlog / todo / in_progress の Issue を in_review にし、done にはしない。Triage・needs_clarification・in_review・done・canceled・アーカイブ済みは対象外。
`--dry-run` は誰でも（LLM も）使え、実行は人だけで、無効な Workspace では実行できない（`AUTOMATION_DISABLED`）。
同じ Issue・同じコミットでは一度だけ進め、コミットのあとで一度でも in_review になった Issue は進めない。
一度でも in_review から動いた Issue（人の差し戻し・取消）は、新しいコミット（rebase・cherry-pick で SHA が変わったものを含む）でも進めず、再び in_review にするのは人か LLM の `nod issue done` だけ。
backlog / todo から進めても started_at は付けない（手動の遷移と同じ。作業時間は未計測になる）。取消は PR 連動と同じく `nod automation undo <id>`。
git は `-c log.showSignature=false` を付け、`GIT_DIR`・`GIT_WORK_TREE` など `GIT_` で始まる環境変数を除いて起動する。
単一の実行ファイルは `bun run build` で `dist/nod` に作られる。

### LLM に定型作業を定期実行させる（#64）

nod は常駐せず、LLM のセッションも起動しない。定型作業は、担当に LLM を指定した定期Issueとして起票し、LLM が `nod issue next` で拾う。

1. 作業の手順をテンプレートにする（任意・人だけ）。テンプレートは全 Workspace で共通で、既定では何も登録されていない。例を `docs/templates/` に置いている。
   LLM はテンプレートを読めるが、登録・置き換え・削除（`nod template add` / `remove`）は `FORBIDDEN_FOR_LLM` になる。

   ```sh
   nod template add 依存更新チェック --from docs/templates/dependency-update-check.md
   nod template add 週次レポート --from docs/templates/weekly-report.md
   ```

2. 定期Issueを登録する（人だけ）。担当に LLM の書き手名（`claude-code`、`codex` など）を指定する。Web では Workspace 設定の「定期Issue」で、担当の候補から選ぶか書き手名を入力する。

   ```sh
   nod recurring add 依存更新チェック --template 依存更新チェック --every monthly --day 1 --start 2026-10-01 --assignee claude-code
   nod recurring add 週次レポート --template 週次レポート --every weekly --weekday 月 --start 2026-10-05 --assignee claude-code
   ```

3. 人が `nod recurring run`（`nod automation run` にも含まれる。Web は Workspace 設定の「定期Issue」または「自動化」の「今すぐ実行」）を実行すると、発生日が来たものが起票される。
   人の起票なので Triage を通らず todo で入り、担当の LLM だけが `nod issue next` で拾える（ほかの LLM には出ない）。
   ただし遷移ルール（#73）で todo → in_progress を禁止している Workspace では、`nod issue next` は `TRANSITION_NOT_ALLOWED` になり着手できない。
4. LLM は説明の手順に従って作業し、`nod issue done` でレビューに回す。done にするのは人である。LLM への手引きは `nod skills get nod` の「定期Issueで起票された定型作業の扱い」にある。

確認は、`nod recurring show <id>`（前回の起票と次回の発生日）、`nod issue list --delegated`（LLM に委任中の Issue）、`nod issue show <id>`（Activity の created に `recurring_id` と発生日が残る）で行う。
テンプレートが消えているなど起票できなかった定期Issueは、実行結果の `failed` に理由付きで出て、ほかの定期Issueは起票される。

### 人だけが行える操作と、その限界

Triage の受け入れ・却下・重複、Workspace の作業規約の登録・変更・削除、テンプレートの登録・置き換え・削除などは人だけが行え、LLM が実行すると `FORBIDDEN_FOR_LLM` になる。
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
