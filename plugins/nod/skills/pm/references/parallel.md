# 並行するIssueの枠と監督

起動と再開時は[永続記録と再開](recovery.md)で管理範囲、試行、工程、占有と予約を復元する。
旧実装者、独立確認担当、現在所有者は同じIssueの対応記録として扱い、枠を重ねて数えない。
起動予約と解放の前後もnodへintentとcheckpointを残す。

以下の`ORCA`は、このセッションで現行手引きを取得した実行ファイルを指す。
新規候補は[candidates.md](candidates.md)、開始と提出は[implementation.md](implementation.md)、質問は[questions.md](questions.md)の既存条件を満たす必要がある。
空き枠があることだけで着手条件を満たしたと判断しない。

## Issueごとの占有と予約

並行上限は省略時1、明示時1または2で固定する。
仕様準備のIssueと、実装用のIssue枠を別に表示する。
正式Spec確認後に実装へ移るときは、新規候補と同じ空き枠の確認と予約を行う。
needs-spec付きのworkerがいることを理由に実装を始めない。

枠に数える単位は、このPMが管理する一意なIssueである。
nodの管理ログにあるIssue、Run、Task、Dispatch、工程、terminalとworktreeを、現在のTask依頼内容とactive Dispatchへ照合する。
Orcaの特定のJSONパスに`issueId`や`managedByPm`が必ず存在すると仮定しない。
同じIssueの元実装者、独立確認担当、再利用前の旧Dispatchは1枠にまとめ、履歴を現在の所有者として重ねない。
管理外のworkerは二重着手と変更範囲の競合を防ぐために照合し、PMの占有数へ加算しない。

| 現在の工程や観測 | 枠の扱い |
| --- | --- |
| 実装用workerの新規起動直前 | 空きを確認して1枠を予約し、同じ選定波の次の候補にも予約済みとして数える |
| 起動試行中、モデル照合待ち、開始通知待ち | 予約1枠。Issueがまだtodoでも空きに戻さない |
| 実装、初回レビュー、指摘修正、独立確認、PR作業 | 同じIssueの占有1枠。Taskや担当が増えても枠を増やさない |
| 人の回答待ち | 同じ占有1枠。質問作成、Deliveryのack、workerの無応答では解放しない |
| 通信断、応答喪失、`unverifiable` | 予約または占有を保持。結果不明を失敗、終了、完了へ変えない |
| PRの実在、現在commit、nodとの関連、`in_review`を確認済み | PMの提出完了として枠を解放する。Issueのdone、マージ、人の最終承認は別の判断 |
| 人への明示的引き継ぎを記録済み | 引き継ぎの工程、判断対象、次の所有者と既存実行の扱いを確認して枠を解放する |
| 起動が適用されなかったことと残存資源の処理を肯定的証拠で確認済み | 予約を解除できる。非zeroやreceipt欠落だけでは解除しない |

人への質問を記録しただけでは明示的引き継ぎにならない。
回答後に同じ元作業を再開する通常の質問待ちは、枠を占有したまま管理する。
[review-fixes.md](review-fixes.md)の上限後の処理などで人へ明示的に引き継ぐときは、停止工程、対象commit、未解決の根拠、必要な判断、次の担当と再開条件をnodへ記録する。
workerのsettlementとcleanup所有権はOrcaの現行契約に従って別に処理する。
枠を空けるために質問待ちを引き継ぎ済みや完了と書き換えない。
既存の起動試行を確認できない場合は、残存資源とrequestを現行recovery手順で照合し、追加workerを起動しない。

新規起動前に、nodへIssue、予約1枠、Runと作成済みTask、要求する`モデル:effort`、理由、開始条件を残す。
未作成のDispatchやrequest IDを捏造しない。
起動receiptを受けたら、実際のTask、Dispatch、terminalとworktree、要求値と実効値、工程に更新する。
同じIssueのログ変更だけで、別Issueの枠や質問を変更しない。

## 空き枠へ独立作業を入れる

