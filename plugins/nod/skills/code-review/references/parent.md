# 親の手順

単独レビューでは利用者のセッションが、実装後レビューでは実装を進行する親エージェントが、この手順で親になる。
親は自分でレビューしない。対象と要求を固定し、レビュー担当エージェントへ委譲し、引き渡しを検査し、判定を変えずに状態・点数・報告を記録する。
あわせて、同じ head SHA に対する CI の結果を読んで記録し、レビューの最終状態・確定した要対応の点数・確認が残る事項と CI の結果から「マージ可否」を決め、Issue があれば判定を merge-ready ラベルで示す。テストと Lint は CI で担保し、親はテストを実行しない。CI の結果は親だけが扱い、レビュー担当へ渡さない。

## 0. 委譲先と前提

- 委譲先は役割別の4定義だけ: Standards 探索は `code-reviewer-standards`、Spec 探索は `code-reviewer-spec`、反証は `code-reviewer-refute`、受け入れ確認は `code-reviewer-acceptance`。受け入れ確認担当は、反証が確定した対応表に「受け入れ確認担当」の行が1行以上あるときだけ委譲する（8節）。
- これらが使えない（定義が見つからない、起動を許可されていないなど）場合も、旧 `code-reviewer` やバンドル済みの `reviewer` などで代用しない。
- レビュー担当エージェントへ委譲できない環境（委譲の仕組みが無いハーネスなど）では、親は自分でレビューせず、最終状態を `未実施`（理由: 委譲できない環境）として記録・報告する。
- 担当のモデルは設定側の責務であり、この手順では扱わない。モデル情報は担当の申告と出典を記録するだけで、停止条件にしない。
- 有効な結果が返らなかった役割は4.1節で扱う。判定の中身と関係しない無効は、その役割だけを同じ入力・新しいコンテキストで1回だけ委譲し直す。利用枠の上限による失敗は委譲し直さず、その時点で止める。別モデル・別アカウントへの切り替えや利用枠の回復待ちはしない。
- 全体期限や担当ごとの打ち切り期限は設けない。担当の実行時間はハーネスに任せる。
- 指摘は直さない。修正は別作業で行い、再レビューは新しい委譲で行う。このレビューから commit・push・PR 投稿・マージをしない。

## 1. 対象・基点・要求を特定する

- 依頼や実装工程から引き継いだ対象リポジトリ・基点・対象版・Issue・Document は聞き直さない。対象リポジトリまたは基点が依頼に無いときだけ利用者に確認する。
- PR を指定された場合は `gh` で実際のリポジトリ・基点・head を特定する。Issue をブランチ名から推測しない。
- コミットのレビュー（`mode: commit`）: `git -C <repo> rev-parse <head>` で head の SHA、`git -C <repo> merge-base <基点> <head>` で merge-base の SHA を固定する。
- 明示された未コミット変更のレビュー（`mode: local`）: 明示されたときだけ行い、commit や stash を作らない。土台の HEAD の SHA を固定し、merge-base は基点と土台の HEAD から求める。差分は表示用の変換を無効にして `git -C <repo> --no-optional-locks diff --binary --no-ext-diff --no-textconv HEAD` で写し、未追跡ファイルは指定されたものだけを写す。
- `mode: commit` では、head を固定した元を記録する。PR なら PR の URL、ブランチ名や `HEAD` などの ref から固定したなら `<repo>` とその ref、SHA だけで指定されたなら「ref なし」とし、2節で作業ディレクトリを作った後に親専用領域の `parent/head-source.md` に書く（担当へ渡す `target.md` には書かない）。10節の8と11節では、この元から対象の現在の head を取り直す。
- 本文を読む前に、変更されたパス（`mode: commit` は `git -C <repo> diff --no-ext-diff --no-textconv --name-only -z <merge-base> <head>` を NUL で区切って読み、日本語などを含むパスも引用符なしの名前で調べる。`mode: local` は土台の HEAD までのコミット済みの差分 `git -C <repo> diff --no-ext-diff --no-textconv --name-only <merge-base> <土台の HEAD>` と、未コミットの差分 `git -C <repo> --no-optional-locks diff --no-ext-diff --no-textconv --name-only HEAD` と、指定された未追跡パスの全部）に、秘密情報を含み得るファイルが無いことを確かめる。パスのどこかの要素が `.env`・`.env.*`・`.aws`・`id_rsa`・`id_ed25519`・`credentials`・`credentials.*`・`*.pem`・`*.key`（大文字小文字を区別しない）に当たれば、差分の本文を写さず、委譲も CI の照合もせず、`未実施`（理由: 秘密情報を含み得る <パス> が差分にあり、必要な範囲を利用者が確かめる必要がある）・点数なし・マージ可否 `不可（人の判断が要る）` として報告する。

```sh
git -C <repo> diff --no-ext-diff --no-textconv --name-only -z <merge-base> <head> | tr '\0' '\n' \
  | grep -iE '(^|/)(\.env(\.[^/]*)?|\.aws|id_(rsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key))(/|$)'   # 1行でも出れば秘密候補あり。-z で取り、日本語などを含むパスも引用符なしの名前で調べる
```
- 差分が空なら委譲も CI の照合もせず、`未実施`（理由: 差分なし）・点数なし・マージ可否 `不可（人の判断が要る）` として報告する。

## 2. 作業ディレクトリを作り、共通入力を固定する

実行ごとに一意な作業ディレクトリを作る。ディレクトリの分離は担当への指示の境界であり、アクセス遮断ではない。以下、依頼の対象リポジトリ（元のリポジトリ）を `<repo>`、担当用の限定 clone を `<W>/repo` と書く。担当には元のリポジトリを渡さない。

```sh
RUN=$(uuidgen | tr 'A-Z' 'a-z')
W="$HOME/.local/share/nod/code-reviews/$RUN"
mkdir -p "$W/input/requirements" "$W/standards/notes" "$W/spec/notes" "$W/refute-input" "$W/refute/notes" "$W/parent/deps"
# 受け入れ確認担当が必要になったときだけ、8節で "$W/acceptance-input/records" "$W/acceptance-input/evidence" "$W/acceptance/notes" を作る
```

| 場所 | 用途 | 書く人 | 読む人 |
|---|---|---|---|
| `repo/` | 担当用の限定 clone（全担当の対象リポジトリ） | 親 | 全担当 |
| `deps/` | 依存の写し（準備できたときだけ） | 親 | 全担当 |
| `input/` | 共通入力（全担当へ同じもの） | 親 | 両探索担当 |
| `standards/` | Standards 探索の `handoff.md` と `notes/` | Standards 探索担当 | 親（検査） |
| `spec/` | Spec 探索の `handoff.md` と `notes/` | Spec 探索担当 | 親（検査） |
| `refute-input/` | 反証への入力（検査済みの引き渡し用ファイルと共通入力の写し） | 親 | 反証担当 |
| `refute/` | 反証の `verdict.md` と `notes/` | 反証担当 | 親（検査と受け入れ確認への写し） |
| `acceptance-input/` | 受け入れ確認への入力（共通入力と反証の判定本文の写し、委譲前に写した Activity・添付 Document の原文 `records/`、それらが明示的に参照する記録と反証が名指しした外部の正本の写しと観測 `evidence/`、目録 `records.md`）。8節で必要なときだけ作る | 親 | 受け入れ確認担当 |
| `acceptance/` | 受け入れ確認の `result.md` と `notes/` | 受け入れ確認担当 | 親 |
| `parent/` | 親専用領域（取得結果、元のリポジトリのパスと限定 clone の確認の記録 `parent/clone.md`、head を固定した元 `parent/head-source.md` と現在の head の照合 `parent/head-check.md`、依存の準備の記録 `parent/deps/`、検査記録、指紋、担当の対応表、無効な試行の出力と記録 `parent/attempts/`・`parent/attempts.md`、受け入れ確認の写しの取得記録と CI の結果を除く前の元の写し `parent/acceptance/`、保存直前の受け入れ証拠の取り直し `parent/acceptance-recheck/`、CI の照合の記録 `parent/ci/<n>/`、CI の再照合での取り直し `parent/recheck-<n>/`、報告の原稿） | 親 | 親だけ |

### 2.1 担当用の限定 clone を作る

head（`mode: local` では土台の HEAD）とその祖先（merge-base を含む）の commit だけを持つ clone を `<W>/repo` に作り、全担当へ対象リポジトリとして渡す。他のブランチ・タグなどの ref、remote、元の object DB への参照（alternates など）、`FETCH_HEAD` のような元のリポジトリへの参照を持たせず、作業ツリーは空にする。

```sh
R="$W/repo"; H=<head の SHA（mode: local では土台の HEAD の SHA）>; MB=<merge-base の SHA>
git init -q "$R"
git -C "$R" -c gc.auto=0 -c maintenance.auto=false fetch -q --no-tags --no-write-fetch-head \
  --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' <repo> "$H"
git -C "$R" update-ref --no-deref HEAD "$H"   # ref を作らず、HEAD だけを head に向ける
```

作った後、次をすべて確かめ、コマンドと出力を元のリポジトリのパスと一緒に `parent/clone.md` に書く。

```sh
git -C "$R" for-each-ref                     # 何も出ない（ブランチ・タグなどの ref が無い）
git -C "$R" remote -v                        # 何も出ない（remote が無い）
test ! -e "$R/.git/objects/info/alternates" && test ! -e "$R/.git/FETCH_HEAD" && echo ok   # 元の object DB・fetch 元を参照しない
git -C "$R" rev-parse HEAD                   # $H と一致
git -C "$R" merge-base --is-ancestor "$MB" "$H" && echo ok   # merge-base を持ち、head の祖先である
echo "$(git -C "$R" rev-list --count --all) $(git -C "$R" rev-list --count "$H")"   # 2つが一致（head の祖先の commit だけ）
echo "$(git -C "$R" cat-file --batch-all-objects --batch-check='%(objectname)' | sort -u | wc -l) $(git -C "$R" rev-list --objects --all | cut -d' ' -f1 | sort -u | wc -l)"   # 2つが一致（head から辿れない object が無い）
git -C "$R" ls-files | wc -l                 # 0（index が空）
ls -A "$R"                                   # .git だけ（作業ツリーが空）
grep -rlF <repo> "$R/.git" --exclude-dir=objects   # 何も出ない（元のリポジトリのパスを持たない）
```

- `target.md` の対象リポジトリには、この clone の絶対パスを書く。元のリポジトリのパスは `parent/clone.md` にだけ書き、依頼本文・`input/`・`refute-input/` に入れない（`acceptance-input/` では、参照された記録の出典に元のリポジトリの作業ツリーのパスが出ることがある。8節）。
- clone を作れない、またはどれかの確認が通らない場合は、委譲も CI の照合もせず、`未実施`（理由: 担当用の限定 clone を作れない（<通らなかった確認>））・点数なし・マージ可否 `不可（人の判断が要る）` として報告する。確認が通らない clone を担当に渡さない。

