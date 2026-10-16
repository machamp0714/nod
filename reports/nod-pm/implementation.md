# PMスキルの実装記録

正本はnodのDocument 189（仕様）とDocument 190（計画）である。
2026-10-16の明示指示により、仕様作成時の「設計のみ」を更新して実装した。
実装場所はStudioの`/Users/ooidetatsuya/orca/workspaces/nod/pm-issue-c236b751`、ブランチは`pm-issue-c236b751`、基点は`fa0bb3b006d3ee6e671ddb9021c6669710cbfd23`である。
nodのSSHラッパーが記録するAir側のパスから、実装場所を推定しない。

## 検証の境界

実nod CLIを一時DBへ接続し、OrcaとGitHubは偽接続先へ固定する。
PMとして動く独立したLLMが実際に発行した依頼、質問、記録、提出判断を操作ログと最終報告で確認する。
固定した補助処理の契約テストと、スキルを読んだLLMの行動評価は区別する。
実機workerと本物のGitHub PRは検証で起動しない。

## 初期環境での失敗

- sandbox内のnod読み取りはSSH先の名前解決に失敗した。ネットワーク許可付きの読み取りで正本を取得した。
- `npm exec --yes --package=bun -- bun --version`はsandbox内でregistryの名前解決に失敗した。同コマンドで準備済みのBun実体を直接呼び、1.4.3を確認して使用した。
- Task 1評価ハーネスの最初のテストは、未実装のsetupモジュール参照により0 pass、1 fail、1 errorとなった。
- 評価環境を同じ保存先へ再作成した試行は`CYCLE_EXISTS`で失敗した。以後は未使用の一時ディレクトリを使う。

## Taskごとの結果

### Task 1のbaseline

スキルを渡していない独立エージェントが、一時DBと偽CLIを実際に操作した。
API-1、10、12、13、14を候補とし、API-10と11のみを各1回再判定した。
他担当、Triage、人の質問、依存待ち、既存workerを保護し、worker起動とIssue着手はなかった。
この範囲はbaselineでも合格し、スキルによる改善と主張しない。

枠の説明では、PM管理外の既存workerまで並行上限へ算入する過剰な制限があった。
仕様上の枠はPMが管理するIssueの開始から提出または明示的引き継ぎまでを数えるため、スキルでは管理範囲を明示する。
最初の偽Orcaは直接`items`を返したが、実機の読み取り専用確認では`result.workers`だった。
baseline終了後に実契約へ修正し、baselineをその契約への適合証拠には用いない。

報告は[evaluations/task1-baseline.md](evaluations/task1-baseline.md)、実操作は[evaluations/task1-baseline.operations.jsonl](evaluations/task1-baseline.operations.jsonl)に保存した。

### Task 1の入力検証

スキルを読んだ別の独立エージェントへ、上限3件、実行先Air、Cycleとモデル未確定の入力を渡した。
上限を丸めず、実行先を無断変更せず、不足項目を未確定として人への確認で停止した。
操作ログはnodとOrcaの手引き取得各1件だけで、Issueとworkerへの変更はなかった。
報告は[evaluations/task1-invalid-input.md](evaluations/task1-invalid-input.md)、実操作は[evaluations/task1-invalid-input.operations.jsonl](evaluations/task1-invalid-input.operations.jsonl)に保存した。

### Task 1の完了確認

スキルありの新しい独立エージェントが、実CLIで候補5件、仕様準備1件、人待ち3件、依存待ち1件、管理外5件を確認した。
API-10と11だけを各1回再判定し、失敗継続のblockerと本番運用の人への質問をnodへ記録した。
PM占有0、上限2、空き2枠と判断し、管理外workerを枠へ加算しなかった。
指定外Workspaceと次Cycleへ着手せず、Issue着手とworker作成もなかった。
報告は[evaluations/task1-with-skill.md](evaluations/task1-with-skill.md)、実操作は[evaluations/task1-with-skill.operations.jsonl](evaluations/task1-with-skill.operations.jsonl)に保存した。

親側の最終確認は契約テスト3 pass、0 fail、19 assertions、型検査成功、`git diff --check`成功である。
Task 1の5 Stepを満たした。
既存規約に合わせてPMの`agents/openai.yaml`も追加し、Codex側の暗黙起動を無効にした。
スキルとREADMEを追加し、配布manifestの4つのversionを0.4.0に揃えた。
実際のグローバル導入は今回の指示に従い実施していない。

