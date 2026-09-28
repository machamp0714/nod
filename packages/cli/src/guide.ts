export const GUIDE = `# nod の使い方（LLM 向け）

nod は、このリポジトリの Issue を管理する CLI である。
Issue を読み書きするときは nod を使う。
人は nod の Web UI や CLI で、確認依頼への回答、レビュー、Triage を行う。

## 書き手

Claude Code の中では、自動で claude-code として記録される。
Codex では、最初に \`export NOD_ACTOR=codex\` を実行する。

## 作業の流れ

1. \`nod issue next --json\` で着手する Issue を1件取る。null なら着手できる Issue はない。
   指定された Issue があるときは \`nod issue start <id>\` を使う。
2. \`nod issue show <id>\` で説明、計画、Documents、Sub-issue、Activity を読む。
3. writing-plans などで実装計画書を書いたときは \`nod issue plan <id> --from <計画書のパス>\` で取り込む。
   計画書の「### Task N」と「- [ ] **Step N**」が Issue の計画になり、計画書は Document として添付される。
   計画書を書き直したら、同じコマンドで取り込み直す。
   計画書がなく手順が3つ以上あるときは \`nod issue plan <id> --step "調査" --step "実装" --step "テスト"\` で計画を示す。
   進めるたびに \`nod issue step <id> <N> doing|done|skipped\`（Step は \`<N.M>\`）で更新する。
4. 設計書を書いたときは \`nod issue doc add <id> <パス> --kind spec\` で添付する。
5. 節目ごとに \`nod issue log <id> "<何をしたか>"\` で経過を1件残す。細かい思考は残さない。
6. 判断に迷ったら推測で進めず、\`nod issue ask <id> "<質問>"\` で人に確認し、その Issue の作業を止める。
   回答は \`nod issue show <id>\` の Activity に出る。
7. 続けられないときは \`nod issue fail <id> "<理由>"\` で報告する。
8. 終えたら \`nod issue done <id> --summary "<やったことの要約>" [--pr <URL>]\` でレビューに回す。
   Issue を自分で done にしない（nod issue update --status done は拒否される）。done にするのは、レビューを終えた人である。
9. レビューで差し戻されると、Issue は in_progress のまま残る。\`nod issue show <id>\` で差し戻しの理由を読み、\`nod issue start <id>\` で再開する。

## 引数の書き方

\`-\` で始まる文字列を渡すときは、\`--\` の後ろに書く。

\`\`\`sh
nod issue ask API-12 -- "--force を外してよいか"
\`\`\`

## 起票

作業中に別の不具合や追加の作業を見つけたら、自分で着手せずに起票する。

\`\`\`sh
nod issue create "<タイトル>" [-d "<説明>" | --template <名前>] [--project <名前>] [--parent <id>] [-p 0-4] [-l <label>]
\`\`\`

LLM が起票した Issue は Triage に入り、人が受け入れるまで \`nod issue next\` に出ない。
1つの Issue を分担できる単位に分けるときは \`--parent <元の id>\` で Sub-issue にする。
説明の雛形（テンプレート）があるときは、\`nod template list\` で探し、\`--template <名前>\` で本文を説明の初期値にする。
雛形の空欄は \`nod issue update <id> -d "<説明>"\` で埋める。

## そのほかのコマンド

- \`nod issue list [--status todo,in_progress] [--project <名前>] [-l <label>] [--all-workspaces]\`
- \`nod issue update <id> [--title] [-d] [-p] [--add-label] [--remove-label] [--parent] [--project]\`
- \`nod issue comment <id> "<text>"\`
- \`nod issue relate <id> --blocks <id> | --related <id> | --duplicate-of <id>\`
- \`nod project list\`、\`nod project show <名前>\`
- \`nod template list\`、\`nod template show <名前>\`

どのコマンドも \`--json\` を付けると JSON で出力する。
失敗すると終了コードが1になり、\`--json\` のときは \`{"error": {"code", "message"}}\` を返す。

## エラーへの対処

- NOT_INITIALIZED：このリポジトリは nod に登録されていない。人に \`nod init\` を依頼する。
- NOT_ACCEPTED：その Issue はまだ Triage にある。着手せず、別の Issue を取る。
- NEEDS_CLARIFICATION：その Issue には、人が決めていない未決事項が残っている。着手せず、別の Issue を取る。
- ASSIGNED_TO_OTHER：その Issue はほかの書き手が担当している。着手せず、別の Issue を取る。
- AWAITING_ANSWER：その Issue には未回答の確認依頼がある。回答が来るまで着手せず、別の Issue を取る。
- BLOCKED：その Issue は message に挙がった Issue にブロックされている。それらが終わるまで着手せず、別の Issue を取る。
- NOT_IN_PROGRESS：done は着手中の Issue にしか使えない。先に \`nod issue start <id>\` で着手する。
- DB_BUSY：ほかの処理が書き込み中である。少し待って再実行する。
- INVALID_ARGS、INVALID_STEP：message の例に従って引数を直し、再実行する。
`;