### 2.2 依存の写しを準備する

担当が固定した依存のコードを外部へ取りに行かないよう、head（`mode: local` では土台の HEAD）の版の lockfile から依存パッケージの配布物を準備し、その写しを `<W>/deps/` に置く。

- 対象は、固定版のリポジトリのルートにある lockfile で、lockfile どおりに入れる指定とスクリプトを実行しない指定の両方を持つパッケージ管理のものだけとする（例: `bun.lock`・`bun.lockb` は `bun install --frozen-lockfile --ignore-scripts`、`package-lock.json` は `npm ci --ignore-scripts`、`pnpm-lock.yaml` は `pnpm install --frozen-lockfile --ignore-scripts`）。
- lockfile が無い、ルート以外にしか無い、どれを使うか固定版から決められない複数の lockfile がある、対応しないパッケージ管理である、準備の終了コードが 0 以外である場合は、`deps/` を置かず、その旨と理由を `manifest.md` に書く。担当はその依存の確認を未確認に残す。
- `mode: local` で未コミットの変更が lockfile やパッケージ定義を変えている場合も、写しは土台の HEAD の lockfile から作り、その旨を `manifest.md` に書く。

```sh
B="$W/parent/deps/build"; mkdir -p "$B"
git -C "$R" archive "$H" | tar -x -C "$B"                     # 固定版を限定 clone から展開する
git -C "$R" show "$H:<lockfile>" | shasum -a 256               # lockfile の sha256
(cd "$B" && <lockfile どおりに入れ、スクリプトを実行しないコマンド>) > "$W/parent/deps/setup.log" 2>&1; echo "deps exit=$?"
mkdir -p "$W/deps"
(cd "$B" && find . -type d -name node_modules -prune -print0 | tar --null -cf - -T -) | tar -xf - -C "$W/deps"   # 配布物（node_modules）だけを写す
(cd "$W/deps" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 \
  && find . -type l -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' l; do printf 'link %s -> %s\n' "$l" "$(readlink "$l")"; done) \
  > "$W/input/deps-files.sha256"                               # 写しの指紋の一覧（ファイルごとの sha256 とリンク先）
rm -rf "$B"
```

- 写しの中のリンクは、リンクのまま写す。写しの外を指すリンク（ワークスペースのパッケージなど）の中身は、担当が限定 clone の固定版で読む。
- `parent/deps/` には、準備のコマンド・終了コード・パッケージ管理とその版・取得元（使った registry の URL）・`setup.log` の sha256・展開した作業領域を片付けたことを書く。`setup.log` は担当に渡さない。

### 2.3 共通入力を写す

`input/` には次だけを置く。

- `target.md`: 対象リポジトリ（担当用の限定 clone `<W>/repo` の絶対パス。元のリポジトリのパスは書かない）、依存の写しの場所（`<W>/deps/`、または「依存の写しなし（理由は manifest.md）」）、基点の指定、merge-base の SHA、head の SHA、`mode: commit` または `mode: local`、Issue（ID またはなし）、計画の出典の扱い。`mode: local` では土台の HEAD の SHA、`local/changes.diff`、`local/untracked/<相対パス>` の一覧も書く。
- `local/`（`mode: local` のときだけ）: `changes.diff` と、指定された未追跡ファイルの写し `untracked/<相対パス>`。
- `deps-files.sha256`（依存の写しを準備できたときだけ）: 2.2節の指紋の一覧。
- `requirements/`: 要求の原文。丸ごと写し、選別・要約・書き換えをしない。
  - `issue.md`: Issue のタイトルと本文だけ。
  - `spec-<DocumentID>.md`: Issue に現在リンクされたすべての `kind=spec` の Document の本文。1件に絞らない。
  - `plan-<DocumentID>.md`: Issue の計画の出典（`plan.source`）が指す `kind=plan` の Document だけ。
  - `workspace-rules.md`: Git 管理外の Workspace の規約の原文（未登録ならその旨の出力）。
- `manifest.md`: `input/` の各ファイルの sha256 と出典（Issue ID と取得時刻、Document ID とパス、Workspace 規約、Git の SHA）、取得できなかった資料と理由、依存の写しの節（場所 `<W>/deps/`、lockfile のパス `<lockfile>@<head の SHA>` と sha256、パッケージ管理とその版、準備のコマンド（スクリプトを実行しない指定を含む）と終了コード、取得元、指紋の一覧 `deps-files.sha256` とそのファイル数。準備しなかった・できなかった場合はその旨と理由）。

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
- `nod issue show` の全出力、Activity（作業ログ・コメント）、実装の完了報告、過去のレビュー、自動チェックの結果、CI の結果と親の CI の照合の記録（`parent/ci/`）、依存の準備の記録（`parent/deps/`）、元のリポジトリのパス、計画の進捗状態は `input/` に入れない。Spec・計画に混ざった結果の節を要求から外す判断は担当に任せ、親は削らない。Activity と添付 Document の原文は、受け入れ確認担当が必要になったときだけ、8節で `acceptance-input/` へ別に写す（探索・反証の担当には渡さない）。

## 3. CI の結果を扱う（親だけ）

テストと Lint は CI で担保する。親はテスト・Lint・ビルドを実行せず、同じ head SHA に対する CI の結果を GitHub から読んで、マージ可否（10節の8）と merge-ready ラベル（11節・13節）にだけ使う。照合は10節の8の直前に1回だけ行う（13節の CI の再照合を除く）。

- 親は CI を実行・再実行せず、完了を待たない（polling しない）。照合した時点の結果で判定し、未確定なら不可として記録する。CI の完了後に判定し直すときは、13節の CI の再照合で行う。
- 実装者の作業ツリーや手元のテストログ、作業ログ・PR の本文などに書かれた CI の結果で代用しない。親が GitHub から読んだ結果だけを使う。
- CI の結果と照合の記録は `parent/ci/<n>/` にだけ置く。担当への依頼本文・共通の context・`input/`・`refute-input/`・`acceptance-input/` に入れず、担当の返答を待つ間に CI の状況や結果を担当へ送らない。受け入れ確認への写し（8節）を取り終えるまで、このレビューの CI の状況や結果を Issue の作業ログに書かない。写しの後に親が Issue へ書く記録（作業ログ・コメント・返信。CI の照合の記録に限らない）は、書いたときに `nod --json issue log`・`nod --json issue comment` が返した id をすべて `parent/acceptance/own-logs.md` に記録する（10節の3と13節の再照合で親自身の記録として止めない。記録していない項目は、親が書いたものでも親以外の追記として扱われる）。
- 親が Issue へ書く CI の結果（CI 判定・必須のチェックごとの結果、それを理由に含むマージ可否、merge-ready の操作とその理由）は、作業ログでは本文が `[ci-result]` で始まる `--kind test` の記録（11節・13節）だけに書く。`--kind progress`・`blocker` の要約には書かず、その記録を参照する。報告 Document では `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の印の間だけに書き、印の外には「CI の結果は印の中」とだけ書く（11節）。後のレビューの受け入れ確認への写し（8.1節）は、この印だけで CI の結果を除く。
- `mode: local` では照合しない。CI の結果は commit 済みの head に対するもので未コミット変更を含まず、変更込みの証拠に流用できないため、スクリプトを実行せず、`parent/ci/1/not-run.md` に CI 判定 `対象外（未コミット）` と理由だけを書く（提出用の CI の結果は commit と push の後に取る）。
- CI 判定で、レビューの最終状態・点数・反証の判定・要求ごとの対応表・受け入れ確認の結果・確認が残る事項を変えない。

### 3.1 必須のチェックを決める

必須のチェックは、次の3つの出典の和集合とする（どれか1つに絞らず、厳しい側に寄せる）。基点は GitHub のブランチ名で指す（PR なら `baseRefName`。`origin/` などの remote 名は外す）。

1. ブランチ保護: `gh api repos/{owner}/{repo}/branches/{基点}` の `.protection.required_status_checks`（`contexts[]` と `checks[{context, app_id}]`）。`/protection` のエンドポイントは管理者の権限が無いと 404 になるので使わない。
   - `protected` が false、または `required_status_checks` の `enforcement_level` が `off` なら、この出典は0件（読めた）とする。
   - `protected` が true なのに `protection.required_status_checks` が無い（権限などで見えない）、ブランチが 404、その他の gh の失敗は、この出典を決められないとする。
2. ルールセット: `gh api --paginate repos/{owner}/{repo}/rules/branches/{基点}` のうち、`type` が `required_status_checks` の規則の `parameters.required_status_checks[{context, integration_id}]`。取得に失敗したら、この出典を決められないとする。
3. Workspace の規約の「必須のチェック」の節: 規約（`nod workspace rules show` の出力。変更は人だけが行え、レビュー対象の差分からは変えられない）の見出し `必須のチェック`（見出しの深さは問わない）から次の見出しまでの箇条書き `- <チェック名>`（`*` も可。名前を囲むバッククォートは外す）。節が複数あれば合わせる。規約が未登録、または節が無ければ0件とする。

- 同じ context と app の指定の項目は1件にまとめ、出典を並べる。app の指定（`app_id`・`integration_id`）がある項目は、その app の check run だけで満たす。
- どれかの出典を決められなければ、CI 判定を `必須のチェックを決められず` とする。すべての出典を読めて和集合が0件なら `必須のチェックなし`（CI が無い場合を含む）とする。どちらもマージ可否を不可にする。
- 基点をブランチ名に解決できない（SHA だけで指定されたなど）ときは、スクリプトを実行せず、`parent/ci/<n>/not-run.md` に CI 判定 `必須のチェックを決められず` と理由を書く。
- 親は必須のチェックを足したり外したりしない。対応表の「自動チェック担当」の行や、差分で変えられるリポジトリの文書（`AGENTS.md`・`README.md` など）から必須のチェックを推測しない。

### 3.2 同じ head SHA の CI の結果を判定する

- head（`target.md` の head の SHA）が GitHub に無い（`gh api repos/{owner}/{repo}/commits/{head}` が失敗する、または返った `.sha` が head と違う。push 前など）なら、CI 判定を `結果なし` とする。
- check run は `gh api --paginate "repos/{owner}/{repo}/commits/{head}/check-runs?per_page=100"`（既定の最新のものだけ）、commit status は `gh api --paginate "repos/{owner}/{repo}/commits/{head}/status?per_page=100"`（context ごとの最新）で読む。`head_sha` が head と違う check run は使わない。
- 必須のチェック1件ごとに、名前が context と同じ check run（app の指定があればその app のものだけ）と、app の指定が無いときだけ context が同じ commit status を候補にし、次で結果を決める。

| 必須のチェックの結果 | 条件 |
|---|---|
| `失敗` | 候補のどれかが完了して `success` 以外（check run の結論の `failure`・`cancelled`・`timed_out`・`action_required`・`neutral`・`skipped`・`stale`・`startup_failure`、commit status の `failure`・`error`）。結論を記録する。`neutral`・`skipped` も成功にしない |
| `未確定` | `失敗` が無く、候補のどれかが完了していない（check run の status が `completed` 以外、commit status の state が `pending`） |
| `成功` | 候補がすべて `success` |
| `結果なし` | 候補が無い |

CI 判定は、必須のチェックが1件以上あり、すべてが `成功` のときだけ `成功` とする。それ以外は次の優先順で1つに決める: `必須のチェックを決められず` > `必須のチェックなし` > `取得できず`（check run・commit status の取得の失敗） > `結果なし`（head が GitHub に無い） > `失敗` > `未確定` > `結果なし`（結果の無い必須のチェックがある）。`対象外（未コミット）`（`mode: local`）を含め、`成功` 以外はどれもマージ可否を不可にする。

### 3.3 スクリプトで照合し、記録する

照合は、このスキルの `scripts/ci-checks.ts` で行う。スクリプトは3.1節・3.2節のとおりに GitHub を読むだけで、CI を実行・再実行せず、GitHub へ書き込まない。

```sh
# スクリプトはこのスキルのディレクトリ（SKILL.md があるディレクトリ。Claude Code では「Base directory for this skill」として示される）から解決する。リポジトリの作業ディレクトリの plugins/ を使わない
C="$W/parent/ci/<n>"   # 10節では 1、13節の再照合では次の番号。存在しないか空のディレクトリにする
bun <スキルのディレクトリ>/scripts/ci-checks.ts --repo <元のリポジトリの絶対パス> --base <基点の GitHub ブランチ名> \
  --head <target.md の head の40桁の SHA> --rules <取り直した Workspace の規約のファイルの絶対パス> --out "$C"; echo "ci-checks exit=$?"
