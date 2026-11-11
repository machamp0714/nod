# 親の手順

単独レビューでは利用者のセッションが、実装後レビューでは実装を進行する親エージェントが、この手順で親になる。
親は自分でレビューしない。対象と要求を固定し、レビュー担当エージェントへ委譲し、引き渡しを検査し、判定を変えずに状態・点数・報告を記録する。
あわせて、固定した head SHA のクリーンな別 checkout でリポジトリのテストを実行して記録し、レビューの最終状態・確定した要対応の点数・確認が残る事項とテスト実行の結果から「マージ可否」を決める。テスト実行は親だけの工程で、その出力はレビュー担当へ渡さない。

## 0. 委譲先と前提

- 委譲先は役割別の3定義だけ: Standards 探索は `code-reviewer-standards`、Spec 探索は `code-reviewer-spec`、反証は `code-reviewer-refute`。
- これらが使えない（定義が見つからない、起動を許可されていないなど）場合も、旧 `code-reviewer` やバンドル済みの `reviewer` などで代用しない。
- レビュー担当エージェントへ委譲できない環境（委譲の仕組みが無いハーネスなど）では、親は自分でレビューせず、最終状態を `未実施`（理由: 委譲できない環境）として記録・報告する。
- 担当のモデルは設定側の責務であり、この手順では扱わない。モデル情報は担当の申告と出典を記録するだけで、停止条件にしない。
- 全体期限や担当ごとの打ち切り期限は設けない。担当の実行時間はハーネスに任せる。
- 指摘は直さない。修正は別作業で行い、再レビューは新しい委譲で行う。このレビューから commit・push・PR 投稿・マージをしない。

## 1. 対象・基点・要求を特定する

- 依頼や実装工程から引き継いだ対象リポジトリ・基点・対象版・Issue・Document は聞き直さない。対象リポジトリまたは基点が依頼に無いときだけ利用者に確認する。
- PR を指定された場合は `gh` で実際のリポジトリ・基点・head を特定する。Issue をブランチ名から推測しない。
- コミットのレビュー（`mode: commit`）: `git -C <repo> rev-parse <head>` で head の SHA、`git -C <repo> merge-base <基点> <head>` で merge-base の SHA を固定する。
- 明示された未コミット変更のレビュー（`mode: local`）: 明示されたときだけ行い、commit や stash を作らない。土台の HEAD の SHA を固定し、merge-base は基点と土台の HEAD から求める。差分は表示用の変換を無効にして `git -C <repo> --no-optional-locks diff --binary --no-ext-diff --no-textconv HEAD` で写し、未追跡ファイルは指定されたものだけを写す。
- 本文を読む前に、変更されたパス（`mode: commit` は `git -C <repo> diff --no-ext-diff --no-textconv --name-only -z <merge-base> <head>` を NUL で区切って読み、日本語などを含むパスも引用符なしの名前で調べる。`mode: local` は土台の HEAD までのコミット済みの差分 `git -C <repo> diff --no-ext-diff --no-textconv --name-only <merge-base> <土台の HEAD>` と、未コミットの差分 `git -C <repo> --no-optional-locks diff --no-ext-diff --no-textconv --name-only HEAD` と、指定された未追跡パスの全部）に、秘密情報を含み得るファイルが無いことを確かめる。パスのどこかの要素が `.env`・`.env.*`・`.aws`・`id_rsa`・`id_ed25519`・`credentials`・`credentials.*`・`*.pem`・`*.key`（大文字小文字を区別しない）に当たれば、差分の本文を写さず、委譲もテスト実行もせず、`未実施`（理由: 秘密情報を含み得る <パス> が差分にあり、必要な範囲を利用者が確かめる必要がある）・点数なし・マージ可否 `不可（人の判断が要る）` として報告する。

```sh
git -C <repo> diff --no-ext-diff --no-textconv --name-only -z <merge-base> <head> | tr '\0' '\n' \
  | grep -iE '(^|/)(\.env(\.[^/]*)?|\.aws|id_(rsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key))(/|$)'   # 1行でも出れば秘密候補あり。-z で取り、日本語などを含むパスも引用符なしの名前で調べる
```
- 差分が空なら委譲もテスト実行もせず、`未実施`（理由: 差分なし）・点数なし・マージ可否 `不可（人の判断が要る）` として報告する。