通知を処理した後と新規着手直前に、固定WorkspaceとCycle、最新のIssue、管理中実行を再取得する。
「上限、占有と予約のIssue一覧、空き枠」を示し、上限から一意な占有と予約のIssue数を引いて空きを求める。
候補同士だけでなく、質問待ちとモデル照合待ちを含む既存作業との変更範囲も照合する。

人待ちで止める対象は、該当Issueとその完了を待つ後続Issueである。
未完了のブロック元、未回答質問、仕様未合意、競合がある候補は、空きがあっても開始しない。
待機中Issueの依存関係を外したり、人の回答を推測して再開したりしない。

| 状況 | 次の行動 |
| --- | --- |
| 既定1、Aが回答待ち | Aが1枠を占有。独立Bでも開始しない |
| 上限2、Aが回答待ち、Bが独立かつ実装可能 | Aの1枠を保持し、Bの1枠を予約して依頼する |
| 上限2、Aがモデル照合待ち、Bがレビュー中 | 予約と占有で2枠。Cは開始しない |
| 上限2、Aが回答待ち、BのPR提出確認済み | Bだけを解放。空いた1枠には最新条件を満たす独立Cを入れられる |
| 空きあり、候補がAの依存待ちだけ | 新規開始せず、既存workerを監督する |

各Issueの開始、質問、回答の出典、対象commit、成果、枠の変化をそのIssueのnodログへ残す。
例えばAの保持期間の質問をBの実装完了で解消せず、BのPR URLをAへ関連づけない。
実回答を得たときも、質問ID、元message、Taskとactive Dispatchを照合して、同じ元作業へだけ返す。

## 監督のcheckpoint

空き枠への依頼後は、全ての管理中実行を同じRunで監督する。
新規候補の一覧が空でも、稼働worker、仕様準備worker、確認担当、提出作業の通知が残る間は監督を続ける。
候補なしをworkerなしと取り違えない。

```sh
ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 60000 --json
ORCA orchestration worker-list --run <RunID> --include-remote --json
```

長い同期waitを繰り返さず、60000ms以下のcheckpointで状態と進捗を共有する。
Deliveryの全メッセージをIssueとactive Dispatchへ対応させ、質問とworker_doneを別々に処理する。
質問待ちDeliveryは対応と待機条件をnodへ保存してからackし、worker_doneを含む場合は次の所有者かrelease成功を先に確認する。
再利用した旧Dispatchをreleaseしない。
ack後の`check`が次のDeliveryを返したら、それも処理対象にする。

timeoutや空通知はcheckpointであり、承認、実行終了、失敗の証明ではない。
3回連続で空の場合は現行Orca手引きに従い、Runを限定してremoteを含むworker一覧とページ続きを取得する。
`projection.liveness`、attention、literalなnextActionを読み、`unverifiable`では状態を保持して読取か待機を続ける。
未知のfieldやargvを推測しない。
通常の監督を無回答のまま完了扱いにせず、人が指定した停止や引き継ぎでは次節の状態を残す。

## 停止と待機の報告

停止指示を受けたら、新しいIssueの仕様準備と実装への着手を止める。
停止の原文、出典、以後の新規着手停止をnodの管理中Issueへ記録し、空き枠への補充も止める。
既存worker、質問、予約、対象commit、worktreeとterminal、active Dispatchを残す。
「新規着手停止」だけを根拠にworker-stop、abandon、release、done化を行わない。
既存実行の通知を受け取った場合も、現在の所有権契約と停止指示の範囲に従って処理し、停止を実行失敗と推定しない。

稼働workerも実行可能な作業もない場合は、提出済み成果と待機事項を報告して終了できる。
生存が不明なworkerをこの終了条件へ入れない。
報告はIssueごとに次の項目を示し、成果なしの場合も明記する。

- 確認済みPR URLと対象commit、テストとレビューの参照、nodの提出状態。
- 現在の工程、占有または予約、Run、Task、active Dispatch、terminalとworktree、モデルの照合状態。
- 未回答の質問IDと原文、元message、必要な人の判断、依存待ちと再開条件。
- 上限、占有と予約、空き枠、仕様準備の件数、新規着手を停止しているか。

人の回答待ちを完了として列挙せず、成果と待機をIssueごとに分ける。