(cd "$C" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256)   # 記録の各ファイルの sha256
```

- `--repo` は gh が GitHub のリポジトリを決めるための元のリポジトリで、担当用の限定 clone ではない。`--rules` は10節の2で取り直した `parent/requirements-recheck/workspace-rules.md`（13節では `parent/recheck-<n>/requirements/workspace-rules.md`）とする。
- 結果は標準出力の1行の JSON と、同じ内容の `parent/ci/<n>/result.json` に出る。`verdict` が CI 判定、`required` が必須のチェックごとの出典（`sources`）・結果（`result`）・使った check run と commit status（`runs` の URL・結論・完了時刻）、`sources` が3つの出典ごとの読めた／0件／決められず と理由、`observedAt` が観測時刻、`reason` が `成功` 以外の理由、`files` が gh の生の応答（`repo.json`・`branch.json`・`rules.json`・`commit.json`・`check-runs.ndjson`・`statuses.ndjson`。取得できたものだけ）の sha256 である。gh の失敗は `errors.txt` に残る。
- 終了コード 0 は判定した（CI 判定が `成功` でなくても 0）。2 は引数の誤り（相対パス、40桁の SHA でない、`--out` が空でない、`--rules` を読めないなど）で、判定ではない。呼び出しを直し、存在しないか空の出力ディレクトリで実行し直す。それ以外の終了コード、または `result.json` を読めない場合は、CI 判定を `取得できず` とし、終了コードと出力を `parent/ci/<n>/` に残す。
- `result.json` の `head` が `target.md` の head の SHA と同じであることを確かめる。違えば CI 判定を `成功` として扱わない。
- 報告には、CI 判定・必須のチェックと出典・必須のチェックごとの結果と URL・head SHA の一致・観測時刻・記録の場所と sha256 を書く（11節）。gh の生の応答は本文を写さず、指紋と場所の参照だけにする。

## 4. 両探索を並列に委譲する

Standards 探索担当と Spec 探索担当を、それぞれ新しいコンテキストで、1回の委譲で同時に起動する。依頼本文は次の最小限だけにする。

```text
役割: Standards 探索
作業ディレクトリ: <W の絶対パス>
読んでよい入力: <W>/input/ 配下（target.md・manifest.md・deps-files.sha256・requirements/・local/）、対象リポジトリ <W>/repo（target.md の担当用の限定 clone）、依存の写し <W>/deps/（準備できたときだけ）
書いてよい場所: <W>/standards/（handoff.md と notes/）と自分の一時ファイル
出力: <W>/standards/handoff.md
```

Spec 探索は `役割: Spec 探索`、書いてよい場所を `<W>/spec/`、出力を `<W>/spec/handoff.md` に置き換える。
共通の context を持つハーネスでは、それを空にする。空にできない場合は「指定された役割・入力・出力だけを使う独立レビュー。自動チェックは実行しない。」のような固定の1文だけにする。要求の要約、親の見立て、実装者の自己評価、作業ログ、探索の返答、CI の状況・結果を入れない。

担当が実行中でまだ返っていない間は、待機中として状況を報告するだけにする。経過時間だけで失敗と判定せず、ハーネスの終了・失敗・取り消しの通知を使う。ハーネスが実行中のままで応答しない場合はその状態を利用者へ報告し、停止を確認できないときは停止済みと報告しない。

ハーネスが返した各担当の ID を `parent/agents.md` に役割・定義名・試行の番号（最初の試行は 1、4.1節の再委譲は 2）と対応付けて記録する。

### 4.1 有効な結果が無い役割の扱い（全役割に共通）

どの役割の担当でも、有効な結果が返らなかったときはこの節で扱う。有効かどうかは5節（探索）・7節（反証）・9節（受け入れ確認）の検査で決める。理由と不足箇所（未確認なら確かめる担当も）を示した未確認と、不足理由を示した受け入れ確認の「確かめられず」は有効な結果であり、不都合な指摘・判定・点数と同じく、委譲し直す理由にしない。親は判定の中身を見て委譲し直すかを決めない。

1. 失敗の種類を、ハーネスの終了通知・担当の返答・エラーの文言・検査の結果など観測できるものだけで決める。
   - **利用枠の上限**: HTTP 429、プロバイダの利用枠・rate limit の上限を示すエラー（`rate_limit_error`・`usage_limit_reached`・usage limit など）、またはプロバイダの待ち要求が retry の上限を超えた旨（omp では `Provider requested <N>ms wait, exceeds retry.maxDelayMs`）が出ている。
   - **利用者による中止**: 利用者が担当またはレビューを止めた。
   - **判定と無関係な無効**: 上の2つ以外のすべて。SKILL.md 2節の禁止規則への違反などの境界違反、引き渡し形式違反（出力ファイルが無い、必須項目の欠落、禁止項目の混入、担当行の欠落）、指定と異なる SHA・要求版の参照、入力不備（役割指定の不備・不一致）、担当の終了・失敗（認証などの実行失敗を含む）。利用枠の上限の印が無い失敗は、原因が利用枠かもしれなくてもここに入れる（観測できない原因を利用枠と推測して止めない）。
2. 判定と無関係な無効は、その役割だけを1回だけ委譲し直す。
   1. 記録する: `parent/attempts.md` に、役割・定義名・試行の番号・担当 ID・無効の理由（検査の番号と違反の箇所、または終了通知の状態とエラーの文言）・omp 内部の再試行を書く。omp 内部の再試行は、担当のセッションの中でハーネスが行った retry（終了通知や担当のセッション記録に出る retry の回数・待ち・エラーの文言。同じプロバイダの別の認証情報への切り替えを含む）であり、親による再委譲とは分けて書く。分からなければ「記録なし」と書く。
   2. 隔離する: 最初の試行のサブディレクトリ（`standards/`・`spec/`・`refute/`・`acceptance/`）を中身ごと `parent/attempts/<役割>-1/` へ移し（`mkdir -p "$W/parent/attempts" && mv "$W/standards" "$W/parent/attempts/standards-1"` など）、同じ名前の空のサブディレクトリと `notes/` を作り直す。移したファイルの sha256 を `parent/attempts.md` に書く。担当は `parent/` を読まない（SKILL.md 2節）ので、委譲し直した担当も後続の担当も最初の試行の出力を読まない。最初の試行の結果は後続の担当（反証・受け入れ確認など）へ渡さない。
   3. 同じ入力を確かめる: `input/` の各ファイルの sha256 が `manifest.md` と一致し、依存の写しの指紋の一覧を2.2節と同じ方法で作り直して `input/deps-files.sha256` と一致し、限定 clone の確認（2.1節）をやり直して `parent/clone.md` と同じ結果になることを確かめる（反証では `refute-input/` の各ファイルの sha256 も `parent/fingerprints.md` と比べ、受け入れ確認では `acceptance-input/` の各ファイルの sha256 を `parent/acceptance/fingerprints.md` と比べる。受け入れ確認の写しは取り直さない）。結果を `parent/attempts.md` に書く。一致しなければ同じ入力を渡せないので委譲し直さず、`未完了`（理由: 有効な結果なし（<役割>。同じ入力を固定できず委譲し直さなかった））とする。
   4. 委譲し直す: 同じ定義へ、最初の試行と一字も違わない依頼本文（4節・6節・8節）と同じ共通の context で、新しいタスクとして新しいコンテキストで起動する。最初の担当への追送や再開は使わない。依頼本文・context に、最初の試行があったこと・無効の理由・その出力を入れない。モデルやアカウントを指定・変更しない。担当 ID を試行の番号 2 として `parent/agents.md` に書く。
   5. 検査する: 委譲し直した担当の結果を、最初と同じ検査（5節・7節・9節）にかける。有効ならその結果を使う。無効なら、それ以上委譲し直さず、その試行も同じく `parent/attempts/<役割>-2/` へ移して記録し、`未完了`（理由: 有効な結果なし（<役割>。1回の再委譲の後も））とする。委譲し直した担当が利用枠の上限で失敗した場合は、3と同じく理由を利用枠の上限にする。
   - 委譲し直すのは役割ごとに1回だけ。最初の試行と委譲し直した結果を比べて選ばない。無効な出力を、修正の依頼・担当の再開・親の補筆で有効にしない。
   - 探索の片方だけが無効なら、その役割だけを委譲し直し、有効だった役割の結果はそのまま使う。両方が無効なら、両方を同じ手順で同時に委譲し直す。他方の探索の終了を待たずに委譲し直してよい。両探索の有効な結果がそろうまで反証を起動しない。
3. 利用枠の上限による失敗は、委譲し直さず、その時点で止める。最終状態は `未完了`（理由: 利用枠の上限、有効な結果なし（<役割>））とする。
   - それ以後はどの役割も委譲し直さず、まだ起動していない担当（反証・受け入れ確認など）を起動しない。並列で実行中の担当は打ち切らずに終了を待ち、受領済みの成果として記録する（有効でも反証は起動しない）。
   - 別アカウントへの切り替え、利用枠の回復待ち、利用枠のリセットの使用、別モデルへの切り替えをしない。
   - 最初の試行のサブディレクトリを2の2と同じく `parent/attempts/<役割>-1/` へ移し、終了通知とエラーの文言をそこに保存して、2の1と同じく `parent/attempts.md` に書く。
4. 利用者による中止は委譲し直さず、`未完了`（理由: 利用者による中止）とする。

## 5. 探索の引き渡し用ファイルを検査する

親は引き渡し用ファイルを書き換えない（補筆・削除・要約・整形をしない）。次だけを確かめ、結果と各ファイルの sha256 を `parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。
2. 指定したパスに `handoff.md` がある。
3. 役割・定義名・対象版・要求資料・依存の写しが書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。終了状態、未確認と理由、判断を見送った事項の節がある（無いことを明示していてもよい）。
4. 各候補に必須項目（SKILL.md の4節）がそろい、候補 ID が役割の接頭辞を持ち重複しない。証拠を取得できなかった候補には理由と不足箇所がある。
5. Standards 探索: 規約の一覧と今回の差分への適用判断、候補一覧または「候補0件」の明示、探索上の不足・判断を見送った事項がある。
6. Spec 探索: 要求ごとの対応表が雛形の4列（要求の出典・状態・証拠または不足理由・候補ID）で、`requirements/` のすべてのファイルを出典に含み、状態が SKILL.md の語彙だけを使う（「受け入れ確認担当」は反証だけが付ける状態だが、Spec 探索が書いていても形式違反にしない。反証が確かめ直して確定する）。未充足・未確認の行に候補 ID があり、その ID が候補一覧にある。列の確認は雛形の見出しと各行の「出典・状態・候補ID」の位置で行い、セル内のコードや文字列に含まれる `|` だけを理由に列数違反としない（Markdown の表示上で列が崩れていても、出典・状態・候補ID が読み取れれば形式違反にしない）。
7. 禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が項目名にも本文にも無い。項目名だけの検査では内容の混入まで保証できないので、本文も読んで確かめる。
8. `input/` の各ファイルの sha256 が `manifest.md` と一致する（担当が共通入力を変えていない）。依存の写しの指紋の一覧を2.2節と同じ方法で作り直して `input/deps-files.sha256` と一致し（担当が写しを変えていない）、限定 clone の確認（2.1節）をやり直して委譲前の `parent/clone.md` と同じ結果になる。

