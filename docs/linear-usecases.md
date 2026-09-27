# Linear のユースケース整理

Nod の UI と機能を Linear をベースに設計するため、Linear でできることをユースケースとして書き出す。
この資料のユースケースは、原則としてすべて Nod で採用する（2026-09-27 に合意）。
例外は、第14節の MCP と API（INT-03、INT-04）であり、LLM の操作手段を CLI に絞るため採用しない。

## 前提

利用形態は個人利用とし、チームに関わる機能は対象外とする。
Linear の Team は Workspace の下位で作業を分ける単位だが、個人利用では Workspace と一致するため、独立した概念としては扱わない。

アクターは次の二つである。

- **私**：人間の利用者。UI を通じて状況を把握し、判断する。
- **LLM**：Claude Code と Codex。nod の CLI（`nod`）と Agent Skill を通じてイシューを読み書きし、作業する。

ユースケースは「<アクター>が<対象>を<操作>できる」の形で書く。
両方のアクターに当てはまるものは「私 / LLM が」と併記する。


## 用語

Nod の用語は Linear に合わせる。
Orca の概念とは、次のように対応させる。データの持ち方は [nod 設計](./superpowers/specs/2026-09-27-nod-design.md) で定める。

| Nod の用語 | Linear での意味 | Orca での対応 |
|---|---|---|
| **Workspace** | 利用の最上位の単位 | Orca のプロジェクト |
| **Project** | Issue を目的ごとに束ねる単位 | なし（Workspace をまたいでよい） |
| **Issue** | 作業の単位 | なし |
| **Sub-issue** | Issue の下に分割した Issue | なし |

「プロジェクト」という語は、Orca では Workspace を、Linear では Project を指す。
この資料では混同を避けるため、両者を英語表記の Workspace と Project で書き分ける。
本文中の「イシュー」は Issue を指す。

ID に `†` を付けた行は、公式ドキュメントで今回確認できていない。
Linear の既知の機能として記載しているが、採用を検討する際は挙動を確かめる必要がある。

## 1. Workspace

| ID | ユースケース | Linear での実現 |
|---|---|---|
| WS-01 | 私が Workspace を切り替えられる | サイドバー左上の Workspace 切り替え |
| WS-02† | 私が Workspace の初期設定（ステータス定義、ラベル、テンプレート）を変更できる | Settings |
| WS-03 | 私が LLM に守らせる作業規約を登録できる | Agent guidance（Markdown で記述） |
| WS-04 | 私が LLM に Workspace へのアクセス権を与えられる | Agent のインストールと権限付与、MCP の OAuth 認可 |

## 2. イシューの作成と編集

| ID | ユースケース | Linear での実現 |
|---|---|---|
| ISS-01 | 私 / LLM がイシューを作成できる | `C` キー、作成モーダル、MCP の create issue |
| ISS-02† | 私がテンプレートからイシューを作成できる | Issue templates |
| ISS-03 | 私がイシューのタイトルと説明を編集できる | イシュー詳細画面（Markdown エディタ） |
| ISS-04 | LLM がイシューのタイトルと説明を更新できる | MCP の update issue |
| ISS-05† | 私 / LLM がイシューにファイルやリンクを添付できる | 説明欄への貼り付け、Attachments |
| ISS-06† | 私がイシューを複製できる | Duplicate issue |
| ISS-07† | 私がイシューをアーカイブまたは削除できる | Archive、Delete |
| ISS-08† | 私が複数のイシューをまとめて編集できる | 複数選択（`X`、Shift+クリック）からの一括変更 |
| ISS-09† | 私が定期的に発生するイシューを自動作成させられる | Recurring issues |

## 3. イシューのプロパティ

| ID | ユースケース | Linear での実現 |
|---|---|---|
| PRP-01 | 私 / LLM がイシューのステータスを変更できる | Status（Backlog、Todo、In Progress、In Review、Done、Canceled） |
| PRP-02 | 私 / LLM がイシューの優先度を設定できる | Priority（No priority、Urgent、High、Medium、Low） |
| PRP-03 | 私 / LLM がイシューにラベルを付けられる | Labels（ラベルグループで分類できる） |
| PRP-04† | 私 / LLM がイシューに見積もりを設定できる | Estimate（ポイント） |
| PRP-05† | 私 / LLM がイシューに期限を設定できる | Due date |
| PRP-06 | 私がイシューの担当者を設定できる | Assignee |
| PRP-07 | 私がイシューを LLM に委任できる | Delegate（担当者は人間のまま、作業を Agent に委ねる） |
| PRP-08† | 私がプロパティをキーボードだけで変更できる | `S`（ステータス）、`P`（優先度）、`L`（ラベル）などのショートカット |

