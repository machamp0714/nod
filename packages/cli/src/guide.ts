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
   ファイルは添付ディレクトリ（\`NOD_ATTACHMENTS_DIR\`）にコピーされ、10MB まで（録画の mp4/webm は 100MB まで）、拡張子は png/jpg/jpeg/gif/webp/mp4/webm/pdf/txt/log/md/csv/json/yaml/yml/zip に限られる。画像と録画は Web の Issue 詳細と Reviews で表示・再生してレビューできる。symlink は添付できない。
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
8. 作業中に PR（draft を含む）を作ったら、その時点で \`nod issue link-pr <id> <PR の URL>\` で Issue に紐付ける（ステータスは変わらない）。
   Workspace で PR 連動が有効なら、PR が open（draft 以外）かマージ済みになったあとの \`nod issue pr-status <id> --refresh\` で in_review に進む（done にはならない）。
   終えたら \`nod issue done <id> --summary "<やったことの要約>" [--pr <URL>]\` でレビューに回す。
   Issue を自分で done にしない（nod issue update --status done は拒否される）。done にするのは、レビューを終えた人である。
   人の \`nod review approve\`（nod の承認）は Issue を done にするだけで、GitHub の承認・マージではない。nod は GitHub の PR に承認・マージを書き込まず、\`gh pr review\` も \`gh pr merge\` も実行しない。PR の承認・マージは GitHub 側で別に行う。
9. レビューで差し戻されると、Issue は in_progress のまま残る。\`nod issue show <id>\` で差し戻しの理由を読み、\`nod issue start <id>\` で再開する。
   \`nod issue start\` は、まだ受け取っていない追加指示を \`pendingInstructions\`（テキストでは「追加指示」）で返す。先に読んで対応する。
   担当の LLM が \`nod issue show\` の「未確認の追加指示」で読んだ指示は確認済みになり、\`nod issue start\` では渡し直されない。
   人は差し戻しで「対応依頼」を付けることがある。種類は \`review_fix\`（指摘対応）と \`rebase\` で、本文に理由と手順が書かれている。
   - 指摘対応：理由に書かれた指摘に対応し、テストを実行してから \`nod issue done <id> --summary "<対応の要約>"\` で再提出する。
   - rebase：ベースブランチの最新に rebase して競合を解消し、テストを再実行して push してから \`nod issue done <id> --summary "<対応の要約>"\` で再提出する。
   稼働中のセッションには、人が確認画面で送ると端末に \`nod: <id> が差し戻されました。…\` という通知が届く。セッションが無いときは、次に \`nod issue start <id>\` したときに受け取る。
   差し戻された Issue は in_progress のため \`nod issue next\` には出ない。自分が担当していた Issue は \`nod issue list --status in_progress\` で確かめ、\`nod issue start <id>\` で拾う。

## 追加指示を受け取る

人は作業中の Issue に「追加指示」を残すことがある。追加指示は Issue のコメントとして残り、\`nod issue show <id>\` の Activity に [追加指示] と出る。
人が確認画面で送ると、Orca の端末に \`nod: <id> に追加指示があります（#<番号>）。nod issue show <id> で読んでください\` という短い通知が届く。
端末に届くのは通知だけで、指示の本文は nod にある。通知を受けたら \`nod issue show <id>\` で全文を読み、作業に反映する。
稼働中のセッションが無いときは送られない。次に \`nod issue start <id>\` したときに \`pendingInstructions\` で受け取る（LLM が受け取ると確認済みになる）。
\`nod issue show <id>\` の「未確認の追加指示」にも出る。担当の LLM が \`nod issue show\` で読むと確認済みになり、次の \`nod issue start\` では渡されない（人や担当でない LLM の show では変わらない）。\`nod issue instructions <id>\` で、これまでの指示と送信・確認の状態を一覧できる。
追加指示の記録（\`nod issue instruct\`）と端末への送信は人だけが行える（LLM は FORBIDDEN_FOR_LLM）。LLM は読むだけにする。

## 着手前に候補だけ確認する

\`nod issue suggest [--project <名前>] --json\` は、現在の Workspace と自分の担当条件に合う候補を1件返す。候補がなければ null を返す。
\`next\` と同じ着手条件と優先度順で選ぶが、Issue・担当・作業場所・時刻・履歴を変更せず、Orca にも通知しない。
提案は予約ではない。着手するときは \`nod issue next\` または \`nod issue start <id>\` を使う。その時点の条件を再確認するため、同じ候補に着手できるとは限らない。

## 定期Issueで起票された定型作業の扱い

人は定型作業（依存更新チェック、週次レポートなど）を、担当に LLM の名前（claude-code、codex など）を指定した定期Issueとして登録する。
起票するのは人の実行（\`nod recurring run\`、\`nod automation run\`、Web の「今すぐ実行」）だけで、nod が自動で起票することはない。
人の起票なので Triage を通らず todo で入り、担当の LLM の \`nod issue next\` に出る。ほかの LLM や担当なしの作業より先に取るわけではなく、優先度順に並ぶ。
遷移ルールで todo → in_progress が禁止されている Workspace では、\`nod issue next\` は TRANSITION_NOT_ALLOWED になる。ルールは変えられないので人に伝える。
\`nod issue show <id>\` の Activity の created に \`recurring_id\`（定期Issueの id）と \`occurrence\`（発生日）があれば、定期Issueで起票された Issue である。
進め方は通常の Issue と同じで、説明（テンプレートの手順と空欄）に従って作業し、空欄は \`nod issue update <id> -d "<説明>"\` で埋め、\`nod issue done <id> --summary "<要約>"\` でレビューに回す。done にするのは人である。
前回の発生日の Issue が残っていても、今回の Issue はそれとは別の作業として扱い、まとめて閉じない。前回分が不要そうなら人に伝える。
手順に書かれていない作業（依存のメジャー更新など）が見つかったら、自分で着手せずに \`--discovered-from <id>\` を付けて起票する。
周期・担当・テンプレートなど定期Issueの定義は変えられない（FORBIDDEN_FOR_LLM）。変えたほうがよいと思ったら \`nod recurring list\` で定義を確かめ、人に依頼する。
テンプレートの手順が古いときも、テンプレートは書き換えず、人に伝える（\`nod template add\` / \`remove\` は FORBIDDEN_FOR_LLM。\`nod template show\` で読むのはできる）。

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
アーカイブ済みの Issue の完全な削除（\`nod issue delete <id> --yes\`）も人だけが行え（LLM は FORBIDDEN_FOR_LLM）、記録は \`nod workspace audit\` で確認できる。
Workspace の自動化（\`nod automation set\` と \`nod automation run\`）の設定・実行は人だけが行える。\`nod automation run\` は定期Issueの起票も同じ回に行う。LLM は \`nod automation run --dry-run\` で対象（起票する定期Issueを含む）を確かめ、人に伝えるだけにする。
PR 連動・コミット連動による in_review への自動遷移の取消（\`nod automation undo <id>\`）も人だけが行える。
\`nod git sync\`（コミットメッセージの Closes/Fixes <ID> で Issue を in_review にする）の実行は人だけが行える。LLM は \`nod git sync --dry-run\` で対象を確かめ、人に伝えるだけにする。
コミットメッセージに Issue ID を書くときは、作業が済んだコミットだけに \`Fixes <ID>\` を付け、途中のコミットには付けない。
\`nod import github <owner/repo>\`（GitHub Issues の取り込み）の実行は人だけが行える。LLM は \`nod import github <owner/repo> --dry-run\` で取り込む内容と状態の対応を確かめ、人に伝えるだけにする。

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
Triage にある Issue の状態を \`nod issue update --status\` や \`nod issue bulk-update -s\` で変えて Triage から出すことも LLM にはできない（FORBIDDEN_FOR_LLM）。状態以外の項目は変えられる。
\`nod triage suggest <id>\` は重複・ラベル・担当の候補を根拠つきで出す（読み取りのみ）。候補の採用も Triage の判断なので人だけが行い、LLM は候補を根拠に人へ伝えるだけにする。
LLM の判断は \`nod triage propose <id> --accept|--decline|--duplicate-of <元の id> [-l <label>] [--assignee <名前>] [-p 0-4] [--project <名前>] [--reason <理由>]\` で「提案」として記録する。提案は Triage の状態を変えず、同じ書き手の再提案は上書きされる。確定は人が Triage 画面か accept / decline / duplicate で行う。記録済みの提案は \`nod triage proposals <id>\` で確かめ、自分の提案は \`nod triage propose <id> --withdraw\` で取り下げる。提案すると me の Inbox に通知が届く。
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
- \`nod issue link-pr <id> <url>\`：作業中の Issue に GitHub の PR を紐付ける（ステータスは変えない。LLM も実行できる）
- \`nod issue pr-status <id> [--refresh]\`：PR のレビュー・CI・マージの状態を表示する。\`--refresh\` で gh から取得して保存する（GitHub へは読み取りのみ。LLM も実行できる）。取得に失敗しても終了コードは0で、\`fetchError\` に理由（GH_NOT_INSTALLED、GH_AUTH、PR_NOT_FOUND、NETWORK、TIMEOUT など）が入る
- \`nod issue pr-diff <id> [--refresh] [--file <パス>]\`：PR の変更ファイル（パス・状態・+/-行数）を表示し、\`--file\` でそのファイルの unified diff を出す。\`--refresh\` で gh から PR の HEAD に固定した差分を取得して保存する（GitHub へは読み取りのみ。LLM も実行できる。gh の呼び出しごとに15秒で時間切れ）。上限はファイル 300 件・全体 5 MB（超えると DIFF_TOO_LARGE）、1ファイル 200 KB か 5,000 行を超えるものとバイナリは本文を保存しない。PR 状態の取得で別の HEAD を知ると古い差分は出さず \`stale\` に両方の HEAD が入る。\`--json\` の一覧は patch を含まないので、本文は \`--file\` で読む。双方向の制御文字は ⟪U+202E⟫ のように符号で表示する
- \`nod project list\`、\`nod project show <名前>\`
- \`nod project update <名前かID> --status planned|started|completed|canceled\`：Project の状態を変更する（所属 Issue の状態は変えない）
- \`nod project report add <名前かID> [--health on_track|at_risk|off_track] -- "<本文>"\`：Project に進捗報告を書く（10000 文字以内。本文は \`-\` で始まってもよいよう \`--\` の後ろに置く。Issue や Project の状態は変えない）。\`--health\` を添えると、その値が Project の現在の健全性になる（添えない報告は現在の健全性を変えない）。\`nod project report list <名前かID>\` で新しい順に読む
- \`nod project milestone add <Project> <名前> [--target YYYY-MM-DD] [-d <説明>]\`：Project に中間目標（Milestone）を作る。\`update <Project> <Milestone> [--name] [--target] [-d]\`（空文字で外す）、\`list\`（完了数/総数つき）も使える。\`remove\`（削除）は人だけが行える（LLM は FORBIDDEN_FOR_LLM）
- \`nod issue update <id> --milestone <名前かID>\`：Issue を同じ Project の Milestone に紐付ける（空文字で外す。Project を変えると外れる）
- \`nod initiative list [--all]\`、\`nod initiative show <名前かID>\`：複数の Project を束ねる上位目標と、配下 Project の Issue を合算した進捗（done/total）を見る
- \`nod initiative create <名前> [-d] [--target YYYY-MM-DD]\`、\`nod initiative update <名前かID> [--name] [-d] [--target] [--status planned|started|completed|canceled]\`、\`nod initiative add-project|remove-project <名前かID> <Project>\`：1つの Project を複数の Initiative に紐付けられる。Project・Issue の状態は変えない
- \`nod template list\`、\`nod template show <名前>\`
- \`nod recurring list\`、\`nod recurring run --dry-run\`（\`nod automation run --dry-run\` にも含まれる）：定期Issue（毎日・毎週・毎月に起票する Issue）と、次に起票する予定を見る。登録・変更・削除と実際の起票（--dry-run なし）は人だけが行える
- \`nod workspace labels list\`：この Workspace のラベル定義（名前・色・説明）を見る。定義のないラベルも付けられる。定義の変更は人だけが行える
- \`nod workspace status-names show\`：ステータスの表示名を見る。表示名を変えたステータスはテキスト出力で「表示名 (内部値)」と出る。\`--status\` と \`--json\` は常に内部値（todo など）を使う。表示名の変更は人だけが行える
- \`nod workspace transitions show\`：この Workspace のステータス遷移ルール（許可しない遷移）を見る。LLM の操作も自動化もルールに従う。ルールの変更は人だけが行える

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
- TRANSITION_NOT_ALLOWED：その状態変更は Workspace の遷移ルールで許可されていない（message にどのルールかが出る）。別の経路で回避せず、ルールに沿った状態を経由するか、人に判断を依頼する。
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