## 2. 作業ディレクトリを作り、共通入力を固定する

実行ごとに一意な作業ディレクトリを作る。ディレクトリの分離は担当への指示の境界であり、アクセス遮断ではない。

```sh
RUN=$(uuidgen | tr 'A-Z' 'a-z')
W="$HOME/.local/share/nod/code-reviews/$RUN"
mkdir -p "$W/input/requirements" "$W/standards/notes" "$W/spec/notes" "$W/refute-input" "$W/refute/notes" "$W/parent"
```

| 場所 | 用途 | 書く人 | 読む人 |
|---|---|---|---|
| `input/` | 共通入力（全担当へ同じもの） | 親 | 両探索担当 |
| `standards/` | Standards 探索の `handoff.md` と `notes/` | Standards 探索担当 | 親（検査） |
| `spec/` | Spec 探索の `handoff.md` と `notes/` | Spec 探索担当 | 親（検査） |
| `refute-input/` | 反証への入力（検査済みの引き渡し用ファイルと共通入力の写し） | 親 | 反証担当 |
| `refute/` | 反証の `verdict.md` と `notes/` | 反証担当 | 親 |
| `parent/` | 親専用領域（取得結果、検査記録、指紋、担当の対応表、テスト実行の記録 `parent/tests/`、報告の原稿） | 親 | 親だけ |

`input/` には次だけを置く。

- `target.md`: 対象リポジトリの絶対パス、基点の指定、merge-base の SHA、head の SHA、`mode: commit` または `mode: local`、Issue（ID またはなし）、計画の出典の扱い。`mode: local` では土台の HEAD の SHA、`local/changes.diff`、`local/untracked/<相対パス>` の一覧も書く。
- `local/`（`mode: local` のときだけ）: `changes.diff` と、指定された未追跡ファイルの写し `untracked/<相対パス>`。
- `requirements/`: 要求の原文。丸ごと写し、選別・要約・書き換えをしない。
  - `issue.md`: Issue のタイトルと本文だけ。
  - `spec-<DocumentID>.md`: Issue に現在リンクされたすべての `kind=spec` の Document の本文。1件に絞らない。
  - `plan-<DocumentID>.md`: Issue の計画の出典（`plan.source`）が指す `kind=plan` の Document だけ。
  - `workspace-rules.md`: Git 管理外の Workspace の規約の原文（未登録ならその旨の出力）。
- `manifest.md`: `input/` の各ファイルの sha256 と出典（Issue ID と取得時刻、Document ID とパス、Workspace 規約、Git の SHA）、取得できなかった資料と理由。

```sh
nod --json issue show <Issue ID> > "$W/parent/issue-snapshot.json"
jq -r '"# \(.title)\n\n\(.description // "")"' "$W/parent/issue-snapshot.json" > "$W/input/requirements/issue.md"
jq -r '.documents[] | select(.kind == "spec") | .id' "$W/parent/issue-snapshot.json"   # 各 ID を nod --json doc show <ID> の .content で spec-<ID>.md へ写す
jq -r '.plan.source // empty' "$W/parent/issue-snapshot.json"                            # この path と一致する kind=plan の Document だけを plan-<ID>.md へ写す
nod -w <repo> workspace rules show > "$W/input/requirements/workspace-rules.md"
(cd "$W/input" && find . -type f ! -path ./manifest.md -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256)   # manifest.md の指紋（除くのは目録自身の ./manifest.md だけ。空白を含むパスも1件として扱う）
```

- 計画の出典が Document に解決できない、または本文を読めない場合は、別の計画で代用せず写さない。`target.md` と `manifest.md` に「計画の出典を解決できず不足（<plan.source>）」と書く。計画の出典が無い場合は「計画の出典なし」と書く。
- `kind=spec` の Document の本文を読めない場合も写さず、`manifest.md` に取得できなかった Document と理由を書く。
- Issue の無い単独レビューでは、`issue.md`・`spec-*`・`plan-*` の代わりに、利用者が明示した要求の原文（Document やファイル）だけを `requirements/request-<n>.md` に丸ごと写し、`target.md` に「Issue なし」と書く。明示された要求が無ければ「Workspace の規約以外の要求資料なし」と書く。`workspace-rules.md` はどちらの場合も写す。
- `nod issue show` の全出力、Activity（作業ログ・コメント）、実装の完了報告、過去のレビュー、自動チェックの結果、親のテスト実行の出力・記録（`parent/tests/`）、計画の進捗状態は `input/` に入れない。Spec・計画に混ざった結果の節を要求から外す判断は担当に任せ、親は削らない。