## 4. イシューの階層と関係

| ID | ユースケース | Linear での実現 |
|---|---|---|
| REL-01 | 私 / LLM がイシューを子イシューに分割できる | Sub-issues |
| REL-02† | 私が子イシューの進捗を親イシューで確認できる | 親イシュー詳細の子イシュー一覧と完了数 |
| REL-03 | 私 / LLM がイシュー間のブロック関係を設定できる | Relations（blocks / blocked by） |
| REL-04 | 私 / LLM がイシュー間の関連を設定できる | Relations（related） |
| REL-05 | 私 / LLM がイシューを重複としてまとめられる | Relations（duplicate of） |
| REL-06† | 私がブロックされているイシューを一覧で見分けられる | 一覧行のブロックアイコン、Blocked フィルタ |
| REL-07† | 私 / LLM が子イシューの完了に合わせて親イシューを自動で閉じられる | Parent auto-close の自動化設定 |

Sub-issue の親子関係は、Project への所属とは別に持つ。

## 5. 閲覧と絞り込み

| ID | ユースケース | Linear での実現 |
|---|---|---|
| VIW-01 | 私が自分の担当や委任済みのイシューを一覧できる | My issues（Assigned、Created、Subscribed、Activity のタブ） |
| VIW-02 | 私がイシューをリストで表示できる | List layout |
| VIW-03 | 私がイシューをボード（カンバン）で表示できる | Board layout |
| VIW-04 | 私がイシューをプロパティでグループ化、サブグループ化できる | Display options の Grouping、Sub-grouping |
| VIW-05 | 私がイシューの並び順を変更できる | Ordering（優先度、更新日、手動など） |
| VIW-06 | 私が一覧に表示するプロパティを選べる | Display properties |
| VIW-07 | 私が完了済みイシューや子イシューの表示を切り替えられる | Completed issues、Sub-issues の表示設定 |
| VIW-08 | 私がイシューを条件で絞り込める | Filter（`F` キー、AND / OR 条件） |
| VIW-09 | 私が絞り込み条件を保存し、ビューとして再利用できる | Custom views |
| VIW-10† | 私がよく見るビューやイシューをお気に入りに登録できる | Favorites（サイドバーに表示） |
| VIW-11 | 私 / LLM がイシューを全文検索できる | Search、MCP の find |
| VIW-12† | 私があらゆる操作をコマンドメニューから実行できる | Command menu（`Cmd+K`） |
| VIW-13† | 私がイシュー一覧をキーボードだけで移動、選択できる | `J` / `K` で移動、`Enter` で開く |
| VIW-14† | 私が一覧からイシューの中身をすぐ確認できる | Peek（`Space`） |

## 6. トリアージ

| ID | ユースケース | Linear での実現 |
|---|---|---|
| TRI-01 | 私が未整理のイシューを一か所で確認できる | Triage inbox |
| TRI-02 | 私が未整理のイシューを受け入れて Backlog / Todo に移せる | Accept |
| TRI-03 | 私が不要なイシューを却下できる | Decline（Canceled に移し、理由をコメントで残す） |
| TRI-04 | 私がイシューを既存イシューの重複としてまとめられる | Mark as duplicate |
| TRI-05 | 私が未整理のイシューを後回しにできる | Snooze（指定日時か、新しい動きがあるまで隠す） |
| TRI-06† | 私が担当者、ラベル、重複候補の提案を受けられる | Triage Intelligence |

Nod では Triage を採用する。
LLM が起票したイシューを、私が受け入れるまで LLM の作業対象から外すためである。
Triage の実現方法は、[nod 設計](./superpowers/specs/2026-09-27-nod-design.md) のステータスの節で定める。

## 7. 通知（Inbox）

| ID | ユースケース | Linear での実現 |
|---|---|---|
| INB-01 | 私が購読中のイシューの変化を通知で受け取れる | Inbox（メンション、ステータス変更、コメント、委任先からの応答など） |
| INB-02 | 私が対応が必要な通知だけを見分けられる | Priority タブ |
| INB-03 | 私が通知を既読 / 未読にできる | `U` キー |
| INB-04 | 私が通知をスヌーズできる | `H` キー |
| INB-05 | 私が通知を削除できる | `Backspace` |
| INB-06 | 私がイシューの購読を開始、解除できる | Subscribe、`Shift+S` で解除 |
| INB-07 | 私が通知画面からイシューのプロパティを直接変更できる | Inbox 上での操作 |
| INB-08 | 私がイシューにリマインダーを設定できる | Reminders |

## 8. コメントと議論

