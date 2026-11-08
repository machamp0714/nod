# 工程入力と記録

## 探索担当による準備

親から受け取ったrepo、基点、対象版、要求と資料の所在を使う。
`prepare` が返す実行IDを、その後の計画、入力取得、2段の記録で一貫して使う。

```sh
nod review prepare --repo /path/to/repo --base main --head HEAD --issue NOD-123 --json
```

- `--head <ref>` の既定はHEADで、merge-baseから固定headまでのcommit差分を対象にする。
- `--document <IDまたはMarkdownパス>` はIssue指定の代わりに使える。
  登録Documentに紐付くIssue本文も取得する。
- 両方省略した場合はCLIがbranchと記録済み作業場所からIssueを解決する。
  候補0件や複数なら正本不明を報告し、ブランチ名から推測しない。
- 未コミット変更は明示された場合だけ `--local` を使う。
  このモードの `--head` は現在のHEADだけとし、明示された未追跡ファイルだけ `--untracked src/new.ts` のように繰り返す。
  commitやstashを作って固定しない。
- 秘密、ignore対象、symlinkなどの制約を解除して取得しない。
  必要対象を固定できなければ未完了として返す。

規約の収集入口は変更ファイルの祖先にある `AGENTS.md`、`CLAUDE.md`、`CODING_STANDARDS.md`、`CONTRIBUTING.md`、`README.md` と、そこからリンクされたローカルMarkdownである。
探索担当は対象に適用される規約と固定 `sources` を照合し、独自資料などの必須規約の欠落を見逃さない。
手元で読んだだけの規約をCLIが固定済みと説明しない。

`preparation.json` の `sources` と `requirements` から、Issueの確定要求、存在するSpec全文、現在計画のTaskとStep、適用規約が揃っていることを確認する。
Specがない場合だけIssue全文を正本とし、取得失敗、矛盾、正本不明をSpec軸の省略や本文だけへの代替で隠さない。
空差分、不正な基点、必須資料不足なら、残件と保存先を親へ返す。

`prepared` は準備だけの状態で、`score=null`、両軸は `not_started` である。
この準備時に読取専用snapshotも作られる。
その後に対象を取り直す準備や別の実行を挟まない。

## 規約の適用範囲を固定する

探索担当が `standardScopeTemplatePath` の雛形から別のJSONファイルを作る。
資料hashと行数は準備結果の固定値を使い、再計算しない。
見出し、参照元、今回の差分との関係、分類に必要な本文を読み、必読指定の参照先も辿る。

`type=standard` の各資料を連続する行範囲で分類し、`required`（今回必須）、`reference`（参考または今回非適用）、`unresolved`（未確認）と理由を記録する。
単語やフォルダ名だけで決めず、リンク先の存在だけで全内容を必須要求にしない。
構成説明や一般的な改善指針を全体監査要求に変えない。

```json
{
  "version": 1,
  "standards": [{
    "source": "standard:README.md",
    "hash": "prepareが返した資料hash",
    "ranges": [
      { "start": 1, "end": 10, "kind": "required", "rationale": "今回の公開APIに適用する規約" },
      { "start": 11, "end": 20, "kind": "reference", "rationale": "別機能の説明で今回の変更には非適用" }
    ]
  }]
}
```

行番号は1始まりで、末尾改行後の空行も含む `content.split("\n").length` まで全規約を欠落や重複なく覆う。
例の行数は実資料に置き換える。
候補や点数を見てから範囲を減らさず、Issue、Spec、承認計画をこの仕組みで除外しない。

`requirements.unresolvedReferences` が必須範囲からの参照なら、固定資料の不足を解決する必要がある。
停止を避けるために必須範囲を参考へ移したり、不明を参考扱いにしたりしない。
参考範囲も固定全文を保持し、必要なら読める。
参考範囲を含む結果は `scope.kind=limited` と適用計画を報告する。
CLIの形式検査を意味上の適用判断の証明にしない。

## 確認対象と責務計画