## 3. テストを実行する（親だけ）

対象 SHA を固定した後、記録（9節）の前に、親がテストを1回実行する。レビュー担当への委譲（4節以降）と並行してよい。

- 出力と記録は `parent/tests/` にだけ置く。担当への依頼本文・共通の context・`input/`・`refute-input/` に入れず、担当の返答を待つ間にテストの状況や出力を担当へ送らない。
- 実装者の作業ツリーを使わない。実装者の既存のテストログで代用しない。
- `mode: local` では実行しない。head のクリーンな checkout は未コミット変更を含まず、head の結果を変更込みの証拠に流用できないため、`record.md` に判定 `対象外（未コミット）` と理由だけを書く（提出用の実行証拠は commit 確定後に取る）。

### 3.1 クリーンな別 checkout を作る

対象リポジトリの作業ツリー・index・ref を変えない方法で作る。`git worktree add` は対象リポジトリのメタデータを変えるので使わない。

```sh
T="$W/parent/tests"
mkdir -p "$T"
git clone --quiet --no-checkout <repo> "$T/checkout"
git -C "$T/checkout" checkout --quiet --detach <head の SHA>
git -C "$T/checkout" rev-parse HEAD      # target.md の head の SHA と一致すること
git -C "$T/checkout" status --porcelain  # 空であること
```

- `rev-parse HEAD` の値、`status --porcelain` の結果、clone 元のパスと手順を作業ディレクトリの由来として `record.md` に書く。
- checkout を作れない、SHA が一致しない、開始時の状態が空でない場合は実行せず、判定を `実行できず` とする。

### 3.2 結果を見る前に範囲と理由を決める

- 固定した head SHA の時点の規約文書（`AGENTS.md`・`CLAUDE.md`・`CONTRIBUTING.md`・`README.md` など）やパッケージ定義（`package.json` の `scripts.test` など）に書かれたテストの入口を checkout から読み、実行するコマンドと範囲、その理由と出典（`<path>@<sha>:L<開始>-L<終了>`）を `parent/tests/plan.md` に書いてから実行する。
- 結果を見る前に、固定版のテストコードから条件付きで実行・skip されるテスト（`test.skipIf`・`test.if`・`describe.skipIf`・`test.skip` など）を探し、それぞれの条件を読む。条件が、この checkout と実行環境では満たせない外部のもの（別途ビルドした成果物、OS の機能、明示的に有効にする環境変数など）であれば、項目（ファイルと行または名前）・条件・必須としない理由を `plan.md` に書く。依存の準備漏れなど、満たせるのに満たしていない条件のものは必須のままにする。
- 実行するコマンドは、skip した項目の名前が個別に残る形にする。テストランナーが項目ごとの結果を書き出す形式を持つなら、範囲を変えない出力の指定だけを足し、その指定も `plan.md` に書く（例: `bun test` には `--reporter=junit --reporter-outfile="$T/results.xml"`。`bun run test` が `bun test` を呼ぶだけなら、その後ろに付ける）。
- 実行後、項目ごとの結果に出た skip を、ファイルと行または名前で `plan.md` の記録と照らす。記録に無い skip、記録と異なる条件の skip、どの項目か出力から分からない skip は必須の項目の skip とし、判定を成功にしない（記録のある条件付き skip だけなら、ほかの条件を満たせば `成功`）。
- テストの入口が書かれていなければ実行せず、判定を `テストなし（未確認）` とする。親がテストの入口を推測して作らない。
- 実行後に範囲を変えない。失敗後に範囲を狭めて成功扱いにしない。

### 3.3 依存を準備し、実行する