| ID | ユースケース | Linear での実現 |
|---|---|---|
| CMT-01 | 私 / LLM がイシューにコメントできる | コメント欄、MCP の create comment |
| CMT-02† | 私 / LLM がコメントにスレッドで返信できる | Threaded replies |
| CMT-03 | 私がコメントで LLM にメンションし、作業を依頼できる | `@` メンション（Agent セッションを開始する） |
| CMT-04† | 私がコメントのスレッドを解決済みにできる | Resolve thread |
| CMT-05† | 私がイシューの変更履歴を時系列で確認できる | Activity（プロパティ変更とコメントの時系列表示） |

## 9. LLM への委任と作業の監督

Linear は、イシューを Agent に委任すると Agent session を作り、その進行を UI に表示する。
session の状態は `pending`、`active`、`awaitingInput`、`error`、`complete`、`stale` の6種類である。
Agent は作業中の出来事を thought、action、elicitation、response、error の5種類の activity として記録する。

| ID | ユースケース | Linear での実現 |
|---|---|---|
| AGT-01 | 私がイシューを LLM に委任して作業を開始させられる | Delegate、`@` メンション |
| AGT-02 | LLM が委任されたイシューを受け取り、作業を開始できる | Agent session の `created` イベント |
| AGT-03 | LLM が作業の計画をチェックリストとして示せる | Agent plan（手順ごとに pending、inProgress、completed、canceled） |
| AGT-04 | LLM が作業中の思考と実行内容を記録できる | activity（thought、action） |
| AGT-05 | 私が LLM の作業状況（作業中、入力待ち、エラー、完了）を確認できる | session の状態表示 |
| AGT-06 | 私が LLM の作業の経過を時系列で追える | activity タイムライン |
| AGT-07 | LLM が私に確認や判断を求められる | activity（elicitation）、状態 `awaitingInput` |
| AGT-08 | 私が LLM からの確認に回答できる | 追加の指示（prompt）を送る |
| AGT-09 | 私が作業中の LLM に追加の指示を出せる | prompt |
| AGT-10† | 私が LLM の作業を止められる | Stop（Agent interaction の資料には記載がない） |
| AGT-11 | LLM が作業結果を報告できる | activity（response） |
| AGT-12 | LLM がエラーで作業を中断したことを報告できる | activity（error）、状態 `error` |
| AGT-13 | 私が LLM の作業画面（外部）を開ける | External URL |
| AGT-14 | 私が LLM の作成したプルリクエストをイシューから開ける | session に紐づく PR リンク |
| AGT-15 | 私が LLM ごとに委任中のイシューを一覧できる | Agent のユーザーページ、My issues、Delegate フィルタ |
| AGT-16 | 私が LLM の作業完了や入力待ちを通知で受け取れる | Inbox への通知 |

2026年6月に追加された Coding sessions では、委任したイシューの実装からプルリクエストのマージまでを Linear 上で扱える。

| ID | ユースケース | Linear での実現 |
|---|---|---|
| AGT-17 | 私が LLM の作った差分をイシューに紐づけてレビューできる | Reviews タブ（差分、スクリーンショット、録画） |
| AGT-18 | 私が LLM の作ったプルリクエストを承認できる | Approve（レビュー依頼の前に承認する） |
| AGT-19 | 私がプルリクエストを Linear からマージできる | Merge |
| AGT-20 | 私が LLM にレビュー指摘への対応やリベースを任せられる | Delegate review actions |
| AGT-21 | 私が LLM の推論の経過をイシューの文脈で確認できる | session context |

Linear Agent は、イシューの読み書きに加えて、Workspace 全体を見渡す作業も受け持つ。

| ID | ユースケース | Linear での実現 |
|---|---|---|
| AGT-22 | LLM が停滞しているイシューやブロッカーを指摘できる | Linear Agent（リスクの検出） |
| AGT-23 | LLM が次に着手すべきイシューを提案できる | Linear Agent（優先順位の提案） |
| AGT-24 | LLM が未整理のイシューをトリアージできる | Linear Agent（トリアージ） |
| AGT-25 | LLM が最近の作業を要約できる | Linear Agent（要約、状況報告） |
| AGT-26 | 私が LLM に定型作業を定期実行させられる | Linear Agent（scheduled loops） |

## 10. Git 連携

| ID | ユースケース | Linear での実現 |
|---|---|---|
| GIT-01 | 私 / LLM がイシューに対応するブランチ名を取得できる | Copy git branch name（`Cmd+Shift+.`） |
| GIT-02 | 私 / LLM がイシューとプルリクエストを紐づけられる | ブランチ名、PR タイトル、本文にイシュー ID を含める |
| GIT-03 | 私 / LLM がプルリクエストの状態に合わせてイシューのステータスを自動で進められる | GitHub automations（PR 作成で In Progress、マージで Done など） |
| GIT-04 | 私がイシュー詳細からプルリクエストの状態（レビュー、CI、マージ）を確認できる | PR attachment |
| GIT-05 | 私 / LLM がコミットメッセージからイシューを閉じられる | Magic words（`Fixes ABC-123` など） |

