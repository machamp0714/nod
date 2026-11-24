---
name: nod
description: >-
  このリポジトリの Issue（タスク）を nod CLI で読み書きする。
  作業を始めるとき、次にやることを探すとき、計画や経過や完了を報告するとき、
  人に確認したいことがあるとき、新しい不具合や作業を見つけて起票するときに使う。
  「Issue」「タスク」「nod」「次の作業」「完了を報告する」「起票」などで起動する。
---

# nod

この SKILL.md は入口であり、使い方の本文ではない。
本文は、実際に動く nod 自身が出力する。

作業の前に、次を実行して手引きを読み、その内容に従う。

    nod skills get nod

`nod` が見つからない場合は、人に nod のインストールを依頼する。

## 書き手と操作

書き手は `NOD_ACTOR` → `OMPCODE=1`（omp）→ `CLAUDECODE=1`（claude-code）→ `CODEX_THREAD_ID`（codex）→ me の順で決まる。
明示指定が必要なら `NOD_ACTOR` を使う。未設定でも書き込みは止まらず、書き手は記録用で操作の許可や人の承認の証明には使わない。
CLI 起票は既定 Triage、利用者の依頼に `--requested` を付けると Todo。Web 起票、複製、定期 Issue は Todo に入る。
戻せない CLI 削除と公開の結果不明の解除には `--yes` が必要。公開は `--yes` があれば非対話でも送れ、なければ TTY で [y/N]、非対話では NOT_INTERACTIVE で止まる。
通知、購読、リマインダーは me の分を対象にし、操作者を別に記録する。`nod notification history` で操作履歴を読む。

## 実装前の仕様要否判定

`nod:implement` は start より先に Issue の判定状態を確認する。初回判定が未完了・失敗なら同じ Issue を `nod issue assess <id>` で一度再試行し、回復しなければ止める。対象外や Workspace 無効化による制限解除と、未判定を混同しない。
`needs-spec` があれば `nod:to-spec` へ進み、実装を始めない。初回判定後のラベルは原則として人間が管理する。`nod:to-spec` は仕様書の作成・添付の完了を確認して `nod issue update <id> --remove-label needs-spec` で解除する。本文変更や仕様 Document の添付だけではシステムによる自動更新・解除は行わない。
needs-spec がなく判定完了済みか対象外・制限解除済みなら、独立した spec・plan がなくても本文の要求と完了条件を正本として実装できる。既存の spec・plan があれば使い、レビューでは本文を根拠に Spec 軸を必ず実行する。

## Issue の開始と再開

着手条件を満たしていれば、どの書き手でも `nod issue start <id>` で開始または再開できる。
開始するたびに Activity に記録され、開始前の作業状況と、作業場所が変わった場合の前のブランチと worktree が返る。
追加指示は `nod issue show <id>` で参照できる。
確認済みになるのは、書き手によらず `nod issue start <id>` で受け取ったときだけである。

## レビュー提出と作業の完了

PR を含む依頼では、必要な実装・検証・独立レビューを済ませ、PR を作成して `nod issue link-pr <id> <URL>` で紐付ける。レビュー依頼時に `nod issue update <id> --status in_review` で In Review に移し、提出として報告する。提出しただけでは Done にしない。
merge と Issue の完了条件を確認した人または権限のあるエージェントが `nod issue done <id> --summary "<実装内容と検証結果>"` で完了する。In Progress と In Review の双方から使える。PR が不要なら必要な検証・完了条件を満たして直接 Done にできる。
完了後に別途 PR 作成を頼まれた場合は、レビュー依頼時に明示的に In Review へ戻す。指摘対応は `nod issue start <id>` で再開する。
draft は原則 In Progress、merge せず close したら継続は In Progress、中止は理由付き Canceled、後回しは Todo/Backlog に明示的に移す。reopen 後はレビューなら In Review、修正なら In Progress にする。
PR の作成・紐付け・状態取得・取得失敗・merge・close・reopen は Issue の状態を自動変更しない。コードレビューと GitHub の PR レビューは独立して行う。PR 作成・承認・merge・本番反映の権限は依頼と既存運用に従い、拡張しない。