- 依存は固定版の lockfile などに従って準備する（例: `bun install --frozen-lockfile`）。lockfile の sha256 と、runtime とその版（例: `bun --version`）を記録する。準備の終了コードが 0 以外ならテストを実行せず、判定を `実行できず` とする。
- `plan.md` のコマンドを checkout で1回だけ実行し、出力を丸ごと保存する。出力を要約で置き換えない。

```sh
date -u +%Y-%m-%dT%H:%M:%SZ                                     # 開始時刻
(cd "$T/checkout" && <依存の準備>) > "$T/setup.log" 2>&1; echo "setup exit=$?"
(cd "$T/checkout" && <plan.md のコマンド>) > "$T/output.log" 2>&1; echo "test exit=$?"
date -u +%Y-%m-%dT%H:%M:%SZ                                     # 終了時刻
shasum -a 256 "$T/setup.log" "$T/output.log" "$T/results.xml" <lockfile>   # 項目ごとの結果のファイルがある場合はそれも
```

- 失敗しても自動で直さない。再実行で成功を待たない（1回の実行の結果を記録する）。

### 3.4 判定し、記録する

| 判定 | 条件 |
|---|---|
| `成功` | 終了コードが 0 で、必須の項目の skip が無い |
| `成功としない（必須の skip あり）` | 終了コードは 0 だが、必須の項目の skip がある |
| `失敗` | 終了コードが 0 以外 |
| `実行できず` | checkout・依存の準備・起動ができないなど、環境の問題等で実行できない |
| `テストなし（未確認）` | 固定版にテストの入口が書かれていない |
| `対象外（未コミット）` | `mode: local` |

`成功` 以外は、どれも成功として扱わない。

`parent/tests/record.md` には次を書く: checkout の SHA と `target.md` の head の SHA、開始時の状態と作業ディレクトリの由来、依存の固定情報（lockfile のパスと sha256）と runtime の版、`plan.md` への参照、依存の準備と実行のコマンド、それぞれの終了コード、出力の原本（`setup.log`・`output.log`・項目ごとの結果のファイル）とその sha256、開始・終了時刻と所要時間、skip の件数と、各 skip の項目（ファイルと行または名前）・`plan.md` の記録との照合の結果・扱い（出力に skip の表示が無ければその旨）、判定。

記録と出力の sha256 を書き終えたら、clone した `$T/checkout`（依存の準備で入ったファイルを含む）を `rm -rf "$T/checkout"` で片付ける。`plan.md`・`record.md`・`setup.log`・`output.log`・項目ごとの結果のファイルは残す（checkout の SHA・lockfile の指紋・ログで再現できる）。片付けたことと時刻を `record.md` に書き足す。片付けに失敗したら、その旨を `record.md` に書き、判定は変えない。

テストの成否で、レビューの最終状態・点数・反証の判定・要求ごとの対応表を変えない。テスト実行の結果は8節のマージ可否にだけ使う。

## 4. 両探索を並列に委譲する

Standards 探索担当と Spec 探索担当を、それぞれ新しいコンテキストで、1回の委譲で同時に起動する。依頼本文は次の最小限だけにする。

```text
役割: Standards 探索
作業ディレクトリ: <W の絶対パス>
読んでよい入力: <W>/input/ 配下（target.md・manifest.md・requirements/・local/）と、target.md に固定した SHA から読む対象リポジトリ
書いてよい場所: <W>/standards/（handoff.md と notes/）と自分の一時ファイル
出力: <W>/standards/handoff.md
```

Spec 探索は `役割: Spec 探索`、書いてよい場所を `<W>/spec/`、出力を `<W>/spec/handoff.md` に置き換える。
共通の context を持つハーネスでは、それを空にする。空にできない場合は「指定された役割・入力・出力だけを使う独立レビュー。自動チェックは実行しない。」のような固定の1文だけにする。要求の要約、親の見立て、実装者の自己評価、作業ログ、探索の返答、親のテスト実行の状況・出力を入れない。

担当が実行中でまだ返っていない間は、待機中として状況を報告するだけにする。経過時間だけで失敗と判定せず、ハーネスの終了・失敗・取り消しの通知を使う。ハーネスが実行中のままで応答しない場合はその状態を利用者へ報告し、停止を確認できないときは停止済みと報告しない。

