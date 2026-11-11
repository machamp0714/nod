# PMの行動評価

このディレクトリは、LLMがPMスキルを使ったときの外部操作を観測する評価環境である。
PM自身の選定ロジックや管理DBを実装するものではない。
nodは実CLIと一時SQLite DBを使い、OrcaとGitHubには偽CLIを使う。
モデルへ送る仕様判定APIも偽接続先に替え、実際のStudio workerやGitHub変更を起動しない。

## S01の評価範囲

期間データは評価専用の内部fixtureで作り、現在Sprint 2の採択集合、別WorkspaceのSprint 4、imported、draftと未採択候補を区別する。
製品CLIやAPIへ合意、採択、開始、fixture作成の入口は追加しない。
公開CLIでcurrentの読取、旧`--cycle`の拒否と無変更、開始と直接所属の未公開を検査する。
Task 1はS01の読取と停止理由、Task 6は移行前の既存実行の所有者と不明状態の保持を扱う。
Task 2〜5の実装と提出のシミュレーションは個別委任の回帰資料として保持し、S02以降の実行監督が接続済みとは主張しない。
既存の評価結果は当時の版の証拠であり、変更後の行動評価の成功へ読み替えない。

## 環境の作成

リポジトリの依存を導入した環境で、未使用の一時ディレクトリを指定する。
引数を省くと新しい一時ディレクトリを作る。

```sh
bun plugins/nod/skills/pm/evals/setup.ts
```

setupのJSON出力にある`source`を、評価する新しいLLMセッションでsourceする。
以後、PATHの`nod`、`orca`、`gh`を使う。
`NOD_DB`はその環境専用で、nodの書き手は`codex`に固定される。
セットアップを同じディレクトリへ再実行すると既存Sprint番号の衝突で失敗するため、比較実行ごとに新しい環境を使う。

## Task 1の実行と採点

[混在候補評価](task1-mixed-candidates.md)の「LLMへ渡す入力」を評価セッションへ渡す。
採点表とsetupのソースは評価セッションに渡さない。
baselineではPMスキルを読ませず、比較実行では`nod:pm`を読ませる。
同じモデルとeffortを使い、各セッションの報告と`operations.jsonl`を評価者が確認する。

操作ログは、実nod CLIへ渡した引数、偽OrcaやGitHubへ出した依頼、書き手、時刻を1行ずつ保存する。
未回答の人質問や他担当を触らなかったことは、報告だけでなくログとnodの再取得結果で確かめる。
自由文の分類理由は評価者が読み、単語の出現だけで合格にしない。
未指定や無効な入力の追加評価も、別の新しいLLMセッションで実行する。

## 契約テストとの区別

```sh
bun test packages/cli/test/pm-evaluation.test.ts
bun run typecheck
```

このテストは評価環境の公開CLI境界を検査する。
実nodで混在するIssueを取得できること、仕様判定の状態と偽APIによる回復、外部変更の遮断と操作記録を確認する。
LLMが正しく分類できたことは、このテストの成功だけからは主張しない。
行動評価の成否は別に記録する。

## Task 2の実行と採点

[実装とPR提出の評価](task2-implementation.md)を使う。
`task2-setup.ts <未使用ディレクトリ> <シナリオ>`で、Task 1と同じ一時DB境界に偽workerの起動、実効設定、完了報告、GitHubの状態を追加する。
操作ログの`origin`はPMからのCLI操作と、偽workerが行った操作を区別する。
初回workerは開始通知まで待機し、後続PR作業は同じterminalの新Dispatchとして実行する。
このfixtureは指定値の転送、git、テスト、レビューの証跡を模擬し、実機や実コードで成功したとは主張しない。
初回レビューは`initial-review.ts`が、実装を進行する親の残す形で再現する。起動した全担当（Standards探索・Spec探索・反証の3担当と、反証が受け入れ確認担当の行を作ったときは受け入れ確認担当）の定義名とID、役割ごとの試行の記録（無効だった試行の担当ID・無効の理由・親専用領域`parent/attempts/`への保存場所と指紋、omp内部の再試行、親による再委譲の有無）、評価環境の作業ディレクトリに置く反証の判定本文`refute/verdict.md`と受け入れ確認の結果`acceptance/result.md`と同じheadのテスト実行記録`parent/tests/record.md`、それを収録した`kind=doc`の報告Document、要約とDocument IDの作業ログ、最終状態（完了・未完了・未実施）、確定した要対応の点数、受け入れ確認の行ごとの判定、確認が残る事項、マージ可否を子nodとファイルへ書く。PMの受理判断は代行しない。
契約テストはIn Reviewへのレビュー提出とPR不要の直接完了、PR紐付け・状態取得でIssue状態が変わらないこと、既存PR更新、モデル異常、テスト失敗でもレビュー原文と点数が変わらずマージ可否が不可になること、完了・5点でも確認が残る事項があればマージ可否が不可でPRもIn Reviewも生じないこと、1回の再委譲の後も必要な担当の有効な結果が無い独立レビュー未完了と、利用枠の上限で再委譲せずに止めた独立レビュー未完了と、担当を1つも起動しない独立レビュー未実施のblocker、判定と無関係な無効から1回の再委譲で有効になった完了の報告が両方の試行を持つこと、受け入れ確認担当が確認済みとした4担当の完了がマージ可でPR提出へ進めること、受け入れ確認の未充足・確かめられずでは完了・5点のままマージ可否が不可でPRもIn Reviewも生じないこと、必要な受け入れ確認担当が有効な結果を返さない独立レビュー未完了のblocker、cleanupの所有権とack順序を公開CLI経由で確認する。

