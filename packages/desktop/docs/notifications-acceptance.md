# デスクトップ通知の受入検証記録

2026年10月15日時点の NOD-19 の検証記録。
正本は Issue 本文、合意した仕様 Document #178（`nod-19-spec-20261015.md`）、実装計画（`nod-19-plan-20261015.md`）である。
自動検証の成功と、配布形態の macOS アプリによる実測を分けて記録する。
未検証の実機項目が残るため、この記録だけでは Task 7 全体の完了を意味しない。

## 検証環境と成果物

macOS 26.3.1、Apple Silicon arm64、Tauri 2、ad-hoc 署名で検証した。
対象コードの HEAD は `1d0168513b30ed161070807411dba644855e49ce`、アプリ版は `0.1.0`、DB schema は `41`。
build-info の `dirty` は `true` で、未コミット状態を隠していない。

| 用途 | 対象 |
| --- | --- |
| 通常の配布用ビルド | `packages/desktop/dist/nod.app` |
| 実機検証用ビルド | `packages/desktop/src-tauri/target/release/bundle/macos/nod通知製品検証.app` |
| 検証用 bundle ID | `io.github.machamp0714.nod.notification-task2-probe` |
| 実機の安定配置 | `~/Library/Application Support/nod-notification-product-probe/nod通知製品検証.app` |
| 更新検証のデータ | `~/Library/Application Support/nod-notification-product-probe/task7-state/` |
| 作業時の証拠保存先 | `/tmp/nod19-acceptance/` |

本番アプリの配置変更、本番プロセスの停止、本番DBへの migration、PR のマージは、この検証では実施しない。
実機用データは DB、Document、添付、Toggl 設定、ログを隔離し、Orca 連携を無効にする。
ビルド検査が起動するのは、一時ディレクトリを使う隔離sidecarである。

## 自動検証とビルド

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| DB migration とバックアップの既存回帰 | 13テスト成功、失敗0。WALの保持、バックアップ失敗時の移行中止、新版DBの拒否、再移行の防止を確認 | `task7-migration-regression.log`。`packages/core/test/db.test.ts`、`db-backup.test.ts` |
| schema40の既存期日 | 8時台と15時台の導入で古い期日を除外し、導入後09:00の既存期日を実DBから実ネイティブ配信へ渡す | `task6-tests-parent.log`。`packages/desktop/test/notification-delivery.test.ts` の「schema40から移行」2ケース |
| ネイティブ配信の回帰 | Task 6 の97テスト成功、失敗0。実Rust worker、HTTP、実DB、偽OS受け口を通す | `task6-tests-parent.log` |
| ネイティブ側の単体テストと統合テスト | 82テスト成功、失敗0。監督、起動、孤児回収、クリック遷移、workerの復帰と終了を含む | `task7-native-tests.log`。`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` |
| 型検査 | 初回と対応表修正後の両方で成功 | `task7-typecheck.log`、`task7-typecheck-final.log`。`bun run typecheck` |
| Web、CLI、通常のデスクトップビルド | 成功 | `task7-desktop-build.log`。`bun run desktop:build` |
| 通常の配布物検査 | 7項目成功。strict署名、sidecarの必須3 entitlements、arm64、build-info、版一致、隔離起動200、schema一致 | `task7-desktop-build.log` |
| 専用IDの実機用ビルド | 成功。同じ staged Web と CLI を使い、専用の設定で Tauri をビルド | `task7-product-build.log` |
| 専用IDの再署名と配布物検査 | 成功。通常版のbuild-infoをコピーし、sidecarへruntimeとentitlementsを付け、外側を再署名。7検査すべて成功 | `task7-product-sign.log`、`task7-product-verify.log` |
| 全体Bun suite（親が1回実行） | 2358成功、1失敗、18246 assertions、247ファイル、176.42秒。失敗は既存の`DB_BACKUP_FAILED`の対応表漏れ | `final-bun-tests.log` |
| 対応表漏れの修正前と修正後 | 既存の`app.test.ts`で修正前7成功、1失敗。`DB_BACKUP_FAILED: 500`を追加し、修正後8成功、失敗0、64 assertions | `task7-error-map-red.log`、`task7-error-map-green.log` |
| 修正後のCLI成果物と配布物検査 | CLIのみ再compileし、通常版と専用ID版のsidecarを差し替え。両方を再署名し、各7検査成功 | `task7-cli-build-final.log`、`task7-normal-sign-final.log`、`task7-product-sign-final.log`、`task7-normal-verify-final.log`、`task7-product-verify-final.log` |

