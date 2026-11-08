# 独立した候補検証と最終記録

親エージェントは探索担当と、新しいコンテキストの検証担当へ順に委譲する。
CLIは担当を起動せず、固定資料の準備と2段の記録だけを行う。
準備から探索記録までは[レビュー入力の準備](review-prepare.md)を参照する。

```sh
nod review input --run <実行ID> --phase verification --json
nod review record --run <実行ID> --phase verification \
  --output /tmp/verification.json --agent code-reviewer --json
nod review show --run <実行ID> --json
```

`input` は入力本文を標準出力へ流さず、`inputPath` と `schemaPath` を返す。
検証担当はこの固定入力を読み、schemaに従うformat=3出力を一つのJSONファイルに書く。
親が検証担当へ渡すものは工程の指定、実行ID、保存先だけとし、探索担当の説明や親の要約を添えない。
同じ担当定義や同じモデルを2回使ってもよいが、検証は新しい委譲による別コンテキストで行う。

## 検証入力の許可範囲

検証入力は、固定資料と探索由来の次の記録だけから構成する。

- 固定資料：対象版と差分、確認単位、段落表、計画、資料索引、`code` と `baseCode` の索引、`focus`、policy、工程指示。
- 探索候補：正規化した候補と、構造化された判定理由および証拠。
- 探索の要求別記録：`id,status,contentAssessment,implementation,verification,evidence,findingIds,scopeEvidence,rationale`。

探索由来の記録は `candidates[]` の各要素に `axis,candidates,requirements` だけを置く。
探索の会話、推論、要約、自己評価、担当情報、時刻などの工程メタデータ、`completed`、`causeGroups`、整合性の総合判断は渡さない。
固定資料の `requirements.consistency=unverified` は資料取得と意味判断の区別を示すもので、探索担当の判断ではない。
検証担当は原因統合と要求同士の整合性を判断し直す。
探索の記録が `explored` でなければ、検証入力の取得は `EXPLORATION_REQUIRED` で拒否する。

## 最終記録の検査と保存

`record --phase verification` は次の順で処理する。

1. 出力ファイルの指定、存在、読取を確認し、16MiB以下の通常ファイルをJSONとして解析する。
2. format=3のschema、工程、完了状態、配列、担当要求ID、対象hash、出典の `type:id` を検査する。
3. 固定資料から出典hashと引用、要求本文、固定分担理由を復元する。
4. 固定Gitのheadまたはbaseから参照先を取得し、実在するパス、行、引用と照合する。
5. 全探索候補に検証結果があるかを確認し、要求別対応、原因統合、整合性の記録を検査する。
6. 既存の採点規則で固定版を採点し、要求、規約、計画、対象の変化を検出して最終結果を保存する。

`requirements` は担当の全要求IDを各1回含める。
欠落や重複は `completed=true` でも採点前の `OUTPUT_INVALID` とし、最終結果を未完了かつ点数なしで保存する。
`--check` でも同じ形式不正として拒否し、記録は保存しない。

最終記録は `reviews/<実行ID>/execution.json` に一度だけ新規作成する。
候補と要求の原記録は `stages`、最終採否は `findings`、要求別判定は `coverage`、共通原因は `rootCauses` に残す。
記録済み実行への再記録は `VERIFICATION_ALREADY_RECORDED` で拒否し、やり直す場合は新しい準備から始める。

必要な確認が終われば `status=completed` となり、要対応の最重影響で0〜4点、要対応がなければ5点になる。
未確認、要求の矛盾、要求変化、出力の欠落や不正は `status=incomplete,score=null` として保存する。
終了コードは最終5点だけ0、それ以外は1となる。
`--output` の省略も `STAGE_MISSING` の最終記録として保存し、引数不足で記録を失わせない。
読取不能は `STAGE_UNREADABLE`、JSONまたは形式不正は `OUTPUT_INVALID`、対象hash不一致は `STALE_EVIDENCE`、`completed=false` は `STAGE_INCOMPLETE` とする。