### Task 2のbaseline

新しい独立エージェントが、モデルの照合後の実装依頼から、既存実装者へのPR依頼と実nodの`in_review`確認まで進めた。
元のterminalを再利用し、初回レビューの重複起動と人の承認、マージはなかった。
ただし親が実操作を照合すると、再利用後の旧Dispatchにもreleaseを送り、最終Deliveryをackしてからreleaseする2つのOrca契約逸脱があった。
評価エージェント自身の「完了」報告だけでは合格にせず、Task 2担当へ手順と偽CLIの契約検出を補強するよう戻した。
偽CLIは初期版でこの2操作を受理していたため、baselineを後片付けの適合証拠には用いない。
報告は[evaluations/task2-baseline.md](evaluations/task2-baseline.md)、実操作は[evaluations/task2-baseline.operations.jsonl](evaluations/task2-baseline.operations.jsonl)に保存した。

### Task 2の行動確認

新しい独立エージェント2名が、スキルを読んで8つの一時環境を実際に操作した。
normal/onとnormal/offでは元のterminalを1回再利用し、新PRを各1件作成、既存PR環境はcreateせずeditを1件発行した。
現在commit、必要なテスト、受け入れ、初回独立StandardsとSpec、PRのHEAD、nodの`in_review`を照合した。
最終Dispatchだけをreleaseしてからackし、旧Dispatchのreleaseと初回レビューの重複起動はなかった。

モデル不一致と実効値nullでは待機workerを保持して開始通知を送らず、非対応環境ではRunも作らなかった。
テスト失敗とレビュー証拠欠落ではPRへ進めず、同じIssueに理由と後続工程を記録した。
この2環境のsettled実装者とDeliveryは後続所有者未決のまま保持しており、後片付け済みとは扱わない。
これらの停止条件を観測したことと、実装から提出までの成功を区別する。
停止報告は[evaluations/task2-stopped-with-skill.md](evaluations/task2-stopped-with-skill.md)、各環境の実操作は同ディレクトリの`task2-*.operations.jsonl`に保存した。

契約テストは初回setup未実装で0 pass、1 fail、1 errorだった。
所有権とack順序、PR selector、補完依頼でPRを作らない境界も、失敗を確認してから補修した。
親側の最終確認は15 pass、0 fail、152 assertions、型検査と差分検査の成功である。
モデル適用、git、テスト、画面、レビューは偽workerの状態をPMが照合したもので、実機転送や実コードの検証ではない。

### Task 3のbaseline

Task 2までのスキルを読む新しい独立エージェントが、API-1の技術質問へ本文の12pxを根拠に元messageへreplyし、working復帰を確認した。
API-2の未決仕様は質問を作成して停止し、needs-specと未合意を維持した。
この主要な保護と返信はbaselineでも合格だった。
人への選択肢はA/Bであり、仕様が求める番号付きではなかったため、新手順では全工程の1/2選択肢と推奨、理由、決定後の動作を共通書式にした。
報告と実操作は[evaluations/task3-baseline.md](evaluations/task3-baseline.md)と[evaluations/task3-baseline.operations.jsonl](evaluations/task3-baseline.operations.jsonl)に保存した。

### Task 3の完了確認

スキルあり5環境を新しい独立エージェント2名が実操作した。
仕様未合意ではneeds-specを維持し、正式Specと実回答、仕様とテスト境界の合意を確認した環境だけto-spec最終工程で解除した。
両環境でAPI-1の既決質問を元messageへreplyし、仕様化中も監督した。
人起点API-7の質問にはチャット原文を保存しただけで代理answerを発行しなかった。

PM起点API-1の質問は番号選択肢、推奨、理由、決定後の動作を記録した。
無回答と曖昧な「それでお願いします」では元workerをawaiting_inputに保ち、一意なチャット実回答の原文と出典を保存した後だけ、同じ質問IDへcodexとして転記して元askへreplyした。
nod回答は評価者だけが一時DBへ明示投入し、PMがansweredBy=meの原文と日時を再取得して、answerを重ねず同じworkerへ渡した。
両窓口で同じDispatch、terminal、worktreeと実効設定を維持し、working復帰を確認した。
新worker、PRは作成していない。