偽CLIの操作ログはテスト観測用であり、新しいPMデータベースではない。
本番運用では要求と判断をnod、実行の権限と状態をOrcaへ記録する。

## Task 3の実行と採点

[仕様準備と質問対応の評価](task3-questions.md)を使う。
`task3-setup.ts <未使用ディレクトリ> <シナリオ>`で既存workerのblocking ask、仕様化の途中記録、正式Specと合意の有無を用意する。
`NOD_DOCS_DIR`と`NOD_ATTACHMENTS_DIR`は評価環境の下へ固定し、実環境の文書を作成しない。
シナリオは技術質問、新しい利用者判断、仕様未合意、正式Spec添付済み、人起点質問である。
新しい利用者判断は評価者がチャットまたは評価者専用`task3-human.ts`で実回答を投入する。
無回答、回答先不明、一意な回答の各段階の操作を分けて保存する。
fixtureは実際の別モデルやworkerを起動せず、スキルの語句を検査して判断を代行しない。

```sh
bun test packages/cli/test/pm-evaluation.test.ts packages/cli/test/pm-task3-evaluation.test.ts
bun run typecheck
```

Task 3の契約テストは元messageへのreplyによる同じDispatchの再開、無回答での待機保持、指定質問だけへの人回答、正式Specの実CLI取得と一時文書への隔離を検査する。
現行CLIが人起点質問へのLLM回答を許可し、評価用CLIが書き手をcodexに保持することも検査する。
この許可範囲と、PMが人起点質問を代理回答しない運用方針は別であり、後者はhuman-originの行動評価で確認する。
PM自身が原文と出典を記録して適切な時点に再開したかは、別セッションの行動評価で判定する。

## Task 4の実行と採点

[指摘修正と独立確認の評価](task4-review.md)を使う。
`task4-setup.ts <未使用ディレクトリ> <シナリオ>`で初回レビュー済みの既存実装者と、3担当の組の報告Documentにある根拠付き必須指摘、任意改善を用意する。
修正1巡で解消、2巡目で解消、2巡後の残存、古いcommit、新しい不具合、任意改善のみの6シナリオを使う。
子nod CLIのDB、Documents、AttachmentsとGitHub読取先を一時環境へ強制する。
元実装者の同terminal再利用、確認待機の所有権、別identityのread-only確認、次所有者の決定からackまでを偽Orcaで観測する。
fixtureは誤ったPR依頼も実行ログへ残し、PMの回数制限や提出判断を代行しない。

```sh
bun test packages/cli/test/pm-evaluation.test.ts packages/cli/test/pm-task3-evaluation.test.ts packages/cli/test/pm-task4-evaluation.test.ts
bun run typecheck
```

契約テストは外部報告、同じ実装者の再利用、独立確認、巡ごとのcommit、所有権とack順序、一時保存先への強制を検査する。
実際の依頼の根拠や判断の妥当性は、凍結したfakeと独立した新セッションの行動評価で別に確認する。

## Task 5の実行と採点

[管理中の実行と独立作業の評価](task5-parallel.md)を使う。
`task5-setup.ts <未使用ディレクトリ> <シナリオ>`で質問待ちの既存Issue、独立候補、依存待ち、仕様準備を同じ一時DBに用意する。
waiting環境で質問待ちの保持と独立作業の提出を評価し、停止、モデル照合待ち、起動試行中、通信断、候補なしの監督、workerなしの待機報告も確認する。
fakeはPMの起動判断、依存、停止判断を強制せず、誤った新規依頼も操作ログへ残す。
無回答の待機を完了とみなさず、評価入力で指定したcheckpointで成果と残る状態を報告する。

```sh
bun test packages/cli/test/pm-evaluation.test.ts packages/cli/test/pm-task3-evaluation.test.ts packages/cli/test/pm-task4-evaluation.test.ts packages/cli/test/pm-task5-evaluation.test.ts
bun run typecheck
```

契約テストはIssueごとの質問と成果、独立PR提出、実装者の再利用とcleanup、予約の保持、一時保存先への固定を検査する。
PMが実際に正しい選定を行ったかは、新しい独立セッションの外部操作を使って別に判定する。

## Task 6の実行と採点

[会話履歴なしの復元評価](task6-recovery.md)を使う。
`task6-setup.ts <未使用directory> <variant>`で通信断、実装中、仕様待ち、修正確認中、PR応答喪失、重複通知と古い報告、2件中の質問待ちと提出済み成果を用意する。
unknownは第1PMがunverifiableを保持して記録した後、評価者だけが`task6-control.ts <同じdirectory> recover`を実行する。
第2freshPMへは同じenv.shだけを引き継ぎ、第1PMの会話と報告を渡さない。
Task、Dispatch、terminalのidentityを維持した同じDBとbackendから、実効値と現在commitを照合して再開したかを見る。
PR応答喪失は既存PRのrepo、branch、headから関連と提出状態を回復し、createを重ねない。

```sh
bun test packages/cli/test/pm-task6-evaluation.test.ts
bun run typecheck
```

契約テストはrecover境界、実nodの永続質問と成果、同一試行、既存PRのselectorとrepo絞り、古commitと再配送、元実装者の待機所有権を確認する。
初期のreceipt喪失は投入状態であり、実通信切断や実機モデル転送を試験したとは主張しない。
fixtureはPM判断を代行せず、独立LLMが実際に出した依頼、質問、記録、PR判断を別に採点する。
