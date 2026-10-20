# デスクトップ通知の受入検証記録

2026年10月15日の検証と、10月20日のスリープ試行を記録する NOD-19 の受入記録。
正本は Issue 本文、合意した仕様 Document #178（`nod-19-spec-20261015.md`）、実装計画（`nod-19-plan-20261015.md`）である。
自動検証の成功と、配布形態の macOS アプリによる実測を分けて記録する。
未検証の実機項目が残るため、この記録だけでは Task 7 全体の完了を意味しない。

## 検証環境と成果物

macOS 26.3.1、Apple Silicon arm64、Tauri 2、ad-hoc 署名で検証した。
初回ビルドの HEAD は `1d0168513b30ed161070807411dba644855e49ce`、共通DR実装の基点は `0bd44a7`。
アプリ版は `0.1.0`、DB schema は `41`。
build-info の `dirty` は `true` で、未コミット状態を隠していない。

| 用途 | 対象 |
| --- | --- |
| 通常の配布用ビルド | `packages/desktop/dist/nod.app` |
| 実機検証用ビルド | `packages/desktop/src-tauri/target/release/bundle/macos/nod通知製品検証.app` |
| 検証用 bundle ID | `io.github.machamp0714.nod.notification-task2-probe` |
| 実機の安定配置 | `~/Library/Application Support/nod-notification-product-probe/nod通知製品検証.app` |
| 更新検証のデータ | `~/Library/Application Support/nod-notification-product-probe/task7-state/` |
| 10月15日の作業時の証拠保存先 | `/tmp/nod19-acceptance/` |
| 10月20日の証拠保存先 | `~/Library/Application Support/nod-notification-product-probe/task7-state/acceptance-20261020/` |
| 10月20日の再試行の証拠保存先 | `~/Library/Application Support/nod-notification-product-probe/task7-state/acceptance-20261020-retry/` |

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
| 更新互換DRの実署名fixture | 既定cdhash DRの誤受入れをREDで確認し、拒否するGREENを確認。専用IDの共通DR、resource変更後の相互要求、別identifierの拒否の3テスト成功 | `task7-dr-red.log`、`task7-dr-green.log`、`task7-dr-fixtures.log` |
| 共通DR実装後の型検査と通常ビルド | 成功。通常配布用アプリは更新互換DRを含む8検査すべてに成功 | `task7-dr-typecheck-final.log`、`task7-dr-desktop-build.log` |
| 完成品検査の対象テスト一式 | 12成功、失敗0、30 assertions。既存の破損成果物の拒否と新しいDR検査を確認 | `task7-dr-verify-tests.log`。`bun test packages/desktop/test/verify-app.test.ts` |
| 共通DRを適用した安定配置の製品構成 | 親の実行で更新互換DRを含む8項目すべて成功 | `task7-common-dr-product-verify.log` |

Task 7 の migration と配信には既存の実DB、ネイティブ配信、偽OS受け口のテストを使った。
その後に実機で見つかった更新後クリックの不具合に対して、実署名した完成品のDRを検査する3テストを追加した。
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
ad-hoc署名の形式は維持し、更新互換に必要な明示DRを補った。
公証は導入していない。

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

その後に画面ロックの解除を観測し、実機の画面操作を再開した。
Due dateの設定から前面バナーの表示、実クリック、対象Issueの表示と個別既読を確認した。
PROBE-7の設定は`12:03:38.060Z`、OS依頼完了は`12:03:39.072Z`で、約1.012秒だった。
Inbox7のDue dateだけが`12:03:39.996Z`に既読となり、Inbox6のcommentは未読を維持した。
バナーには現在のタイトルと「期日が到来しました（2026-10-15）」が表示された。
証拠は`task7-latest-due-result.json`。

製品構成の別IDアプリで初回ON時に「許可しない」を選び、アプリONとOS不許可を別々に表示した。
Due dateと個別リマインダーはともにInboxへ未読で残り、OS配信履歴は`excluded`、理由は`permission`となった。
証拠は`task7-os-denied-result.json`。
この時点では、OS側で許可済みから取り消す操作と実スリープは未確認だった。