ハーネスが返した各担当の ID を `parent/agents.md` に役割・定義名と対応付けて記録する。

## 5. 探索の引き渡し用ファイルを検査する

親は引き渡し用ファイルを書き換えない（補筆・削除・要約・整形をしない）。次だけを確かめ、結果と各ファイルの sha256 を `parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。
2. 指定したパスに `handoff.md` がある。
3. 役割・定義名・対象版・要求資料が書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。終了状態、未確認と理由、判断を見送った事項の節がある（無いことを明示していてもよい）。
4. 各候補に必須項目（SKILL.md の4節）がそろい、候補 ID が役割の接頭辞を持ち重複しない。証拠を取得できなかった候補には理由と不足箇所がある。
5. Standards 探索: 規約の一覧と今回の差分への適用判断、候補一覧または「候補0件」の明示、探索上の不足・判断を見送った事項がある。
6. Spec 探索: 要求ごとの対応表が雛形の4列（要求の出典・状態・証拠または不足理由・候補ID）で、`requirements/` のすべてのファイルを出典に含み、状態が SKILL.md の語彙だけを使う。未充足・未確認の行に候補 ID があり、その ID が候補一覧にある。列の確認は雛形の見出しと各行の「出典・状態・候補ID」の位置で行い、セル内のコードや文字列に含まれる `|` だけを理由に列数違反としない（Markdown の表示上で列が崩れていても、出典・状態・候補ID が読み取れれば形式違反にしない）。
7. 禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が項目名にも本文にも無い。項目名だけの検査では内容の混入まで保証できないので、本文も読んで確かめる。
8. `input/` の各ファイルの sha256 が `manifest.md` と一致する（担当が共通入力を変えていない）。

全確認単位を覆っているかの意味上の判断は反証担当が行う。親の検査は形式と参照の確認であり、内容の正しさの保証ではない。
どちらかの担当に違反・欠落・失敗があれば、その結果を有効とせず、反証を起動しない。最終状態を `未完了`（理由: <担当>の有効な結果なし）とし、自動で修正を依頼したり、再委譲・担当の再開で代替したりしない（8節へ進む）。

## 6. 反証への入力を写し、反証を委譲する

両探索の検査を通過したときだけ、検査済みの引き渡し用ファイルと共通入力を、内容を変えずに `refute-input/` へ写す。

```sh
cp "$W/standards/handoff.md" "$W/refute-input/standards-handoff.md"
cp "$W/spec/handoff.md" "$W/refute-input/spec-handoff.md"
cp -R "$W/input/target.md" "$W/input/manifest.md" "$W/input/requirements" "$W/refute-input/"
[ -d "$W/input/local" ] && cp -R "$W/input/local" "$W/refute-input/"
(cd "$W/refute-input" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256)
```

写した各ファイルの sha256 が、検査時に記録した引き渡し用ファイルの指紋と `input/` の指紋に一致することを確かめ、`parent/fingerprints.md` に書く。一致しなければ写し直さず、反証を起動せずに `未完了`（理由: 反証への入力を固定できず、反証の有効な結果なし）とする。
探索のサブディレクトリ全体、`notes/`、一時ファイル、探索の返答・会話出力、親の要約は写さない。

反証担当は、新しいタスクとして新しいコンテキストで1体だけ起動する。探索担当への追送や再開は使わない。探索の候補が0件でも、必要な確認の不足や判断の見送りを確かめさせるため省かない。依頼本文は次だけにする（作業ディレクトリの他の場所を示さない）。

```text
役割: 反証
読んでよい入力（次のファイルだけ）:
- <W>/refute-input/standards-handoff.md
- <W>/refute-input/spec-handoff.md
- <W>/refute-input/target.md
- <W>/refute-input/manifest.md
- <W>/refute-input/requirements/<各ファイル>
- <W>/refute-input/local/<各ファイル>（mode: local のときだけ）
- target.md に固定した SHA から読む対象リポジトリ
書いてよい場所: <W>/refute/（verdict.md と notes/）と自分の一時ファイル
出力: <W>/refute/verdict.md
```

共通の context は4節と同じく空か固定の1文だけにする。待機と ID の記録は4節と同じ。

## 7. 反証の結果を検査する

`verdict.md` を書き換えずに次を確かめ、`parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。指定したパスに `verdict.md` がある。
2. 役割・定義名・対象版・受け取った入力が書かれ、対象版が `target.md` と一致する。
3. 両方の引き渡し用ファイルのすべての候補 ID が採否一覧にあり、判定と根拠がある。要対応には影響度 0〜4 がある。
4. 要求ごとの対応表が雛形の4列で、Spec 探索の対応表のすべての行を確定している（列の確認は5節の6と同じく、セル内の `|` だけを理由に違反としない）。
5. 反証で追加した発見（無ければ無いことの明示）、軸ごとの要対応と未確認の件数、未確認と理由、判断を見送った事項がある。未確認ごとに、理由と確かめる担当がある。
6. `refute-input/` の各ファイルの sha256 が `parent/fingerprints.md` と一致する。