探索担当が要求の原文、段落、適用範囲と今回の成果物を読み、確認の責務を探索前に決める。
要求本文や行IDを書き換えたり、要求を弱めたDocumentを作ったりしない。

| 確認対象 | 扱い |
|---|---|
| コード、設定、指示文が表す動作や制約 | レビュー担当に残し、固定契約と実装から確認する |
| 書式、現在のHTTP応答、検査コマンドの合否だけ | 純粋な検査要求の行を `automatic_check` へ分担し、結果は受領しない |
| 実利用時の成功率や指示の遵守率などの動作評価 | 静的な指示内容の適合と区別し、評価計画の存在を実施済み証拠にしない |

スキルの「条件XならYを選ぶ」は通常そのスキルの実行時の指示である。
差分レビューでは指示の条件、例外、参照先が明示仕様に適合するかを確認し、その操作をレビュー担当が実行する義務へ読み替えない。
一方、今回の要求が評価の実施や観測結果を明示的に求める場合は、指示文の存在だけで充足させない。
確認対象が原資料から決まらなければ未確認に残す。

責務計画は行全体の分担であり、複合行の一部だけを除外できない。
「URLを適切に構成し、到達確認する」のような行は意味や設計をレビュー対象へ残す。
必須仕様の取得不能をリンク検査担当へ移して通さない。

```json
{
  "version": 1,
  "assignments": [{
    "sourceHash": "prepareのsourcesにある要求資料のhash",
    "line": 12,
    "owner": "automatic_check",
    "rationale": "書式検査の実行と合否は自動チェック工程が担当する"
  }]
}
```

未登録の要求はレビュー対象のままで、計画に結果や診断を書かない。
固定分担の要求も対応表に残し、探索と検証で `out_of_scope`、本文分類 `independent_check`、`scopeEvidence` はその要求自身の固定参照とする。
CLIは分担理由を計画の固定文字列へ復元し、異なる申告文を `proposedRationale` に残す。
意味や設計を含む行が誤って分担されていたら、その義務を消さず未確認として報告する。

## 同じ実行へ計画を固定する

両計画は `prepare` ではなく `plan` に渡す。

```sh
nod review plan --run <runId> --scope-plan /path/to/scope.json \
  --responsibility-plan /path/to/responsibility.json --json
```

全規約を確認する場合はscope計画を省略でき、分担なしならresponsibility計画を省略できる。
これは探索担当による事前判断であり、独立反証の結論ではない。
固定済みの計画は変更できず、再計画には新しい準備が必要である。
状態は `planned`、点数は `null` のままである。

## 両軸の探索入力と出力

```sh
nod review input --run <runId> --phase standards --json
nod review input --run <runId> --phase spec --json
```

各返答の `inputPath` と `schemaPath` を読む。
入力本文を標準出力へ展開するコマンドではない。
入力は確認単位、段落表、資料索引、`focus`、固定分担、対象diff、コード索引と工程指示を持つ。
`contextPath` を起点に `sources[].path`、`code.paths`、`baseCode.directory` の固定本文を読む。
コードや要求を現在の作業ツリーから取り直して混ぜない。

同じ探索担当がStandardsとSpecを確認し、各軸の全 `assignedRequirementIds` をそれぞれ1つのformat=3出力へ記録する。
CLIやスキルから別担当、分割担当、並列処理を起動しない。
探索の `causeGroups` は空配列でよく、整合性の最終判断は検証担当へ残す。

## 探索の中間記録

```sh
nod review record --run <runId> --phase exploration \
  --standards /path/to/standards.json --spec /path/to/spec.json \
  --agent code-reviewer --json
```

出力は工程schemaに従い、トップレベルの `format=3`、固定対象 `target.hash`、工程 `axis`、`completed`、候補、要求、整合性、原因グループを持つ。
採点のために自分で総合点を出力しない。

必要なら記録前に同じ引数へ `--check` を付け、出力の形式だけを検査できる。
この検査は自動チェックの受領ではなく、記録契約の検査であり、引用照合、採点、保存は行わない。
`--check` の成功を記録済みと報告しない。
未完了の確認を形式だけ整えて `completed=true` にしない。