共通DRを適用した主製品の検証アプリでも、閉窓常駐中の両種類の配信を確認した。
独立した窓一覧が空でPID99259が存続している状態から、Due dateは設定`12:45:15.244Z`に対して`12:45:16.112Z`にOS依頼を完了し、約0.868秒だった。
個別リマインダーは予定`12:45:35.612Z`に対して`12:45:36.205Z`に完了し、約0.593秒だった。
Dueの実バナー本文を確認し、Reminderの実クリックで復元操作を加えず可視窓とPROBE-13を確認した。
Inbox13のReminderだけが既読になり、同IssueのInbox12のDueと無関係なInbox6のcommentは未読を維持した。
Due12を後からクリックする試みは通知センターの窓消失と古いindexのため効果を確認できず、既読も未達だった。
このDue12クリックを成功として扱わない。
この実機確認では両種類の予定が約20秒離れており、同時刻に各一件となる条件は固定時計の実DB統合テストで別に確認した。
証拠は`task7-closed-due-os-ui.json`、`task7-closed-due-click-ui.json`、`task7-closed-due-result.json`。

アーカイブ済みIssue、削除済み通知、永久削除済みIssueの実クリックも確認した。
PROBE-10はアーカイブ済みの詳細を表示し、Inbox10だけを既読にした。
PROBE-11は通知だけを削除した後もIssueを正常表示した。
PROBE-12は永久削除後に「Issueが見つかりません」を表示した。
別commentの未読は維持した。
証拠は`task7-click-cases.json`、`task7-click-cases-result.json`、`task7-archive-click-ui.json`、`task7-deleted-notification-click-ui.json`、`task7-deleted-issue-click-ui.json`。

sidecarの復旧待ちを挟むDue dateの実クリックも成功した。
PROBE-14のDue14が`12:48:26.908Z`に送信完了した後、親が検証用sidecarだけを停止し、復旧待ち中に実通知をクリックした。
接続先は旧port65518から新port51480へ変わり、新しいsidecarの起動完了は`12:48:49.098Z`だった。
現在の接続先でPROBE-14を表示し、Due14だけが`12:48:49.365Z`に既読となった。
復元操作を加えず可視窓と対象Issueを確認し、Due12の未読とReminder13の既読を維持した。
証拠は`task7-recovery-click.json`、`task7-recovery-click-result.json`、`task7-recovery-click-ui.json`と隔離データ内の`task7-state/logs/nod.log`。

共通DRを適用した主製品では、Due dateの通知から完全終了中の自動起動も成功した。
PROBE-15のDue15を`12:49:20.268Z`に送信した後、通常終了し、独立したプロセス確認でnativeとsidecarの両方が停止したことを確認した。
旧通知の実クリックでOSが`12:49:33.441Z`に自動起動し、現在のport51756へ`12:49:34.030Z`に接続した。
復元操作を加えずPROBE-15の可視窓と詳細を確認し、Due15だけが`12:49:34.372Z`に既読となった。
証拠は`task7-common-dr-cold-due.json`、`task7-common-dr-cold-due-ui.json`、`task7-common-dr-cold-due-result.json`。
実機確認の終了後、親が専用アプリ3本を通常終了し、nativeとsidecarの停止を独立して確認した。
本番アプリは停止せず維持した。