Task 7 では新しいテストを追加していない。
既存の migration、配信処理、偽OS受け口の境界と、次の実データ移行の照合で自動確認を補えるためである。
偽OSの許可や通知送信は、OSの実際の許可画面、バナー表示、クリックの証拠には使わない。

全体suiteの失敗は、基点`fa0bb3b`にも存在するエラー対応表の漏れだった。
coreが投げる既存の`DB_BACKUP_FAILED`をサーバーの`ERROR_STATUS`へ1行で登録した。
HTTP応答は修正前のfallbackと同じ500である。
全体suiteは再実行せず、初回の失敗と修正後の対象テスト成功を区別して残す。
この修正によるWebやネイティブ本体の変更はないため、CLIだけを再compileした。
続いて親が安定配置の実機用アプリにも修正済みCLIを差し替え、外側を再署名し、strict署名検査とLaunchServices登録を行った。
LSEnvironmentを保持し、ネイティブ本体は変更していない。
アプリは通常終了済みで、残った両種類の通知を終了中クリックの検証用に保持している。

通常ビルドのWeb出力には500 kBを超えるchunkの警告があるが、ビルドは成功した。
署名や公証の方式は変更していない。

## 旧DBからの移行

親が旧schema40の検証DBをreadonlyで開き、SQLite backup APIでWALを含めて隔離コピーした。
コピーに対するschema40から41への migration は成功し、次の全列照合が一致した。

- Issue 5件。
- Inbox通知3件。
- デスクトップ通知設定。
- 配信履歴2件。

既存の過去期日 `2026-10-14` は `excluded`、将来期日 `2026-10-16` は `pending` として保存された。
通知一覧の取得後も過去の期日到来通知を一斉生成しなかった。
migration 前の自動バックアップを1件作成し、旧schema40、Issue 5件、`integrity_check=ok` を確認した。
証拠は `check-migration.ts` と `task7-migration.log` にある。

続いて親が配布形態の新しい専用アプリへ入れ替え、同じ`task7-state`のDBで起動した。
実アプリによるschema40から41への移行で、Issue、通知、設定、配信履歴の全列保持、バックアップ、過去期日の除外、将来期日の保持、integrityを確認した。
実APIからONと最後のON時刻の維持も確認した。
証拠は `task7-product-migration.json` で、接続先は `http://127.0.0.1:64182` だった。
旧DBの正本 `pre-due-data.db` は変更しない。

## 配布形態での実機確認

Task 2 では製品の Tauri アプリを専用IDでビルドし、隔離データで次を確認した。
詳細な作業時証拠は `task2-product.md` と `task2-*.log` にある。

| 項目 | 実測 |
| --- | --- |
| 初期OFF、ON操作、OSの実許可画面 | 成功。アプリ設定ONとOS許可済みを別々に表示 |
| 通常再起動での設定 | ONと最後のON時刻を保持 |
| 前面表示中の個別リマインダー | 現タイトルと任意メモを表示。予定からOS依頼完了まで約0.824秒 |
| 閉窓常駐中の個別リマインダー | ウィンドウ一覧が空でプロセス存続を確認し、別Workspaceの通知を表示。約0.387秒 |
| 実通知のクリック | 対象Issueを表示し、クリックしたreminderのIDだけ既読。同Issueのcommentは未読を保持 |
| 通常ブラウザ | ON操作はdisabled、`window.__TAURI_INTERNALS__` はundefined |

Task 1 のSwift API試作では拒否、前面通知、閉窓通知、再起動直後の待機中クリックを実測した。
方式選定の証拠は [試作の記録](../probe/README.md) にある。
製品構成固有の拒否、取消、終了中クリックの確認を、この試作の結果だけで完了にはしない。

