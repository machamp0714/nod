## 管理情報（親が記入）

- runId: 
- 作業ディレクトリ: 
- 最終状態: 完了／未完了／未実施（理由）
- 点数: 0〜5／点数なし
- 点数の計算: 要対応の件数、各要対応の候補 ID と影響度、最も重い影響度（最小値）。要対応0件かつ必要な確認済みなら 5。軸間で平均せず、任意・棄却・基点から存在（対象外）は入れない。未実施・未完了は点数なし。5 点だけではマージ許可ではない。テスト実行の結果では状態・点数を変えない。
- マージ可否: 可（人のレビューなしでマージ可）／不可（人の判断が要る）
  - 可は、最終状態が完了・点数が 5・同じ head SHA の別 checkout でのテスト実行が成功のときだけ。可でもリポジトリの既存のマージ条件は省かない。
  - 不可の理由: 最終状態とその理由／点数または点数なし／残った未確認（対応表の行・候補 ID）／テスト実行の判定と、checkout の SHA が head の SHA と一致するか
  - 対応表の「自動チェック担当」の行: 行の一覧と、マージ可否の判定でテスト実行の成功により満たしたか（対応表と点数の対象外という扱いは変えない）
- 対象版: repo の絶対パス／基点の指定／merge-base の SHA／head の SHA／mode（mode: local なら土台の HEAD の SHA と `local/changes.diff`・未追跡の写しの sha256）
- 未コミット変更の差分確認（mode: local のとき）: 反証の結果を受け取った後に取り直した土台の HEAD と差分の指紋、変化の有無

### テスト実行による検証

- 判定: 成功／成功としない（必須の skip あり）／失敗／実行できず／テストなし（未確認）／対象外（未コミット）（実行しなかった場合はその理由）
- 選んだ範囲と理由: テストの入口の出典（`<path>@<sha>:L<開始>-L<終了>`）、コマンドと範囲、必須としない skip の項目と理由（`<W>/parent/tests/plan.md`）
- checkout の SHA: （head の SHA との一致）
- 作業ディレクトリの由来: clone 元と手順、開始時の `status --porcelain` の結果
- 依存の固定情報と runtime: lockfile のパスと sha256、runtime と版
- コマンド: 依存の準備／テスト
- 終了コード: 依存の準備／テスト
- skip: 件数と各項目（ファイルと行または名前）、`plan.md` の記録との照合の結果、扱い
- 所要時間: 開始・終了時刻
- 出力の指紋: `setup.log`・`output.log`・項目ごとの結果のファイル（例: `results.xml`）の sha256
- 出力原本への参照: `<W>/parent/tests/record.md`・`<W>/parent/tests/output.log`・`<W>/parent/tests/setup.log`・項目ごとの結果のファイル

### 要求の出典と写しの指紋

| 写し | 出典 | sha256 |
|---|---|---|
| `requirements/issue.md` | Issue <ID> のタイトルと本文（取得時刻） | |
| `requirements/spec-<ID>.md` | Document <ID>（パス） | |
| `requirements/plan-<ID>.md` | 計画の出典が指す Document <ID>（パス）／計画の出典なし／解決できず不足 | |
| `requirements/workspace-rules.md` | Workspace の規約 | |

取得できなかった資料と理由:

### 保存時の要求変化の確認

取り直した時刻、比べた資料、変化の有無。変化があれば、この結果は旧要求に対するもので、現在の要求への適合は未確認であること。

### 担当

| 役割 | 定義名 | 担当 ID | 終了状態 | 引き渡しの検査 | モデル申告と出典 |
|---|---|---|---|---|---|
| Standards 探索 | code-reviewer-standards | | | | |
| Spec 探索 | code-reviewer-spec | | | | |
| 反証 | code-reviewer-refute | | | | |

- 実装者との対応: 実装者（実装後レビューなら実装担当の ID、単独レビューなら分かる範囲）と各担当が別の担当であること。ID の違いだけで会話を引き継いでいないことの証明とは扱わない。
- モデル情報は申告と出典だけで、不明は未確認とする。実効モデルの証明ではない。

### 原本の場所と指紋

| 原本 | 場所 | sha256 |
|---|---|---|
| 共通入力の目録 | `<W>/input/manifest.md` | |
| Standards 探索の引き渡し用ファイル | `<W>/standards/handoff.md`（反証への写し `<W>/refute-input/standards-handoff.md`） | |
| Spec 探索の引き渡し用ファイル | `<W>/spec/handoff.md`（反証への写し `<W>/refute-input/spec-handoff.md`） | |
| 反証の判定本文 | `<W>/refute/verdict.md` | |
| 親の検査記録 | `<W>/parent/checks.md`・`<W>/parent/fingerprints.md` | |
| テスト実行の記録 | `<W>/parent/tests/plan.md`・`<W>/parent/tests/record.md` | |
| テスト実行の出力 | `<W>/parent/tests/setup.log`・`<W>/parent/tests/output.log`・項目ごとの結果のファイル | |

### 後続判断

未実施なら原因・受領済みの成果・取得できた担当 ID と、Done・In Review・PR へ進めないこと。未完了なら残った未確認と、既存の提出・完了条件へ委ねること。完了なら点数と要対応の有無。いずれもマージ可否と、不可なら人の判断が要ること。

### 独立性の限界

探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。

- この実行のロール設定: Standards 探索 `<review-standards の設定>`、Spec 探索 `<review-spec の設定>`、反証 `<review-refute の設定>`（出典: ハーネスが示した担当の設定。分からなければ未確認）。2つの探索ロールが同じモデルに設定されていた場合（比較用に揃えた設定など）は、「この実行では探索の2担当は同じモデルの設定であり、モデルの違いによる独立性は無い」と書き添える。

## 反証担当の判定本文（原文のまま）

- 原本: `<W>/refute/verdict.md`
- sha256: 
- 担当 ID: 

次の印の間に `refute/verdict.md` の全文を一字も変えずに入れる。未実施で判定本文が無ければ、印の間に「未受領」と理由だけを書く。

<!-- refute-verdict:begin -->
<!-- refute-verdict:end -->