| Task 7 の追加項目 | 状態 |
| --- | --- |
| 新しい配布用アプリへの入れ替え、同じDBのmigration、設定と履歴の保持 | 成功。全列保持、schema41、旧版バックアップ、過去excluded、将来pending、ONと最後のON時刻を確認 |
| 製品構成での初回許可拒否、Inboxの継続 | 成功。アプリONとOS不許可を別表示し、両種類のInboxを保持 |
| OS側で許可済みから取り消す操作 | 未検証 |
| Due dateの前面通知、現在のタイトルと期日 | 成功。約1.012秒でOS依頼完了し、実バナーを表示 |
| Due dateの閉窓通知 | 成功。約0.868秒でOS依頼完了し、実バナー本文を確認 |
| Due dateの実クリックと当該通知だけの既読 | 成功。対象Issueを表示し、別commentの未読を維持 |
| アーカイブ済みIssue、削除済み通知、永久削除済みIssueの実クリック | 成功。参照画面、Issueの通常表示、消失案内をそれぞれ確認 |
| 完全終了中の通知クリックから自動起動、現在の接続先への遷移 | 未変更署名の新Reminder、共通DR更新前後のReminder、共通DR製品のDueで成功。旧cdhash DRの更新前通知には失敗あり（次節） |
| sidecar復旧待ちのDueクリックと現在の接続先への遷移 | 成功。旧port65518から新port51480へ復旧し、PROBE-14を表示してDue14だけを既読 |
| 完全終了中の超過分の回収開始5秒 | 成功。両種類を0.133秒で取得し、約0.136秒でOS依頼完了 |
| 完全終了から回収した両種類のバナー、実クリック、送信済みの重複防止 | 未検証 |
| 実スリープ復帰後の回収開始5秒、両種類の通知、重複防止 | 未実測・ユーザー判断で省略（10/20）。2回の試行とも予定前に自動復帰し条件不成立。複数回のスリープ後も両種類の配信履歴は各1件を維持（次節） |
| 共通DR適用後の通常配信5秒と実クリック | Due閉窓0.868秒、Reminder閉窓0.593秒とReminder実クリック成功。閉窓Due12の後追いクリックは効果未確認 |
| 更新後の送信済み重複防止 | 未検証 |

## 10月20日の実スリープ試行

2026年10月20日に本人がスリープ操作を行い、17:06に戻った。
本人も、操作していないのにすぐ画面が戻ったことを確認した。
隔離アプリは同じbundle IDと共通DRによるad-hoc署名を使い、native PIDは`73323`、sidecar PIDは`73464`、接続先portは`61024`だった。
以下の時刻はすべてJSTである。
PROBE-16のDue通知17はInboxのスヌーズを`17:03:33.398`まで設定し、PROBE-17のReminder通知18も同時刻を予定とした。
Due通知はスヌーズ解除による配信であり、09:00そのものの到来検証には当たらない。

`pmset`には次のスリープと復帰が記録された。

| スリープ（Sleep） | 復帰 |
| --- | --- |
| 17:03:23 | 同秒にDarkWakeとFullWake |
| 17:04:08 | 17:04:12にDarkWake、17:04:13にFullWake |
| 17:04:58 | 17:05:04にFullWake |
| 17:05:49 | 17:06:04にWake |

両通知は`17:03:33.404`に`claimed`となり、Dueは`17:03:33.407`、Reminderは`17:03:33.409`に`sent`となった。
予定は最初の自動復帰後の稼働中に到来したため、実スリープ中の期限到来から復帰後5秒以内に回収する条件は成立していない。
`sent`は実OSへの送信依頼完了を示し、今回は実バナーを目視しておらず、クリックも未確認である。
nativeは同じPIDで継続し、再起動はなかった。
複数回のスリープ後も両通知の未読を保持し、配信履歴のDB行は各1件で増加しなかった。

証拠は上記の永続保存先の`sleep-fixture.json`、`before-arm.json`、`after-wake.json`、`pmset-before.log`、`pmset-after.log`、`before-sleep.db`、`prepare-sleep.ts`にある。[^証拠保存先]

[^証拠保存先]: 10月20日の再開時点で、前回の`/tmp/nod19-acceptance/`の証拠は消失していた。今回の証拠は永続ディレクトリへ保存した。