全確認単位を覆っているかの意味上の判断は反証担当が行う。親の検査は形式と参照の確認であり、内容の正しさの保証ではない。
どちらかの担当に違反・欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外はその役割だけを1回だけ委譲し直して同じ検査をする）。両探索の有効な結果がそろうまで反証を起動しない。4.1節の後もどちらかの有効な結果が無ければ、反証を起動せず、最終状態を `未完了` とする（10節へ進む）。

## 6. 反証への入力を写し、反証を委譲する

両探索の検査を通過したときだけ、検査済みの引き渡し用ファイルと共通入力を、内容を変えずに `refute-input/` へ写す。4.1節で委譲し直した役割は、委譲し直した担当の引き渡し用ファイル（同じ場所にある）を写す。

```sh
cp "$W/standards/handoff.md" "$W/refute-input/standards-handoff.md"
cp "$W/spec/handoff.md" "$W/refute-input/spec-handoff.md"
cp -R "$W/input/target.md" "$W/input/manifest.md" "$W/input/requirements" "$W/refute-input/"
[ -d "$W/input/local" ] && cp -R "$W/input/local" "$W/refute-input/"
[ -f "$W/input/deps-files.sha256" ] && cp "$W/input/deps-files.sha256" "$W/refute-input/"
(cd "$W/refute-input" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256)
```

写した各ファイルの sha256 が、検査時に記録した引き渡し用ファイルの指紋と `input/` の指紋に一致することを確かめ、`parent/fingerprints.md` に書く。一致しなければ写し直さず、反証を起動せずに `未完了`（理由: 反証への入力を固定できず、反証の有効な結果なし）とする。
探索のサブディレクトリ全体、`notes/`、一時ファイル、探索の返答・会話出力、`parent/attempts/` の無効な試行、親の要約は写さない。

反証担当は、新しいタスクとして新しいコンテキストで1体だけ起動する（無効なら4.1節で、新しい1体へ1回だけ委譲し直す）。探索担当への追送や再開は使わない。探索の候補が0件でも、必要な確認の不足や判断の見送りを確かめさせるため省かない。依頼本文は次だけにする（作業ディレクトリのこれ以外の場所を示さない）。依存の写しは `refute-input/` へ写さず、両探索と同じ `<W>/deps/` を渡す。

```text
役割: 反証
読んでよい入力（次のファイルだけ）:
- <W>/refute-input/standards-handoff.md
- <W>/refute-input/spec-handoff.md
- <W>/refute-input/target.md
- <W>/refute-input/manifest.md
- <W>/refute-input/requirements/<各ファイル>
- <W>/refute-input/local/<各ファイル>（mode: local のときだけ）
- <W>/refute-input/deps-files.sha256（依存の写しを準備できたときだけ）
- 対象リポジトリ <W>/repo（target.md の担当用の限定 clone）
- 依存の写し <W>/deps/（準備できたときだけ）
書いてよい場所: <W>/refute/（verdict.md と notes/）と自分の一時ファイル
出力: <W>/refute/verdict.md
```

共通の context は4節と同じく空か固定の1文だけにする。待機と ID の記録は4節と同じ。

## 7. 反証の結果を検査する

`verdict.md` を書き換えずに次を確かめ、`parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。指定したパスに `verdict.md` がある。
2. 役割・定義名・対象版・受け取った入力・依存の写しが書かれ、対象版が `target.md` と一致する。
3. 両方の引き渡し用ファイルのすべての候補 ID が採否一覧にあり、判定と根拠がある。要対応には影響度 0〜4 がある。
4. 要求ごとの対応表が雛形の4列で、Spec 探索の対応表のすべての行を確定している（列の確認は5節の6と同じく、セル内の `|` だけを理由に違反としない）。
5. 反証で追加した発見（無ければ無いことの明示）、軸ごとの要対応と未確認の件数、未確認と理由、判断を見送った事項がある。未確認ごとに、理由と確かめる担当がある。
6. 受け入れ確認担当の行の節がある（行が無ければ「なし」の明示）。対応表で状態が「受け入れ確認担当」の行がすべてこの節に同じ要求の出典であり、各行に確かめること（成果物・作業・手順・配置）と必要な外部の正本（要らなければ「なし」）がある。この節にあって対応表に無い行が無い。
7. `refute-input/` の各ファイルの sha256 が `parent/fingerprints.md` と一致する。依存の写しの指紋の一覧と限定 clone の確認を5節の8と同じくやり直し、委譲前と同じ結果になる。

欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は反証だけを1回だけ委譲し直して同じ検査をする。探索の結果はそのまま使う）。4.1節の後も有効な結果が無ければ、受け入れ確認担当を起動せず `未完了` とする（10節へ進む）。理由と確かめる担当を示した未確認は有効な結果であり、それだけでは `未完了` にせず、委譲し直す理由にもしない。
反証の有効な結果を受け取ったら8節へ進む。

## 8. 受け入れ確認への入力を写し、受け入れ確認を委譲する

検査を通過した `refute/verdict.md` の「要求ごとの対応表（確定）」で、状態が「受け入れ確認担当」の行を数え、件数と各行の要求の出典を `parent/acceptance/rows.md` に書く（`mkdir -p "$W/parent/acceptance"`）。

- 0行なら受け入れ確認担当を起動せず、`acceptance-input/` も作らない。報告に「受け入れ確認担当の行なし（起動せず）」と書いて10節へ進む。
- 1行以上なら、受け入れ確認担当は必要な担当である。起動し忘れたまま10節へ進んで `完了` にしない。委譲できない・有効な結果が返らない場合は4.1節で扱い、有効な結果が無ければ `未完了` とする。

### 8.1 写しを取る

委譲の直前に、親が次だけを `acceptance-input/` へ写す。親は中身を選別・要約・抜粋・改変しない（下の CI の結果の印による除外だけを例外とする）。探索の引き渡し用ファイル、反証の `notes/`、担当の返答、`parent/` の記録（CI の照合の記録 `parent/ci/`、依存の準備の記録 `parent/deps/`、無効な試行 `parent/attempts/` を含む）は写さない。

```sh
A="$W/acceptance-input"; P="$W/parent/acceptance"
mkdir -p "$A/records/documents" "$A/evidence" "$W/acceptance/notes"
cp -R "$W/input/target.md" "$W/input/manifest.md" "$W/input/requirements" "$A/"
[ -d "$W/input/local" ] && cp -R "$W/input/local" "$A/"
[ -f "$W/input/deps-files.sha256" ] && cp "$W/input/deps-files.sha256" "$A/"
cp "$W/refute/verdict.md" "$A/refute-verdict.md"                       # 反証の判定本文を丸ごと（該当行だけを抜き出さない）
date -u +%Y-%m-%dT%H:%M:%SZ                                             # Activity と Document の取得時刻
nod --json issue show <Issue ID> > "$P/issue-snapshot.json"
mkdir -p "$P/documents"
jq '.activity' "$P/issue-snapshot.json" > "$P/activity.json"             # Activity の全件の元の写し（作業ログ・コメント・イベント。親専用）
jq '[.[] | select(.kind == "comment" and (.body | startswith("[ci-result]")) | not)]' "$P/activity.json" > "$A/records/activity.json"   # 本文が [ci-result] で始まる作業ログ・コメントを返信ごと除いた写し
jq -r '.[] | select(.kind == "comment" and (.body | startswith("[ci-result]"))) | .id' "$P/activity.json"   # 除いた項目の id（records.md に書く）
jq -r '.documents[] | .id' "$P/issue-snapshot.json"                       # 各 ID を nod --json doc show <ID> の .content で "$P/documents/document-<ID>.md"（元の写し）へ写し、次の awk で records/documents/document-<ID>.md へ写す（kind を問わず全件）
awk '/^<!-- ci-result:begin -->$/{print; print "（CI の結果は親だけが扱うため除いた）"; f=1; next} /^<!-- ci-result:end -->$/{f=0} !f' "$P/documents/document-<ID>.md" > "$A/records/documents/document-<ID>.md"   # ci-result の印の間だけを置き換える
```

- 写しの元は、委譲の直前に取った Activity と、Issue に現在リンクされたすべての Document（kind を問わない）の本文とする。取得時刻・Document ID・kind・パスを記録する。
- CI の結果（3節）は印だけで除く。除くのは、本文が `[ci-result]` で始まる Activity の作業ログ・コメント（その返信を含む）と、Document の `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の印の間（「（CI の結果は親だけが扱うため除いた）」に置き換える）だけとする。親は本文の意味で選別しない。印の無い記録に CI の結果が混ざっていても親は除かず、担当が SKILL.md 2節のとおり使わずに混入として報告する。`evidence/` に写す参照された記録には、この除外をしない。
- 除く前の元の写し（`parent/acceptance/activity.json`・`parent/acceptance/documents/`）は親専用領域に残す。10節の3と13節の再照合は元の写しと比べ、除いた項目も親自身の記録かどうか（own-logs）の扱いを変えない。
- Issue の無い単独レビューでは Activity と Document を写さず、利用者が証拠として明示したファイル・Document だけを、下の参照された記録と同じ条件で `evidence/` に写す。明示が無ければ `records.md` に「Issue なし、明示された証拠なし」と書く。反証が名指しした外部の正本は、Issue の有無にかかわらず下のとおり写す。
- `evidence/` に写すのは次の2種類だけとする。証拠の要否や関連を親が判断して選ばない。親が自分で正本や証拠を探したり、作ったりしない。
  - 参照された記録: `records/` に写した Activity の本文と Document の本文が明示的に参照する成果物・実行記録・配置先（パス・URL・Document ID・Git のリポジトリと revision）。
  - 名指しされた外部の正本: 検査を通過した反証の判定本文の「受け入れ確認担当の行」の節の「必要な外部の正本」の欄に書かれた出典と版（版履歴の出典が書かれていれば、それも1件として扱う）。出典の場所（パス・URL・Document ID・Git のリポジトリ）が書かれていなければ、取得不能（出典の場所が名指しされていない）とし、場所を探さない。