欠落・失敗があれば `未完了`（理由: 反証の有効な結果なし）とする（自動の再委譲はしない）。理由と確かめる担当を示した未確認は有効な結果であり、それだけでは `未完了` にしない。

## 8. 最終状態・点数・確認が残る事項・マージ可否を決める

1. `mode: local` では、反証の結果を受け取った後に、土台の HEAD と差分（指定された未追跡ファイルを含む）を同じ方法で取り直し、`input/` の写しの sha256 と比べる。変わっていれば、確認が残る事項に「未コミット変更の土台 HEAD・差分の変化」（出典: 変わった写し、確かめる担当: 人、理由: 固定した変更と現在の変更が異なる）を加える。
2. 保存の直前に、要求の本文・資料だけを2節と同じ方法で `parent/requirements-recheck/` へ取り直し、`input/requirements/` と sha256 で比べる（Issue のタイトルと本文、現在リンクされている `kind=spec` の集合と本文、計画の出典が指す Document、Workspace の規約）。Activity・進捗・更新日時は比べない。変わっていれば旧要求に対する結果として保存し、確認が残る事項に「保存時の要求の変化」（出典: 変わった資料、確かめる担当: 人、理由: 現在の要求への適合を確かめていない）を加える。
3. 最終状態を SKILL.md の6節で決める。必要な担当の有効な結果の有無だけで決め、判定本文の未確認や1・2の変化では `完了` を `未完了` にしない。
4. `完了` のとき、未確認が残っていても、反証担当の判定から規則どおりに確定した要対応の点数を計算する。親は判定・影響度・対応表を変えない。計算の過程（要対応の件数、各要対応の影響度、最小値）を記録する。
5. 確認が残る事項をまとめる。判定本文の未確認（対応表の「未確認」の行と、判定「未確認」の候補。要実行確認を含む）と要求間の矛盾を、判定本文の要求の出典（または候補 ID）・確かめる担当・理由のまま1件ずつ並べ、1・2で加えた事項と合わせる。例外を設けず、どれも最終状態と点数を変えない。
6. テスト実行の結果では、3〜5の最終状態・点数・確認が残る事項を変えない。反証担当が確定した対応表の行（「未確認」「自動チェック担当」を含む）も書き換えない。
7. マージ可否を決める。
   - `可（人のレビューなしでマージ可）`: 次のすべてを満たすときだけ。
     1. 最終状態が `完了` で、確定した要対応の点数が `5`。
     2. 対応表のすべての行が、反証で「充足」「説明」「対象外」のどれかであるか、「自動チェック担当」で同じ head SHA のテスト実行が `成功` であるか、「受け入れ確認担当」で受け入れ確認担当が「確認済み」とした行である。
     3. 確認が残る事項が、対応表の内外を問わず0件。
     4. `record.md` の checkout の SHA が `target.md` の head の SHA と同じで、判定が `成功`。
   - `不可（人の判断が要る）`: それ以外のすべて。最終状態とその理由、確定した要対応の点数または点数なし、テスト実行の判定と SHA の一致、確認が残る事項（要求の出典・確かめる担当・理由）をすべて並べる。
   - 対応表の「自動チェック担当」の行は、マージ可否の判定でだけテスト実行の `成功` で満たしたことにする（点数の対象外という扱いは変えない）。テスト実行が `成功` でなければ、満たしていない理由として並べる。
   - 対応表の「未確認」の行は、テストの成功では消えない（確認が残る事項として残り、マージ可否は `不可`）。
   - `可` でも、リポジトリの既存のマージ条件（CI・必須のレビューなど）は省かない。

