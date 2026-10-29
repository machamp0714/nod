# 永続記録の照合と再開

PMの起動直後、通信断、応答喪失、停止からの再開では、工程を進める前にこの手順を使う。
同じセッションでも副作用の前後に記録し、次のPMが会話履歴なしで読める状態を保つ。
Orcaの現行ガイドと`references/recovery-and-cleanup.md`、`references/coordinator-loop.md`、必要な操作の`--help`を読み、以下の`ORCA`にはその実行ファイルを使う。
独自の復元DBを作らず、nodのActivityとDocument、Orcaの操作receiptと実行状態を使う。

## 副作用前のintentと後のcheckpoint

起動、開始通知、修正依頼、独立確認、質問と回答、PR依頼、release、Delivery ackの前に、操作の**intent**（これから行う操作と照合に使う相関）をnodへ残す。
記録に失敗したら副作用を発行しない。
同じ操作に一つの操作相関IDを使い、Orcaのmutationには現行契約の`--retry-request <操作相関ID>`を指定する。
CLI応答、実行状態、成果を再取得した後、**checkpoint**（確認済みと未確認を区別した進行位置）を同じIssueへ追記する。
nodの書込応答を失った場合も、Activity、質問、Document、PR関連を再取得して既存結果を探し、同じ書込を無条件に繰り返さない。

各Issueのcheckpointは、次の情報を含める。
値が未取得ならunknownまたは未作成と記し、要求値や予定値で実績を埋めない。

| 項目 | 保存する情報 |
| --- | --- |
| 管理範囲と要求 | Workspace、固定Cycle、並行上限、新規着手停止の有無、要求の本文またはspec/plan参照、利用者判断の原文と出典 |
| 工程と枠 | 現在工程、占有または起動予約、解放根拠、仕様準備と実装の区別 |
| 操作と試行 | 操作相関ID、操作内容と宛先、intent/enqueued/確認済み/unverifiableの区別、Run、Task、active Dispatch、旧Dispatchからの所有権移転 |
| 実行場所と設定 | Studioの接続先、repo、worktree selectorとpath、terminal、branch、現在commit、agent、要求モデルとeffort、観測した実効値、照合結果と理由 |
| 修正と確認 | startedとcompletedの巡数、未完了の工程、指摘IDと根拠、基点と対象commit、元実装者と独立確認担当のidentity、現在の待機Dispatch |
| 通知と成果 | 受理したRun/Task/Dispatch/message ID、Delivery IDとackの確認状態、受入とテストとレビューの参照、PR URL/branch/headとnod提出状態 |
| 質問と次の行動 | nod質問ID、元message、選択肢、原文と実回答の出典、未回答と残る停止理由、次に照合する証拠または必要な人の判断 |

```sh
nod -w <Workspace> issue log <IssueID> "<上記のintentまたはcheckpoint>" --kind progress
```

修正巡のstartedは第n巡の修正依頼を行う直前に記録し、独立確認の受理後だけcompletedをnへ進める。
started=1、completed=0なら第1巡の途中であり、第2巡を新設しない。
通知の再配送、証拠補完、再起動だけでは巡数を増やさない。
質問の作成前にも原文と元messageをintentに残し、応答喪失後は既存質問IDを探す。

## 起動前にTaskを永続化する

新規workerや同terminal後続作業は、Taskを先に作成してnodにそのIDを記録してから起動する。
worker-startの応答を失ってDispatchが分からなくても、既知のTaskと操作相関から元試行を探せるためである。
新しいRunが必要なら同様に作成前のintentと操作相関、作成後のRun IDを記録する。
既存Runがある再開では新Runを作らない。

```sh
ORCA orchestration task-create --run <RunID> --spec "<自足した依頼、対象Issue、操作相関、設定と開始条件>" --retry-request <Task作成の操作相関ID> --json
nod -w <Workspace> issue log <IssueID> "<Task ID、起動操作相関、予約、起動前intent>" --kind progress
ORCA orchestration worker-start --run <RunID> --task <記録済みTaskID> --on <Studio接続先> --worktree new-top-level --repo <正確なrepo selector> --name <作業名> --agent <指定agent> --model <指定モデル> --effort <指定effort> --retry-request <起動の操作相関ID> --json
```

既存terminalの再利用は、同じ記録順で`--task`、`--terminal`、元worktreeを使い、起動用model/effort/placementを重ねない。
activeな確認待機Dispatchが元実装者を所有している場合は、それへsendし、同じterminalに新Dispatchを重ねない。

## 会話履歴を使わず照合する順序

1. 指定Workspaceと固定Cycleの最新Issue、Activity、Document、質問、PR関連を取得する。
   checkpointから管理中Issue、Run、Task、操作相関、元実装者、工程、予約、巡、受理messageを復元する。
   古い記録だけで現在の権限を確定しない。
2. `status`、Runごとの`task-list`、`worker-list --run <RunID> --include-remote`、terminal一覧を読む。
   worker一覧のページと読取不足を確認し、既知Taskの依頼内容とactive Dispatchを照合する。
   fixture固有のIssueやPM管理フィールドが本番Orcaにあると仮定しない。
3. 該当Dispatchの`worker-show`と`worker-read`を取得し、実行host、worktree、terminal、agent identity、要求値と観測した実効値を確認する。
   実行先gitの現在commitとbranchを確認し、受理済みのテスト、レビュー、修正差分、PR headを対応させる。
   PM自身のcwdのgitをStudioの証拠に置き換えない。
