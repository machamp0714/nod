# 異なるモデルによる固定差分レビュー

`nod review run` は、`review prepare` と同じ対象固定・要求取得から始め、Standards探索とSpec探索を並列に実行し、その終了後に別コンテキストで候補を検証する。
各工程は確認単位を最大80単位ずつの分割へ分け、モデルCLIを同時最大8プロセスで実行し、工程ごとに1つの記録へ集約する（[分割と集約](#分割と集約)）。
探索後、CLIが候補・要求別証拠の出典と対象版を検査し、軸別結果と点数を返す。
`status=completed` は必要なレビュー確認の完了を表す。要対応が残ると0〜4点、両軸の確認が完了し要対応0件なら5点となる。
途中停止や証拠不足では `status=incomplete`、`score=null`。終了コードは5点のみ0、それ以外は1。
`execution.status=completed` はモデルCLI実行の完了だけを表す。5点も固定した対象・確認範囲に限った結果であり、自動修正やマージ許可ではない。

```sh
nod review run --repo /path/to/repo --base main --issue NOD-123 \
  --provider claude --review-model '<利用者のレビューモデル設定>' \
  --implementation-models '<実装した実効モデルID>,<追加の実装モデルID>' \
  --extra-usage-disabled --json
```

`--head`、`--document` による対象・要求指定も `review prepare` と同じ。
モデルの独自defaultはない。実装に複数モデルを使った場合は実効IDの集合を申告する。レビュー設定が別名でも、Claudeランタイムの `modelUsage` にある実効IDが実装集合と重なれば停止する。モデル本文の自己申告は証拠にしない。

## 既存契約と実CLIの制約

`--extra-usage-disabled` は、利用者がアカウント側の追加使用・クレジット消費を無効と確認したことを示す。
結果には `billing.evidence=operator_confirmation` と保存し、CLIが課金停止を機械的に保証したとは扱わない。未指定なら、認証を確認した後 `BILLING_POLICY_UNVERIFIED` で停止する。
このオプションがアカウント設定を変更することはない。

Claudeは `auth status` の `claude.ai`・`firstParty`・Pro/Max、Codexは `login status` のChatGPT認証を要求する。
APIキーやprovider切替の環境変数をモデル子に渡さず、API認証へのfallback、追加購入、超過使用の有効化をしない。取得した使用量はトークン情報であり、実請求額ではない。

**レビューproviderとしてのCodexは、現在は推論前に `MODEL_UNVERIFIED` で停止する。**
`codex exec --json` の実行イベントには実効モデルIDがない。2026年10月28日にローカルCLIの `app-server generate-json-schema --experimental` も確認したが、`ThreadStartResponse.thread.model` は設定モデルであり、per-turn execution telemetryではないと明記されている。`TurnCompletedNotification.turn` にも実効モデルIDはない。`model/rerouted` のみでは通常turnの実効値を確認できない。
対応を進めるには、毎turnで使ったモデルをランタイム由来で識別できるprotocol情報が必要である。
これは呼び出し側のClaude/Codex Skillの制限ではなく、レビュー担当providerの実効値確認の制約である。

2026年10月28日の実行入口疎通では、Claudeは `claude.ai/max`、CodexはChatGPT認証を確認した。追加使用無効の確認が未了のため推論は0件、両者とも `BILLING_POLICY_UNVERIFIED` で停止した。偽CLIによる3工程の成功を実モデルの完遂・検出性能へ読み替えない。

入力がモデル上限を超えた場合は `INPUT_TOO_LARGE` として未完了にする。利用枠不足の `USAGE_LIMIT` と区別し、追加使用の有効化を案内しない。失敗理由はエラー本文とHTTP状態から判定し、`usage` や `fallback_credit` などのtelemetryキーを根拠にしない。必要資料を黙って切り捨てて再実行しない。

## 対象・取消・保存

コードは固定commit、または明示したlocal対象のtreeのblobから実行専用の `context/` へ読み取り専用の通常ファイルとして保存する。主入力には差分・要求資料・ファイル索引を渡し、関係コードは必要な箇所だけ読む。未コミット作業やindexをモデルに触らせない。
ファイル索引 `code` はhead側の相対パス一覧 `paths` と、実行属性のあるファイル `executable` だけを持つ。基点（merge-base）側は読み込めた全ファイルを `.review-base-<runId>/` 配下の同じ相対パスへ置き、`baseCode` には場所 `directory`、headと内容が異なるかheadに無いファイルの `paths`、headと同じblobのファイル数 `sameAsHead` だけを渡す。同じblobのファイルも `directory` 配下にあり、Read/Glob で読める。
Claudeは `--restricted` でcwd内のRead/Grep/Globだけ許可する。Bash・Write・Edit・Agent・Skill・MCP・hookなどは提供せず、safe-modeでcustomizationを無効化する。資料内の命令を実行させない。
秘密情報候補のパスは本文を読まず、symlink・submoduleは辿らない。バイナリ、不正なUTF-8、1ファイル2MiB超、総量64MiB超の資料も `execution.excludedSources` に理由を残す。
変更対象が除外されれば未完了とする。無関係な除外資料は探索を妨げないが、必要な関係コード・証拠が不足する場合はモデルに `completed=false` と不足の記録を要求する。

期限は準備開始から最大30分。`--timeout-seconds` で短くできるが延長はできない。
SIGINT/SIGTERM、期限、失敗ではモデルのプロセス群を止め、SIGTERMに応じない子孫へSIGKILLを送る。停止処理と保存は期限後の後処理であり、成功には読み替えない。
1つの分割の失敗・期限・取消で全分割を止め、待機中の分割は起動しない。最初の失敗理由（`DEADLINE_EXCEEDED`・`INPUT_TOO_LARGE`・`OUTPUT_INVALID` など）を `problems` の先頭に残し、巻き添えで中断した分割の `CANCELLED` で置き換えない。完了済みの分割の出力と、未完了・未起動の分割の担当IDは保存するが、部分完了は `status=incomplete`・`score=null` のままとする。
Windowsなどプロセス群の停止を提供できない環境は未対応として停止する。

保存先はDBと同じディレクトリの `reviews/<runId>/`。`preparation.json` と `execution.json`、初回の専用記録 `initial-review.json` を別々に新規作成し、再実行で前回結果を上書きしない。初回記録は未完了時も保存する。
`execution.stages` には工程（`standards`・`spec`・`verification`）ごとに1件、実効モデル、使用量、所要時間、候補・要求別記録、失敗理由を残す。生のstderrや探索の思考過程を次工程へ渡さない。
`execution.stages[].input` には実CLIへ渡した入力量を残す。`bodyBytes` はstdinの本文JSON、`schemaBytes` は `--json-schema` のUTF-8 byte数、`assignedRequirementIds` は担当単位数、`reviewUnits` は参考を含めて渡した単位数。分割した工程では全分割の合計で、分割別の値は `shards[].input` にある。モデル入力の本文自体は保存しない。入力上限の失敗時もこの記録から肥大化を確認する。

## 分割と集約

1回のモデルCLIへ全単位の要求別記録を出力させると、出力生成だけで30分の期限を超える。期限は延長せず、確認単位を分けて並列に処理する。

- 探索は軸ごとに、資料順・行順を保った最大80単位のほぼ均等な連続区間へ分ける。上限内なら段落の途中で分けない。80単位以下の工程は従来どおり1回のCLI実行で、入力に `shard` を付けない。
- 探索の分割はSpecを先に、同時最大8プロセスで起動する。各分割の入力は担当単位と主要求の参考としてのSpec単位だけを持ち、出力schemaの `requirements` は担当IDだけを担当件数どおりに返させる。
- 同じ軸に複数の探索分割があれば、入力の `shard.candidateIdPrefix`（例 `s2-`）で候補IDを始めさせる。schemaの `candidates[].id` の `pattern` とCLIの検査で接頭辞の無い候補を `OUTPUT_INVALID` として拒否し、CLIは候補IDを書き換えない。
- 検証は全単位（Spec単位を先頭）が80単位以下なら1回で実行する。超える場合は2段階で実行する。
  1. 主分割（`shard.judgesCandidates=true`）が単独で先に起動し、探索の全候補の採否（`candidates`）と原因統合（`causeGroups`）、Spec単位の先頭区間（最大80単位）の要求別記録だけを返す。
  2. 主分割の完了後、残りのSpec単位と規約単位の分割を同時最大8プロセスで起動する。入力の `candidates[].candidates` は主分割が検証した候補（採否・`rootCause`・言い換え後の `failure`・`expectedBehavior` を含む）で、`findingLinks` の `observedBehavior`・`obligation.candidate` はその文と同一にさせる。schemaで `candidates`・`causeGroups` を `maxItems: 0` とし、候補の追加・判定はさせない。主分割が失敗・中断したら残りは起動せず `not_started` として担当IDを残す。
  探索の要求別記録は各分割の担当分だけを渡す。リンクの完全一致の検査は緩めない。
- 時間の見込み（f1b5ae09の実測、要求1単位あたり探索約3.6秒・検証約1.5秒・1回の固定費約100秒からの推定。実モデルでは未確認）：探索は各巡の最も大きい分割の所要時間の和（規約1,000単位なら8プロセスで2巡）。検証は主分割の所要時間に、残りの分割の所要時間（1,000単位なら2巡）を加える。準備を除き、325単位で約12分、1,010単位で約23分。
- 工程の集約記録は、全分割が完了したときだけ `status=completed`。実効モデルは和集合（各分割で実装モデルとの重複を検査する）、使用量と入力量は合算、所要時間は工程の実時間、出力形式は全分割で一致しなければ `OUTPUT_INVALID`。`output` は出力を検証できた分割の候補・要求別記録を連結し、未完了の分割があれば `output.completed=false`。
- 検証の `consistency` は、1つでも `conflict` なら `conflict`、全分割が根拠付きで `consistent` のときだけ `consistent`、それ以外は `unverified`。根拠は分割ごとに連結する。採点は従来どおり集約した1つの検証記録を全単位について判定し、判定条件は分割で緩めない。
- `execution.stages[].shards` に分割ごとの `index`・`status`（`completed`・`incomplete`・`not_started`）・担当ID `requirementIds`・`candidateIdPrefix`・`judgesCandidates`・`elapsedMs`・`usage`・`effectiveModels`・`input`・`cliStatus`・`problem` を残す。分割の出力は工程の `output` にだけ置く。

## 固定資料の索引と規約適用計画

モデルの主入力は対象diff、確認単位、段落表、資料索引である。資料索引 `sources` は資料ごとに `source`（`type:id`）、`title`、読取専用の固定ファイル `path`、行数 `lines`、見出しの `title`/`line` を1回だけ持ち、本文・資料hash・見出しごとのhash・versionは渡さない。必要な本文は `path` から読む。規約の適用範囲と理由は `standardScope` にだけ置き、全行が参考範囲の規約は索引の `referenceOnly` だけにする。事前責務計画の分担は `sourceHash` ではなく資料ID `source` で渡す。

確認単位 `reviewUnits` は `id`・`axis`・`requirement`・`reference`（`source`/`line`）・`requiredAssessmentReferences` と、複数行の段落なら `paragraph` を持つ。段落の範囲と本文は `reviewParagraphs` に段落ごと1回だけ置き、出典hashと引用は単位ごとに繰り返さない。各工程へは担当単位（Standards探索は規約、Spec探索はSpec、候補検証は全軸。分割した工程ではその分割の担当分）と、主要求の参考としてSpec単位だけを渡し、担当外の規約単位は渡さない。CLIは固定した全単位と全source本文から出典hash・引用・段落を復元して照合する。

CLIの保存成果（`preparation.json`・`execution.json` の `sources`・`execution.sourceFiles`）には引き続き全source本文とhashを保持する。

`prepare` は全規約のhash・行数を持つ `standardScopeTemplatePath` も返す。初期値は `unresolved` で、判断を埋めるまで実行できない。

`--scope-plan` は固定した `standard:<id>` とhashに対し、全行を `required`・`reference`・`unresolved` に分類したJSONを受け取る。形式と作成手順は[Skillの実行手順](../plugins/nod/skills/code-review/references/execution.md#規約の適用範囲を固定する)を参照する。未指定は従来の全規約確認。Issue・Spec・承認計画の除外は許さない。

全資料・全行を網羅しない計画、重複・hash不一致は `SCOPE_PLAN_INVALID`、未確認は `SCOPE_UNVERIFIED` で停止する。判断の意味上の妥当性は作成者・レビュー担当の責務。単なる資料取得や形式検査だけで証明したと扱わない。計画とhashは `standardScope` に固定し、途中変更・読取不能は `REQUIREMENTS_CHANGED`。隔離修正後も初回の計画を引き継ぐ。

参考範囲は要求の行単位確認から外すが、資料全文を保存し、候補の根拠にも使用できる。参考範囲があれば `scope.kind=limited` と `standardApplicability` に範囲・理由を残す。元のPR全体に適用される規約を検証済みとは表現しない。

### 簡潔な構造化出力

現在のモデル要求は `format=3` のJSON Schemaを使う。トップレベルの `target` を固定対象hashに制約し、候補・要求・整合性・原因グループの必要な項目と型を指定する。要求の全件確認・候補の採否は引き続き別途照合する。

要求本文・axis・出典hash・引用はモデルに繰り返させず、固定した要求IDからCLIが復元する。コード引用は `path/revision/line` を固定Gitへ照合し、実在する行全文を取得する。元の詳細形式も従来の照合を維持する。明示された誤った引用や対象hashを都合よく修正して合格させない。

固定資料の出典は全て `{source,line}` で返し、`source` は資料索引 `sources[].source`・`reviewUnits[].reference.source` と同じ `type:id`（例 `standard:AGENTS.md`）を省略せずに使う。`--json-schema` は全ての出典の `source` に型接頭辞（`issue`/`document`/`plan`/`standard`）を必須とするので、型なしID・ファイル名・snapshotの `path` は実CLIの構造化出力検証で再出力させる。schemaの肥大化を避けるため全資料IDは列挙せず、索引に無いIDと範囲外・整数でない行はCLIが `OUTPUT_INVALID` で拒否する。拒否時の `problems[].referenceDiagnostic` には理由 `reason`（`unknown_source`/`invalid_line`/`line_out_of_range`）、出力項目 `field`、取り違えの種類 `sourceForm`（`catalog_id`/`id_without_type`/`snapshot_path`/`unknown`）、一致した資料の位置・行番号・行数だけを残し、モデルが返した文字列は保存しない。型なしIDやpathを索引の資料へ自動補正して通さない。

新形式のrequired候補には今回の差分行の `changeEvidence` を要求する。差分外の既存問題はrequiredにしない。候補検証の `causeGroups` に全候補を一度ずつ割り当て、同一原因を共通IDへ統合し、根拠を保存する。グループの欠落・重複・未知候補は出力不正で停止。差分行の存在やグループの形式が、因果関係や意味上の同一性を証明するわけではない。

## 指摘・要求別判定の契約

入力の `reviewUnits` は固定したIssue・Spec・規約の本文から作る。見出し・空行・表の区切り・コード囲みを除き、短文やチェック欄のない散文も確認対象に残す。計画JSONはTask・Stepのtitleとdescriptionだけを抽出し、状態やJSON構造を要求にしない。各単位のすべての要求を確認し、探索も検証も単位を省略できない。Specの確認単位が0件なら未完了になる。
`focus` は差分から選んだ観点と理由であり、追加の必須規約や指摘数のノルマではない。

各工程の候補は `execution.stages[].output.candidates` に保存する。最終採否は `findings`、要求別判定は `coverage`。探索候補を検証担当が省略した場合も未確認として残す。CLIは対象hash、出典hashと引用、固定Gitのhead/baseにおけるパス・行・引用を照合する。削除したファイルは `revision=base` で基点の証拠を示せる。

| 出力 | 意味 |
|---|---|
| `findings[].decision` | `required`、`unverified`、`false_positive`、`out_of_scope`、`deferred`、`risk_accepted`、`optional` |
| `findings[].proposedDecision` | 検証モデルが提案した判定。CLI照合で未確認へ変わった場合も残す |
| `findings[].contract` | 固定sourceの `{source,hash,line,quote}`、または固定コードの `{path,revision,line,quote}`。モデルは `source`（`type:id`）/`line` または `path`/`revision`/`line` だけを返し、hash・quoteはCLIが固定資料・固定Gitから復元する |
| `findings[].location` | `{path,revision:head\|base,line,quote?}`。対象の主識別は `target.hash` |
| `condition` / `failure` / `impact` | 到達条件、破綻、実際の影響と0〜4の影響点 |
| `evidence` / `reproduction` | 静的証拠と再現手順。現在の工程は実行ツールを持たず、実行済みコマンドの証明にはしない |
| `defense` / `sdk` | 既存防御の検査とSDK版の裏付け。SDKが関係するときは版を含む固定依存ファイルの引用が必要 |
| `needsSpecificationDecision` | 新たな仕様判断が必要ならtrue。requiredには確定できない |
| `rootCauses` | 共通原因と軸別候補の関連。片軸の証拠を消さず、後続修正・評価で二重計上を避ける |
| `coverage[].status` | `satisfied`、`unsatisfied`、`unverified`、`out_of_scope`、説明確認の`context` |
| `coverage[].findingIds` | 未充足を裏付けるrequired候補の軸付きID（`standards:id` / `spec:id`）。未充足を候補なしで完了にしない |
| `scope` | 全要求か限定範囲かと、対象外として残る要求ID。限定合格をIssue全体の充足と表現しない |

候補には採否理由 `rationale` を必須とし、対象外・後続対応・リスク受容には計画の `scopeEvidence` を要求する。要求の対象外判定も同じで、まだ実装がない後続Taskは `implementation=[]` を許す。単にモデルが対象外と言うだけでは満点にしない。要求間の矛盾や整合性未確認は未完了となる。

要求の充足には実装参照と静的な確認方法・証拠が必要で、既存テスト成功だけを充足としない。未確認や旧版の証拠が1件でも残れば最終点数はnull。確認済み問題・棄却理由・モデル段階の原記録は消さない。要対応の最重影響で0〜4点を決め、任意提案は減点しない。
実行中にIssue・Document・計画・適用規約の内容や版が変われば、新しい実行を要求する。

CLIが保証するのは版・出典・必要記録・採点規則の照合であり、自然言語の影響判断や証拠の意味上の正しさまで決定的に証明するものではない。モデルの検出性能は別途の過去事例・新規PR評価で測る。

## 後続工程への接続

`initialReviewPath` が修正前の初回記録を示す。`execution.stages` から探索候補と検証棄却を分けて読み、`findings` の `required` だけを修正候補にする。根本原因単位の評価は `rootCauses` と軸別候補を併用する。
現在の入口はcommit差分と明示したlocal差分のレビュー、隔離修正1回、明示した最大3回の隔離修正に対応する。任意の同時編集から元作業を保護する反映adapterは未対応のため、元作業への自動反映は提供していない。実効モデルの確認と課金方式の制約はこれまでと同じで、Codex providerは推論前に停止する。


## local対象の実行結果

`review run` も `--local` と繰り返し指定できる `--untracked <path>` を受け付ける。省略時は従来どおりcommitだけを対象とする。指定方法・除外条件・indexの制約は[レビュー入力の準備](review-prepare.md#未コミット変更を明示して固定する)を参照する。

Standards探索・Spec探索・候補検証の3工程は同じ固定treeを読み、証拠の `revision=head` もlocal対象のtreeに対して照合する。`revision=base` はmerge-baseのまま。適用規約もlocalの固定内容から取得し、固定後に規約が変更された場合は未完了にする。

実行開始後の元ファイルの編集を上書きしない。コードが同時編集されても結果は開始時の固定対象だけについて保存する。`mode=local` の5点は `headSha` のcommit、後から作成したcommit、現在の作業ツリーに対する承認へ転用できない。別commitを確認するにはそのcommitを対象とした新しい実行が必要である。

後続の隔離修正では `target.local.repo` の `treeSha` を起点にし、開始時indexの内容は `indexTreeSha` と `stagedPatch`、原本照合は `indexHash` と `sourceFingerprint` を併用できる。これらは反映許可や同時編集の排他保証ではない。自動反復の最終照合でもこの区別を保ち、排他保護が成立しない状態では元作業へ書き込まない。

## 隔離領域で1回修正する

`--repair-once` を明示した場合、完了した初回レビューの `required` だけを実装側モデルへ渡す。修正、指定した必要な検証、新しいStandards探索・Spec探索・候補検証までを1回実行する。この段階では元の作業へ反映しない。従来の `review run` だけでは修正しない。

```sh
nod review run --repo /path/to/repo --base main --issue NOD-123 \
  --provider claude --review-model '<レビューモデル設定>' \
  --implementation-models '<実装の実効モデルID>' --extra-usage-disabled \
  --repair-once --repair-provider claude --repair-model '<実装側のモデル設定>' \
  --repair-plan /path/to/preparation-plan.json --json
```

修正モデルもCLIの `modelUsage` を照合し、実装モデル集合への所属と、それまでのレビュー実効モデル集合との不一致を要求する。修正側がCodexの場合も、実効モデルを証明できない現在の公開protocolでは推論前に `MODEL_UNVERIFIED` で停止する。追加使用無効の確認はレビュー側と共通で、実推論の無許可の疎通をしない。

モデルは初回の固定 `context/` をRead/Grep/Globで読むだけで、shellや書込ツールを持たない。変更案は相対パス、変更後全文（削除はnull）、対応する `axis:id` 形式のrequired IDとして返す。CLIが対象版、requiredとの対応、パス、通常ファイル、サイズ、要求・規約の保護を検査してから隔離領域へ適用する。新たな仕様判断、任意提案、要求・規約の追加や書換えによる合格は認めない。変更の意味上の妥当性は新しい両軸レビューで確認する。

### 準備・検証計画

`--repair-plan` は利用者または呼出側Skillが対象の固定規約を確認して用意するJSONであり、モデルが生成した任意shellを実行する入口ではない。必要な検証を特定できなければ実行を始めない。内容はhashとともに保存し、後から計画ファイルを変えても実行中の計画は差し替わらない。

```json
{
  "version": 1,
  "isolation": "copy",
  "rationale": "固定規約を確認した。隔離コピーで検証でき、追加の環境準備は不要。",
  "standards": [],
  "prepare": [],
  "verify": [
    { "command": "bun", "args": ["test"], "rationale": "対象の必要な回帰検証" },
    { "command": "bun", "args": ["run", "typecheck"], "rationale": "対象の型検査" }
  ]
}
```

規約が存在すれば `standards` にすべての固定規約の `{ "source": "standard:CLAUDE.md", "hash": "固定sourceのSHA-256" }` を記録する。`verify` は空にできない。これは呼出側による準備条件・検証選択の記録であり、hashの一致だけで自然言語の規約適合を機械的に証明したとは扱わない。

現在の隔離adapterはmacOSの独立コピーと `sandbox-exec` に対応する。準備・検証の書込先と `TMPDIR` は隔離作業領域内に限り、ネットワーク、元リポジトリの読取、秘密候補の読取を禁止する。OS隔離が成立しない場合は未完了になり、非隔離実行へ切り替えない。依存関係の導入を含め、必要な準備がこの条件内で成立する必要がある。検証コマンドが対象の内容・実行属性・削除状態を変えた場合も再レビューへ進めない。

モデルから除外したbinary・不正なUTF-8を含め、通常ファイルは固定Git blobから検証環境へbyteを保持して再現する。1ファイル64MiB、総量128MiBを超える環境は未対応。秘密候補、symlink、submoduleはコピーせず `repair.excludedEnvironmentSources` に残す。これらが必要な準備・検証・レビューは完了扱いにしない。

Orca、worktree、Docker、huskyへの言及は、必須の準備規約か単なる説明かを呼出側が全文の文脈で判断する。該当する `standards` 要素に `environment` 配列を置き、各言及行を `{ "line": 34, "quote": "行全文", "kind": "informational", "rationale": "今回の修正には適用されない機能説明" }` の形で記録する。行番号は1始まりで、改行を除く行全文を引用する。該当語のない資料では配列を省略できる。

`kind` は `required`（適用される必須準備）、`informational`（単なる説明・今回非適用）、`unresolved`（未確認）。同じ行に必須指示が含まれれば `required` とする。CLIは全言及行の網羅・重複・引用・理由を検査する。言及があるのに記録がない旧形式の計画や未確認は `REPAIR_PREPARATION_REQUIRED`、出典に合わない判断は `REPAIR_PREPARATION_INVALID` で停止する。単語だけを根拠に機能説明を必須規約へ変換しない。

`required` と判断された専用準備は `REPAIR_PREPARATION_UNSUPPORTED` で停止する。規約の意味・適用判断は計画を作る呼出側の責務であり、hashや引用の一致だけで解釈を機械的に証明するものではない。判断と根拠は `repair-N/preparation-plan.json` に保存する。Orca・Docker・worktreeなどの専用準備規約を実行できるadapterはまだ実装していない。nodも必要な依存・検証が隔離環境内で成立する場合だけ実行できる。他リポジトリの自動修正対応完了を意味しない。

### 結果と後続工程

初回からの同じ期限を、準備・修正モデル・検証・再レビューへ渡す。終了コード0だけで成功にせず、必要な検証が完了し、現在の固定版で両軸の要対応0件の場合だけ `repair.status=ready`、`score=5` とする。元への適用は常に `repair.applied=false`。指摘が任意提案だけの場合は `not_needed` で修正モデルを呼ばない。

`initial-review.json` は上書きしない。`repair-1/` に次の成果を保存する。

- `changes.patch`: 修正前の固定treeから修正後treeまでの差分。未適用・失敗時も保存する。
- `repair.json`: 準備計画のhash、実効修正モデル、使用量、コマンド別の完了状態・出力hash、停止理由、元と修正後の対象。
- `snapshot.git` と `workspace/`: 修正後の固定treeと検証用作業領域。commitは作らない。
- `review/`: 修正後の新しい3工程、要求別対応、根本原因と軸別指摘、その版の点数。
- `result.json`: 処理全体の結果。検証失敗・退行・期限・未確認では `status=incomplete`、`score=null`。

変更案の検査や適用準備中に止まった場合、patchは最後に確定できた安全な差分（まだなければ空）になる。受け取った変更案は `repair.model.output` に残す。未検証の作業領域や変更案を成功・適用可能とみなさない。

反復処理の接続点は `repairReviewOnce` と `runReviewPass`。前者は1回の修正と再レビューを行い、iterationと初回originを渡せる。後者は固定済み `ReviewPreparation` に対して同じ証拠照合を行う。`repair.originalTarget` は初回、`inputTarget` はその反復の修正前、`finalTarget` は修正後、`reviewPath` は再レビューの保存先である。退行がある場合も、その版の完了したレビュー点数は `reviewPath` の履歴に残る。`autoRepairReview` が反復回数、再発・進展なしの停止、累積patch、元対象の最終照合と検証済みpatchの受け渡しを担当する。

CLI契約テストでは一時Git/DBと偽モデルCLI・偽sandboxを使う。`NOD_REPAIR_REAL_SANDBOX=1 bun test packages/cli/test/review-repair.test.ts` はモデルを偽のまま実OS隔離を使う独立検証であり、通常のOrca terminalなどsandboxを起動できる環境で実行する。OS境界テストは外部書込・元repo読取・偽の秘密候補読取・通信拒否を確認し、通信先の稼働も隔離外の事前・事後接続で確認する。偽モデルの通過を実モデルの修正能力や検出性能の証明にしない。


## 上限付きの自動修正とpatch受け渡し

`--auto-repair` を明示すると、初回レビューの後に最大3回の修正・必要な検証・新しい両軸レビューを実行する。`--repair-provider`、`--repair-model`、`--repair-plan` は1回修正と同じ設定を使う。`--repair-once` との併用は未完了になる。従来のレビューだけでは修正しない。

```sh
nod review run --repo /path/to/repo --base main --issue NOD-123 \
  --provider claude --review-model '<レビューモデル設定>' \
  --implementation-models '<実装の実効モデルID>' --extra-usage-disabled \
  --local --auto-repair --repair-provider claude \
  --repair-model '<実装側のモデル設定>' --repair-plan /path/to/preparation-plan.json --json
```

初回からの期限を全反復に引き継ぎ、準備・修正・検証・再レビュー・最終照合を含め最大30分とする。期限後は新しい工程を始めず、子処理を停止して最後に確定した成果を保存する。保存などの後処理時間を新しい実行枠にはしない。準備・検証計画は実行用の `repair-plan.json` に固定し、利用者側の計画ファイルを途中で変更しても反復へ取り込まない。

次の場合は最終 `status=incomplete`、`score=null` で停止する。

- 同じ確認済み根本原因が残る、または過去に確認した原因が再発する。
- 差分がない、初回や過去の対象treeへ戻る、要対応の原因数が減らない、最重影響が悪化する。
- 最大3回、全体期限、取消、モデル・準備・検証・取得・解析の失敗に達する。
- 重要な未確認や新たな仕様判断が残る、要求・計画・適用規約が初回から変わる。

過去の確認済み指摘と根拠は、再レビューの候補検証にだけ `priorConfirmedFindings` として渡す。Standards/Spec探索は独立したままで、探索の思考過程や実装者の自己評価は渡さない。候補検証は到達条件・契約・破綻・証拠を照合し、同原因なら既存の `rootCause` を再利用する。旧版の証拠を現在版の証拠として採用しない。原因の意味上の同一性と指摘の妥当性はモデルの判断に依存し、識別子の照合だけで検出性能を保証するものではない。

### 検証済みpatchの受け渡し

必要な全検証・現在版の両軸5点・要求不変を確認してから、元のHEAD・index・対象ファイルを読み直す。local対象では初回のtree・index hash・source fingerprintと照合し、commit対象では元作業の内容がそのcommitと一致することを確認する。不一致・読取不能は `ORIGINAL_TARGET_CHANGED` で停止する。

全検証・両軸の再レビュー・要求と元対象の照合が完了し、累積patchを保存できた場合だけ、`autoRepair.status=patch_ready`、最終 `status=completed`、`score=5` を返す。適用状態は常に `autoRepair.application=not_applied`、`applied=false`。点数は `target` と `autoRepair.patchTarget` で識別する隔離修正後の固定内容だけに対応し、元のHEADや作業ツリーが修正済み・承認済みという意味ではない。元への自動反映は初版の対象外である。

`checks.originalTargetUnchanged=true` は最終照合で読んだ内容の一致を表す。その後の編集までロックする保証や、現在の作業への適用許可を意味しない。最終Git照合中の編集もファイルの再読取で確認し、不一致なら未完了とする。受け渡し後は対象版とpatchを確認して別工程で適用し、必要な現在commitのレビューを行う。

照合後の同時編集や途中失敗でも元へ書かないため、元ファイルとindexを上書き・復元しない。stash、commit、push、PR投稿、mergeは行わない。修正不要なら `autoRepair.status=not_needed`、反復0回で初回結果を返す。

### 保存と再開

実行全体の `result.json` と `autoRepair` に状態・反復回数・履歴・累積patchを保存する。`iterations` は開始した修正工程数であり、途中失敗した回も含む。初回の `initial-review.json` と各回の `repair-N/result.json`・`repair-N/review/execution.json` は上書きしない。

- `autoRepair.patchPath`: 初回対象から最後に差分を確定できた対象までの累積 `changes.patch`。失敗前に確定した版は `patchTarget` で識別する。
- `autoRepair.history`: 各回の結果・再レビューの保存先・最終対象。再レビュー未実施の失敗も区別する。
- `repair-N/changes.patch`: その回の入力から修正後までの差分。
- `repair-N/cumulative.patch`: その回までに確定できた累積差分。未検証の差分も保持し、適用可能という意味にはしない。

失敗時は現在の指摘、未確認、停止理由と、最後に保存できたpatchを読む。再実行は新しい実行IDになる。以前の未完了の記録を上書きせず、古い結果を現在のcommitの承認へ転用しない。Task7のSkill連携では `autoRepair.status` と最終 `score` を優先し、`repair.status=ready` や履歴の5点だけで自動修正全体を成功と説明しない。

CLIテストでは、最終Git照合の読取直後に別プロセスが編集するケースで未完了・点数なしとなり編集内容を保持することを確認する。累積patchの保存失敗は `PATCH_SAVE_FAILED` となり、各回の `cumulative.patch` と履歴を保持する。自動反映の実装・検証は後続対応である。

## 開発用の過去事例を評価する

[過去事例の凍結・再生・集計](review-evaluation.md)の `review evaluation` は、共通レビュー入口を通した初回結果だけを記録する。正解・比較結果・人判定はモデル入力から分離し、重複除去した要対応の適合率、重大見逃し、PR単位の選別時間を後から集計する。開発用集合の結果を新規30 PRの受入へ転用しない。

format=2の要求別証拠は、実装なら固定コードの行、範囲宣言や文書契約なら固定資料の `source/line` を参照できる。資料に要求が書かれている事実だけで実装の充足を証明しない。探索候補の軸は担当工程に固定し、検証でも候補の軸とIDを保持する。

## 自動チェックと独立したレビュー

`reviewPolicy=independent-v1` は、自動チェックの結果を入力にせずコード・要求を読解した結果を表す。
Biome、lint、型検査、ビルド、テスト、再現コードはレビューから実行しない。結果・診断・ログ・要約・実行証拠への参照も渡さない。旧 `--evidence-plan` は利用できない。候補検証もコードと契約・到達条件・影響の読解で行い、実行が必要なレビュー対象の懸念は未確認として残す。

書式や機械的な違反の再検出を目的にしない。Specとの不一致、業務ロジック、権限・状態遷移・境界条件、テストの期待値やCI設計の不足はレビュー対象とする。自動チェックの成功・失敗・未実行でレビューの状態や点数を変えず、マージ判断では両方を別々に確認する。

機械的な合否だけを要求する行は、レビュー前に `--responsibility-plan /path/to/responsibility.json` で担当を固定できる。`prepare`・`run`・`evaluation replay` で使える。

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

元の要求は変更せず対応表に残り、該当行は `out_of_scope` と分担の理由を記録する。分担の理由は計画の固定値であり、hash・引用と同じくモデルに書き写させない。format=2以降の出力では探索・検証とも、CLIが該当要求の `rationale` を計画の文字列で復元し、モデルが異なる文面を返した場合は捨てずに `proposedRationale` として保存する。判定は従来どおり、探索・検証の両方が `out_of_scope`、`scopeEvidence` がその要求自身の `source`/`line`（format=3では本文分類 `independent_check` も）であることを照合する。固定分担の行を充足など別の状態にした場合や、別の行を `scopeEvidence` にした場合は `COVERAGE_INCOMPLETE` で未完了とする。未登録の要求の `rationale` は変更しない。結果や診断をこの計画に書かない。未登録の要求はレビュー対象のまま。意味・設計の要求を含む複合行を丸ごと除外せず、モデルが内容を読んで機械的な合否を判定せずに意味・設計部分を確認する。hash・行・重複・許可キーをCLIで照合し、途中変更は停止する。担当の意味的妥当性は利用者の要求から確認する必要があり、形式照合だけで正しさを保証しない。

証拠は `evidence.kind=static`、`verification.method=inspection`。`recordIds` は空配列にする。実行証拠を自己申告したモデル出力は `REVIEW_LAYER_VIOLATION` で未完了とする。

## 変更前から存在する要求未充足

`baseCode` で基点側の固定コードも読める（`baseCode.directory` 配下の同じ相対パス）。固定Specが明確に要求する振る舞いを基点から満たしていない場合、候補を `required`、`origin: pre_existing` とし、`baselineEvidence` にbase側の同じpath（`directory` を付けない元のpath）・同じ内容の行を付ける。要求別判定は `unsatisfied` のまま保持し、対応候補を `findingIds` へ記録する。行が一致することだけで同じ原因を証明したとはせず、条件と周辺の変化も照合する。

CLIは `BASELINE_REQUIREMENT_UNSATISFIED` と点数なしを返し、自動修正を開始しない。既存の未充足を今回導入した退行として数えず、仕様や修正範囲の判断が必要な残件として報告する。合格させるためにoptional・充足・対象外へ変えない。基点の証拠が足りない場合は `unverified` のままとする。今回導入した問題は `origin: introduced` と差分行の `changeEvidence` を持つ。


## 本文分類と軸をまたぐ対応（format=3）

Spec全文と固定行IDを維持し、`contentAssessment`に`kind`、実装義務の原文引用`obligations`、固定参照`references`、理由`rationale`を保存する。`obligation`と`mixed`は実装義務を持つ。`background`、`rationale`、`scope`、`validation_gap`は説明だけと両工程が同じ分類で確認したときに限り`status=context`を使える。説明確認には空の実装証拠を認めるが、充足や対象外には変えない。探索の義務を消す分類、未知の分類、出典不足、同じ本文を根拠にする要対応・未確認候補との矛盾は`CONTENT_ASSESSMENT_UNVERIFIED`で未完了にする。

事前責務計画に登録した独立検査だけの要求は`independent_check`・`out_of_scope`とする。URL到達性などの検査実行をレビューに持ち込まない。意味・設計要求が混在する誤った分担は未確認へ戻す。必須の静的資料が取得できない場合の準備失敗は維持する。

要求の`findingIds`は軸付きIDとし、`findingLinks`に元の`findingAxis`・`findingId`、`violation` / `supporting` / `rejected` / `unresolved`の関係を残す。同一IDが両軸にあっても混同しない。別軸の要対応が要求違反を裏付ける場合、候補を移動・複製せず要求側の軸も未充足とする。操作・条件・期待動作・修正効果・出典の検査は継続する。候補の期待動作`expectedBehavior`と誤動作`failure`を分け、リンクの期待動作・`observedBehavior`との対応を検査する。

format=2以前の記録は従来の形式で解釈し、新しい説明判定へ自動変換しない。分類の独立確認と参照の整合性検査は、意味判断の正しさや検出性能を保証しない。偽モデルによる契約テストと実モデルの回帰・独立評価は別に報告する。