- 1件ごとに `evidence/<n>/` を作り、出典の形に応じて次の表のどれか1つの読み取りだけで写す。表のどれにも当たらない、または読み取りが失敗した場合は、写しを作らずに取得不能と理由を記録する。

| 出典の形 | 読み取り（これだけ） | 識別情報として記録するもの |
|---|---|---|
| 絶対パス（`~` で始まるものを含む）の通常のファイル | このスキルの `scripts/copy-evidence.ts` で、本文を開く前にパスの名前と各要素の種類・大きさを検査し、通ればそのファイル1つを `evidence/<n>/copy` へ写し、観測を `evidence/<n>/observation.txt` に書く（下のコマンド） | `observation.txt` の sha256（結果の `observationSha256`） |
| Git のリポジトリのパスと revision（とファイル）、またはその版履歴 | `git -C <dir> rev-parse --verify '<revision>^{commit}'` で commit を固定し（revision の指定が無ければ取得時の `HEAD`）、ファイルは `git -C <dir> --no-pager show --no-textconv <commit>:<file>` を `evidence/<n>/<file の名前>` へ、版履歴は `git -C <dir> --no-pager log --no-ext-diff --no-textconv --format='%H%x09%cI%x09%aI%x09%s' <commit> -- <file>` を `evidence/<n>/history.txt` へ写す。`fetch`・`checkout` など Git の状態を変える操作と、作業ツリーを読む操作（`status`・`diff`）はしない | 固定した commit の SHA、名前で指した revision（ブランチ・タグ）とそれが指す commit |
| Issue にリンクされていない Document の ID | `nod --json doc show <ID>` の `.content` を `evidence/<n>/document-<ID>.md` へ写す | 本文の sha256 |
| `https://` の URL | 認証情報・cookie・設定ファイルを使わない GET を1回だけ行う: `curl -q -fsS --proto '=https' --proto-redir '=https' --max-redirs 5 --max-time 60 --max-filesize 20000000 -D "$D/headers.txt" -o "$D/body" -w '%{http_code} %{url_effective}\n' '<URL>'` | 応答の状態と最終の URL、本文の sha256（`ETag`・`Last-Modified` があれば写す） |

```sh
# スクリプトはこのスキルのディレクトリ（SKILL.md があるディレクトリ。Claude Code では「Base directory for this skill」として示される）から解決する。リポジトリの作業ディレクトリの plugins/ を使わない
bun <スキルのディレクトリ>/scripts/copy-evidence.ts '<出典の絶対パス>' "$A/evidence/<n>" > "$P/evidence-<n>.json"   # ~ で始まる出典はスクリプトがホームへ展開する。終了コードと結果の JSON を records.md に写す
```

- 写すのは、明示的に参照された通常のファイル1つだけとする。リンクは辿らず、ディレクトリの配下も写さない。スクリプトは本文を開く前に、まず名前だけで、SKILL.md 2節の秘密候補の名前（パスのどこかの要素が当たるもの）、`.`・`..`・空の要素（`//`・末尾の `/`）を含むパス（書かれたパスと読むパスがずれ得る）、レビューの作業ディレクトリ（`~/.local/share/nod/code-reviews/` の配下。過去のレビューと、このレビューの `<W>` とその親専用領域 `<W>/parent/` を含む）と常設データセット（`~/.local/share/nod/review-evaluation/` の配下）を調べる。この2つの領域は大文字小文字を区別せずに比べる。続けてルートから出典までの各要素を `lstat` だけで調べ、どれかの要素がシンボリックリンク、出典がディレクトリか通常のファイル以外（FIFO・デバイス・ソケット）、大きさが上限の 20000000 バイト（URL の行の `--max-filesize` と同じ）を超える、のどれかなら本文を読まない。読むときは最後の要素のリンクを開かない指定で開き、検査したファイルと同じであることを確かめてから読み、読んだ後に各要素がリンクに変わっていない・置き換わっていないことを確かめ直す。
- 終了コード 0 は写した。1 は取得不能で、写し先に何も作らない（写しも観測も無い）。理由は結果の `code` と `message`: `SECRET_CANDIDATE`（秘密候補。`secrets` に出典と当たったパス）、`NON_CANONICAL_PATH`（`.`・`..`・空の要素を含む）、`FORBIDDEN_AREA`（レビューの作業ディレクトリ・親専用領域・常設データセットの配下）、`SYMLINK_IN_PATH`（パスのどこかの要素がシンボリックリンク。検査の後や読む間にリンクへ変わったものを含む）、`NOT_REGULAR_FILE`（ディレクトリ、または FIFO・デバイス・ソケットなどの通常のファイル以外。どちらかは `message` に書く）、`TOO_LARGE`（上限サイズを超える）、`NOT_FOUND`（存在しない）、`READ_FAILED`（権限などの読み取りの失敗、検査の後や読む間に別のファイルへ置き換わった）、`UNEXPECTED_ERROR`（写しの途中の失敗。作りかけの写しは消す）。2 は引数の誤り（相対パス、写し先に既に写しがあるなど）で、取得不能ではなく呼び出しを直す。
- 観測は `file<TAB><出典のパス><TAB><バイト数><TAB><sha256>` の1行とする（写しは `evidence/<n>/copy` のファイル1つ）。
- 取得不能になった絶対パスを、親は別の方法（リンク先やディレクトリの中のファイルを親が選んで写す、リンクを辿るなど）で取り直さない。その証拠に依存する行は受け入れ確認担当が「確かめられず」とし、確認が残る事項に入るので、マージ可にならない（10節）。
- 取得不能とするもの（写さない）: 秘密情報を含み得るパス（SKILL.md 2節の名前。絶対パスは、パスのどこかの要素が当たるもので、写す前にスクリプトが確かめる）と、利用者情報（`user:pass@`）や名前に `token`・`key`・`secret`・`password`・`signature`・`sig`・`credential`・`X-Amz-` を含むクエリを持つ URL（秘密候補）、絶対パスのうちパスのどこかにシンボリックリンクを含むもの・ディレクトリ・通常のファイル以外・上限サイズを超えるもの・`.` や `..` や空の要素を含むもの、過去のレビューの作業ディレクトリ・このレビューの作業ディレクトリ `<W>`（親専用領域 `<W>/parent/` を含む。担当へ渡さない）・常設データセット（`~/.local/share/nod/review-evaluation/`）の配下、存在しないもの、`https://` 以外の URL・別のホスト（`ssh` など）・認証が要るもの（HTTP 401・403・407 など）・表の外のコマンドやスクリプトの実行が要るもの（読み取り手段が無い）、名指しの Git の revision が無いもの（名指しの版との対応を示せない）。
- リポジトリ内の相対パスと対象リポジトリの commit の SHA: 写さない。担当が限定 clone の固定版で読む（`records.md` にそう書く）。
- 親は表の読み取りのほかに、任意のスクリプトの実行、対象コードの再現、デプロイ、書き込み、認証情報の引き渡しをしない。既存の実行記録を写して読むことは、要実行確認の解消にも、3節の CI の結果の代わりにもならない。名指し・参照された版と写しの対応を親は判断しない。Git の revision を commit に固定できたとき以外は「親は確かめていない（出典の場所が示すのは取得時刻の内容）」と記録し、判断は担当に任せる。
- `records.md`（目録）に次を書く。10節で同じ方法で取り直すので、取り直しに要る情報を省かない。
  - `acceptance-input/` の各ファイル（`records.md` を除く）の sha256 と出典（共通入力は `manifest.md` と同じ出典、反証の判定本文は `refute/verdict.md` と担当 ID、Activity は Issue ID と取得時刻、Document は ID・kind・パス・取得時刻）。
  - 証拠の項目 ID: Activity のコメントは `activity:<コメントの id>`（コメント以外の項目は `activity@<時刻>`）、Issue にリンクされた Document は `document:<ID>`、`evidence/` の写しは `evidence/<n>`。Activity のコメントと Document には本文の sha256 を書く（Document は、印の間を置き換えた写しと元の写しの両方）。
  - CI の結果の除外: 除いた Activity の項目 ID とその本文の sha256、印の間を置き換えた Document の ID と元の本文の sha256。除いたものが無ければ「なし」。
  - `evidence/<n>` ごとに、種類（参照された記録／外部の正本）・参照元（Activity の項目 ID と時刻、Document ID と行、または反証の判定本文の「受け入れ確認担当の行」の要求の出典）・参照や名指しの原文・出典・名指しや参照元の版（原文のまま。無ければ「記載なし」）・読み取りの方法（表の行と実際のコマンド）・識別情報・取得時刻・写し先と sha256・版の対応について親が示せたこと、または取得不能と理由（絶対パスはスクリプトの `code` と `message`。秘密候補なら当たったパス（`secrets` の出典と当たったパス）を書く。本文は写さない）。

