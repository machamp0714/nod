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
   設計メモなどを新しく書くときは \`nod doc create <相対パス.md> --title "<タイトル>" [--kind spec|plan|doc] [--body "<本文>" | --body -] --issue <id>\` で作る。
   作成先は Documents ディレクトリ（\`NOD_DOCS_DIR\`）の下に限られ、既存ファイルは上書きしない。本文の正本は作られた Markdown ファイルである。
   Document と Issue のリンクは \`nod doc link|unlink <Document id> --issue <id>\` で付け外しし、\`nod doc show <Document id>\` でリンク先の Issue を確かめる。
   Markdown 以外の資料やリンクは添付にする。\`nod issue attach add <id> --url <URL> [--title <表示名>]\` でリンク（http/https のみ）を、\`nod issue attach add <id> --file <パス> [--title <表示名>]\` でファイルを添付する。
   ファイルは添付ディレクトリ（\`NOD_ATTACHMENTS_DIR\`）にコピーされ、10MB まで、拡張子は png/jpg/jpeg/gif/webp/pdf/txt/log/md/csv/json/yaml/yml/zip に限られる。symlink は添付できない。
   添付できるのは登録済み Workspace か OS の一時ディレクトリの下のファイルだけで、途中に symlink や . で始まるディレクトリ（.ssh・.git など）を経由するものは添付できない。URL に user:password@ は含められない。
   本文を nod で読む Markdown や複数の Issue で共有する Markdown は Document、その Issue だけの読まない資料（ログ・画像・PDF など）は添付と使い分ける。
   \`nod issue attach list <id>\` で一覧し、\`nod issue attach remove <id> <添付 id>\` で削除する。アーカイブ中の Issue には追加も削除もできない。
5. 節目ごとに \`nod issue log <id> "<内容>" [--kind <種類>]\` で作業ログを1件残す。人は Issue 詳細で種類ごとに絞り込んで読む。
   残すのは、作業の要約・判断の根拠・実行した結果である。内部の思考（推論の途中経過）は残さない。
   種類は次のどれかで、省略すると \`progress\` になる。
   - \`progress\`（経過）：何をしたか、どこまで進んだか
   - \`plan\`（方針）：これからどう進めるか、方針を変えたこと
   - \`rationale\`（判断根拠）：選んだ案と、選んだ理由・退けた案
   - \`command\`（実行コマンド・結果）：実行したコマンドと、結果の要点
   - \`test\`（テスト結果）：実行したテストと、成否・件数
   - \`blocker\`（ブロッカー）：進められない原因と、必要なもの
   1件は 4000 文字までである。長い出力は貼らずに要点だけを残し、全文が必要なら \`nod doc create\` で Document にする。
   秘密値（トークン、パスワード、.env の値、秘密鍵、資格情報）は書かない。コマンドの出力に含まれるときは伏せてから残す。
   既知の形の秘密値を含むと SECRET_DETECTED で拒否され、何も記録されない。
6. 判断に迷ったら推測で進めず、\`nod issue ask <id> "<質問>"\` で人に確認し、その Issue の作業を止める。
   回答は \`nod issue show <id>\` の Activity に出る。
7. 続けられないときは \`nod issue fail <id> "<理由>"\` で報告する。
8. 終えたら \`nod issue done <id> --summary "<やったことの要約>" [--pr <URL>]\` でレビューに回す。
   Issue を自分で done にしない（nod issue update --status done は拒否される）。done にするのは、レビューを終えた人である。
9. レビューで差し戻されると、Issue は in_progress のまま残る。\`nod issue show <id>\` で差し戻しの理由を読み、\`nod issue start <id>\` で再開する。

## 着手前に候補だけ確認する

\`nod issue suggest [--project <名前>] --json\` は、現在の Workspace と自分の担当条件に合う候補を1件返す。候補がなければ null を返す。
\`next\` と同じ着手条件と優先度順で選ぶが、Issue・担当・作業場所・時刻・履歴を変更せず、Orca にも通知しない。
提案は予約ではない。着手するときは \`nod issue next\` または \`nod issue start <id>\` を使う。その時点の条件を再確認するため、同じ候補に着手できるとは限らない。

## Issue 用のブランチ名を取得する

\`nod issue branch-name <id>\` はコピーできるブランチ名だけを返す。例：API-12 は \`nod/api-12\`。
タイトルに依存せず、IDの大小文字を変えても同じ名前になる。\`--json\` では \`issueId\` と \`suggestedBranch\` を返す。
この名前は生成候補であり、記録済みの実行場所の \`branch\` とは別である。ブランチ作成・checkout・着手・DB更新・Orca通知は行わない。

## Issue を複製する

\`nod issue copy <id> [--title <text>]\` は同じ Workspace に新しい ID の Issue を作る。引き継ぐのはタイトル・説明・Project・ラベル・優先度・見積もりだけで、元の Issue は変えない。
期限・担当・作業状況・親子・関係・PR・実行場所・計画・Documents・質問・コメントは引き継がない。LLM の複製は通常の起票と同じく Triage に入る。

## Issue のアーカイブ

\`nod issue archive <id> [--reason <text>]\` と \`nod issue unarchive <id>\` は人だけが行える（LLM は FORBIDDEN_FOR_LLM）。ステータスは変えない。
アーカイブ済みの Issue は既定の一覧・Inbox・Triage・\`nod issue next\` から外れ、ブロック元としても数えない。\`nod issue list --archived\` で確認できる。
Workspace の自動化（\`nod automation set\` と \`nod automation run\`）の設定・実行は人だけが行える。LLM は \`nod automation run --dry-run\` で対象を確かめ、人に伝えるだけにする。

## 引数の書き方

\`-\` で始まる文字列を渡すときは、\`--\` の後ろに書く。

\`\`\`sh
nod issue ask API-12 -- "--force を外してよいか"
\`\`\`

## 起票

作業中に別の不具合や追加の作業を見つけたら、自分で着手せずに起票する。

\`\`\`sh
nod issue create "<タイトル>" [-d "<説明>" | --template <名前>] [--project <名前>] [--parent <id>] [--discovered-from <id>] [-p 0-4] [--estimate 1-100] [--due YYYY-MM-DD] [-l <label>]
\`\`\`

別のIssueの作業中に発見した場合は \`--discovered-from <id>\` で起票元を明示する。親子関係の \`--parent\` とは別に記録され、未指定の起票元は推測されない。

LLM が起票した Issue は Triage に入り、人が受け入れるまで \`nod issue next\` に出ない。
\`nod triage accept\`、\`nod triage decline\`、\`nod triage duplicate\` は人だけが実行できる。
受け入れ・却下・重複の判断が必要なときは、人に判断を依頼する。
\`nod triage suggest <id>\` は重複・ラベル・担当の候補を根拠つきで出す（読み取りのみ）。候補の採用も Triage の判断なので人だけが行い、LLM は候補を根拠に人へ伝えるだけにする。
LLM の判断は \`nod triage propose <id> --accept|--decline|--duplicate-of <元の id> [-l <label>] [--assignee <名前>] [-p 0-4] [--project <名前>] [--reason <理由>]\` で「提案」として記録する。提案は Triage の状態を変えず、同じ書き手の再提案は上書きされる。確定は人が Triage 画面か accept / decline / duplicate で行う。記録済みの提案は \`nod triage proposals <id>\` で確かめる。
1つの Issue を分担できる単位に分けるときは \`--parent <元の id>\` で Sub-issue にする。
Sub-issue がすべて完了した親は「完了候補」になる（\`nod issue list --completion-candidates\` で一覧できる）。
完了候補の親を done にするのは人である。LLM は親を完了にせず、人に完了の確認を依頼する。
説明の雛形（テンプレート）があるときは、\`nod template list\` で探し、\`--template <名前>\` で本文を説明の初期値にする。
雛形の空欄は \`nod issue update <id> -d "<説明>"\` で埋める。

## 最近の作業を要約する

\`nod summary [--since 24h|7d|<ISO日時>] [--project <名前>] [--all-workspaces] [--limit <n>] [--include-archived] --json\` は、期間内の動きを種類別に返す読み取り専用のコマンドである（既定は現在の Workspace の直近24時間、最長 90 日）。
種類は 完了・レビュー提出・差し戻し・着手・ブロッカー（\`blocker\` の作業ログと \`nod issue fail\`）・質問・回答・新規起票・キャンセル・アーカイブで、各項目の \`actorKind\` が \`human\`（me）か \`llm\` かを示す。種類ごとに新しい順で \`--limit\` 件（既定20）まで並べ、残りは \`more\` に数える。アーカイブ済み Issue の動きは既定で除く。
数えるのは期間内に起きた動き（event）の数である。完了は done への遷移ごとに数えるため、いま done の Issue を closed_at で数える Analytics とは、再オープンや同じ Issue の再完了があると一致しない。完了の \`actor\` は、完了より前で最後に担当だった LLM（いなければ確定した人）になる。
これは材料であり、nod は文章の要約を作らない。自分の言葉でまとめを残すときは、関係する Issue へ \`nod issue comment\` で書くか、\`nod doc create\` で Document にする。

## そのほかのコマンド

- \`nod issue list [--status todo,in_progress] [--project <名前>] [-l <label>] [--all-workspaces] [--delegated]\`：\`--delegated\` は LLM に委任中の Issue を LLM ごとに出す
- \`nod issue update <id> [--title] [-d] [-p] [--estimate] [--due] [--add-label] [--remove-label] [--parent] [--project]\`：見積もりはポイント（1〜100 の整数）、期限は時刻なしの日付（1900-01-01 以降）。空文字で外す
- \`nod issue bulk-update <id...> [-s] [-p] [--assignee] [--project] [--estimate] [--due] [--add-label] [--remove-label]\`：複数の Issue に同じ変更を加える（1回100件まで）。1件でも失敗したら何も変えず、失敗した Issue と理由を返す。Triage の Issue の状態は変えられない
- \`nod issue comment <id> "<text>" [--reply-to <コメントID>]\`：コメントを書く。\`--reply-to\` でそのスレッドに返信する（コメントIDは \`nod issue show\` の \`#番号\`）
- \`nod issue resolve <id> <コメントID> [--reopen]\`：スレッドを解決済み・未解決にする。人だけが実行できる（LLM は FORBIDDEN_FOR_LLM）
- \`nod issue relate <id> --blocks <id> | --related <id> | --duplicate-of <id>\`
- \`nod issue pr-status <id> [--refresh]\`：PR のレビュー・CI・マージの状態を表示する。\`--refresh\` で gh から取得して保存する（GitHub へは読み取りのみ。LLM も実行できる）。取得に失敗しても終了コードは0で、\`fetchError\` に理由（GH_NOT_INSTALLED、GH_AUTH、PR_NOT_FOUND、NETWORK、TIMEOUT など）が入る
- \`nod issue pr-diff <id> [--refresh] [--file <パス>]\`：PR の変更ファイル（パス・状態・+/-行数）を表示し、\`--file\` でそのファイルの unified diff を出す。\`--refresh\` で gh から PR の HEAD に固定した差分を取得して保存する（GitHub へは読み取りのみ。LLM も実行できる。gh の呼び出しごとに15秒で時間切れ）。上限はファイル 300 件・全体 5 MB（超えると DIFF_TOO_LARGE）、1ファイル 200 KB か 5,000 行を超えるものとバイナリは本文を保存しない。PR 状態の取得で別の HEAD を知ると古い差分は出さず \`stale\` に両方の HEAD が入る
- \`nod project list\`、\`nod project show <名前>\`
- \`nod project update <名前かID> --status planned|started|completed|canceled\`：Project の状態を変更する（所属 Issue の状態は変えない）
- \`nod template list\`、\`nod template show <名前>\`
- \`nod workspace labels list\`：この Workspace のラベル定義（名前・色・説明）を見る。定義のないラベルも付けられる。定義の変更は人だけが行える
- \`nod workspace status-names show\`：ステータスの表示名を見る。表示名を変えたステータスはテキスト出力で「表示名 (内部値)」と出る。\`--status\` と \`--json\` は常に内部値（todo など）を使う。表示名の変更は人だけが行える

どのコマンドも \`--json\` を付けると JSON で出力する。
失敗すると終了コードが1になり、\`--json\` のときは \`{"error": {"code", "message"}}\` を返す。

## エラーへの対処

- NOT_INITIALIZED：このリポジトリは nod に登録されていない。人に \`nod init\` を依頼する。
- NOT_ACCEPTED：その Issue はまだ Triage にある。着手せず、別の Issue を取る。
- FORBIDDEN_FOR_LLM：人だけが行える操作である。書き手を変えて回避せず、人に判断を依頼する。
- NEEDS_CLARIFICATION：その Issue には、人が決めていない未決事項が残っている。着手せず、別の Issue を取る。
- ASSIGNED_TO_OTHER：その Issue はほかの書き手が担当している。着手せず、別の Issue を取る。
- AWAITING_ANSWER：その Issue には未回答の確認依頼がある。回答が来るまで着手せず、別の Issue を取る。
- BLOCKED：その Issue は message に挙がった Issue にブロックされている。それらが終わるまで着手せず、別の Issue を取る。
- ISSUE_ARCHIVED：その Issue はアーカイブ済みで、変更できない。復元（\`nod issue unarchive\`）は人だけが行えるため、必要なら人に依頼し、別の Issue を取る。
- NOT_IN_PROGRESS：done は着手中の Issue にしか使えない。先に \`nod issue start <id>\` で着手する。
- DB_BUSY：ほかの処理が書き込み中である。少し待って再実行する。
- SECRET_DETECTED：作業ログに秘密値らしき値が含まれていた。値を伏せて書き直し、再実行する。
- INVALID_ARGS、INVALID_STEP：message の例に従って引数を直し、再実行する。

## 停滞候補とブロッカーの確認

\`nod issue diagnose --stale-days 7 [--project <名前/ID>] --json\` は現在のWorkspaceを診断する。日数は正の整数で必ず指定する。
未完了の直接blocksと、in_progress / in_review / needs_clarificationで指定日数以上活動記録がない候補を返す。実際の作業停止を断定しない。
最終活動はIssue作成・更新、event、コメント、質問作成・回答の有効日時の最大値。日時はUTCの経過時間で比較し、閾値一致を含む。未来日時は停滞としない。
done / canceledは対象外。未来までsnoozeされたIssueは停滞判定から除くが、ブロッカー情報は残す。担当者による制限はない。
ブロック元は別Workspace・ProjectでもIDを示し、完了・中止済みと推移的な関係は含めない。
JSONはevaluatedAt、staleDays、findingsを返し、空結果はfindings: []となる。診断で状態・担当・eventを変更せず、claim・Orca通知を行わない。通常のCLI起動時のDB初期化・migrationは既存通り。
この出力を根拠に人へ状況を伝え、LLMによるTriage判断やdoneへの変更は行わない。
`;