Task 7 では配布形態のアプリを完全終了し、停止中に個別リマインダーとDue dateの到来分を用意してから起動した。
起動完了は `2026-10-15T10:22:53.836Z`、現在の接続先は `http://127.0.0.1:64551` だった。
両通知の取得は `10:22:53.969Z` で、接続完了から回収開始まで0.133秒だった。
Due dateは `10:22:53.970Z`、個別リマインダーは `10:22:53.972Z` にOS依頼を完了し、全体で約0.136秒だった。
配信履歴の両件が`sent`となり、回収開始5秒の条件を満たした。
これはOS送信依頼までの実測であり、ロック中のバナー表示やクリックを確認したことにはならない。
証拠は `task7-closed-recovery.json` と、隔離データ内の `task7-state/logs/nod.log` にある。

Task 7 の画面を伴う実機追加確認は、画面ロックの解除待ちである。
`CGSSessionScreenIsLocked=Yes` を確認し、ユーザーへ解除の連絡を依頼している。
実スリープ操作の可否も回答待ちであり、解除待ちや自動テストを実機成功として扱わない。

| Task 7 の追加項目 | 状態 |
| --- | --- |
| 新しい配布用アプリへの入れ替え、同じDBのmigration、設定と履歴の保持 | 成功。全列保持、schema41、旧版バックアップ、過去excluded、将来pending、ONと最後のON時刻を確認 |
| 製品構成での許可拒否とOS側の取消、通常利用とInboxの継続 | 未検証 |
| Due dateの前面通知と閉窓通知、現在のタイトルと期日 | 未検証 |
| Due dateの実クリックと当該通知だけの既読 | 未検証 |
| アーカイブ済みIssue、削除済み通知、永久削除済みIssueの実クリック | 未検証 |
| 完全終了中の通知クリックから自動起動、現在の接続先への遷移 | 未検証 |
| 完全終了中の超過分の回収開始5秒 | 成功。両種類を0.133秒で取得し、約0.136秒でOS依頼完了 |
| 完全終了から回収した両種類のバナー、実クリック、送信済みの重複防止 | 未検証 |
| 実スリープ復帰後の回収開始5秒、両種類の通知、重複防止 | 未検証 |
| 更新後の通常配信5秒、実クリック、送信済みの重複防止 | 未検証 |

## Issue本文の完了条件との対応

番号はこの記録内の参照用であり、Issue本文の条件を順に対応させている。

| 条件 | 自動検証と実測の証拠 | 残る実機確認 |
| --- | --- | --- |
| 本文1：許可要求、拒否しても通常利用とInboxを維持 | Task 2の実許可要求。ネイティブ配信の`denied`、`notDetermined`、許可取得エラーの実DBテスト。Task 1の拒否実測 | 製品での拒否と取消 |
| 本文2：前面と閉窓常駐中、一覧を開かず日時に通知 | Task 2の前面0.824秒、閉窓0.387秒。実workerと実DBの配信テスト | 更新後の両種類の前面通知と閉窓通知 |
| 本文3：日時変更と解除、重複防止 | `notification-delivery.test.ts`の期限前後の変更と解除、同時claim、複数接続、再起動、既読と削除、OFFの競合。製品更新で送信履歴保持 | 更新後の送信済み分の実機重複防止 |
| 本文4：通知から対象Issueを開く | Task 2の実クリックと個別既読。`packages/server/test/desktop-notifications.test.ts`の参照、削除、個別ack。Rustの現在ポートへの遷移テスト | Due date、終了中、復旧後、削除状態の実クリック |
| 本文5：再起動とスリープ復帰の期限超過 | 実workerの復帰配信、古い順、5秒以内の回収開始、取得前後障害のテスト。製品の完全終了復帰で0.133秒の回収開始を実測 | 完全終了復帰のバナーとクリック、実スリープ復帰 |
| Due1：ローカル09:00、未完了Issue | 実ネイティブ配信の09:00直前とちょうど、全Workspace、人とLLMとWebと一括更新、完了と取消のテスト | 製品のDue date実通知 |
| Due2：当日09:00以降と過去日付の設定時に一回 | 実ネイティブ配信の15時設定と変更、同値再保存で予定時刻を維持するテスト | 製品で新規設定後の通知5秒 |
| Due3：変更、解除、完了、取消、同一期日の重複防止 | 期日追従、日付往復、未完了復帰、実DBロック、ロールバック、claim後変更のテスト。製品更新で配信履歴保持 | 更新後の送信済み分の実機重複防止 |
| Due4：個別リマインダーと独立、同時刻に各一件 | 実ネイティブ配信で両種類を各一件送り、メモと購読通知を維持するテスト | 両種類の実通知 |
| Due5：Inbox、設定、許可、回収、クリックの共用 | OFFでもInbox保持、再ON除外、保留と復元、個別既読、送信失敗、復帰配信のテスト。製品の完全終了復帰でOS依頼完了 | 製品のDue dateバナーとクリック、拒否、実スリープ |
| Due6：導入前の古い期日を一斉通知しない | schema40移行の実DBネイティブ2ケース。実データ全列保持、旧版バックアップ、過去excludedと将来pendingを隔離DBと配布用アプリ更新の双方で実測 | 将来09:00の到来は固定時計の実DBネイティブテストで確認 |