本人はBluetoothマウスをOFFにして再試行した。
`pmset`では`17:14:38`にSleep、`17:14:42`にDarkWakeとFullWakeが記録され、`E_RX_IP_PACKET`と`UserActivity Assertion`が残った。
PROBE-18のDue通知19はスヌーズ期限を`17:15:23.992`とし、PROBE-19のReminder通知20も同時刻を予定とした。
両通知は`17:15:24.976`に`claimed`、Dueは`17:15:24.979`、Reminderは`17:15:24.981`に`sent`となり、両方とも未読、配信履歴は各1行だった。
再び稼働中に予定を迎えたため、この再試行も実スリープ復帰後5秒の成功証拠にはしない。
Dueは今回も09:00到来の検証ではない。
証拠は再試行の永続保存先の`sleep-fixture.json`、`after-retry.json`、`pmset-after.log`、`before-arm.json`、`before-sleep.db`、`prepare-sleep.ts`にある。

17:16に本人が、個人プロダクトのためこの検証をスキップしたいと明示した。
この判断により、実スリープ中の期限到来から復帰後5秒以内の回収開始の実測を、今回の必須完了条件から外す。
Task 7.3の実スリープ受入実測は`skipped`とし、結果は「未実測・ユーザー判断で省略（10/20）」と記録する。
追加のスリープ再試行やMac設定変更は求めない。
完全終了や更新の既存の実測証拠は維持し、OS側の許可取消など、ほかの未検証項目はこの省略判断の対象に含めない。

## 更新後クリックと共通DR

既定ad-hoc署名で送ったDue dateの旧通知を、アプリの再署名後かつ完全終了中にクリックすると、通知は消えたがアプリは起動しなかった。
usernotedは`Failed to find appropriate application to launch`を記録し、実クリックのcontents actionは受信していた。
同じbundle IDの旧版と新版でも、既定DRが各版のcdhashを要求して相互に一致しないことを署名検査で確認した。
未変更署名で出した新Reminderでは終了中クリックから自動起動し、現在のport57842のPROBE-8を表示して当該Inbox8だけを既読にした。

続いて別IDの製品構成アプリで、共通の明示DRを使う更新前Aと更新後Bを比較した。
AでReminderを表示して完全終了した後、無害なresourceを1ファイル追加し、同じ明示DRでad-hoc再署名したBに入れ替えた。
AのCDHashは`99bb3127d7454aaf16664a8e841316beca14ab74`、Bは`12679d71886a155cc547ec5f377ac7ee24d4ddde`に変わった。
両者のDRは`designated => identifier "io.github.machamp0714.nod.notification-signature-allowed"`で同一だった。
Aが出した通知を実クリックすると、OSがBを自動起動し、現在のport62331のUPD-1を表示した。
ウィンドウを復元する操作を加えずに、表示中の窓と対象Issueを確認した。
Reminder1だけが`12:32:58.187Z`に既読となった。
証拠は`task7-common-dr-ab.json`、`task7-common-dr-result.json`、`~/Library/Application Support/nod-notification-signature-allowed/state/logs/nod.log`にある。

この結果に基づき、外側のアプリへbundle IDと一致する共通の明示DRを付ける。
完成品検査ではInfo.plistと明示DRの一致を確認し、署名自体が有効な既定cdhash DRも拒否する。
親が主製品の安定配置にも共通DRを適用し、strict署名検査とLaunchServices登録を行った。
GUI起動対象が競合しないよう、重複する検証成果物3本は登録を解除して退避した。
sidecarのruntimeと3 entitlementsは維持し、新しい証明書や公証は導入しない。
識別はbundle IDによるもので、証明書による配布者認証ではない。
通知機能の最初の本番配布版から共通DRを使い、今後の更新間で同じ識別条件を維持する。
旧cdhash DRで送った既存通知が、この変更で遡って直ることは保証しない。
この説明は開発者向けの署名手順に置き、利用者の通知設定画面には出さない。

## Issue本文の完了条件との対応

番号はこの記録内の参照用であり、Issue本文の条件を順に対応させている。