```sh
(cd "$A" && find . -type f ! -path ./records.md -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256)   # records.md に書く指紋
(cd "$A" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) > "$P/fingerprints.md"   # 委譲前の指紋（records.md を含む）
```

写した共通入力の sha256 が `input/` の指紋と、`refute-verdict.md` の sha256 が検査時の `refute/verdict.md` の指紋と一致することを確かめ、`parent/acceptance/fingerprints.md` に書き添える。一致しなければ写し直さず、受け入れ確認担当を起動せずに `未完了`（理由: 受け入れ確認への入力を固定できず、受け入れ確認の有効な結果なし）とする。

### 8.2 委譲する

受け入れ確認担当は、新しいタスクとして新しいコンテキストで1体だけ起動する（無効なら4.1節で、新しい1体へ1回だけ委譲し直す）。探索・反証の担当への追送や再開は使わない。依頼本文は次だけにする（作業ディレクトリのこれ以外の場所を示さない）。

```text
役割: 受け入れ確認
読んでよい入力（次のファイルだけ）:
- <W>/acceptance-input/refute-verdict.md
- <W>/acceptance-input/records.md
- <W>/acceptance-input/records/<各ファイル>
- <W>/acceptance-input/evidence/<各ファイル>（写したときだけ）
- <W>/acceptance-input/target.md
- <W>/acceptance-input/manifest.md
- <W>/acceptance-input/requirements/<各ファイル>
- <W>/acceptance-input/local/<各ファイル>（mode: local のときだけ）
- <W>/acceptance-input/deps-files.sha256（依存の写しを準備できたときだけ）
- 対象リポジトリ <W>/repo（target.md の担当用の限定 clone）
- 依存の写し <W>/deps/（準備できたときだけ）
書いてよい場所: <W>/acceptance/（result.md と notes/）と自分の一時ファイル
出力: <W>/acceptance/result.md
```

共通の context は4節と同じく空か固定の1文だけにする。待機と ID の記録は4節と同じ。

## 9. 受け入れ確認の結果を検査する

`result.md` を書き換えずに次を確かめ、`parent/checks.md` に書く。証拠が十分かどうかの判断はしない（担当の役割）。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。指定したパスに `result.md` がある。
2. 役割・定義名・対象版・受け取った入力が書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。
3. `parent/acceptance/rows.md` のすべての行が、同じ要求の出典で行ごとの判定にある（担当行の欠落が無い）。
4. 各行に、要求の出典・対象版・判定（確認済み／未充足／確かめられず のどれか）・成果物の不変版の存在・作業・手順の実施・現在の配置・外部の正本との内容の一致・更新順序（それぞれ判定か「対象外（要求が求めていない）」）・証拠・不足理由がある。確認済み以外の行の不足理由が「なし」や空ではない。
5. 判定に使った証拠の節、反証の判定と矛盾する証拠の節、判断を見送った事項の節がある（無いことの明示でもよい）。判定に使った証拠の各項目が、`records.md` の項目 ID（`activity:<id>`・`activity@<時刻>`・`document:<ID>`・`evidence/<n>`）か限定 clone の固定版を指す。
6. `acceptance-input/` の各ファイルの sha256 が `parent/acceptance/fingerprints.md` と一致する。依存の写しの指紋の一覧と限定 clone の確認を5節の8と同じくやり直し、委譲前と同じ結果になる。

欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は受け入れ確認だけを1回だけ委譲し直して同じ検査をする。探索と反証の結果はそのまま使う）。4.1節の後も有効な結果が無ければ `未完了` とする。不足理由を示した「確かめられず」と「未充足」は有効な結果であり、それだけでは `未完了` にせず、委譲し直す理由にもしない。不足があっても、同じ実行の中で証拠を足して判定し直させない。

## 10. 最終状態・点数・確認が残る事項・マージ可否を決める

1. `mode: local` では、反証の結果（受け入れ確認担当を起動したときはその結果も）を受け取った後に、土台の HEAD と差分（指定された未追跡ファイルを含む）を同じ方法で取り直し、`input/` の写しの sha256 と比べる。変わっていれば、確認が残る事項に「未コミット変更の土台 HEAD・差分の変化」（出典: 変わった写し、確かめる担当: 人、理由: 固定した変更と現在の変更が異なる）を加える。
2. 保存の直前に、要求の本文・資料だけを2.3節と同じ方法で `parent/requirements-recheck/` へ取り直し、`input/requirements/` と sha256 で比べる（Issue のタイトルと本文、現在リンクされている `kind=spec` の集合と本文、計画の出典が指す Document、Workspace の規約）。Activity・進捗・更新日時はここでは比べない（受け入れ確認の証拠は3で扱う）。変わっていれば旧要求に対する結果として保存し、確認が残る事項に「保存時の要求の変化」（出典: 変わった資料、確かめる担当: 人、理由: 現在の要求への適合を確かめていない）を加える。
3. 受け入れ確認担当の有効な結果を受け取ったときは、2と同じく保存の直前に、結果の「判定に使った証拠」の節にある項目と、そのうち `evidence/<n>` について `records.md` に書いた参照元（Activity の項目・Document）だけを取り直し、`parent/acceptance-recheck/` に置いて固定時（`records.md`）と比べる。Activity と Document の固定時は、8.1節で CI の結果を除く前の元の写し（`parent/acceptance/activity.json`・`parent/acceptance/documents/` と、`records.md` の元の本文の sha256）とする。取り直す時刻を記録する。
   - `evidence/<n>`: `records.md` に書いた読み取りの方法で、同じ出典から取り直す（絶対パスは同じスクリプト `scripts/copy-evidence.ts` で `parent/acceptance-recheck/evidence/<n>` へ写しと観測を取り直す。8.1と同じ検査（秘密候補の名前、`.`・`..`・空の要素、レビューの作業ディレクトリ・常設データセットの配下、パスのリンク、通常のファイルか、上限サイズ）をして、終了コード 1 なら写しを作らず「取り直せず」とし、結果の `code` と `message`（`SECRET_CANDIDATE` なら秘密候補になったとして当たったパス）を添える。Git は名前で指した revision の解決と同じ commit の読み取り、Document は本文、URL は GET）。写しと観測の sha256、Git の revision が指す commit、最終の URL を固定時と比べる。
   - `activity:<id>`・`activity@<時刻>`、および `evidence/<n>` の参照元の Activity の項目: `nod --json issue show` を `parent/acceptance-recheck/issue-snapshot.json` へ取り直し、同じ項目の有無、本文の sha256、解決の状態を比べる（固定の後に足された返信は次の親以外の追記で扱う）。
   - `document:<ID>`、および `evidence/<n>` の参照元の Document: 取り直した Issue に同じ Document がリンクされているかと、本文の sha256 を比べる（Issue にリンクされていない参照元の Document は `nod --json doc show <ID>` の本文）。
   - 固定の後に足された Activity（取り直した Activity のうち、固定時の元の写し `parent/acceptance/activity.json` に無いコメント・作業ログ・返信・確認依頼と、固定時の確認依頼に付いた回答）は、親自身の記録（3節で id を `parent/acceptance/own-logs.md` に記録したもの）を除いて、1件でもあれば親以外の追記とする。項目の種類・作業ログの種類・書いた人・返信先・本文を問わず、本文の意味や、本文が判定に使った証拠の出典を含むかどうかでは選別しない。親と実装者は同じ書き手（actor）で書くことがあるので、親自身の記録かどうかは書いた人ではなく own-logs の id だけで決める。親以外の追記は、どの証拠に関するかを親は決めないので、判定に使った証拠を使ったすべての行に付ける。Issue のイベント（状態・計画の進捗・ラベル・担当・優先度などの event 項目）は追記に含めない。
   - 親は変化と追記の意味（訂正か、撤回か、無害か）を判断しない。観測ごとに次の理由で、その証拠を使った行（親以外の追記は、判定に使った証拠を使ったすべての行）の要求の出典ごとに、確かめる担当「受け入れ確認担当（新しい実行）」と、項目 ID・出典・固定時と保存直前の指紋（親以外の追記は、追記の項目 ID・時刻・書いた人と、返信先）を添えて、確認が残る事項に加える。

   | 保存直前の観測 | 理由 |
   |---|---|
   | 判定に使った Activity の項目・Document、または `evidence/<n>` の参照元が無い、Issue からのリンクが外れた | 証拠の削除 |
   | 判定に使った Activity の項目・Document、または `evidence/<n>` の参照元の本文の sha256 が違う | 証拠の訂正 |
   | 判定に使った Activity の項目・`evidence/<n>` の参照元の Activity の解決の状態の変化 | 対応不明（撤回・訂正の可能性。親は意味を判断しない） |
   | 親以外の追記（固定の後に足された Activity のうち親自身の記録でないもの。1件でも） | 親以外の追記（使用した証拠の有効性を確認できない。親は意味を判断しない） |
   | 外部の正本の写し・観測の sha256、または名前で指した Git の revision が指す commit が違う | 外部の正本の変化 |
   | 参照された記録の写し・観測の sha256、または名前で指した Git の revision が指す commit が違う | 参照された記録（配置先・成果物を含む）の変化 |
   | 最終の URL が違う、名前で指した Git の revision が無くなった | 対象版との対応不明 |
   | 取り直せない（存在しない、読み取りの失敗、認証が要る、秘密候補になった、パスにリンクを含む・ディレクトリなど通常のファイル以外になった・上限サイズを超えた） | 取り直せず（失効を含む） |

   - 次は止めない: 親自身の記録、Issue のイベント、判定に使っていない Activity の項目（参照元を除く）の本文・解決の状態の変化や Document の変化（追記ではない）、Issue の更新日時の変化、取り直した時刻の違い、HTTP の応答の `Date` などの見出しだけの違い。
   - 報告の再照合の節には、固定の後に足された Activity の件数、親以外の追記の件数と各項目（項目 ID・時刻・書いた人・返信先。確認が残る事項にした）、止めなかった親自身の記録と Issue のイベントの件数を書く。
   - 取り直した内容は `parent/acceptance-recheck/` にだけ置く。変化があっても、新しい写しを担当へ渡さず、同じ実行の中で受け入れ確認担当に判定し直させず、担当の判定本文・最終状態・点数を変えない。受け入れ確認の判定（確認済みを含む）は固定時の証拠に対するものとして、そのまま報告する。
   - この再照合が保証するのは取り直した時点の観測までであり、将来の配置状態や正本の版を保証したとは報告しない。
