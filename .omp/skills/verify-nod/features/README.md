# verify-nod の機能の一覧

nod の利用者から見える振る舞いを、検証用の nod で確かめるための一覧で、版管理して保守する。操作の前にこの索引を読み、確かめたい機能のファイルを手順として使う。起動・状態確認・後始末と補助スクリプトの使い方は `../SKILL.md` にある。

## 前提（baseline）

- 作業ツリーのルートを cwd にして、`./.omp/skills/verify-nod/scripts/verify-nod.ts launch` で起動した run を使う。以下、補助スクリプトを `S=./.omp/skills/verify-nod/scripts/verify-nod.ts`、`launch` の出力の `runId` を `R` と書く。
- run は空のデータから始まる。Workspace は1つ（キー `V<runId の末尾5桁を大文字>`、名前 `verify-nod-<runId>`）だけで、Issue・Document・質問は0件。
- `$S doctor $R` が終了コード 0 で通る。通らない run は操作せず、`cleanup` してから `launch` し直す。
- 外部サービス（仕様要否判定、GitHub、Toggl、Orca）は切ってある。それらの成功の経路には到達できない（「確かめられない範囲」）。
- デスクトップアプリは動かさない。Web（ヘッドレスの Chromium）で確かめたことは、デスクトップアプリで確かめたことにならない（「確かめられない範囲」）。
- 利用者の nod（ポート 4700、`~/.local/share/nod`）には触れない。PATH の `nod` は使わない。
- 自分が `launch` した run だけを操作する。

## 操作の決まり

- 機能のファイルの手順は、前提の状態から始める。手順が必要とするデータは、同じ run の中で利用者の経路（CLI か Web）で作る。
- CLI は `$S cli $R --evidence <機能の ID> -- --json <nod の引数...>` で実行する（`--json` で出力を JSON にして、比べられるようにする）。
- Web は `$S browser $R --feature <機能の ID>` に、手順の JSON の配列を標準入力で渡す。呼び出しごとに新しいブラウザのページで始まるので、手順は `goto` から書く。ページを開いたまま CLI で書くときは、手順の `cli`（同じ run・同じ許可リストの環境のソースの CLI）を使う。
- ロケータは ARIA の role と accessible name（`exact: true` で完全一致）を第一に使い、ページの場所はルートのパス（`/issues`、`/issues/<ID>` など）で指す。CSS や DOM の位置、座標は使わない。
- 待つときは `expect`・`wait`・`url`・`events` で画面の状態を待つ。固定の時間で待たない。
- コマンドと名前は書いてあるとおりに使う。引用した名前やフラグを変えない。
- テスト専用の口（`packages/web/e2e` の `nod.me.*`、DB への直接の書き込み、server の内部の関数）でデータを作らない。
- 証拠は消さない。`cleanup` は `evidence/` を残す。

## 証明と、到達できないときの報告

- 利用者の操作と、その結果の状態の両方を残す。最後の画面だけでは証明にならない。
- CLI の証拠は、コマンド・標準出力・標準エラー・終了コード（`evidence/<機能の ID>/NNN-cli.json`）。
- Web の証拠は、ARIA スナップショットとスクリーンショット（どちらにも run の ID と URL が入る）と、手順ごとの結果の記録（`NNN-browser.json`）。
- 書き込みの副作用は、書いたのと別の読み取りの見方（例: CLI で書いたら Web の一覧と詳細、Web で書いたら CLI の `show`）で確かめる。
- 証拠を報告するときは、機能の ID、使った入口（CLI か Web のどの画面か）、run の ID、証拠のパスを添える。
- 外部サービスに依る経路は、成功したと報告しない。到達できないことと、満たせない前提を書く。未設定・無効の表示は確かめてよい。
- 到達できない経路は、試したコマンドと満たせなかった前提を添えて「到達できない」と報告する。別の入口で確かめたことを、試していない入口の証明として報告しない。
- 前提のデータが足りずに手順が通らないときは、失敗として報告し、理由を機能のファイルの `Gotchas` に書く。手順を弱めて通さない。

