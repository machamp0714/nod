## 管理情報（親が記入）

- runId: 
- 作業ディレクトリ: 
- 最終状態: 完了／未完了／未実施（理由）
- 点数: 0〜5／点数なし
- 点数の計算: 要対応の件数、各要対応の候補 ID と影響度、最も重い影響度（最小値）。要対応0件かつ必要な確認済みなら 5。軸間で平均せず、任意・棄却・基点から存在（対象外）は入れない。未実施・未完了は点数なし。5 点だけではマージ許可ではない。
- 対象版: repo の絶対パス／基点の指定／merge-base の SHA／head の SHA／mode（mode: local なら土台の HEAD の SHA と `local/changes.diff`・未追跡の写しの sha256）
- 未コミット変更の差分確認（mode: local のとき）: 反証の結果を受け取った後に取り直した土台の HEAD と差分の指紋、変化の有無

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

### 後続判断

未実施なら原因・受領済みの成果・取得できた担当 ID と、Done・In Review・PR へ進めないこと。未完了なら残った未確認と、既存の提出・完了条件へ委ねること。完了なら点数と要対応の有無。

### 独立性の限界

探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。

## 反証担当の判定本文（原文のまま）

- 原本: `<W>/refute/verdict.md`
- sha256: 
- 担当 ID: 

次の印の間に `refute/verdict.md` の全文を一字も変えずに入れる。未実施で判定本文が無ければ、印の間に「未受領」と理由だけを書く。

<!-- refute-verdict:begin -->
<!-- refute-verdict:end -->
