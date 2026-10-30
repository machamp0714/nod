# 指摘修正と独立確認

この手順は、`nod:implement`内の初回独立レビューを受け取った後に使う。
PMが同じ初回レビューを追加起動せず、元実装者による修正と、別identityによる確認を調整する。
PM自身は実装ファイルを修正しない。
Orcaの現行`references/coordinator-loop.md`、`references/placement-and-remote.md`、`references/messaging-and-gates.md`と`worker-start --help`を確認する。
以下の`ORCA`はこのセッションで手引きを取得した実行ファイルを指す。
新規依頼、通知、所有権移転の前後には[永続記録と再開](recovery.md)のintentとcheckpointを残す。
Taskを先に作りIDを保存してから起動し、各mutationへ記録済みの`--retry-request`を付ける。
startedとcompletedを区別して記録し、会話履歴や重複報告から巡数を数え直さない。

## 初回指摘を分ける

初回報告のRun、Task、active Dispatch、Issue、元実装者、terminal、worktree、実効モデルとeffort、現在commitを[実装手順](implementation.md)どおり照合する。
StandardsとSpecの両軸、実装者と異なるreviewer identity、レビュー基点と対象commitを確認する。
指摘ごとに次の区別を行い、nodへ分類と根拠を記録する。

| 分類 | 修正対象にする根拠 |
| --- | --- |
| 仕様不適合 | Issue本文または正式Specの要求と、現在の振る舞いが異なる。該当項目と不一致の証拠がある |
| 規約違反 | 適用するリポジトリ規約の箇所と、違反する差分が特定できる |
| 不具合 | 再現条件、期待結果と実際の結果があり、現在commitで確認できる |
| 任意改善 | 好み、将来の整理、設計案の比較など、仕様と規約と期待動作への違反を示していない |