4. 最終状態を SKILL.md の6節で決める。必要な担当（受け入れ確認担当の行があれば受け入れ確認担当を含む）の有効な結果の有無だけで決め、判定本文の未確認、受け入れ確認の「未充足」「確かめられず」、1〜3の変化では `完了` を `未完了` にしない。
5. `完了` のとき、未確認が残っていても、反証担当の判定から規則どおりに確定した要対応の点数を計算する。親は判定・影響度・対応表を変えない。受け入れ確認の結果と3の再照合で点数・反証の判定本文・受け入れ確認の結果を変えない。計算の過程（要対応の件数、各要対応の影響度、最小値）を記録する。
6. 確認が残る事項をまとめる。判定本文の未確認（対応表の「未確認」の行と、判定「未確認」の候補。要実行確認を含む）と要求間の矛盾を、判定本文の要求の出典（または候補 ID）・確かめる担当・理由のまま1件ずつ並べる。受け入れ確認の結果で「未充足」「確かめられず」の行を、要求の出典・確かめる担当「受け入れ確認担当」・理由（判定と不足理由を結果の原文のまま）で並べ、反証の判定と矛盾する証拠を、反証の判定の箇所・確かめる担当「人」・理由（受け入れ確認の証拠と反証の判定の矛盾と、結果の原文）で並べる。受け入れ確認担当の行の候補ID列にあり、確かめる担当を受け入れ確認担当とした判定「未確認」の候補は、別の事項として並べず、その行の受け入れ確認の判定で扱う（SKILL.md の6節。確認済みなら残さず、未充足・確かめられずならその行の事項に候補 ID を書き添える）。1〜3で加えた事項と合わせる。例外を設けず、どれも最終状態と点数を変えない。
7. CI の結果では、4〜6の最終状態・点数・確認が残る事項を変えない。反証担当が確定した対応表の行（「未確認」「自動チェック担当」「受け入れ確認担当」を含む）と受け入れ確認の結果も書き換えない。
8. マージ可否を決める。
   - 先に、3.3節のスクリプトを1回だけ実行し、`parent/ci/1/` に記録する（1〜3の後、マージ可否を決める直前）。Workspace の規約は2で取り直した `parent/requirements-recheck/workspace-rules.md` を渡す。`mode: local`、または基点をブランチ名に解決できないときは実行せず、3節・3.1節のとおり `parent/ci/1/not-run.md` に書く。
   - 続けて `mode: commit` では、`parent/head-source.md` の元から対象の現在の head を取り直し（PR なら `gh pr view <PR> --json headRefOid`、ref なら `git -C <repo> rev-parse <ref>`）、`target.md` の head の SHA と比べる。使ったコマンド・取得時刻・現在の head・比べた結果を `parent/head-check.md` に書く。「ref なし」やコマンドの失敗で取り直せなければ、その旨を書く。
   - `可（人のレビューなしでマージ可）`: 次のすべてを満たすときだけ。
     1. 最終状態が `完了` で、確定した要対応の点数が `5`。
     2. 対応表のすべての行が、反証で「充足」「説明」「対象外」のどれかであるか、「自動チェック担当」で同じ head SHA の CI 判定が `成功` であるか、「受け入れ確認担当」で受け入れ確認担当が「確認済み」とした行である。
     3. 確認が残る事項が、対応表の内外を問わず0件。
     4. `parent/ci/<n>/result.json` の `head` が `target.md` の head の SHA と同じで、CI 判定（`verdict`）が `成功`。
     5. 直前に取り直した対象の現在の head が `target.md` の head の SHA と同じ（`parent/head-check.md`）。
   - `不可（人の判断が要る）`: それ以外のすべて。最終状態とその理由、確定した要対応の点数または点数なし、CI 判定とその理由（必須のチェックごとの結果、head SHA の一致）、現在の head の照合の結果、確認が残る事項（要求の出典・確かめる担当・理由）をすべて並べる。CI 判定が `成功` 以外（`失敗`・`未確定`・`結果なし`・`取得できず`・`必須のチェックなし`・`必須のチェックを決められず`・`対象外（未コミット）`）なら、ほかの条件をすべて満たしていても不可とする。現在の head が固定した head と違う（理由: 対象版が現在の head と違う（追加コミット））、または取り直せない（理由: 現在の head を取り直せない）ときも、ほかの条件をすべて満たしていても不可とする。
   - 対応表の「自動チェック担当」の行は、マージ可否の判定でだけ同じ head SHA の CI 判定 `成功` で満たしたことにする（点数の対象外という扱いは変えない）。CI 判定が `成功` でなければ、満たしていない理由として並べる。
   - 対応表の「受け入れ確認担当」の行は、受け入れ確認担当が「確認済み」とした行だけを、マージ可否の判定で満たしたことにする（点数の対象外という扱いは変えない）。CI の成功では満たさない。
   - 対応表の「未確認」の行と、受け入れ確認の「未充足」「確かめられず」の行は、CI の成功では消えない（確認が残る事項として残り、マージ可否は `不可`）。
   - CI 判定の成否で、最終状態・点数・対応表・受け入れ確認の結果・確認が残る事項を変えない。
   - `可` でも、リポジトリの既存のマージ条件（ブランチ保護・必須のレビューなど）は省かず、迂回しない。

結果は固定した対象版と要求に対するものであり、別の commit の承認に使わない。CI 判定は照合した時点の観測であり、その後の CI の結果は13節の CI の再照合で扱う。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果として報告する。

## 11. 報告を作り、保存する

報告は2つに分ける。[監査の雛形](../assets/audit.md)で `parent/audit.md`、[結果の雛形](../assets/report.md)で `parent/report.md` を作る。両方を同じ runId・対象SHAで対応付ける。判定・採点・マージ条件は変えない。

監査記録には、従来の管理情報・点数の計算・全対応表・出典と指紋・取得と再照合・担当と試行の記録を残す。反証の `refute/verdict.md` と、起動した受け入れ確認の `acceptance/result.md` は、それぞれ `cat` で監査の印の間へ一字も変えずに入れる。本文が無ければ「未受領」と理由、担当行が無ければ「受け入れ確認担当の行なし（起動せず）」を書く。限定 clone は `parent/clone.md`、依存は `manifest.md`、証拠の写しは `acceptance-input/records.md` と `parent/acceptance/`、保存前の再照合は `parent/acceptance-recheck/`、CI と現在headは `parent/ci/1/` と `parent/head-check.md` を参照する。生のAPI応答は場所と指紋だけを記録する。

利用者向け結果は、結論（最終状態・点数・マージ可否・短い理由）、対象SHA、Severity付きの要対応、未確認事項、監査への参照だけにする。要対応は反証の確定結果から問題・影響・場所を短く転記し、共通規則の対応で Severity と影響度の数値を併記する。親が判定や影響度を再評価せず、原因の統合や指摘・未確認の省略をしない。未確認は不具合と分け、不足と確認する担当を示す。原文・全対応表・指紋・担当履歴は結果へ転載しない。
結果・監査の両方で、CI の結果を含む部分（マージ可否・理由・現在head・merge-readyを含む）は `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の間だけに書く。後のレビューの入力から除く境界は3節と同じで、結果を短くしても隔離を弱めない。
担当の表と試行の記録は `parent/agents.md`・`parent/attempts.md` から書く。無効だった試行と委譲し直した試行の両方を、担当 ID・無効の理由・保存場所・指紋とともに載せ、担当のセッション内の omp 内部の再試行と親による再委譲を分けて書く。
モデル情報は各担当の引き渡し用ファイル・判定本文・受け入れ確認の結果の申告と、ハーネスが示した情報だけを出典付きで書く。不明は未確認とし、実効モデルの証明として扱わない。

Issue がある場合は、最終状態にかかわらず監査・結果をそれぞれ `kind=doc` の別Documentとして添付する。監査を先に保存し、そのIDと参照先を結果へ記入してから結果を保存する。

```sh
nod doc create <Issue IDの小文字>-code-review-audit-<YYYYMMDD>-<runIdの先頭8文字>.md \
  --title "<Issue ID> コードレビュー監査（<runIdの先頭8文字>）" --kind doc --issue <Issue ID> --body - < "$W/parent/audit.md"
nod doc show <監査Document ID>
# 監査IDと参照先を parent/report.md の監査記録の節に記入してから保存する
nod doc create <Issue IDの小文字>-code-review-<YYYYMMDD>-<runIdの先頭8文字>.md \
  --title "<Issue ID> コードレビュー結果（<runIdの先頭8文字>）" --kind doc --issue <Issue ID> --body - < "$W/parent/report.md"
