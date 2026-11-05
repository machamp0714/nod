# 過去事例の凍結・再生・集計

`nod review evaluation` は開発用の過去事例を扱う。新規30 PRの選定・受入や、PER-31全体の完了は判定しない。
実モデルの検出性能は実モデルを実行して人が判定するまで不明であり、fake CLIのテスト結果から推定しない。

## 事例を固定する

正解とレビュー要求は別ファイルにする。評価集合・正解・人判定は対象リポジトリの外へ置き、対象commitに混ぜない。
`input.document` には当時の要求だけを置く。現在のPR本文、後の修正コード、正解コメントは渡さない。
当時の資料から再構成した要求は、その旨と出典・限定範囲を明記する。必要な要求が復元できない場合は `unavailableReason` に理由を入れる。

```json
{
  "version": 1,
  "purpose": "development",
  "selection": "モデル再生前に固定した選定規則と対象範囲",
  "cases": [{
    "id": "case-1",
    "repoKey": "example",
    "pr": 123,
    "input": {
      "repo": "/path/to/historical-repo",
      "base": "0000000000000000000000000000000000000000",
      "head": "1111111111111111111111111111111111111111",
      "document": "/path/outside-repo/requirements.md"
    },
    "requirementEvidence": "当時要求のcommit、パス・行・hashと復元の限界",
    "provenance": ["指摘と独立確認の出典"],
    "unavailableReason": null,
    "oracle": [{
      "id": "cause-1",
      "kind": "positive",
      "major": true,
      "cause": "根本原因と到達条件",
      "impact": "データ消失・主要機能停止等の実影響と重大判定の理由",
      "evidence": "対象版に対する確認証拠・出典"
    }]
  }]
}
```

`base` は比較対象のmerge-base、`head` は指摘当時のcommitを40桁で指定する。上のSHAは形式例であり実行できない。
`kind=negative` は正常動作または棄却された特定主張の対照であり、PR全体のバグなし認定ではない。
原サービスのラベルを重大度へ機械変換しない。正常対照も正例と同じ対象版・契約・証拠を持つ。

```sh
nod review evaluation freeze --manifest /path/manifest.json --out /path/frozen.json --json
```

要求本文を読み込み、選定規則・順序・正解と一緒にSHA-256で固定する。既存ファイルへの上書きは拒否する。
`freeze` はGitオブジェクトの存在や証拠の意味上の正しさまで保証しない。準備入口でGitと規約の取得可否を確認し、その不足を別記する。
凍結ファイルは改変検知用のhashを持つが署名ではない。管理者が意図的にhashまで書き換える行為を防ぐ仕組みではない。

## 初回レビューを再生する

```sh
nod review evaluation replay --dataset /path/frozen.json --case case-1 \
  --provider claude --review-model '<利用者の設定>' \
  --implementation-models '<実装に使った実効モデルID集合>' \
  --extra-usage-disabled --json
```

課金方式・実効モデルの条件は[通常レビュー](review-run.md)と同じ。`--extra-usage-disabled` は利用者の確認が済んだ場合だけ指定する。
`--scope-plan` で固定規約の適用計画も指定できる。評価要求の本文と凍結集合は変更せず、計画は実行記録に固定する。範囲を変更した再試行を初回成績へ差し替えず、限定評価として報告する。
再生は共通の `runReview` を使用する。渡すのは固定commit、凍結要求、明示モデル設定だけで、正解・比較結果・人判定・自動修正設定は渡さない。
凍結後に元の要求ファイルが変わっても、保存した本文から独立した要求ファイルを作る。

DBと同じディレクトリの `reviews/evaluation/<attemptId>/` に初回記録を内包した `evaluation-run.json` を新規保存する。
`frozen.json.runs.jsonl` へ実行前に記録するため、途中停止や保存失敗も初回の未完了として残る。
同じcaseの2回目以降は履歴に残し、集計に使う初回を成功した結果へ差し替えない。台帳や初回記録を削除して失敗を隠さない。
`status=recorded` は記録の保存完了だけを表す。`reviewStatus=completed, score=2` も有効な初回レビューであり、モデル失敗ではない。
修正後の結果や固定SHAと異なる結果は集計を拒否する。初回の実効モデル・工程別使用量・所要時間・候補・検証判定も保存する。

## 人の判定を後から結び付ける

レビューが終わってから、可能な範囲で発信元を伏せて比較・人の判定を行う。
正解IDとモデルの原因名の一致を文字列比較で自動認定しない。契約・到達条件・破綻・影響を確認して `knownCause` で対応付ける。