重大度やreviewerの断定だけで必須にしない。
根拠や対象commitが不足する指摘は不足証拠として返し、仕様変更が必要なら[質問の手順](questions.md)で人へ戻す。
判断の余地がある設計改善を自動修正の受入条件へ追加しない。
任意改善だけなら0巡のまま、受入条件、必要テスト、現在commitの初回レビューが揃ったことを確認して[PR作業](implementation.md#同じ実装者へpr作業を渡す)へ進む。

必須指摘の依頼には、指摘ID、分類、正本の該当箇所または再現証拠、対象commit、対象差分、期待する修正、確認可能な受入条件を添える。
元報告の引用または参照先を残し、PMの要約だけで根拠を置き換えない。
古いcommitの報告は現在の解消証拠に使わず、現在commitとの対応が確認できるまでPRへ進まない。

## 巡と所有権を記録する

初回レビューは**0巡**である。
元実装者の修正と、実装者以外の独立確認が完了した組を**1巡**と数える。
自動で進めるのは最大2巡までとする。
修正依頼を送っただけ、修正報告だけ、確認担当を起動しただけでは完了巡を増やさない。

nodのActivityへ、少なくとも次の節目を分けて記録する。
別のPMセッションでもログだけから現在の巡と所有者を復元できる形にする。

| 節目 | 記録するもの |
| --- | --- |
| 初回レビュー受理 | 初回0巡、基点と対象commit、StandardsとSpec、reviewerと実装者identity、必須指摘と任意改善 |
| 第n巡の修正開始 | 完了巡n-1、進行中n、修正Taskとactive Dispatch、修正前commit、必須指摘IDと根拠と受入条件、元terminalとworktree、モデル:effort |
| 修正報告受理 | 進行中n、修正TaskとDispatch、新commit、受入証拠、必要テストのコマンドと対象commit、次の確認待機Taskとactive Dispatch |
| 第n巡の独立確認開始 | 進行中n、確認Taskとactive Dispatch、reviewer identity、修正前後commit、確認する既存指摘と修正差分、実装者の現在所有者 |
| 第n巡の確認完了 | 完了巡n、確認TaskとDispatch、確認対象commit、指摘IDごとの解消証拠と残存、新しい不具合、現在gitとの照合、次の所有者と提出または停止判断 |

例では`nod -w <Workspace> issue log <IssueID> "<上記の根拠と対応>" --kind progress`を使う。
通信断や応答喪失で未完了巡を0へ戻さず、active Dispatchとログを再取得する。
旧Dispatchや重複通知を新しい確認として数えず、現在commitが不明なら`unverifiable`として提出を停止する。

## 元実装者へ修正を戻す

修正は元の実装agent、同じterminal、同じ専用worktree、同じ実効モデルとeffortで行う。
`worker-show --dispatch`で元セッションの実効設定を再取得し、`モデル:effort`を依頼にも記載する。
不一致、設定不明、再利用非対応なら別の実装者を起動せず人へ戻す。
既にsettleした元実装者へ新しい修正Taskを渡し、receiptで新Dispatchへの所有権移転を確認してから元Deliveryをackする。

```sh
ORCA orchestration worker-show --dispatch <元実装DispatchID> --json
ORCA orchestration task-create --spec "<同じIssue、第n巡の指摘修正、全必須指摘の根拠と対象commitと受入条件、同じモデル:effort、必要テストと新commitを報告、pushとPR作成は後続指示待ち>" --json
ORCA orchestration worker-start --task <修正TaskID> --terminal <元agentのhandle> --worktree <元terminalの正確なselector> --json
ORCA orchestration check --ack <処理済みDeliveryID> --json
```

reuseに`--agent`、`--model`、`--effort`、新しい`--on`を重ねない。
旧Dispatchはcleanup所有権を失うので後からreleaseしない。
修正報告では現在commitの受入結果、必要テスト、変更差分を照合し、テスト未実行や失敗のままPRを依頼しない。
証拠の補完だけでは新しい完了巡にしない。

## 実装者と異なる担当へ確認を依頼する

確認は元実装者とは異なるidentityが行う。
初回レビューの再実行ではなく、既存指摘IDの解消と、修正前commitから現在commitへの差分だけを対象にする。
独立確認依頼には元の根拠と受入条件、修正報告、テスト、基点と対象commit、read-only制約を含める。
確認担当は実装ファイルを変更せず、未解消の指摘、新しく確認した不具合、各結果の証拠を報告する。

独立確認を待つ間も元実装者を維持する。
修正報告のsettlementを受理したら、同じ元terminalへ「確認待機と後続対応」のTaskを直ちに渡して所有権を移す。
このTaskはPMから次の指示が届くまで変更せず、同じDispatchで通知を待ち、指示された修正、PR作業、または人への引き継ぎ報告でsettleする。
人の明示依頼がない`worker-retain`で待機を作らない。
待機Taskのreceiptを確認し、独立確認の次所有者も決めてから修正報告のDeliveryをackする。

独立担当には同じ実行先の正確なworktreeをread-onlyで指定し、別terminalを起動する。
新規起動用モデルとeffortはユーザー指定または合意済み方針に従い、対応能力と`launch.requested`、`launch.effective`を照合してから開始を通知する。

```sh
ORCA orchestration task-create --spec "<同じIssue、第n巡の独立確認、既存指摘と修正差分と受入証拠、read-only、実装者とは別identity、対象commitとテストと解消証拠、新しい不具合を報告、PMの設定照合後に開始>" --json
ORCA orchestration worker-start --task <確認TaskID> --on <元のStudio接続先> --worktree <元の正確なselector> --agent <指定agent> --model <指定モデルID> --effort <指定effort> --json
ORCA orchestration send --to dispatch:<確認DispatchID> --subject "独立確認開始" --body "<要求値と実効値の一致、対象commit、開始条件を満たしたこと>" --json
```

PMは完了報告のactive Dispatchとreviewer identity、基点と対象commit、必要な指摘IDごとの結果を照合し、実行先gitのHEADと比べる。
実装者の自己申告だけ、古いレビュー、依頼のenqueueだけでは解消済みにしない。
確認担当がsettleしたら、その現所有者のreleaseまたは次の所有者を決めてからDeliveryをackする。

## 次巡、提出、人への引き継ぎを決める

| 確認結果 | 次の動作 |
| --- | --- |
| 現在commitの受入と必要テストが成功し、全必須指摘の解消を独立確認 | 初回両軸レビューから修正差分の確認までの証拠を保ち、[既存のPR手順](implementation.md#同じ実装者へpr作業を渡す)へ戻す |
| 第1巡完了で既存必須指摘が残る | 同じ元実装者へ第2巡の指摘修正を返す。根拠と受入条件を維持し、差分に対応する対象commitへ更新する |
| 第2巡完了で必須指摘が残る | 第3巡を自動開始せず、結果と必要な判断を人へ戻す。PR作成へ進まない |
| 新しく確認した不具合がある | 残る巡数にかかわらず人へ戻し、PR作成へ進まない。回数上限を理由に無視しない |
| 確認対象が古いcommit、現在commitの証拠が不足または不一致 | 現在の確認として採用せず、人へ不足と停止理由を示す。PR作成へ進まない |

確認待機Taskがactiveなら、同じDispatchへ次の修正またはPR作業の自足した依頼を`send --to dispatch:<待機DispatchID>`で渡す。
独立確認がsettleしても元実装者の待機Taskはactiveのままであり、同じterminalへ新Dispatchを重ねない。
PR依頼は現在commitと確認済み証拠を含め、subjectにもpushとPR作業の目的を明示し、enqueueだけで提出完了にしない。
settle済みなら同じterminalに新Taskをreuseし、どちらでも元の実効設定を再照合して`モデル:effort`を明記する。
PRの実在、headRefOid、nodとの関連と`in_review`の確認は既存手順どおり行う。
修正ありのPR条件では、古い初回レビューだけを現在commitの確認とせず、その後の全修正差分の独立確認と現在commitの必要テストを揃える。

人への相談は[質問の手順](questions.md)に従い、Issueと質問ID、番号選択肢、推奨、理由、回答後の動作を示す。
例えば「1. 提出を止め、残存指摘と修正方針を人が確認する（推奨）」「2. 利用者が追加対応の範囲と上限を指定する」とし、PRの強行を選択肢にしない。
上限、完了巡、未完了工程、現在commit、未解決IDと根拠、実装者の所有者をnodへ残し、実回答なしに追加巡へ進まない。
人へ明示的に引き継ぐ場合、activeな待機Taskへ変更を行わず現状態を報告してsettleするよう依頼し、その報告を受理してreleaseしてからackする。
通信断や生存不明のworkerを停止済みと推定してreleaseせず、`unverifiable`の実行をそのまま記録する。
