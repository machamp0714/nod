---
name: implement
description: "nod の Issue の要求を、既存計画または軽い Task ごとに新しいエージェントで実装し、止まらずに最後まで進める。Task ごとに Step・コミット・作業ログを残し、最後に nod:code-review を 1 回実行する。"
disable-model-invocation: true
---

<!-- mattpocock/skills の engineering/implement（c55ee46）を元に、計画の完走と nod への記録を足した。tdd は呼び出す。 -->

# nod:implement

Issue の要求を最後まで実装する。既存の計画（`nod:to-plan` で作った Task と Step）があれば依存の順に使い、なければ本文を正本に必要な作業だけを追跡する。途中でユーザーの確認を挟まない。中断しても、nod の Step の状態と作業ログから別の LLM が再開できるように記録を残す。

引数: `<Issue id>`（必須）。

## 0. 準備

- Codex で動いているときは、nod に書き込む前に `export NOD_ACTOR=codex` を実行する。
- **デフォルトブランチ（main / develop など）の上なら、何もせずに止めて**、作業ブランチを作るよう伝える（`nod issue branch-name <id>` で候補が得られる。GitHub に出るブランチ名・コミット・PR には nod の Issue ID を書かない）。判定状態や needs-spec による停止は以下に従う。
- 作業ツリーに、この Issue と関係のない未コミットの変更があれば触らない（stash もしない）。コミットには自分の変更だけを入れる。
- **start より先に** `nod issue show <id> --json` で本文、ラベル、`specAssessment`、計画（Task・Step の状態）、Documents、Activity（作業ログ）を読む。kind=spec の Document があれば全文読む。
- Issue の Workspace で `nod workspace spec-assessment show --json` を読み、現在の `enabled` を確認する（別 Workspace の Issue は、その Workspace を指定して確認する）。
- Workspace が有効で、`specAssessment` があり、`status` が `pending` または `failed`、かつ `suspended` でも `recordOnly` でもない場合は、`nod issue assess <id> --json` で初回判定の回復を **1 回だけ**試み、`show --json` で状態を再確認する。まだ実効的な未完了・失敗なら、作成済みの同じ ID と安全な失敗種別を報告して止める。Issue を作り直さず、秘密値や未加工の API エラー本文を出さない。
- `specAssessment` がない（null／省略）場合は対象外、`suspended` は Workspace の無効化による制限解除、`recordOnly` は初回判定後の任意再評価である。これらの履歴上の待機・失敗で実装を止めない。設定の無効化やラベル削除を LLM が制限回避のために行わない。
- 現在のラベルに `needs-spec` があれば、`nod:to-spec <id>` へ案内して実装を始めずに止める。仕様書があっても同じ。仕様確定後の解除は人間が行い、LLM は自動解除しない。
- `needs-spec` がなく判定完了済み（任意再評価中も含む）または対象外・制限解除済みなら `nod issue start <id>` を実行する。差し戻しの理由や追加指示が出たら先に読んで反映する。
- spec・plan・事前の `nod:to-plan` は必須にしない。既存 spec と計画は引き続き使う。spec がなければ Issue 本文の要求と完了条件を正本にする。見出しやチェックボックスの有無、短文であることだけで仕様不足と決めない。
- 計画がなければ本文から実装・検証できる範囲の軽い Task・Step を作業追跡用に記録する（例: `nod issue plan <id> --step "本文の要求を実装・検証する"`）。計画 Document の作成や別工程の承認を増やさない。重要な利用者向け仕様を決めないと進められない場合だけ、未決事項を `nod issue ask` に記録して止める。

## 1. 再開位置を決める

- 状態が done / skipped の Task は飛ばす。
- doing の Task があれば、中断した作業である。作業ログの最後の記録と `git log` / `git status` を見て、どこまで進んだかを確かめてから続ける。
- 依存先（Task タイトル末尾の「依存: …」）がすべて done の Task のうち、番号の小さいものから進める。

## 2. Task を 1 つずつ実装する

各 Task について次を行う。