| 条件 | 自動検証と実測の証拠 | 残る実機確認 |
| --- | --- | --- |
| 本文1：許可要求、拒否しても通常利用とInboxを維持 | Task 2の実許可要求。製品構成の別IDで実拒否し両種類のInboxを保持。ネイティブ配信の`denied`、`notDetermined`、許可取得エラーの実DBテスト | OS設定での許可取消 |
| 本文2：前面と閉窓常駐中、一覧を開かず日時に通知 | Task 2の前面0.824秒、閉窓0.387秒。Task 7のDue前面1.012秒、共通DR適用後のDue閉窓0.868秒とReminder閉窓0.593秒。実workerと実DBの配信テスト | 共通DR適用後の前面両種類の再確認 |
| 本文3：日時変更と解除、重複防止 | `notification-delivery.test.ts`の期限前後の変更と解除、同時claim、複数接続、再起動、既読と削除、OFFの競合。製品更新で送信履歴保持 | 更新後の送信済み分の実機重複防止 |
| 本文4：通知から対象Issueを開く | Task 2の実クリックと個別既読。Task 7のDue前面、sidecar復旧待ち、完全終了中の実クリック、閉窓と終了中Reminder、アーカイブ、通知削除、Issue永久削除の実クリック。サーバーとRustの遷移テスト | 閉窓Due12の後追いクリックは効果未確認、既読未達 |
| 本文5：再起動とスリープ復帰の期限超過 | 実workerの復帰配信、古い順、5秒以内の回収開始、取得前後障害のテスト。製品の完全終了復帰で0.133秒の回収開始を実測。10月20日のスリープ試行と再試行は予定前に自動復帰し条件不成立 | 完全終了復帰のバナーとクリックは未検証。実スリープ復帰後の回収開始5秒は未実測・ユーザー判断で省略（10/20） |
| Due1：ローカル09:00、未完了Issue | 実ネイティブ配信の09:00直前とちょうど、全Workspace、人とLLMとWebと一括更新、完了と取消のテスト。製品のDue前面バナーと実クリック、閉窓バナーを確認 | 閉窓Due12の後追いクリックは未達 |
| Due2：当日09:00以降と過去日付の設定時に一回 | 実ネイティブ配信の15時設定と変更、同値再保存で予定時刻を維持するテスト。製品で当日の新規設定から約1.012秒のOS依頼と実バナー | 過去日付の製品実測は固定時計テストに留まる |
| Due3：変更、解除、完了、取消、同一期日の重複防止 | 期日追従、日付往復、未完了復帰、実DBロック、ロールバック、claim後変更のテスト。製品更新で配信履歴保持 | 更新後の送信済み分の実機重複防止 |
| Due4：個別リマインダーと独立、同時刻に各一件 | 同時刻の実DBネイティブ統合テストで各一件とメモ、購読通知の維持を確認。実機PROBE-13では約20秒差で両種類の配信を確認。10月20日はDueのスヌーズ解除とReminderを同時刻に予定し、両種類のOS送信依頼と配信履歴各1件を確認 | 同時刻併存時の実バナーとクリックは未確認 |
| Due5：Inbox、設定、許可、回収、クリックの共用 | OFFでもInbox保持、再ON除外、保留と復元、個別既読、送信失敗、復帰配信のテスト。製品でDueの前面と閉窓バナー、前面、sidecar復旧待ち、完全終了中の実クリック、個別既読、許可拒否、完全終了復帰のOS依頼完了を確認 | 製品のOS取消は未検証。実スリープ復帰後の回収開始5秒は未実測・ユーザー判断で省略（10/20） |
| Due6：導入前の古い期日を一斉通知しない | schema40移行の実DBネイティブ2ケース。実データ全列保持、旧版バックアップ、過去excludedと将来pendingを隔離DBと配布用アプリ更新の双方で実測 | 将来09:00の到来は固定時計の実DBネイティブテストで確認 |

## 仕様 #178 の詳細条件との対応