## 11. ドキュメント

| ID | ユースケース | Linear での実現 |
|---|---|---|
| DOC-01† | 私 / LLM が設計メモなどのドキュメントを作成できる | Documents |
| DOC-02† | 私 / LLM がドキュメントとイシューを相互にリンクできる | ドキュメント内のイシュー参照、イシュー作成 |

## 12. 自動化

| ID | ユースケース | Linear での実現 |
|---|---|---|
| AUT-01† | 私が長期間更新のないイシューを自動で閉じさせられる | Auto-close |
| AUT-02† | 私が完了したイシューを自動でアーカイブさせられる | Auto-archive |
| AUT-03† | 私がステータスの遷移ルールを定義できる | Workflow settings |

## 13. 分析

| ID | ユースケース | Linear での実現 |
|---|---|---|
| ANL-01† | 私が完了数や作業時間の推移を確認できる | Insights |
| ANL-02† | 私が LLM の作業量を確認できる | Insights（Agent の活動も集計対象） |
| ANL-03† | 私が最近の動きの要約を読める | Pulse |

## 14. データの取り込みと連携

| ID | ユースケース | Linear での実現 |
|---|---|---|
| INT-01† | 私が他のツールからイシューを取り込める | Importers（GitHub Issues、Jira など） |
| INT-02† | 私がイシューを CSV で書き出せる | Export |
| INT-03（不採用） | LLM が MCP 経由でイシューの検索、作成、更新、コメントをできる | Linear MCP server |
| INT-04†（不採用） | LLM が API 経由でイシューを読み書きできる | GraphQL API、Webhooks |

## LLM の操作手段

LLM は、MCP サーバーを介さず、nod の CLI（`nod`）を実行して Workspace を操作する。
`nod` の使い方は、LLM 向けの Agent Skill で伝える。

この Agent Skill の形は、Orca の `orca-cli` を参考にする。
`orca-cli` の SKILL.md は、起動条件と手引きの取得方法だけを書いた短い入口であり、コマンドの詳細はバイナリ自身が出力する手引きに任せている。
こうすると、Skill の記述と実際のコマンドの版がずれない。

第9節の LLM 側のユースケース（計画、経過、作業状況、確認依頼、結果報告）の実現方法は、[nod 設計](./superpowers/specs/2026-09-27-nod-design.md) で定める。

## 15. イシューをまとめる上位概念

Linear には、イシューを束ねる上位の単位として Project、Initiative、Cycle、Milestone がある。
Nod では、イシューをまとめる概念として Project を採用する。
Linear は個々の Project をサイドバーに並べず、サイドバーには Projects 一覧への入口だけを置く。
個々の Project がサイドバーに現れるのは、利用者がお気に入りに登録したときに限られる（この2文は公式ドキュメントで未確認）。

| ID | ユースケース | Linear での実現 |
|---|---|---|
| GRP-01 | 私 / LLM が目的ごとにイシューを Project にまとめられる | Projects |
| GRP-02 | 私が Project ごとの進捗と健全性を確認できる | Project の progress graph、status、health |
| GRP-03 | 私が Project に中間目標を設定できる | Project milestones |
| GRP-04 | 私が複数の Project を上位目標で束ねられる | Initiatives |
| GRP-05 | 私がイシューを期間（スプリント）で区切れる | Cycles |
| GRP-06 | 私 / LLM が Project の進捗報告を書ける | Project updates |

## 対象外としたチーム機能

次の機能はチーム運用を前提とするため、ユースケースに含めていない。

- メンバー招待、権限ロール、ゲスト
- 複数 Team の作成と Team 間のイシュー移動
- Triage の担当ローテーション
- 顧客要望の管理（Customer requests）、Linear Asks
- SLA

## 出典

- [Linear Docs](https://linear.app/docs)
- [Agents in Linear](https://linear.app/docs/agents-in-linear)
- [Linear Agent](https://linear.app/docs/linear-agent)
- [Coding sessions](https://linear.app/docs/coding-sessions)
- [My issues](https://linear.app/docs/my-issues)
- [GitHub integration](https://linear.app/docs/github)
- [Agent interaction（Developers）](https://linear.app/developers/agent-interaction)
- [Linear MCP server](https://linear.app/docs/mcp)
- [Triage](https://linear.app/docs/triage)
- [Inbox](https://linear.app/docs/inbox)
- [Display options](https://linear.app/docs/display-options)
- [Projects](https://linear.app/docs/projects)