1. `nod issue step <id> <N> doing` にする。
2. **新しいエージェントに任せる。** ハーネスにサブエージェントがあれば、Task ごとに新しいものを起動する（前の Task の文脈を持ち込まない）。無ければ、このセッションで順に実装する。渡す内容:
   - Issue id、Task N のタイトルと Step（受け入れ条件）、仕様書のパス（なければ Issue 本文の全文と、それが正本であること）
   - 仕様の Testing Decisions に書かれた seam で、Skill ツールの `tdd` を使ってテスト先行で実装すること（合意済みの seam は確認し直さない）。仕様書がなければ本文の完了条件と既存テストを基に、外から観測できる既存の境界で検証し、その選択を記録する
   - 型チェック（あれば）と単体のテストファイルをこまめに実行すること。テストの実行方法はリポジトリの CLAUDE.md / AGENTS.md に従う
   - コミットしないこと、`nod:implement` / `nod:code-review` を呼ばないこと、エージェントを増やさないこと
   - 終わったら、変えた内容・実行したテストと結果・判断したこと・残った懸念を報告すること
3. 結果を確かめる。差分が Task の範囲に収まっているか、Step を満たしているかを見る。足りなければ同じ Task を続けさせる。
4. 満たした Step を `nod issue step <id> <N.M> done`、Task を `nod issue step <id> <N> done` にする。満たせなかった Step は skipped にせず doing のまま残し、ログに理由を書く。
5. **コミットする。** メッセージはリポジトリの既存のコミットの書き方に合わせる。nod の Issue ID は書かない。対応する GitHub Issue がコードと同じ repo にあるときだけ、作業が済んだ最後のコミットに `Fixes #<GitHub の番号>` を付ける（途中のコミットには付けない）。
6. **作業ログを残す**（引き継ぎの正本）。
   - `nod issue log <id> "Task N 完了: <何ができたか>。コミット <短い sha>。次: Task M" --kind progress`
   - 実行したテストと件数・成否を `--kind test` で 1 件
   - 選んだ案と理由があれば `--kind rationale`
   - ログは要点だけにする（1 件 4000 字まで）。秘密値は書かない。

### 詰まったとき

- 仕様で決まっていない判断は、仕様と既存コードに最も沿う案を選んで進め、`--kind rationale` に残す。ユーザーに止めて聞くのは、どの案を選んでも仕様を満たせないときだけ（`nod issue ask <id> "<質問>"`）。
- 進められない Task は `--kind blocker` に原因と必要なものを残し、その Task に依存する Task も飛ばす。依存しない Task は続ける。

## 3. 仕上げ

1. テストスイート全体を 1 回実行し、`--kind test` に残す。
2. **`nod:code-review` を新しいエージェントで 1 回実行する。** 基点はデフォルトブランチとの merge-base、仕様はこの Issue の kind=spec の Document、なければ Issue 本文の全文と完了条件。Spec 軸は省略しない。書いたこのセッションではレビューしない（確証バイアスを避けるため）。
3. レビューの指摘は直さない。要点を `nod issue log <id> "<観点ごとの指摘の要約>" --kind progress` に残し、報告に載せる（何度回しても新しい指摘が出るので、自動で直すと終わらない）。
4. `nod issue done` は実行しない（レビューへの提出は PR を作ってから）。

## 4. 報告と完了時のネクストアクション

終えた Task・飛ばした Task とその理由・テストの結果・レビューの指摘を簡潔に報告する。続けて、次の一手を番号付きで示し、おすすめを 1 つ理由つきで添えて、ユーザーの選択を待つ（自分から次へ進まない）。指摘の有無でおすすめを変える。

1. レビューの指摘に対応する
2. PR を作る（PR のタイトル・本文に nod の Issue ID を書かない）。作ったら `nod issue link-pr <id> <URL>` で紐付ける。PR 連動が有効な Workspace ではこの時点で in_review に進むので、`nod issue done` は要らない（実行すると NOT_IN_PROGRESS で失敗する）。紐付けた後も in_progress のままなら、`nod issue done <id> --summary "<要約>"` で提出する