記録前の形式確認には同じコマンドへ `--check` を付ける。
この場合は `saved=false` を返し、引用照合、採点、保存を行わない。
形式確認が通ってもレビュー完了や合格を意味しない。

## 固定版の結果と現在版への提出

`target.hash` は準備時の対象だけを識別する。
`fixedResult` は固定資料に対する状態、点数、両軸の結果を残し、トップレベルの状態と `currentSubmission.eligible` は記録時点の変更検出を反映する。
要求、規約、計画が変わった場合は `REQUIREMENTS_CHANGED`、対象の選択式が指すcommitやlocal対象が変わった場合は `TARGET_CHANGED` を記録する。
いずれもトップレベルは未完了かつ点数なしとなり、固定版が5点でも現在版へ提出できない。

準備時の `HEAD` やbranchの選択式は記録時に解決し直す。
local対象は元のHEAD、indexの識別値、追跡ファイル、明示した未追跡ファイルの状態を照合する。
証拠は現在版から取り直さず、準備した固定Gitから読む。
元の作業ツリー、index、commitは変更しない。

`currentSubmission.eligible=true` も固定した確認範囲についての結果に限る。
`scope.kind=limited` の5点をIssue全体の充足へ読み替えず、記録後の変更には新しいレビューが必要となる。
CLIの変更検出は同時編集を排他する仕組みでも、マージ許可でもない。

## 固定資料の索引と規約適用計画

主入力は対象diff、確認単位、段落表、資料索引を持つ。
`sources` は `source`（`type:id`）、`title`、固定本文の `path`、行数、見出しの位置を一度だけ持ち、本文とhashを繰り返さない。
各パスは `contextPath` からの相対パスで、本文は固定snapshotから必要な箇所を読む。
`code={paths,executable}`、`baseCode={directory,paths,sameAsHead}` の索引も維持する。

`reviewUnits` は行ごとの固定IDと要求本文、出典、`requiredAssessmentReferences` を持つ。
複数行の条件は `reviewParagraphs` へ一度だけ置き、単位から `paragraph` で参照する。
Standards探索は規約単位、Spec探索は要求単位、検証は全単位を担当する。
各工程は一つの出力を返し、分割や並列起動をCLIは管理しない。

規約適用計画は探索前に `review plan --scope-plan` で固定する。
雛形の全行を `required` または `reference` に分類し、固定sourceとhash、連続する全行範囲、理由を指定する。
`unresolved` が残れば `SCOPE_UNVERIFIED`、不足、重複、hash不一致なら `SCOPE_PLAN_INVALID` となる。
Issue、Spec、承認計画はこの計画で除外できない。

```json
{
  "version": 1,
  "standards": [{
    "source": "standard:AGENTS.md",
    "hash": "準備で返った規約hash",
    "ranges": [{ "start": 1, "end": 12, "kind": "required", "rationale": "今回の変更へ適用する" }]
  }]
}
```

参考範囲も本文を保存し、候補の根拠に使える。
全行が参考なら入力は `referenceOnly` の索引だけを持ち、範囲と理由を重複させない。
参考範囲や対象外要求があれば、最終結果の `scope` に限定範囲と残要求を示す。

## 出典と候補の契約

出典は `{source,line}`、コード参照は `{path,revision,line}` で返す。
`source` は索引と同じ `type:id` を省略せず使い、ファイル名、型なしID、snapshotのpathで代用しない。
CLIがhash、引用、要求本文を復元し、型なしIDや不正引用を自動補正して合格させない。
未知出典や範囲外の行は `OUTPUT_INVALID` とし、`referenceDiagnostic` には種類、項目、索引上の位置、行番号だけを残す。
担当が返した未知文字列は診断へ保存しない。

候補には到達条件、期待動作、破綻、影響、静的証拠、再現手順、既存防御、採否理由、責務の根拠を記録する。
期待動作を実際の誤動作で代用しない。
SDKが関係すれば、固定依存ファイルの引用と単一依存の実版を照合し、範囲指定や部分一致を実版の証拠としない。