結果は固定した対象版と要求に対するものであり、別の commit の承認に使わない。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果として報告する。

## 9. 報告を作り、保存する

[報告の雛形](../assets/report.md) で `parent/report.md` を作る。管理情報は親が書き、反証担当の判定本文は `refute/verdict.md` を `cat` でそのまま入れる（`未実施`・`未完了` で判定本文が無ければ「未受領」と理由を書く）。
管理情報には「最終状態」「確定した要対応の点数」「確認が残る事項（要求の出典・確かめる担当・理由）」「マージ可否」を別項目として並べ、8節の結果と理由を書く。テスト実行による検証は `parent/tests/record.md` から書き、出力の原本は指紋と場所の参照だけにして本文を写さない。
モデル情報は各担当の引き渡し用ファイル・判定本文の申告と、ハーネスが示した情報だけを出典付きで書く。不明は未確認とし、実効モデルの証明として扱わない。

Issue がある場合は、最終状態にかかわらず報告を `kind=doc` の Document として Issue に添付し、作業ログに残す。

```sh
nod doc create <Issue IDの小文字>-code-review-<YYYYMMDD>-<runIdの先頭8文字>.md \
  --title "<Issue ID> コードレビュー結果（<runIdの先頭8文字>）" --kind doc --issue <Issue ID> --body - < "$W/parent/report.md"
nod doc show <Document ID>
awk '/^<!-- refute-verdict:begin -->$/{f=1;next} /^<!-- refute-verdict:end -->$/{f=0} f' <Document のパス> | shasum -a 256
```

- `nod doc show` で kind が doc であり Issue にリンクされたことを確かめる。収録した判定本文の sha256 が `refute/verdict.md` と一致することを確かめ、一致しなければ保存失敗として報告する。指紋は同一性の確認であり、改変を機械的に防ぐものではない。
- `完了`: `nod issue log <Issue ID> "<要約>" --kind progress` に、状態・確定した要対応の点数・要対応の要点・確認が残る事項の件数と要点（要求の出典・確かめる担当・理由）・テスト実行の判定・マージ可否・Document ID・runId・3担当の役割と ID を書く。
- `未実施`・`未完了`: `nod issue log <Issue ID> "<要約>" --kind blocker` に、独立レビューが未実施・未完了であること・原因（`未完了` なら有効な結果が無い担当）・受領済みの成果・取得できた担当 ID・点数なし・テスト実行の判定・マージ可否（`不可`）・Document ID・runId を書く。
- 担当の ID はこの作業ログでもレビューと対応付ける。ID が異なることだけで、会話を引き継いでいないことを証明したとは扱わない。
- Issue の無い単独レビューは、`parent/report.md` とチャットでの報告だけにする。
- 要求の写し・引き渡し用ファイル・メモ・反証の結果・テスト実行の記録（`parent/tests/` の `plan.md`・`record.md`・`setup.log`・`output.log`。checkout は3.4節で片付け済み）は作業ディレクトリに残す。

## 10. 後続

- 実装後レビューでは、報告と Document ID を呼出元の手順へ返して終える。単独レビューは報告で終える。
- `未実施`・`未完了`: Issue を Done にも In Review にもせず、PR も出さない（PR 不要の依頼でも Done に進めない）。自動の再委譲や探索担当の再開で代替しない。
- `完了` でマージ可否が `不可`: 確認が残る事項は、提出・完了に必要な確認の不足として扱い、合格・指摘なし・確認済みへ読み替えない。後続の判断は既存の提出・完了条件に委ねる。
- マージ可否が `不可（人の判断が要る）` なら、人の判断なしにマージへ進めない。`可` でもリポジトリの既存のマージ条件を省かず、このレビューからはマージしない。
- 次の判断が必要な場合だけ、具体的な選択肢を番号付きで示し、おすすめと理由を添える。