記録は `exploration.json` に一度だけ保存する。
両工程完了なら `explored`、欠落、読取不能、形式不正、対象不一致、`completed=false` なら `exploration_incomplete` になる。
どちらも `score=null` かつ `reviewCompleted=false` である。
記録済み出力の差し替えは行わず、親へ状態と保存先を返す。
探索担当はここで終了する。

## 検証担当の許可入力

新規コンテキストの検証担当は、親から工程、実行ID、保存ディレクトリだけを受け取る。
最初に次を実行する。

```sh
nod review input --run <runId> --phase verification --json
```

レビュー入力としては返された `inputPath`、`schemaPath`、それらが参照する固定資料とコードだけを読む。
保存先の一覧、`exploration.json`、探索のraw出力、親report、準備や計画の原記録から、許可入力にない情報を取り出さない。
`agent://`、`history://`、会話ファイル、別ツールや親への問い合わせから探索の履歴や要約を回収しない。
peer rosterを他担当の履歴を読むための索引として使わない。
探索担当のモデル申告や定義名を読む必要もない。

許可入力は次の内容に限られる。

- 固定資料：確認単位、段落、資料索引、計画、対象版、diff、`code` と `baseCode`、`focus`、policy、工程指示。
- 探索候補：正規化した候補と、構造化された判定理由および証拠。
- 探索の要求別記録：`id,status,contentAssessment,implementation,verification,evidence,findingIds,scopeEvidence,rationale`。

探索の会話、推論、自己評価、親や探索担当の要約、実装者の自己評価、担当情報や時刻などの工程メタデータ、`completed`、`causeGroups`、整合性の総合判断は検証入力ではない。
固定資料にある `requirements.consistency=unverified` は探索担当の判断ではなく、資料取得と意味判断の区別である。

## 独立した反証と最終記録

全候補の契約、条件、期待動作、実際の破綻、影響、既存防御、責務、基点との関係を固定証拠から確認する。
候補の軸とIDを維持し、棄却や対象外も含め全候補へ対応する。
要求との対応は候補の採否とは別に確認する。

`causeGroups` へ全候補の `axis:id` を1回ずつ割り当て、同じ条件と原因の候補を統合する。
文字列の一致だけで統合せず、統合や分離の理由を残す。
同一原因でも各軸の契約と証拠から採否を独立に判断する。
要求同士の整合性 `consistency` は `consistent`、`conflict`、`unverified` と根拠を自分で判断し直し、候補0件や資料取得の成功だけで確認済みにしない。

```sh
nod review record --run <runId> --phase verification \
  --output /path/to/verification.json --agent code-reviewer --json
```

必要なら保存前の `--check` で形式を整えられるが、固定Gitへの引用照合と採点は保存する記録時に行われる。
`execution.json` は一度だけ保存する。
記録後に過去の探索情報へアクセスして判断を変えたり、結果を書き換えたりしない。
検証担当は記録の返答から最終状態と結果を親へ返し、両担当の照合は親へ任せる。

欠落や形式不正、全候補への対応不足、未確認、要求矛盾、要求や対象の変化は `incomplete` かつ点数 `null` として保存される。
必要な確認が終わった `completed` のときだけ採点され、要対応の最重影響で0〜4点、要対応0件なら5点となる。
最終5点だけ終了コード0、それ以外は1なので、非0を記録失敗と即断せず返された状態と保存の有無を確認する。

## 担当の申告

各担当は `--agent` に自分の定義名を渡す。
自分が知りうるモデル情報と出典がある場合だけ、記録コマンドへ `--model-claim '<申告値>' --model-claim-source '<出典>'` を添える。
既に自分へ与えられた情報を申告するだけとし、別担当の履歴や設定を調べて埋めない。
不明なら両オプションを省略し、`value=null,source=null,status=unverified` のまま記録を進める。
これは申告であって実効値の証明ではなく、要求の未確認や停止条件とは別である。
担当IDは親が委譲結果から取得し、実行IDと保存先へ対応付ける。