新しく導入した要対応候補は実際の変更行を `changeEvidence` に示す。
追加行はhead、削除行はbaseを使い、置換は対応するどちらかを使う。
指摘位置が未変更の利用側にある場合も、変更された依存先の根拠を別に示せる。
削除ファイルの指摘は `revision=base` で示す。

既存問題には同じpathと内容の基点引用 `baselineEvidence` が必要となる。
今回の明示要求が修正を求める場合と、無関係な既存課題として範囲外にする場合を `scopeAssessment` と要求出典で区別する。
関係が未確認なら、既存問題を消さず未完了にする。

検証の `causeGroups` は全候補を一度ずつ含める。
未知候補、欠落、重複は出力不正とし、同一原因にまとめても各軸の候補と証拠は残す。
探索候補の省略は `CANDIDATE_OMITTED` となり、棄却や任意改善へ読み替えない。

## 要求別対応と本文分類

要求ごとに実装参照、静的な確認方法、証拠、状態を返す。
状態は `satisfied`、`unsatisfied`、`unverified`、`out_of_scope`、説明確認の `context` を区別する。
未充足には軸付き候補ID（`standards:id` または `spec:id`）と `findingLinks` が必要となる。
操作、条件、義務の一致、実際の破綻、修正による当該違反の解消、固定要求とコードの証拠を照合する。
同じ原因というだけで別要求を充足したことにしない。

`contentAssessment` は背景、理由、範囲、検証不足、義務、混在、独立検査、未確認を区別する。
義務は原文から抜き出して保持し、検証で背景や短い別引用へ変更して消さない。
各単位の行と段落先頭の出典を含め、探索と検証の分類と義務の対応を確認する。
同じ段落の背景が別の契約違反と無関係なら、候補を消さずに根拠付きの棄却リンクで対応だけを退けられる。

要求の整合性は検証担当が `consistent`、`conflict`、`unverified` と証拠を返す。
資料取得の成功や候補0件だけで整合性を確認済みにしない。

## 自動チェックと独立したレビュー

レビュー担当はlint、型検査、テストを実行も受領もしない。
要求の意味と実装を静的に確認し、実行済みコマンドやテスト成功を証拠へ混ぜない。
必要な固定資料や工程全体の確認が不足すれば `completed=false`、個別要求の不足ならその要求を `unverified` にする。

機械的な合否だけの要求を分担する場合は、探索前に `review plan --responsibility-plan` で固定する。

```json
{
  "version": 1,
  "assignments": [{ "sourceHash": "固定資料hash", "line": 3, "owner": "automatic_check", "rationale": "現在の到達性は独立検査で確認する" }]
}
```

探索と検証の両方で同じ要求を `independent_check` として対象外にし、その要求自身の出典を `scopeEvidence` に示す。
CLIは理由を計画の固定値へ復元し、担当の言い換えは `proposedRationale` に保存する。
同じ文に実装義務が混在する場合は、その義務を消して分担済みとしない。

## 担当の申告と途中終了

両担当はそれぞれ `--agent` を指定し、知りうる場合だけ `--model-claim` と `--model-claim-source` を添える。
`agents.exploration` と `agents.verification` は定義名とモデルの申告を保存し、モデル不明は `value=null,source=null,status=unverified` とする。
申告は実効モデルの証明ではなく、同じモデルや不明なモデル情報を停止条件にしない。
実装者とのモデル独立性はomp設定が担い、担当IDと実行IDの対応は親が作業ログへ残す。

検証記録がなければ、親は独立レビュー未実施として扱う。
準備だけ、探索だけの記録を閉じる追加コマンドはなく、中間状態のまま保存する。
検証まで記録した未完了は未実施と区別して報告する。
出力の形式不備は記録前に `--check` で直せるが、記録後のやり直しや指摘修正後のレビューは新しい準備と委譲で行う。

CLIは直接モデル起動、モデル選択、課金確認、隔離修正、自動修正、全体期限を提供しない。
担当の実行時間と中断はompが管理し、Git一呼出しの時間制限をレビュー全体の期限へ転用しない。
CLIの引用照合と採点は記録の形式と版を検査するもので、自然言語の意味判断や実モデルの検出性能を証明しない。