## 機能のファイルの形

機能のファイルは、H1 の題と、利用者から見える振る舞いを書いた1段落で始め、次の4つの H2 をこの順に置く。

1. `Sub-features` は、短い ID と1行の説明を並べる。
2. `How to get to it (user POV)` は、利用者の入口をすべて並べる（使えない入口は理由を添える）。
3. `Driving it with verify-nod.ts` は `Preconditions:` で始め、利用者の操作・実際のコマンド・観測できる結果を組にした項目を並べる。
4. `Gotchas` は、検証を無駄にしたり無効にしたりする落とし穴を並べる。

実装の細部は書かない。書くのは利用者の経路、安定したハンドル（role と name、ルートのパス）、必要な状態、コマンド、観測できる証明だけにする。機能の ID はファイル名（拡張子なし）と同じにし、証拠の置き場 `evidence/<機能の ID>/` の名前にも使う。

## 機能

- [Issue の作成と、一覧・詳細での表示](./issue-create.md)（`issue-create`）は、CLI での起票、Web の Issues の一覧と Issue の詳細での表示、CLI の `show` での読み直し、Web の「New Issue」が無効であることを扱う。
- [Issue の状態の変更（詳細と Board）](./issue-status.md)（`issue-status`）は、詳細のプロパティの Status のメニュー、Board（`/issues?layout=board`）でのカードのドラッグ（列と Hidden columns）、再読み込み後の表示、CLI の `show` の保存値と Activity の書き手 `me` を扱う。
- [CLI の書き込みの Web への反映](./cli-to-web.md)（`cli-to-web`）は、Web を開いたまま `browser` の `cli` の手順で書き、再読み込みなしで一覧・詳細・Activity が変わること（変更の通知）を扱う。
- [質問と回答（未回答の質問の一覧を含む）](./questions.md)（`questions`）は、CLI の `issue ask` の書き手で出る場所が分かれること（`me` は Open questions、それ以外は Inbox）、Open questions・Issue の詳細・Inbox での回答、件数の変化と一覧が空になること、CLI の保存値を扱う。
- [Document の作成、Issue への添付、表示](./documents.md)（`documents`）は、CLI の `doc create`・`issue doc add`、Web の「新規ドキュメント」・Issue の詳細の「新規作成」「既存を添付」、Document の本文の表示、Issue と Document の相互のリンク、run の `data/documents/` にファイルができることを扱う。

## 確かめられない範囲

次の2つは、成功の経路にこのスキルでは到達できない。機能のファイルは、到達できない理由と前提、確かめてよい範囲（未設定・無効の表示、Web の側の表示）、それ以外の確かめ方への案内を書く。到達できない経路を報告するときは、そのファイルの前提を添える。

- [外部サービスに依る機能（到達できない範囲）](./external-services.md)（`external-services`）は、仕様要否判定・GitHub（PR の状態、GitHub Issue）・Toggl・Orca について、run のどの隔離で切っているか、成功の経路に要るもの、未設定・無効のときの表示（「判定失敗：APIキーが未設定です」「gh が見つかりません」「未設定」「Orca との連携が無効です」）の確かめ方を扱う。
- [デスクトップアプリ固有の機能（動かさない）](./desktop.md)（`desktop`）は、ウィンドウ・sidecar の監督・OS の通知・OS のドラッグ＆ドロップ・完成品の検査を、既存の受入記録（`packages/desktop/docs/`、`packages/desktop/test/board-drag-status-smoke.ts`、`packages/desktop/scripts/verify-app.ts`）へ案内し、Web の側で確かめてよい表示（通常のブラウザでは通知を有効にできない）を扱う。

機能の一覧に無い機能を確かめたいときと、一覧が実物と合わないときは、`../SKILL.md` の「保守」に従う。