## 自動チェックと独立したレビュー

`reviewPolicy=independent-v1` は自動チェックの結果を入力にせず、コードと要求を読解した結果を表す。
Biome、lint、型検査、ビルド、テスト、再現コードを実行せず、結果、診断、ログ、要約、実行証拠の参照も取得しない。
`evidence.kind=static`、`verification.method=inspection`、`recordIds=[]` を使う。
実行しないと確認できないレビュー対象の懸念は未確認に残す。

候補の `responsibility` は `owner`（`review`、`automatic_check`、`unresolved`）、理由、固定参照を持つ。
検証では採否より先に責務を照合する。
自動チェック担当の候補が混入したら、IDと軸を保持し、検査設定や規約の固定参照を1件以上付け、`decision=out_of_scope`、`scopeEvidence=null`、`needsSpecificationDecision=false` として監査記録へ残す。
チェックを実行できないことをレビュー未確認の停止理由にしない。
責務の根拠が足りなければ `owner=unresolved`、`decision=unverified` とする。
候補の分類は固定要求の分担を変更する権限ではない。

書式の乱れだけからhook未実行を推測しない。
hookの終了値消失、CIの検査対象の誤り、テスト期待値の不足などの設計は、独立したコード証拠があればレビュー対象である。
自動チェックの成否を点数に混ぜない。

## 差分と既存課題の範囲

`candidatePolicy=diff-defects-v1` は差分が導入、悪化させた具体的不具合と今回の明示要件の実装漏れを対象にする。
整理、好み、将来の追加変更だけを前提にした懸念は候補にしない。
要対応には到達条件、契約違反、具体的影響、固定証拠が必要である。
任意の設計選択を必須仕様の未決にしない。
混入した任意改善は候補IDを消さず `optional` として保存し、通常の報告には提案しない。

`scopePolicy=changes-and-explicit-requirements-v1` に従い、無関係な既存課題を探し回らない。
関連コードの影響確認中に見つかった既存課題だけ、`origin=pre_existing` として扱う。
`baselineEvidence` はhead側 `location` と同じpath、同じ行内容のbase参照を示し、行番号の違いは許す。
別ファイルの関連証拠は `scopeAssessment.references` に分ける。
行の一致だけで影響なしとせず、変更した利用側や到達条件も確認する。

- 今回悪化せず修正も明示されていない課題は `kind=unrelated_existing`、`decision=out_of_scope`、`changeEvidence=null`、`scopeEvidence=null`、`needsSpecificationDecision=false` とする。
  Issue、Document、計画による範囲の固定参照を残し、課題、基点証拠、除外理由を別枠で報告する。
  採点と未完了判定には含めない。
- 今回の明示的な修正要求なら `kind=explicit_requirement`、`decision=required`、`changeEvidence=null` とし、要求を `unsatisfied` として候補に対応付ける。
- 基点や今回の範囲が不明なら `unverified` とし、除外や充足へ読み替えない。

要求行を対象外にできるのは、未充足の理由が検証済みの無関係な既存課題だけの場合に限る。
`findingIds` にその候補を、`scopeEvidence` にその要求自身の固定参照を、`rationale` に理由を残す。
未充足の事実は証拠として保持し、同じ行に今回の要対応や未確認があれば行全体を除外しない。

## 出典と依存実版

資料の出典は索引と同じ `type:id`（例 `standard:AGENTS.md`）と行番号を使う。
ファイル名、型なしID、snapshotのpath、索引にないIDで代用しない。
hash、引用、要求本文はCLIが固定値から復元する。
不正な出典は `OUTPUT_INVALID` となり、`referenceDiagnostic` の `reason`、`field`、`sourceForm` が取り違えを示す。
未知の出典を近いIDへ手で補正して通さない。
コード参照は `{path,revision,line}` とし、新規の不具合の `changeEvidence` には実際の追加行（head）または削除行（base）を示す。