nod doc show <結果Document ID>
awk '/^<!-- refute-verdict:begin -->$/{f=1;next} /^<!-- refute-verdict:end -->$/{f=0} f' <監査Document のパス> | shasum -a 256
awk '/^<!-- acceptance-result:begin -->$/{f=1;next} /^<!-- acceptance-result:end -->$/{f=0} f' <監査Document のパス> | shasum -a 256
```

- 両Documentの kind・Issueリンクを確かめる。結果の監査参照が今回保存した監査を指し、runId・対象SHA・最終状態・点数・要対応・未確認・マージ可否が両者で一致することを確かめる。原文の指紋は監査Documentの印の間と原本を比べる。全文の保存時の同一性もそれぞれタイトル見出しを除いた本文と原稿のsha256で確認する。どちらかの保存・リンク・指紋確認が失敗したら保存失敗として報告し、merge-ready を付けない。保存できたDocumentは保持し、再保存のためレビューを流し直さない。
- 以下の作業ログには結果Document IDと監査Document IDを両方記録する。利用者へ返す「報告Document ID」は短い結果のIDとする。
- `完了`: `nod --json issue log <Issue ID> "<要約>" --kind progress` に、状態・確定した要対応の点数・要対応の要点・受け入れ確認の行ごとの判定（起動したとき）・確認が残る事項の件数と要点（要求の出典・確かめる担当・理由）・Document ID・runId・起動した全担当（3担当と、起動したときは受け入れ確認担当）の役割と ID・委譲し直した役割があればその試行（最初の担当 ID・無効の理由と、委譲し直した担当 ID）を書く。CI 判定・マージ可否・merge-ready は書かず、下の `[ci-result]` の記録を参照する旨だけを書く（3節）。返った id は `parent/acceptance/own-logs.md` に記録する（3節）。
- `未実施`・`未完了`: `nod --json issue log <Issue ID> "<要約>" --kind blocker` に、独立レビューが未実施・未完了であること・原因（`未完了` なら有効な結果が無い担当と理由。利用枠の上限ならそのこと）・試行の記録（担当 ID・無効の理由・委譲し直したかどうか）・受領済みの成果・取得できた担当 ID・点数なし・Document ID・runId を書く。CI 判定・マージ可否は書かず、下の `[ci-result]` の記録を参照する旨だけを書く（3節）。返った id は `parent/acceptance/own-logs.md` に記録する（3節）。
- 担当の ID はこの作業ログでもレビューと対応付ける。ID が異なることだけで、会話を引き継いでいないことを証明したとは扱わない。
- merge-ready ラベル（Issue があるときだけ。最終状態にかかわらず、報告の保存と上の作業ログの後に行う）: ラベルは、固定した head SHA に対する現在のマージ可否の表示であり、自動マージの指示ではない。ブランチ保護・必須のレビューなど既存のマージ条件を迂回しない。
  - マージ可否が `可` なら、付ける直前に10節の8と同じ方法で対象の現在の head を取り直し、結果を `parent/head-check.md` に書き足す。`target.md` の head の SHA と同じときだけ `nod issue update <Issue ID> --add-label merge-ready` で付ける。違う、または取り直せないときは付けず、マージ可否を `不可`（理由: 対象版が現在の head と違う（追加コミット）、または現在の head を取り直せない）として扱う（報告 Document は書き換えず、下の記録とチャットの報告に書く）。`不可` で、`nod --json issue show <Issue ID>` の `.labels` に merge-ready があれば `nod issue update <Issue ID> --remove-label merge-ready` で外す。`不可` で付いていなければ付けない。
  - 付けた／外した／付けなかったこと（付けなかったときは、マージ可否が不可の理由）と、判定した head SHA・現在の head の照合の結果（取り直した head と取得時刻）・基点・CI 判定と必須のチェックごとの結果（出典・check run の URL）・報告の Document ID・runId・CI の記録の場所（`<W>/parent/ci/<n>/` と `result.json` の sha256）を、本文を `[ci-result]` で始めて `nod --json issue log <Issue ID> "<記録>" --kind test` に1件残し、返った id を `parent/acceptance/own-logs.md` に記録する（3節）。ラベルの操作に失敗したら、その旨も同じ記録とチャットの報告に書く（報告 Document は書き換えない）。
- Issue の無い単独レビューは、`parent/report.md` と `parent/audit.md` を残し、結果から監査へ参照する。チャットでは短い結果だけを返す。merge-ready ラベルは扱わない。
- 要求の写し・限定 clone と `parent/clone.md`・引き渡し用ファイル・メモ・反証の結果・受け入れ確認への写し（`acceptance-input/`・`parent/acceptance/`）と受け入れ確認の結果・保存直前の受け入れ証拠の取り直し（`parent/acceptance-recheck/`）・無効な試行の記録（`parent/attempts/`・`parent/attempts.md`）・CI の照合の記録（`parent/ci/<n>/`）は作業ディレクトリに残す（13節の CI の再照合で使う）。依存の写し（`deps/`）は保存を終えた後に片付けてよい（lockfile の sha256 と `deps-files.sha256` で同一性を確かめ直せる）。片付けたら、そのことと時刻を `parent/deps/` の記録に書き足す。

## 12. 後続

- 実装後レビューでは、短い結果と結果Document ID・監査Document IDを呼出元へ返す。単独レビューのチャットも結論・Severity付きの要対応・未確認・結果と監査への参照だけにする。詳細は監査に残し、チャットへ繰り返さない。
- `未実施`・`未完了`: Issue を Done にも In Review にもせず、PR も出さない（PR 不要の依頼でも Done に進めない）。`未完了` は4.1節の手順（判定と無関係な無効は1回だけ委譲し直し、利用枠の上限では委譲し直さない）を終えた結果であり、さらに委譲し直したり、担当を再開したり、利用枠の回復を待って流し直したりして代替しない。
- `完了` でマージ可否が `不可`: 確認が残る事項は、提出・完了に必要な確認の不足として扱い、合格・指摘なし・確認済みへ読み替えない。後続の判断は既存の提出・完了条件に委ねる。保存直前の再照合で見つかった証拠の変化を確かめ直すには、新しいレビューで写しを取り直す（このレビューの判定を新しい証拠で書き換えない）。
- マージ可否が `不可（人の判断が要る）` なら、人の判断なしにマージへ進めない。`可` でもリポジトリの既存のマージ条件を省かず、このレビューからはマージしない。merge-ready ラベルを自動マージ・承認の代わりにしない。
- CI 判定が `未確定`・`結果なし`（push 前・PR 前・CI の実行中など）でマージ可否が `不可` のときは、CI の完了後に13節の CI の再照合で判定し直す（レビューはやり直さない。完了を待って polling しない）。
- merge-ready が付いた後に、追加コミット・要求や使用証拠の変化・CI の失敗や未確定で条件を満たさなくなった、または判定が古くなったと分かった時点で、ラベルを外して理由を記録する（13節）。
- 次の判断が必要な場合だけ、具体的な選択肢を番号付きで示し、おすすめと理由を添える。

## 13. CI の再照合（同じ head SHA）

保存したレビューの CI 判定が `未確定`・`結果なし`（push 前・PR 前・CI の実行中など）だった場合や、merge-ready の判定を新しくする場合に、レビューをやり直さずに、同じ head SHA の CI の結果とマージ可否を照合し直す。担当へ委譲せず、親も自分でレビューしない。実装を進める親や PM もこの節に従ってよい。CI の完了を待って polling しない（完了の後に行う）。

1. 結果Documentの監査参照から監査Documentと作業ディレクトリ `<W>`（監査の管理情報の「作業ディレクトリ」）を特定し、runId・対象SHAが一致することを確かめる。再照合の番号 `<n>` は `parent/ci/` と `parent/recheck-<n>/` の番号の最大の次とし、`parent/recheck-<n>/` を作る。`<W>/input/target.md` の head SHA と現在のブランチまたは PR のhead（`gh pr view <PR> --json headRefOid,baseRefName` など）を比べる。以下の原判定・点数・対応表・受け入れ確認結果・既存の確認事項は監査から読み、結果だけで代用しない。既存の単一報告はそのまま監査情報を含む保存時の記録として参照し、過去のDocumentを書き換えない。
2. head が違う（追加コミット）なら照合しない。merge-ready が付いていれば `nod issue update <Issue ID> --remove-label merge-ready` で外し、「判定が古い（追加コミット）」と、報告の head SHA・現在の head SHA・報告の Document ID を、本文を `[ci-result]` で始めて `nod --json issue log <Issue ID> "<記録>" --kind test` に記録し、8の `record.md` を書いて終える（`parent/ci/<n>/` は作らない）。新しい head には新しいレビュー（1節から）が要る。
3. 報告の最終状態が `完了` でない、確定した要対応の点数が `5` でない、報告の確認が残る事項が1件以上ある、`mode: local` である、または4〜6で使う作業ディレクトリの記録（`input/target.md`・`input/requirements/`・`input/manifest.md`、Issue があるときは `parent/acceptance/own-logs.md`、受け入れ確認担当を起動したときは `acceptance-input/records.md` と `acceptance/result.md`）のどれかが無いなら、照合し直してもマージ可否は `可` にならない。Issue の無い単独レビューでは `parent/acceptance/own-logs.md` を求めない（Issue へ記録を書かないので作られない）。照合せず、merge-ready が付いていれば外し、理由（無い記録はそのパス）を2と同じく `--kind test` に記録し、8の `record.md` を書いて終える（`parent/ci/<n>/` は作らない）。
4. head が同じなら、10節の2・3を同じ方法で `parent/recheck-<n>/`（要求は `parent/recheck-<n>/requirements/`、受け入れ証拠は `parent/recheck-<n>/acceptance/`）へやり直す。比べる相手は固定時（`input/requirements/`、`acceptance-input/records.md` と、Activity・Document は CI の結果を除く前の元の写し `parent/acceptance/activity.json`・`parent/acceptance/documents/`）で、Issue があるときは親自身の記録の扱い（`parent/acceptance/own-logs.md` の id）も同じとする。Issue の無い単独レビューでは Activity・Document を写していないので、受け入れ証拠は `evidence/<n>` だけを取り直し、own-logs は使わない。見つかった変化は10節と同じ理由で確認が残る事項に加える。報告 Document は書き換えず、加えた事項は8の `record.md` と7の記録に書く。
5. 3.3節のスクリプトを `parent/ci/<n>/` へ1回だけ実行する（`--rules` は `parent/recheck-<n>/requirements/workspace-rules.md`、`--base` は報告の基点のブランチ名、`--head` は `target.md` の head の SHA）。PR があれば、その `baseRefName` が報告の基点と同じことを確かめ、違えば `必須のチェックを決められず` として扱う。
6. 報告の最終状態・確定した要対応の点数・対応表・受け入れ確認の結果と、報告の確認が残る事項に4で加えた事項を合わせ、10節の8と同じ規則でマージ可否を決める（`parent/ci/<n>/result.json` の `head` が `target.md` の head の SHA と同じで、CI 判定が `成功`）。報告の判定本文・最終状態・点数・対応表は変えない。
7. 11節と同じく merge-ready を付ける・外す。付けた／外した／付けなかったことと、判定した head SHA・基点・CI 判定と必須のチェックごとの結果（出典・check run の URL）・報告の Document ID・runId・再照合の番号 `<n>`・CI の記録の場所（`<W>/parent/ci/<n>/` と `result.json` の sha256）・4で加えた確認が残る事項を、本文を `[ci-result]` で始めて `nod --json issue log <Issue ID> "<記録>" --kind test` に1件残す。
8. 再照合の記録を `parent/recheck-<n>/record.md` に書く（2・3で照合せずに終えるときも書く）。書くのは、報告の Document ID と runId、比べた head（報告の head の SHA・現在の head の SHA と基点、取得に使ったコマンドと取得時刻）、照合せずに終えたならその理由（2の追加コミット、3の条件と無い記録のパス）、要求と受け入れ証拠の再照合の結果（4。比べた資料と変化の有無、加えた確認が残る事項。照合しなかったときは「照合せず」）、CI の記録の場所 `parent/ci/<n>/` と `result.json` の sha256・CI 判定（照合しなかったときは「照合せず」）、マージ可否と理由、ラベルの操作（付けた／外した／付けなかった）、この再照合で書いた作業ログの id である。

- この節で親（または実装を進める親・PM）が Issue へ書いた記録の id も、3節のとおり `parent/acceptance/own-logs.md` に記録する。
- レビューの保存後から再照合までに、実装を進める親・PM が同じ Issue へ書いた記録（作業ログ・コメント・返信。PR の URL や提出・受理の記録を含む）も、`nod --json` で書いて返った id を4の前に `parent/acceptance/own-logs.md` へ記録したものだけを親自身の記録とする。それ以外は、書いた人を問わず親以外の追記とする（10節の3）。
- Issue の無い単独レビューでも照合し直してよいが、ラベルは扱わず、結果はチャットで報告する。
- 再照合の結果は、照合した時点の観測である。その後に追加コミット・要求や使用証拠の変化・CI の失敗や未確定で条件を満たさなくなった、または判定が古くなったと分かった時点で、merge-ready を外して理由を記録する（実装を進める親・PM の手順でも同じ）。
