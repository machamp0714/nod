# Sprint履歴への移行と旧版への復旧

S01は旧Cycleを閲覧専用のSprint履歴（imported）へ移す。
移行後は`nod sprint list`と`nod sprint show <UUIDまたは共通番号>`で履歴を読む。
旧Cycle IDは移行対応と旧URLの案内にだけ使い、新しいSprint番号として読み替えない。
人の合意、採択、開始、切替の公開操作とSprintからの自律実行はS02以降で接続する。

## 移行前に保存するもの

旧版コードと対応するDB、Documents、添付の実ファイルを一組として保存する。
Documentには絶対パスで参照する外部ファイルもあるため、保存先のディレクトリだけでなくDBから参照されるファイルを含める。
版、コードのcommit、取得日時、元のパス、復旧先、ファイルのhashと件数を記録する。

DBはSQLiteの整合性を保つ方法でコピーする。
新版の公開`openDb`は版を上げる前に`VACUUM INTO`でコミット済みWALを含むコピーをDB横の`backups/`へ作る。
名前は`nod-<UTC時刻>-<連番>-v<旧版>.db`で、最新5世代を保持する。
DBバックアップは参照ファイルを含まないため、復旧用の一組は自動バックアップとは別に保管する。
稼働中のDB本体だけをファイルコピーしてWALを捨てない。

旧PMとworkerはDB移行では停止しない。
切替前にOrcaのRun、Task、active Dispatch、実行host、worktree、terminal、要求モデルと実効モデル、未確定操作、質問、予約と占有を照合する。
通信断や結果不明は保持し、currentが空でも空き枠へ変えない。
整合したDBと参照ファイルの組を取得するための書込み停止は、実行所有者と人の切替判断を確認して別途行う。

## 移行時の契約

旧schema42のDBを新版の公開`openDb(<明示した隔離DBパス>)`で開くとschema43へ移行する。
空、過去、現在だった期間、未来を含む全Cycleを1件ずつimportedへ移し、移行だけでactiveを作らない。
元IssueとWorkspace、取得済みイベント、保存Viewと表示設定を保持する。
未記録のtimezone、ゴール、DoD、合意、達成結果は不明のままにする。
移行取得時の状態を過去終了時点の成果とは扱わない。

バックアップ作成に失敗した場合は`DB_BACKUP_FAILED`で止まり、移行元のschemaとデータを変更しない。
移行transactionの末尾で`PRAGMA foreign_key_check`を行い、不整合ならschemaとデータを巻き戻す。
同じDBの再オープンでは履歴、関連、イベントを増やさず、同じ版のバックアップも再生成しない。
CLIの通常起動とAPIの通常アクセスは旧Cycleの自動作成と持ち越しを行わない。
旧書込み、旧`--cycle`、直接所属の要求は廃止案内と無変更で拒否する。

## 隔離fixtureでの復旧確認

旧版は基点`41e40d607a11121dbc594130b8b75d0990a9d590`のschema42コードを使う。
旧版コードと依存は事前に用意し、検証スクリプトは導入やグローバル設定の更新を行わない。
この作業環境では`/tmp/nod-sprint-history-validation/baseline-code`に隔離してある。

```sh
/tmp/nod-sprint-history-tools/verify bun scripts/verify-sprint-recovery.ts \
  /tmp/nod-sprint-history-validation/baseline-code \
  /tmp/nod-sprint-history-validation/sprint-recovery-check
```

出力先は未使用の絶対パスを指定する。
このスクリプトは合成fixtureを旧版公開APIで作り、新版公開`openDb`で移行する。
移行前バックアップのintegrityとFK、再オープンの冪等性、旧版公開APIでの期間、Issue所属、Document本文、添付、通常更新を確かめる。
合成fixtureの参照ファイルだけを削除し、退避したコピーから元の絶対パスへ復旧してhashを照合する。
復元DBは`restored.db`という別のファイルに置く。
結果と対応ファイルは出力先の`result.json`に保存する。
旧CLIは起動時に旧同期が動くため、静的な復旧読取には旧版coreの公開操作を使う。

障害時の無変更と旧schema移行の回帰は次の対象で確認する。

```sh
/tmp/nod-sprint-history-tools/verify bun test \
  packages/core/test/sprint-history-migration.test.ts \
  packages/core/test/db-backup.test.ts \
  packages/core/test/sprint-current.test.ts
```

## リリース時の復旧判断

今回の検証は隔離fixtureに限る。
通常本番DBへの移行、mainマージ、配布は実施しない。
8件の統合検証と実際の切替確認は別途必要である。

復旧時は新旧双方の実行を照合し、書込みの停止と所有者を確認してから、対応する旧版と移行前DBと参照ファイルを一緒に戻す。
新版schema43のDBを旧版へ渡して戻したことにしない。
移行前バックアップへ戻すと取得後の更新は失われるため、差分の保全と扱いを人が判断する。
DBを閉じた復元先に整合したバックアップを置き、古い`-wal`と`-shm`を混在させない。
Documentの絶対パスは元の位置へ復元するか、明示した再配置手順と全参照の読取確認を別途行う。
添付も対応する保存先と相対パスの組を復元する。
旧版の公開読取、件数と関連、FK、Document本文と添付hash、通常Issue操作を確認し、人の判断で運用を再開する。
旧PMとworkerの不明状態は、この復旧でも終了扱いにしない。

## 検証証拠の版

この手順自体は成功記録ではない。
各実行でコードのcommitと変更manifest、コマンド、終了コード、件数、ログ、未確認事項を保存する。
Task1、Task2、Task3の成功記録は各Taskの対象差分に対する証拠であり、Task4後の最終commitの成功へ読み替えない。
最終commitでの全suite、型検査、CLIとWebのbuild、CLIとAPIとWebの受入確認、既存E2Eと見た目と操作確認は実装責任者が一度実行する。
