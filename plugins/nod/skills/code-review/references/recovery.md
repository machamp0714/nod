# 停止理由と再実施

親は `nod review show --run <runId> --json` と取得済みの記録から、観測した原因だけを報告する。
検証担当は許可入力と自分のCLI操作の返答だけで判断し、診断を理由に探索の原記録、raw出力、親report、他担当の履歴を読まない。

## 未実施と記録済み未完了

| 状況 | 親の扱い |
|---|---|
| 委譲不能、担当の実行失敗や記録前終了、最終検証記録なし | 独立レビュー未実施。理由、取得済みの両担当IDと定義名、runId、保存先をblockerと報告へ残す |
| prepared、planned、explored、exploration_incompleteのみ保存 | 中間状態のまま残す。点数なしで、独立レビュー完了や合格へ読み替えない |
| 検証まで記録され、最終incompleteかつscore=null | 記録済み未完了。未実施へ読み替えず、指摘、未確認、停止理由、保存先を既存の提出条件へ渡す |
| 検証がcompletedで0〜4点 | 実施済みの要対応結果。非0終了だけで担当の実行失敗へ読み替えない |

未実施なら親自身のレビューで補わず、Done、In Review、PR提出へ進めない。
失敗後の自動再委譲は行わない。
中間状態を閉じるコマンドは作らず、保存済み結果を上書きしない。

## 問題ごとの必要条件

| 観測した問題 | 再実施に必要な条件 |
|---|---|
| 対象や基点不明、空差分、不正な対象 | 正しいrepo、基点、対象版を特定する。空差分を5点にしない |
| IssueやSpecの取得不能、正本不明、要求矛盾 | 正本と必要な資料を取得する。存在するSpecをIssue本文だけで代替しない |
| 必須規約が固定sourcesに無い、STANDARD_UNREADABLE | 必要な固定資料を整える。スキルだけの評価で補わない |
| SCOPE_PLAN_INVALID、SCOPE_UNVERIFIED、RESPONSIBILITY_INVALID | 固定hash、全行範囲、適用理由、分担の意味を確認する。必須要求を参考や検査担当へ移して通さない |
| PLAN_REQUIRED、EXPLORATION_REQUIRED | 前工程が実際に固定または記録されているかを親が確認する。検証担当は探索記録を迂回して調べない |
| STAGE_MISSING、STAGE_UNREADABLE、OUTPUT_INVALID、STAGE_INCOMPLETE | 実際の問題コードと保存状態を残す。未完了出力を合格へ整形しない |
| OUTPUT_INVALIDとreferenceDiagnostic | reason、field、sourceFormで出典の取り違えを把握する。型なしID、snapshotのpath、未知資料、範囲外の行を手で補正して通さない |
| STALE_EVIDENCE、不正な固定引用 | 同じ準備実行のtarget.hashと固定資料、コードを使う。現在版から証拠を取り直して混ぜない |
| CANDIDATE_OMITTED、原因グループや要求対応の不備 | 全候補の元の軸とID、要求別の対応、独立した原因統合を保持する。候補の削除や任意改善扱いで隠さない |
| REVIEW_LAYER_VIOLATION、責務根拠の不足 | 自動チェック結果を受領しない。固定分担と候補の責務を区別し、意味や設計の要求を除外しない |
| BASELINE_SCOPE_UNVERIFIED | 同じpathと行内容の基点証拠、今回の要求と影響を確認する。不明のまま除外しない |
| REQUIREMENTS_CHANGED、TARGET_CHANGED | 固定版の結果と現在版の提出不可を分ける。新しい対象と要求で準備から行う |
| PLAN_ALREADY_FIXED、EXPLORATION_ALREADY_RECORDED、VERIFICATION_ALREADY_RECORDED | 記録を変更せず、新しい準備と委譲で別実行とする |
| 担当の中断や実行環境の失敗 | 観測した失敗と保存済み成果を残す。未記録の原因を推測せず、自動再委譲しない |

記録前の出力形式だけなら、担当は同じrecord引数の `--check` で確認し、一時出力を整えられる。
保存済み工程の再記録はできない。
指摘修正は親側の別作業へ返し、再レビューには新しい実行IDと新しい委譲を使う。
点数は表示した固定版と確認範囲だけの結果であり、限定評価や未実施の確認をIssue全体の完了へ読み替えない。