4. nodの工程と成果に、Orcaの実行権限と現在状態を合わせ、Issueごとのcheckpointを追記する。
   読取不足、設定不明、所有権不明、commit不一致が残るIssueは止める。
   `launch.effective`の欠落を`launch.requested`で埋めず、実装開始を通知しない。
5. 一意な管理Issueで枠を数え直す。
   起動予約、unverifiable、レビュー、修正、回答待ちは枠を保持し、同Issueの旧workerとreviewerを別枠へ加算しない。
   提出済みIssueの解放と、別Issueの質問待ちを混ぜない。

仕様待ちは未回答質問、別モデル照合、仕様合意、テスト境界合意、正式Spec添付を個別に復元する。
実装中は既存試行を監督し、初回レビューを追加起動しない。
修正確認中はstarted/completedと対象commit、独立担当、元実装者の待機所有者を復元し、既存確認を受け取る。
PR提出後はPR実在とhead、nodのin_review、cleanupとackの残件を確認し、実装を始め直さない。

## 応答喪失と通信断

Orca mutationの応答を失ったら、その操作相関を使って結果を問い合わせる。

```sh
ORCA orchestration request-show --request <記録済み操作相関ID> --json
ORCA orchestration task-list --run <RunID> --json
ORCA orchestration worker-list --run <RunID> --include-remote --json
ORCA orchestration worker-show --dispatch <照合したDispatchID> --json
```

completedなら記録済みreceiptを読み、同じ操作を新しいIDで発行しない。
pendingなら元操作が稼働中か、Orcaの再起動で結果未記録かを調べる。
元の呼出が稼働中なら待ち、現行recovery契約が再実行を指定する場合だけ、元のコマンドと同じ`--retry-request`でjoinまたは回復する。
これは元操作の回復であり、新しいworker試行や新しいTaskの作成ではない。
absentや操作相関未記録なら、無作用の証明にせず既知Task、Dispatch、terminal、実行hostの残存資源を照合する。
対応が一意に分からなければunverifiableを記録し、追加workerを起動しない。

通信断、timeout、空通知、nullのagentWait、変化のない出力だけでは失敗、終了、完了と推定しない。
生存と結果がunverifiableの間は予約と占有を保ち、stop、abandon、retry、releaseを行わない。
既存workerの正のlive証拠と設定一致を確認できれば元試行を引き継ぐ。
正のexited証拠や既知failed/stoppedが得られた場合だけ、現行recoveryのliteralなnextActionと所有権に従って判断する。
不足が利用者判断を要する場合は[質問の手順](questions.md)で、保持する実行、確認できない点、推奨と選択肢、判断後の動作を示す。
人へ質問したこと自体で生存不明を終了扱いにしない。

## 重複通知と古い報告

完了報告はRun、Task、Dispatch、message ID、工程、対象commitを受理済みcheckpointと照合する。
同じmessageの再配送は既存受理結果に合流し、質問、修正巡、確認Task、PR依頼を増やさない。
同じIDで本文や対象commitが異なる場合は矛盾として保持し、都合のよい方を採用しない。
旧Dispatchの報告や現在commitと不一致のレビューを、現在工程の完了証拠に使わない。
旧Taskが成功していても、cleanupが次Dispatchへ移転済みなら旧Dispatchをreleaseしない。

各Deliveryの全行について、受理、既処理、古い報告、照合不能を記録する。
settlementを受理した現所有者には、次の所有者かrelease成功を確認してからackする。
再起動後も現在のcleanup所有者を再取得し、旧ログだけでreleaseを再発行しない。
release結果不明は現行recoveryのreceiptへ従い、terminal closeで代用しない。
ack応答を失った場合も現在Deliveryと受理記録を照合し、再配送を工程再実行に変えない。

## PR結果不明から既存成果へ合流する

PR依頼後の応答喪失では、新しいPR依頼を出す前に対象repo、branch、現在commitとnodの既存関連を読む。
明示したrepoで既存PRを探し、URL、numberまたはbranchで取得する。

```sh
gh pr list --repo <OWNER/REPO> --head <実装branch> --state all --json number,url,state,isDraft,headRefName,headRefOid,baseRefName
gh pr view <確認したURLまたはnumberまたはbranch> --repo <OWNER/REPO> --json number,url,state,isDraft,headRefName,headRefOid,baseRefName
```

既存PRのheadが確認済み現在commitと一致し、対象branchとbase、openかつ非draftである場合は、そのPRへ合流する。
nodのリンクとrefreshで状態が自動で変わることはない。レビュー提出の条件と検証が確認済みなら`nod issue update <IssueID> --status in_review`で提出状態を回復する。DoneにするのはmergeとIssueの完了条件を確認した後だけで、提出時点では完了にしない。
成果が確認できても実行settlementが不明なら、PR確認済みとcleanup未確認を分けて残す。
古いhead、複数候補、取得失敗、PR不在の読取だけでは、新PRを作る根拠にしない。
元の依頼と実行結果を照合し、必要なら同じ元実装者へ既存PRの更新または不足証拠だけを依頼する。
PM自身がpush、PR作成、mergeを肩代わりしない。

## 停止と引き継ぎの報告

停止、評価で指定したcheckpoint、人への引き継ぎでは、各Issueの工程、確認済み成果、未確認事項、予約と占有、現在所有者、質問ID、次の具体的な照合または判断を報告する。
新規着手停止の原文と出典もnodへ残す。
既存作業と実行状態を保持する停止を、workerの失敗や人の承認に変えない。
次のPMはこの報告文を記憶することを前提にせず、nodとOrcaから同じ状態を再取得する。
