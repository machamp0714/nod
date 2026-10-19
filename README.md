# nod

LLM（Claude Code、Codex）が作業し、人が判断するための個人用 Issue 管理ツール。
LLM は CLI（`nod`）で Issue を起票し、着手し、確認を依頼し、完了を報告する。
人は Web UI で、確認依頼への回答、Triage を行う。
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

### ワークフローのプラグイン（nod:backlog / pm / wayfinder / to-spec / to-plan / implement / code-review）

バックログ作成・指定範囲の進行管理と、構想の整理→仕様→計画→実装→レビューを nod の Issue に記録しながら進めるスキル7つを、`plugins/nod` に置いている。
Claude Code と Codex の両方から、GitHub のマーケットプレイスとして導入する。

`nod:backlog <要望・会話・PRD>` は、利用者への価値と受け入れ条件が分かる Issue を作成する。
起票前に `nod template list` と `nod template show <名前>` で登録済みテンプレートを確認し、その見出し・順序・項目を使う。
未登録の場合はスキル内の標準テンプレートを使い、Story を自然な日本語で記述する。
テンプレートの取得失敗時や候補を選べない場合は、未登録として進めず確認する。
下書きだけの依頼では本文の提示までにし、起票後には本文・起票先と、Issue ID・タイトル・使用したテンプレートを確認して報告する。
手順は[バックログ作成スキル](plugins/nod/skills/backlog/SKILL.md)にある。

`nod:pm <Workspace> --cycle <Cycle> --on Studio` は、Airで起動し、指定Workspaceと固定CycleのIssueをOrcaで監督する。
並行上限は既定1件、`--max-parallel 2`で最大2件にできる。
実装担当、モデルとeffortは、`--agent codex --model <モデルID> --effort <effort>`などの個別指定、合意済み方針、既存ユーザー設定の具体値を使う。
モデルをスキル独自の既定値へ変えない。
これらはスキルへの指示であり、nod CLIのオプションではない。
候補表示だけを頼むこともでき、その段階でworkerを起動しない。
人や他担当の作業、未受理のTriage、未回答の人の質問、未完了の依存先を保護し、指定外Workspaceや次Cycleへ範囲を広げない。
起動手順は[PMスキル](plugins/nod/skills/pm/SKILL.md)、一時DBと偽の接続先による評価手順は[PMの行動評価](plugins/nod/skills/pm/evals/README.md)にある。

`nod:wayfinder <構想またはマップの Issue ID>` は、大きな構想を判断用の親子 Issue と依存関係に分ける。子ごとに調査・試作・人との対話で方針を固め、別モデルの推奨も参考にする。モデル同士が一致しても、人の回答を待って判断する。判断用 Issue の全てに `to-spec` を実行する必要はなく、実装対象の仕様を詰める段階で `nod:to-spec` を使う。

```sh
claude plugin marketplace add machamp0714/nod && claude plugin install nod@nod
codex plugin marketplace add machamp0714/nod && codex plugin add nod@nod
```

スキルを変えたら、`plugins/nod/.claude-plugin/plugin.json`・`plugins/nod/.codex-plugin/plugin.json`・`.claude-plugin/marketplace.json`（2か所）の version を同じ値に上げる。Claude Code の `claude plugin update nod@nod` は version が変わらないと「already at the latest version」で反映しない。マージ後に `claude plugin marketplace update nod && claude plugin update nod@nod`、Codex は `codex plugin marketplace upgrade` で反映する。

### Issue の完了と PR

LLM も `nod issue done <id> --summary "<完了内容>"` で、着手中の Issue を直接 done にできる。
作業報告は Activity に残り、親子関係・依存関係・作業時間の集計にも完了が反映される。
PR は `nod issue link-pr <id> <url>` で紐付け、`nod issue pr-status <id> --refresh` で GitHub のレビュー・CI・マージ状態を確認する。
PR の紐付け・状態取得やコミットを理由に Issue の状態が自動で変わることはない。
GitHub の PR レビュー・マージと、`nod:code-review` によるコードレビューは、それぞれ独立した機能として使える。
単一の実行ファイルは `bun run build` で `dist/nod` に作られる。

### LLM に定型作業を定期実行させる（#64）

nod は常駐せず、LLM のセッションも起動しない。定型作業は、担当に LLM を指定した定期Issueとして起票し、LLM が `nod issue next` で拾う。

1. 作業の手順をテンプレートにする（任意・人だけ）。テンプレートは全 Workspace で共通で、既定では何も登録されていない。例を `docs/templates/` に置いている。
   LLM はテンプレートを読めるが、登録・置き換え・削除（`nod template add` / `remove`）は `FORBIDDEN_FOR_LLM` になる。
   Web の Workspace 設定の「テンプレート」からも、追加・本文の編集・削除ができる（名前は変えられない）。

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
4. LLM は説明の手順に従って作業し、`nod issue done` で直接完了にする。LLM への手引きは `nod skills get nod` の「定期Issueで起票された定型作業の扱い」にある。

確認は、`nod recurring show <id>`（前回の起票と次回の発生日）、`nod issue list --delegated`（LLM に委任中の Issue）、`nod issue show <id>`（Activity の created に `recurring_id` と発生日が残る）で行う。
テンプレートが消えているなど起票できなかった定期Issueは、実行結果の `failed` に理由付きで出て、ほかの定期Issueは起票される。

### 人だけが行える操作と、その限界

Workspace の作業規約の登録・変更・削除、テンプレートの登録・置き換え・削除などは人だけが行え、LLM が実行すると `FORBIDDEN_FOR_LLM` になる。
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
