# 隔離修正とpatch受け渡し

自動修正を利用者が明示した場合だけ使う。通常レビューと `nod:implement` からの最終レビューでは自動的に有効にしない。
確認済みの `required` だけが修正対象。任意改善、未確認の懸念、新しい仕様判断、仕様書を書き換えることでの合格を含めない。

## 1. 修正モデルと準備計画を確認する

修正providerとモデル設定を利用者の指定から得る。修正モデルは実装モデル集合に属し、レビューの実効モデルと異なる必要がある。Codex修正providerも現在は実効値確認不能で停止する。

固定規約に従う隔離環境と必要な検証を決め、`--repair-plan` 用JSONを実行用の一時ディレクトリへ保存する。規約の出典とhashは準備結果の `sources` から取得する。

```json
{
  "version": 1,
  "isolation": "copy",
  "rationale": "固定規約に照らした環境準備の根拠",
  "standards": [
    { "source": "standard:AGENTS.md", "hash": "準備結果の規約hash" }
  ],
  "prepare": [],
  "verify": [
    { "command": "bun", "args": ["test"], "rationale": "この変更に必要な検証の根拠" }
  ]
}
```

例をそのまま実行せず、対象repoの全固定規約と必要なコマンドへ置き換える。規約が存在しない場合だけ `standards=[]` にする。`verify` は空にできない。

各固定規約の全文を読み、`Orca`・`worktree`・`Docker`・`husky` に言及する行ごとに、該当する `standards` 要素の `environment` 配列へ次の記録を加える（大文字小文字は区別しない）。言及のない資料では省略できる。

```json
{
  "line": 34,
  "quote": "指定Workspaceと固定CycleのIssueをOrcaで監督する。",
  "kind": "informational",
  "rationale": "PM機能の説明であり、この修正の作業領域にOrcaを要求していない。"
}
```

行番号は1始まり、引用は固定sourceの行全文。文脈を読んで、適用される必須の環境準備指示なら `required`、単なる機能説明・今回適用されない指示なら `informational`、判断不能なら `unresolved` とし、理由を書く。同じ行に必須指示と説明が混在すれば `required` とする。例の分類をそのまま転用しない。
CLIは全言及の網羅・出典hash・行・引用・分類・理由を照合する。`required` は専用adapter未対応として停止し、欠落や `unresolved` も未完了とする。意味の判断は規約を読む呼出側の責務であり、CLIの照合だけで自然言語の解釈を証明したと扱わない。準備計画は保存され、後から判断の根拠を確認できる。

モデルが返した任意shellを準備計画として実行しない。本番データ生成、外部サービスへの書込、環境規約の迂回を検証の都合で行わない。

現在はmacOSのcopy adapterと `sandbox-exec` が必要。ネットワーク・元repo読取・秘密候補読取・隔離領域外書込は禁止され、必要な依存や検証がこの条件内で成立する必要がある。
Orca・worktree・Docker・husky等の専用準備規約に対応するadapterは未実装で `REPAIR_PREPARATION_UNSUPPORTED` になる。他リポジトリの専用準備を汎用コピーで代替しない。nodも隔離内で必要検証が成立しなければ未完了にする。

## 2. 明示した修正モードで実行する

通常の `nod review run` 引数に次を追加する。

```sh
--auto-repair --repair-provider claude \
  --repair-model '<実装側の修正モデル設定>' --repair-plan /path/to/repair-plan.json
```

1回だけの修正を指定された場合は `--auto-repair` の代わりに `--repair-once` を使う。併用しない。
初回レビュー後、確認済み指摘の隔離修正・必要な検証・新しいコンテキストによる3工程の再レビューを最大3回、全体30分で行う。
同じ原因の再発、原因数が減らない、重大化、対象treeの循環、失敗・未確認・期限で停止する。満点になるまで上限を延長しない。

自動チェックは外側の修正・受け渡し制御が担当し、レビューへ結果を渡さない。チェック失敗をレビュー指摘や次の修正課題に変換しない。現在の実装は固定修正版を再レビューした後、独立チェックを実行する。両結果を受け渡し条件として確認し、チェック失敗時も `repair.reviewPath` のレビュー結果を保持する。全体の最終点数はnullでも、独立したレビューの点数まで変更しない。

## 3. patchと対象版を報告する

`--auto-repair` の成功は最上位 `completed`、`score=5`、`autoRepair.status=patch_ready`。`application=not_applied`、`applied=false` を必ず併記する。
必要な検証・両軸レビューが完了し、要求と元対象が最終照合時に不変で、累積patchの保存が成功したことを確認する。照合後の編集をロックした保証ではない。
点数は `autoRepair.patchTarget` の隔離修正後の固定内容だけに対応し、元HEAD・現在の作業ツリーへの承認ではない。
`not_needed` は初回に要対応がなく修正していない状態。1回修正では `repair.status=ready` と最上位の完了状態・対象を併せて確認する。

`initialReviewPath`、最終 `artifactPath`、累積 `autoRepair.patchPath`、各回の `history` を報告する。
失敗時のpatchは未検証の変更を含み得るため適用可能とは説明しない。最終scoreはnullのまま、各回の保存済み成果と停止理由を残す。

初版はpatchの受け渡しまで。元のファイル・indexへの適用、commit、push、PR投稿、マージを自動実行しない。patch適用を別途依頼された場合は、その時点の対象と変更を確認する独立作業とする。