| 仕様の条項 | 証拠 |
| --- | --- |
| 初期OFF、最後のON時刻、再起動、保存失敗 | `packages/core/test/desktop-notifications.test.ts`。Task 2の画面と再起動実測 |
| 全Workspace、CLIとWebの先行Inbox化、表示画面から独立 | 実ネイティブ配信テスト、Task 2の別Workspace閉窓実測 |
| 再ON前の除外、許可不許可と取得エラーの区別 | 実ネイティブ配信の「初回ON前」「OFF中」「再ON前の保留」、`denied`、`notDetermined`、`permission-error` |
| 未読条件、削除と復元、スヌーズ、アーカイブ | 実ネイティブ配信の保留と復元、既読と削除の永久除外、実DB競合 |
| 最新タイトル、当該メモ、期日、過去分の表示 | 実ネイティブ配信の内容検証、`packages/web/src/lib/notification.test.ts`、Task 2の実バナー |
| クリック、当該通知だけの既読、消失時の案内 | サーバーのクリックackテスト、Rustの未完了クリックと現在ポートのテスト、Task 2とTask 7の実クリック。実機でsidecar復旧後の新ポート、アーカイブ、通知削除、Issue永久削除も確認。残る範囲は前表の未検証項目 |
| 原子的な取得、claimedとsentとfailedの区別 | 実DB複数接続と実Rust process、取得前後のクラッシュ、応答障害、送信失敗、終了中batchのテスト |
| 通常配信5秒と復帰後の回収開始5秒 | Task 2の通常配信実測、実workerの復帰と依存障害復旧テスト。Task 7の完全終了復帰は0.133秒で回収開始。実スリープ復帰後の回収開始5秒は、2回の試行とも予定前に自動復帰し条件不成立。未実測・ユーザー判断で省略（10/20） |
| ローカル暦日、TZ変更、夏時間、日付境界 | 別APIプロセスの固定時計とTZによるTokyo、New York、Los Angeles、DST前後の実DB配信テスト。MacのOS設定変更は未実施 |
| 一括更新の失敗とロールバック | 実ネイティブ配信と実DB競合の一括更新ロールバックテスト |
| 欠落可能性とInbox保持、操作方法 | [README](../README.md#デスクトップ通知の利用)、送信障害とクラッシュ境界のテスト |

## Task 7 のStep別判定

| Step | 判定 | 根拠 |
| --- | --- | --- |
| 1：旧DB移行と履歴保持 | 自動検証、隔離DB、製品更新での移行実測は成功 | 全列一致、旧版バックアップ、過去除外、将来既存09:00のネイティブ配信 |
| 2：配布形態の許可、両種類の通知とクリック | 一部確認済み | Task 2の個別リマインダー、Task 7のDue前面バナーとクリック、両種類の閉窓配信、削除状態のクリック、初回許可拒否を実測。OS取消と閉窓Due12の後追いクリックなどは未確認 |
| 3：終了、スリープ、更新と5秒条件 | `skipped`（実スリープの受入実測、10月20日のユーザー判断）。完全終了復帰の回収開始、更新時の保持、共通DR更新とsidecar復旧待ちのクリックは実測済み | 回収開始0.133秒、設定と配信履歴保持。実スリープ復帰後の回収開始5秒は未実測・ユーザー判断で省略（10/20）。完全終了から回収した両種類のバナーとDueクリック、更新後の重複防止は未検証のまま |
| 4：自動検証、型検査、各ビルドと配布検査 | ビルドと担当検証は成功。全体suiteの既存1失敗を最小修正し対象テスト成功。共通DR追加後の対象検証と8項目の配布物検査も成功 | 初回全体2358成功/1失敗、対応表修正後対象8成功/0失敗。全体再実行はしていない。実機通知とクリックの失敗があれば完了にしない |
| 5：利用方法、制約、証拠対応 | 記録済み。実機証拠の追記待ち | READMEと本記録。本番配置やPRマージは別指示 |

ユーザー判断で省略した実スリープの受入実測を除き、残る実機確認の証拠と変更ごとの対象検証をこの記録へ追記してから、Task 7 全体の完了を判断する。