報告は[evaluations/task3-spec-with-skill.md](evaluations/task3-spec-with-skill.md)と[evaluations/task3-answer-with-skill.md](evaluations/task3-answer-with-skill.md)、実操作は同ディレクトリの`task3-*.operations.jsonl`に保存した。
担当の最終契約検証はTask 1から3の21 pass、0 fail、195 assertions、親側はTask 3の6 pass、0 fail、43 assertionsと型検査成功を確認した。
初回はsetup/helper未作成の失敗、テスト側のlabels型誤認、型検査2件の不整合を検出し訂正した。
Task 3の4 Stepを満たした。

### Task 4のbaselineとfixture補修

旧Task 3版スキルを固定した新しい独立エージェントが、F1の元実装者への返却、1巡目修正、別identityの独立確認、同じ実装者へのPR提出、cleanupを実操作した。
任意改善O1を強制せず、初回レビューを重複せず、修正1巡で`in_review`を確認した。
この正常経路はbaselineでも合格し、新スキルによる改善と主張しない。
報告と実操作は[evaluations/task4-baseline.md](evaluations/task4-baseline.md)と[evaluations/task4-baseline.operations.jsonl](evaluations/task4-baseline.operations.jsonl)に保存した。

親のfixture確認では、後段の履歴説明を現在のPR依頼と誤分類する可能性と、2巡目の確認基点がaに固定された問題を見つけた。
公開CLI契約テストで計4件の失敗を確認し、baseline終了後に補修する。
PMの依頼の意味は評価者が全文で判断し、偽workerの単語一致による誤動作と区別する。

### Task 4の完了確認

fixtureは現在意図だけの解釈と2巡目c→dへ補修し、別PR URLの拒否も失敗を確認してから追加した。
親側の契約検証は11 pass、0 fail、178 assertions、型と差分検査成功だった。
担当はTask 1から4の契約32 pass、0 failも確認した。

スキルあり6環境を新しい独立エージェント2名が実操作した。
1巡解消はa→c、2巡目解消はa→c→d、任意改善だけは0巡で提出し、元実装者と実効設定を維持した。
独立確認は別identityで既存指摘と各修正差分だけを確認し、初回レビューを重複しなかった。
現在commitとPRのHEAD、nodの`in_review`、現所有者のrelease後ackを確認した。

2巡後のF1残存、古いcommitの解消申告、新しいF2不具合ではpushとPRを依頼せず、人へ番号選択肢、推奨、理由、再開条件を記録した。
古いcommitは有効完了0、進行中1、確認報告受領1を区別し、未完了巡をリセットしなかった。
確認中は元実装者を維持し、明示的な人への引き継ぎ報告後だけ現所有者をreleaseしてackした。
Task 4の4 Stepを満たした。
報告は[evaluations/task4-success-with-skill.md](evaluations/task4-success-with-skill.md)と[evaluations/task4-stopped-with-skill.md](evaluations/task4-stopped-with-skill.md)、実操作は同ディレクトリの`task4-*.operations.jsonl`に保存した。
行動評価中の読取では未知のguideとIssue IDの誤記が各1件拒否され、正しい読取へ訂正した。状態変更は伴わなかった。

### Task 5のbaselineとfixture補修

旧Task 4版のbaseline初回は、元実装者へのPR依頼後も提出証拠を得られず未完了として停止した。
親の確認で、偽workerのPR開始条件が公開ガイドにない不備と、API-1のPR branchがAPI-2用に固定された不整合を見つけた。
公開契約をREDからGREENで補修し、fixtureを再凍結して、未使用環境でbaselineとgreenをやり直した。
旧失敗をSkillの失敗や成功と混同しない。
補修後baselineは質問待ち1枠を保持して独立API-2を提出できたため、この正常経路を新手順による改善とは主張しない。

### Task 5の完了確認

新しい独立エージェント2名が8環境で実際に依頼、質問、記録、提出判断を発行した。
上限2ではAPI-1質問待ち1枠を保持してAPI-2の1枠だけを予約、同じ実装者でPR提出した。
API-2の現在commit cとPR branch export-column、実nodのin_review、現Dispatch release後ackを確認し、API-1の質問は未回答のまま占有1を維持した。
既定1ではAPI-2を起動せず、質問作成を明示的引き継ぎへ読み替えなかった。
モデル照合待ち、起動試行中、通信断は予約1を保持して追加起動と開始通知を行わなかった。
停止では空きがあっても補充せず、元worker、質問、所有権を維持した。
新規候補なしでも既存workerを監督し、API-1の元実装者でPR branch retentionと現在commit aを確認して提出した。
workerなしの環境は成果なし、未回答の人起点質問、API-4依存待ちを報告し、代理回答しなかった。
API-4依存とAPI-6 needs-specは全環境で保持した。