SDKの根拠は固定lockfileなどで解決済みの単一依存の実版とする。
`^`、`~`、不等号、wildcard、タグを実版と扱わず、数値だけの抜き出しや部分一致で通さない。
`sdk.status=verified` の `version` は `source` の引用に含まれる実版へ対応させ、複数依存の版を連結しない。
追加依存は `evidence` と固定参照へ残し、実版不明は未確認とする。

## 本文分類と指摘の対応

要求の行IDを保ち、`reviewUnits[].paragraph` が指す `reviewParagraphs` の全文から主語、条件、時点、操作を確認する。
同じ語を含むだけの別操作の不具合を未充足根拠にしない。
担当外の単位は参考として読めるが、そのIDの要求レコードは追加しない。
各 `assignedRequirementIds` を1回ずつ返し、0件なら空配列にする。

`contentAssessment` に種類、原文からそのまま抜き出した実装義務、固定出典、理由を残す。
`requiredAssessmentReferences` は全件含め、当該行と段落先頭の参照も保持する。
背景、根拠、範囲宣言、未検証領域の説明だけなら `status=context` とし、実装の充足や対象外へ置き換えない。
説明だけの `implementation=[]` は許される。
義務が混ざる文は `mixed` とし、探索の義務を検証で説明扱いに移したり、短縮したりしない。
分類不一致、出典不足、候補との矛盾は未確認として残す。

要求が適用される全対象、入口、実行形態、条件を固定証拠で確認した場合だけ `satisfied` とする。
一部経路の証拠を全体へ広げない。
未確認経路があれば `unverified`、欠落を確認できれば `unsatisfied` と候補にする。
肯定文、例示、概要や列挙にないことだけから排他性や網羅性の要求を追加しない。
一方、明示された禁止や保証への反例、必須記載の欠落は根拠付きで扱う。

検証の `findingLinks` では候補の元の `findingAxis` と `findingId` を保ち、操作、条件、期待動作、実際の破綻、修正効果、要求とコードの固定参照を照合する。
候補の `expectedBehavior` は契約が求める動作、`failure` は実際の誤動作として区別する。
リンクの `obligation.candidate` と `observedBehavior` をそれぞれに対応させる。

- `violation` は全 `match=same` と `effectOfFix=resolves_this_violation` を必要とし、元の軸付きID（`standards:id` または `spec:id`）を `findingIds` に入れる。
- `supporting` も同じ一致と修正効果を必要とする。
  未充足の複合要求の対象外部分や、同一原因の別候補の補足へ限定し、必須指摘へ加えない。
- `rejected` は候補を直しても当該違反が変わらない対応、`unresolved` は未確認の対応とする。
  未確認の対応がある要求を充足にしない。

説明行の段落内に要対応や未確認の候補がある場合も独立に照合する。
別操作で無関係なら具体的相違と修正しても変わらない根拠を棄却リンクへ残し、説明を実装義務へ変えない。
原因統合だけで要求との対応を認めない。

## 保存先と親による最終照合

既定の保存先はnod DBと同じディレクトリの `reviews/<runId>/` である。
`prepare.artifactPath` は `preparation.json`、`plan.artifactPath` は `plan.json`、探索記録は `exploration.json`、最終検証記録は `execution.json` を指す。
親へはファイルパスに加え保存ディレクトリも返す。
各工程の入力とschemaは `inputs/`、固定コードと資料は `context/` にあるが、検証担当はCLI入力からの参照だけを使う。

親は両委譲から戻った後で次を行う。

```sh
nod review show --run <runId> --json
```

`show` と最終 `execution.json` の実在を照合し、同じ `runId` と `target.hash`、両担当の申告、最終状態を確かめる。
探索だけの `artifactPath` や成功終了を最終記録と取り違えない。
`fixedResult` の固定版評価と `currentSubmission.eligible` を区別し、変更検出時の点数なしを過去の5点で埋めない。
検証記録が無ければ未実施、記録済みの未完了なら結果として報告する。
CLIの照合や採点は形式と固定版の検査であり、自然言語の意味判断や不具合の完全な発見を証明しない。