```json
[{
  "caseId": "case-1",
  "attemptId": "再生結果のattemptId",
  "complete": false,
  "triageMinutes": null,
  "findings": [{
    "finding": "spec:モデルの候補ID",
    "causeId": "人が同一原因と確認した共通ID",
    "verdict": "valid",
    "evidence": "独立確認の条件・結果と出典",
    "knownCause": "cause-1"
  }]
}]
```

`verdict` は `valid`、`invalid`、`pending`。未記録も判定待ちであり、追加発見を自動で誤検知にしない。
既知正解にない有効指摘は `knownCause` を省略する。探索で発見したが検証で棄却された有効指摘にも判定を付ける。
同じ機械的原因IDまたは根拠付きの人の原因IDを統合し、採否が割れる原因は多数決にせず判定待ちにする。
`complete=true` だけで未判定は消えない。初回の最終候補にないIDや重複した人判定は拒否する。

時間はPR単位の不要指摘の選別時間を分で記録する。選別不要なら `triageMinutes=0` と `triageEvidence="選別不要"` を記録する。
未計測は `null`。0以外の値にも計測根拠が必要で、負数は拒否する。

```sh
nod review evaluation report --dataset /path/frozen.json \
  --judgments /path/judgments.json --json > /path/evaluation-report.json
```

判定ファイルはレビュー入力に渡らず、出力には判定内容とファイルhashを残す。出力先は過去の評価を上書きしない新しいパスにする。

## 集計の読み方

- `cases` と `causeMatches` は全固定ケース・全既知正例の一致/見逃し/未確認を保持する。追加の有効発見、検証で棄却した有効指摘も候補IDで列挙する。候補IDの列挙は原因数ではない。
- `metrics.prs` はrepoとPR番号で重複を除く。各PRは凍結した順序の最初のcaseを主対象とし、別版は `excludedFromPrCount` へ列挙する。別版もケース別の回帰確認からは除かない。
- 適合率は主対象の重複除去済み最終 `required` を分母、妥当と判定された原因を分子にする。分母0は `null`（N/A）。判定待ちがある値は確定値ではなく、`precisionIsFinal=false`。
- `regression.majorTotal` は全固定ケースの既知重大原因数。重大0件または未確認が残る場合、検出率は `null`。未確認を見逃し0件や100%検出へ読み替えない。
- `triageMedianMinutes` は全主対象PRの計測がそろった場合のみ出す。`observedTriageMedianMinutes` は計測済み部分だけの参考値。`triageUnknown` が残る状態では全件基準への合格を確定しない。
- `findingsOnlyMedianMinutes` は最終候補があるPRの計測済み部分だけの値。repo別内訳、5分超のケース、未実施、評価不能、未確認候補も併記する。
- `telemetry.stages` の使用量はランタイム由来。価格換算も実請求額も推定せず、`actualCharge` と `estimatedCharge` は `null`。

`status=evaluated` は記録と人判定がそろったことを表し、合格を表さない。`acceptance=not_evaluated` と `prospectiveTrial.status=not_started` は常に残す。
開発用集合では重大正例の全件検出・正常/棄却例への重大誤指摘0件を別途確認する。資料不足を含む状態では試行開始条件を満たしたとしない。
新規試行は別工程で開始点と選定順序を固定し、対象リポジトリごとに同数のPRを集める。適合率80%以上、重大見逃し0件、全PR中央値5分以内の受入はこの開発用CLIから確定しない。

自動チェックの結果をレビューへ渡す旧方式は廃止した。新方式は `reviewPolicy=independent-v1` を記録し、旧方式の結果と分けて集計する。評価者は自動チェック担当の正例を事前分類し、レビューの発見実績と見逃しから分ける。機械的違反を最終指摘した場合は範囲違反として適合率の分母と選別負担に含める。分類不明は未確認とし、判定後の都合のよい除外をしない。

## 独立レビューの評価集合（version 2）

新方式のmanifestには `version: 2` と `reviewPolicy: "independent-v1"` を指定する。各oracleに `layer`（`review` / `automatic_check` / `unresolved`）、分類根拠の `layerEvidence`、固定した検査設定の `checkConfiguration` を追加する。分類・正解・検査結果はモデル入力に渡さない。

`automatic_check` はレビューの検出実績と見逃しから分ける。その原因をレビューが最終要対応にした場合は、正しい診断内容でも担当外の指摘として分母と選別時間に残す。`unresolved` が残れば評価はpendingとし、適合率を確定しない。旧方式の結果を新方式の集合へ混在させると集計を拒否する。version 1は旧記録の参照用に残す。