親の契約確認は10 pass、0 fail、134 assertions、型検査と差分検査成功だった。
担当のPM回帰は42 pass、0 fail、507 assertions。
初回はsetup未実装、API-17誤参照、labels APIとnarrowingの型不整合を検出して訂正した。
公開PR開始契約とPR branchは追加の失敗を確認して補修した。
Task 5の4 Stepを満たした。
各報告と実操作はevaluations/task5-*.mdおよびtask5-*.operations.jsonlへ保存した。
モデル、git、テスト、レビュー、PRは偽接続先の外部状態を照合した証拠であり、実機実装の検証ではない。
実nodの作業場所メタデータはPM cwdを示す既知境界があり、Studioの実行場所をその記録だけから推定していない。

superviseの初回PR読取では、PMがまだ取得していない番号41を指定してPR_NOT_FOUNDとなった。
受信通知の実URL42へ訂正し、提出失敗と推定せず再取得を確認した。状態変更は伴わなかった。

### Task 6のbaseline

旧Task 5版を読む独立PMが、通信断では実効値unknownと予約1を保持し、PR応答喪失では既存PR42へlink/pr-statusのみでin_reviewを回復した。
この二重作成を避ける経路はbaselineでも成立し、改善と主張しない。
PRケースのsettled Dispatchはrelease未実施のまま保持されており、baselineをcleanup完了の証拠に使わない。
報告と実操作はevaluations/task6-baseline*.md、task6-baseline-*.operations.jsonlに保存した。

### Task 6の行動確認

7環境を新しい独立PMで操作し、unknownは第1PMと第2fresh PMの2セッションで評価した。
第1PMは起動結果不明とunverifiable、実効値nullを確認し、自足checkpointを実nodへ保存して予約1を保持した。
親が評価者専用controlで接続と実効値だけを回復し、第1PMの会話も報告も渡さず別の新規PMを同じ永続状態へ投入した。
第2PMは同じTask、Dispatch、terminal、実効設定と正のliveを照合し、元workerに開始を通知した。
元の起動要求や実装者を再作成せず、初回独立両軸と現在commit aの必要テストを照合後、同terminalの後続PRだけを依頼して提出した。
実装中の復元も初回レビューを重複せず同じ実装者で提出した。

修正確認中はstarted=1/completed=0から既存独立確認を受理してcompleted=1へ進め、元のactive dispatch-waitへ現在commit cのPR作業を1回依頼した。
再配送ケースは受理済みdone-review-1二重通知と古いDispatchのcommit aを全行分類し、巡1を保持して現在cだけを提出した。
旧Dispatchと既解放reviewerを再releaseせず、現所有者release成功後にDeliveryをackした。
PR応答喪失はrepo/branch/headと既存PR42へ合流し、nod関連とin_reviewだけを回復した。
新Task、worker、PR作成や再提出依頼はなく、現所有者releaseとreclaimable一覧空を確認した。
過去のDelivery/ack履歴は公開契約に照会がなく未確認であり、今回のrelease確認と区別して残した。

仕様待ちは既存質問ID、未回答、仕様とテスト境界の未合意、正式Specなしを区別し、needs-specと元workerを維持した。
2件並行はAPI-1未回答/占有1とAPI-2提出済みPR/current c/in_review/release済み/占有0を別々に復元し、停止中の空き枠を補充しなかった。
全ケースでintent/checkpointと操作相関、枠、未解決事項、次に照合する根拠を実nodへ残した。

親のTask 6契約は8 pass、0 fail、62 assertions、担当のPM全回帰は50 pass、0 fail、569 assertions。
初回はsetup未実装と各シナリオ未投入のRED、既存PRの誤create記録のREDを確認して補修した。
行動評価の読取ではnod skills get to-specのUNKNOWN_SKILLと未対応workspace showを各1件記録し、状態制約を回避せず適切な読取へ戻った。
Task 6の4 Stepを満たした。
報告と実操作はevaluations/task6-*-with-skill.mdおよびtask6-*.operations.jsonlに保存した。
モデル、git、テスト、独立レビュー、PRは模擬外部状態であり、実機の転送、負荷、実コード、実画面を検証したとは主張しない。
初期の応答喪失は永続状態として投入しており、全Orca mutationの実通信切断やreceipt回復を網羅した試験ではない。