## 仕様 #178 の詳細条件との対応

| 仕様の条項 | 証拠 |
| --- | --- |
| 初期OFF、最後のON時刻、再起動、保存失敗 | `packages/core/test/desktop-notifications.test.ts`。Task 2の画面と再起動実測 |
| 全Workspace、CLIとWebの先行Inbox化、表示画面から独立 | 実ネイティブ配信テスト、Task 2の別Workspace閉窓実測 |
| 再ON前の除外、許可不許可と取得エラーの区別 | 実ネイティブ配信の「初回ON前」「OFF中」「再ON前の保留」、`denied`、`notDetermined`、`permission-error` |
| 未読条件、削除と復元、スヌーズ、アーカイブ | 実ネイティブ配信の保留と復元、既読と削除の永久除外、実DB競合 |
| 最新タイトル、当該メモ、期日、過去分の表示 | 実ネイティブ配信の内容検証、`packages/web/src/lib/notification.test.ts`、Task 2の実バナー |
| クリック、当該通知だけの既読、消失時の案内 | サーバーのクリックackテスト、Rustの未完了クリックと現在ポートのテスト、Task 2の実クリック。追加実機確認は前表の未検証項目 |
| 原子的な取得、claimedとsentとfailedの区別 | 実DB複数接続と実Rust process、取得前後のクラッシュ、応答障害、送信失敗、終了中batchのテスト |
| 通常配信5秒と復帰後の回収開始5秒 | Task 2の通常配信実測、実workerの復帰と依存障害復旧テスト。Task 7の完全終了復帰は0.133秒で回収開始。実スリープ復帰は未検証 |
| ローカル暦日、TZ変更、夏時間、日付境界 | 別APIプロセスの固定時計とTZによるTokyo、New York、Los Angeles、DST前後の実DB配信テスト。MacのOS設定変更は未実施 |
| 一括更新の失敗とロールバック | 実ネイティブ配信と実DB競合の一括更新ロールバックテスト |
| 欠落可能性とInbox保持、操作方法 | [README](../README.md#デスクトップ通知の利用)、送信障害とクラッシュ境界のテスト |

## Task 7 のStep別判定

| Step | 判定 | 根拠 |
| --- | --- | --- |
| 1：旧DB移行と履歴保持 | 自動検証、隔離DB、製品更新での移行実測は成功 | 全列一致、旧版バックアップ、過去除外、将来既存09:00のネイティブ配信 |
| 2：配布形態の許可、両種類の通知とクリック | 一部確認済み | Task 2の個別リマインダー実測あり。製品の拒否と取消、Due dateなどは未検証 |
| 3：終了、スリープ、更新と5秒条件 | 完全終了復帰の回収開始と更新時の保持は実測済み。実機追加確認待ち | 回収開始0.133秒、設定と配信履歴保持。バナー、クリック、実スリープ、更新後の重複防止は未検証 |
| 4：自動検証、型検査、各ビルドと配布検査 | ビルドと担当検証は成功。全体suiteの既存1失敗を最小修正し対象テスト成功 | 初回全体2358成功/1失敗、修正後対象8成功/0失敗。全体再実行はしていない。実機通知とクリックの失敗があれば完了にしない |
| 5：利用方法、制約、証拠対応 | 記録済み。実機証拠の追記待ち | READMEと本記録。本番配置やPRマージは別指示 |

実機確認の残項目を実測し、その証拠と最終全体suiteの結果をこの記録へ追記してから、Task 7 全体の完了を判断する。
