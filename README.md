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
単一の実行ファイルは `bun run build` で `dist/nod` に作られる。

## server（開発時）

```sh
bun run server                # http://127.0.0.1:4700 で API を起動する
NOD_PORT=4800 bun run server  # ポートを変える
```

DB は `nod` と同じく `NOD_DB` か `~/.local/share/nod/nod.db` を使う。
web の開発サーバーは `/api` をこの server に転送する。
