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
- PR を指定された場合は `gh pr view <PR> --json url,headRefOid,baseRefName` などで実際のリポジトリ・基点・head の SHA を特定する。Issue をブランチ名から推測しない。
- コミットのレビューは `mode: commit`（head は SHA、またはブランチ名・`HEAD` などの ref）。明示された未コミット変更のレビューは、明示されたときだけ `mode: local` とし、commit や stash を作らない。未追跡ファイルは指定されたものだけを渡す。
- Issue の無い単独レビューでは、利用者が明示した要求（ファイルか Document）だけを渡す。

## 2. 対象を固定し、共通入力を作る（スクリプト）

1節で決めた値で、このスキルの `scripts/review.ts prepare` を1回実行する。スクリプトが、対象の SHA の固定、秘密候補と空差分の検査、担当用の限定 clone と確認（2.1節）、依存の写しと指紋（2.2節）、共通入力と目録（2.3節）、head を固定した元の記録を行う。親はこれらを手で繰り返さず、テストを実行しない。

```sh
# スクリプトはこのスキルのディレクトリ（SKILL.md があるディレクトリ。Claude Code では「Base directory for this skill」として示される）から解決する。リポジトリの作業ディレクトリの plugins/ を使わない
bun <スキルのディレクトリ>/scripts/review.ts prepare --repo <元のリポジトリの絶対パス> --base <基点の指定> \
  --mode commit --head <head の SHA か ref> [--pr <PR の URL>]   # PR なら --head は gh で解決した40桁の SHA
  # mode: local なら --mode local [--untracked <リポジトリのルートからの相対パス>]...（土台の HEAD を固定する）
  # 要求: --issue <Issue ID>、Issue が無ければ --request <ファイルの絶対パス>... / --request-doc <Document ID>...（無ければ省く）
```

- 作業ディレクトリ `<W>` は実行ごとに `$HOME/.local/share/nod/code-reviews/<runId>`（runId は小文字の uuid）に作られる。結果は標準出力の1行の JSON と、同じ内容の `parent/prepare.json` に出る（`work` が `<W>`、`runId`、`mergeBase`・`head`（`mode: local` では土台の HEAD）、`headSource`、`clone`、`deps`、`inputs`（`input/` の各ファイルの sha256）、`unavailable`（取得できなかった資料と理由））。
- 終了コード 2 は引数の誤り（相対パス、解決できない ref、追跡済みのファイルを `--untracked` に渡したなど）で、判定ではない。呼び出しを直して実行し直す。それ以外の 0 以外の終了コードは予期しない失敗で、委譲しない。
- `ready` が false なら `status` は `未実施` で、委譲せず、10節の `finalize` で報告する（CI は照合せず、`reason` を理由・点数なし・マージ可否 `不可（人の判断が要る）` として報告と作業ログが書かれる）。理由は、秘密情報を含み得る <パス> が差分にある（必要な範囲を利用者が確かめる必要がある）、差分なし、担当用の限定 clone を作れない（<通らなかった確認>）のどれか。
- 秘密候補は、本文を写す前に変更されたパスの名前だけで調べる（`mode: commit` は merge-base から head までの差分、`mode: local` はそれに未コミットの差分と指定された未追跡パスを加えたもの。名前は NUL 区切りで読み、日本語などを含むパスも引用符なしの名前で調べる）。パスのどこかの要素が `.env`・`.env.*`・`.aws`・`id_rsa`・`id_ed25519`・`credentials`・`credentials.*`・`*.pem`・`*.key`（大文字小文字を区別しない）に当たれば止まり、差分の本文・限定 clone・依存の写し・要求の写しを作らない。
- `mode: commit` では、head を固定した元（PR なら URL、ref から固定したなら `<repo>` とその ref、SHA だけなら「ref なし」）が親専用領域の `parent/head-source.md` に書かれる（担当へ渡す `target.md` には書かない）。10節の8と11節では、この元から対象の現在の head（PR なら基点も）を取り直す。

ディレクトリの分離は担当への指示の境界であり、アクセス遮断ではない。以下、元のリポジトリを `<repo>`、担当用の限定 clone を `<W>/repo` と書く。担当には元のリポジトリを渡さない。

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
| `parent/` | 親専用領域（準備の結果 `parent/prepare.json`、Issue の取得結果 `parent/issue-snapshot.json`、元のリポジトリのパスと限定 clone の確認の記録 `parent/clone.md`、head を固定した元 `parent/head-source.md` と現在の head の照合 `parent/head-check.md`、依存の準備の記録 `parent/deps/`、委譲の記録 `parent/agents.md`、検査記録 `parent/checks.md`、段階ごとの同一性の確認 `parent/identity.md`、反証への入力の指紋 `parent/fingerprints.md`（それぞれ同じ名前の `.json` も）、反証の判定本文から読み取った構造 `parent/refute-structure.json`、受け入れ確認の結果から読み取った構造 `parent/acceptance-structure.json`、無効な試行の出力と記録 `parent/attempts/`・`parent/attempts.md`、受け入れ確認担当の行 `parent/acceptance/rows.md`・受け入れ確認の写しの取得記録（`records.json`・`items.json`・`evidence.json`・`evidence.md`・`refs.json`・参照の候補 `ref-candidates.*`・委譲前の指紋 `fingerprints.md`）と CI の結果を除く前の元の写しと親自身の記録の id `own-logs.md`（`parent/acceptance/`）、保存直前の取り直し `parent/requirements-recheck/`・`parent/local-recheck/`・`parent/acceptance-recheck/`、CI の照合の記録 `parent/ci/<n>/`、CI の再照合での取り直し `parent/recheck-<n>/`、報告の原稿 `parent/report.md`・`parent/audit.md` と `finalize` の結果 `parent/finalize.json`、各サブコマンドの結果 `parent/<サブコマンド>.json`） | 親 | 親だけ |

### 2.1 担当用の限定 clone

スクリプトは、元のリポジトリを変えずに、head（`mode: local` では土台の HEAD）とその祖先（merge-base を含む）の commit だけを持つ clone を `<W>/repo` に作り、次をすべて確かめて、コマンドと出力を元のリポジトリのパスと一緒に `parent/clone.md`（結果は `parent/prepare.json` の `clone.checks`）に書く: ref・remote・alternates・`FETCH_HEAD` が無い、HEAD が head、merge-base が head の祖先、commit と object が head から辿れるものだけ、index と作業ツリーが空、`.git`（objects を除く）に元のリポジトリのパスが無い。

- `target.md` の対象リポジトリはこの clone の絶対パスになる。元のリポジトリのパスは `parent/` にだけ置き、依頼本文・`input/`・`refute-input/` に入れない（`acceptance-input/` では、参照された記録の出典に元のリポジトリの作業ツリーのパスが出ることがある。8節）。
- 確認が通らない clone を担当に渡さない（スクリプトは `未実施` を返す）。
- 後の段階（4.1節・5節・6節）では、スクリプトが同じ確認を同じ方法でやり直し、`parent/prepare.json` の `clone.checks` と比べる（`parent/identity.md`）。親は手で繰り返さない。

### 2.2 依存の写し

担当が固定した依存のコードを外部へ取りに行かないよう、スクリプトは head（`mode: local` では土台の HEAD）の版のルートの lockfile から、lockfile どおりに入れる指定とスクリプトを実行しない指定の両方を持つパッケージ管理だけで配布物を準備する（`bun.lock`・`bun.lockb` は `bun install --frozen-lockfile --ignore-scripts`、`package-lock.json` は `npm ci --ignore-scripts`、`pnpm-lock.yaml` は `pnpm install --frozen-lockfile --ignore-scripts`、`yarn.lock` は v1 なら `yarn install --frozen-lockfile --ignore-scripts`、Yarn 2 以降なら `.yarnrc.yml` の `yarnPath` の Yarn で `node <yarnPath> install --immutable --mode=skip-build`）。

- 固定版を限定 clone から `parent/deps/` の作業領域へ展開して準備し、`node_modules` だけをリンクのまま `<W>/deps/` へ写し、指紋の一覧 `input/deps-files.sha256`（ファイルごとの sha256 の後にリンクごとの `link <パス> -> <リンク先>`）を作って、作業領域を片付ける。写しの外を指すリンク（ワークスペースのパッケージなど）の中身は、担当が限定 clone の固定版で読む。
- lockfile が無い、ルート以外にしか無い、どれを使うか固定版から決められない複数の lockfile がある（`package.json` の `packageManager` で決まる場合を除く）、形式や Yarn の版を決められない、準備の終了コードが 0 以外、`node_modules` が作られない場合は、`deps/` を置かず、理由が `manifest.md` に書かれる。担当はその依存の確認を未確認に残す。
- `mode: local` で未コミットの変更が lockfile やパッケージ定義を変えている場合も、写しは土台の HEAD の lockfile から作り、その旨が `manifest.md` に書かれる。
- 準備のコマンド・終了コード・パッケージ管理とその版・取得元・`setup.log` の sha256・作業領域を片付けたことは `parent/deps/` に書かれる。`setup.log` は担当に渡さない。
- 後の段階（4.1節・5節・6節）では、スクリプトが指紋の一覧を同じ方法で作り直し、`input/deps-files.sha256` と比べる（`parent/identity.md`）。親は手で繰り返さない。

### 2.3 共通入力

`input/` には次だけが置かれる。

- `target.md`: 対象リポジトリ（限定 clone `<W>/repo` の絶対パス）、依存の写しの場所（`<W>/deps/`、または「依存の写しなし（理由は manifest.md）」）、基点の指定、merge-base と head の SHA、`mode`、Issue（ID またはなし）、計画の出典の扱い。`mode: local` では土台の HEAD の SHA、`local/changes.diff`、`local/untracked/<相対パス>` の一覧も書く。
- `local/`（`mode: local` のときだけ）: 表示用の変換を無効にした未コミットの差分 `changes.diff`（`git --no-optional-locks diff --binary --no-ext-diff --no-textconv HEAD`）と、指定された未追跡ファイルの写し `untracked/<相対パス>`。
- `deps-files.sha256`（依存の写しを準備できたときだけ）。
- `requirements/`: 要求の原文。丸ごと写し、選別・要約・書き換えをしない。
  - `issue.md`: Issue のタイトルと本文だけ。
  - `spec-<DocumentID>.md`: Issue に現在リンクされたすべての `kind=spec` の Document の本文。1件に絞らない。
  - `plan-<DocumentID>.md`: Issue の計画の出典（`plan.source`）が指す `kind=plan` の Document だけ。解決できない・読めない場合は別の計画で代用せず、「計画の出典を解決できず不足（<plan.source>）」と書かれる。出典が無ければ「計画の出典なし」。
  - `workspace-rules.md`: Git 管理外の Workspace の規約の原文（`nod -w <repo> workspace rules show` の出力。未登録ならその旨の出力）。
  - Issue の無い単独レビューでは、`issue.md`・`spec-*`・`plan-*` の代わりに、利用者が明示した要求の原文だけを `request-<n>.md` に丸ごと写し、`target.md` に「Issue なし」と書く（明示された要求が無ければ「Workspace の規約以外の要求資料なし」）。`workspace-rules.md` はどちらの場合も写す。
- `manifest.md`: `input/` の各ファイル（`manifest.md` 自身を除く）の sha256 と出典（Issue ID と取得時刻、Document ID とパス、Workspace 規約、Git の SHA）、取得できなかった資料と理由（読めなかった `kind=spec` の Document など）、依存の写しの節（場所、lockfile のパス `<lockfile>@<head の SHA>` と sha256、パッケージ管理とその版、準備のコマンドと終了コード、取得元、`deps-files.sha256` の件数。準備しなかった・できなかった場合は理由）。

`nod issue show` の全出力（`parent/issue-snapshot.json`）、Activity（作業ログ・コメント）、実装の完了報告、過去のレビュー、自動チェックの結果、CI の結果と親の CI の照合の記録（`parent/ci/`）、依存の準備の記録（`parent/deps/`）、元のリポジトリのパス、計画の進捗状態は `input/` に入らない。Spec・計画に混ざった結果の節を要求から外す判断は担当に任せ、親は削らない。Activity と添付 Document の原文は、受け入れ確認担当が必要になったときだけ、8節で `acceptance-input/` へ別に写す（探索・反証の担当には渡さない）。`unavailable` に資料があっても、親は別の資料で代用しない（担当が不足として扱う）。

## 3. CI の結果を扱う（親だけ）

テストと Lint は CI で担保する。親はテスト・Lint・ビルドを実行せず、同じ head SHA に対する CI の結果を GitHub から読んで、マージ可否（10節の8）と merge-ready ラベル（11節・13節）にだけ使う。照合は `review.ts finalize`（10節の8）が1回だけ行い、13節の CI の再照合は `review.ts recheck-ci` が行う。どちらも同じディレクトリの `scripts/ci-checks.ts` をサブプロセスとして起動する（3.3節）。親はレビューの CI を `ci-checks.ts` で手で照合しない。

- 親は CI を実行・再実行せず、完了を待たない（polling しない）。照合した時点の結果で判定し、未確定なら不可として記録する。CI の完了後に判定し直すときは、13節の CI の再照合で行う。
- 実装者の作業ツリーや手元のテストログ、作業ログ・PR の本文などに書かれた CI の結果で代用しない。GitHub から読んだ結果だけを使う。
- CI の結果と照合の記録は `parent/ci/<n>/` にだけ置く。担当への依頼本文・共通の context・`input/`・`refute-input/`・`acceptance-input/` に入れず、担当の返答を待つ間に CI の状況や結果を担当へ送らない。受け入れ確認への写し（8節）を取り終えるまで、このレビューの CI の状況や結果を Issue の作業ログに書かない。写しの後に親が Issue へ書く記録（作業ログ・コメント・返信。CI の照合の記録に限らない）は、すべて親自身の記録として id を `parent/acceptance/own-logs.md`（`- <id>: <内容>` の行）に記録する。`finalize`・`recheck-ci` が書いた作業ログの id はスクリプトが記録する。それ以外に親が書いた記録は、`nod --json issue log`・`nod --json issue comment` が返した id を、`finalize`・`recheck-ci` の `--own-log <id>`（繰り返し可）で渡す（照合の前に記録される）。記録していない項目は、親が書いたものでも親以外の追記として扱われる（10節の3と13節の再照合）。
- 親が Issue へ書く CI の結果（CI 判定・必須のチェックごとの結果、それを理由に含むマージ可否、merge-ready の操作とその理由）は、作業ログでは本文が `[ci-result]` で始まる `--kind test` の記録（11節・13節）だけに書く。`--kind progress`・`blocker` の要約には書かず、その記録を参照する。報告 Document では `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の印の間だけに書き、印の外には「CI の結果は印の中」とだけ書く（11節）。後のレビューの受け入れ確認への写し（8.1節）は、この印だけで CI の結果を除く。
- `mode: local` では照合しない。CI の結果は commit 済みの head に対するもので未コミット変更を含まず、変更込みの証拠に流用できないため、`finalize` は `ci-checks.ts` を起動せず、`parent/ci/1/not-run.md` に CI 判定 `対象外（未コミット）` と理由だけを書く（提出用の CI の結果は commit と push の後に取る）。未実施では `照合せず（未実施）`、評価用の事例（`prepare --case`）では `照合せず（評価用の事例）` と理由を同じく書く。
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
- 基点の指定をブランチ名に解決できない（`git -C <repo> rev-parse --symbolic-full-name <基点の指定>` が `refs/heads/<ブランチ>` でも `refs/remotes/<remote>/<ブランチ>` でもない。SHA だけで指定されたなど）ときは、`ci-checks.ts` を起動せず、`parent/ci/<n>/not-run.md` に CI 判定 `必須のチェックを決められず` と理由が書かれる。
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

照合は、このスキルの `scripts/ci-checks.ts` で行う。`ci-checks.ts` は3.1節・3.2節のとおりに GitHub を読むだけで、CI を実行・再実行せず、GitHub へ書き込まない。レビューでは `review.ts finalize`（10節の8）と `review.ts recheck-ci`（13節）が、次の引数でサブプロセスとして1回だけ起動する。親は手で起動しない。

- `--repo` は元のリポジトリ（gh が GitHub のリポジトリを決める。担当用の限定 clone ではない）、`--base` は基点の指定から解決したブランチ名（3.1節）、`--head` は `target.md` の head の SHA、`--rules` は取り直した Workspace の規約（10節の2の `parent/requirements-recheck/workspace-rules.md`、13節では `parent/recheck-<n>/requirements/workspace-rules.md`。取り直せなければ起動せず `必須のチェックを決められず`）、`--out` は `parent/ci/<n>/`（10節では 1、13節では次の番号）。
- `ci-checks.ts` の結果は `parent/ci/<n>/result.json` に出る。`verdict` が CI 判定、`required` が必須のチェックごとの出典（`sources`）・結果（`result`）・使った check run と commit status（`runs` の URL・結論・完了時刻）、`sources` が3つの出典ごとの読めた／0件／決められず と理由、`observedAt` が観測時刻、`reason` が `成功` 以外の理由、`files` が gh の生の応答（`repo.json`・`branch.json`・`rules.json`・`commit.json`・`check-runs.ndjson`・`statuses.ndjson`。取得できたものだけ）の sha256 である。gh の失敗は `errors.txt` に残る。
- 終了コードが 0 でない、または `result.json` を読めなければ、CI 判定を `取得できず` とし、終了コードと出力を `parent/ci/<n>/ci-checks.log` に残す。
- `result.json` の `head` が `target.md` の head の SHA と違えば、CI 判定を `成功` として扱わない（マージ可否の不可の理由に、head の不一致として書かれる）。
- 報告には、CI 判定・必須のチェックと出典・必須のチェックごとの結果と URL・head SHA の一致・観測時刻・記録の場所と sha256 が書かれる（11節）。gh の生の応答は本文を写さず、指紋と場所の参照だけにする。
- `ci-checks.ts` は単独でも使える（`bun <スキルのディレクトリ>/scripts/ci-checks.ts --repo <絶対パス> --base <ブランチ名> --head <40桁の SHA> --rules <絶対パス> --out <存在しないか空のディレクトリ>`。終了コード 0 は判定した、2 は引数の誤り）。PM の手順の、初回レビューと違う head の CI の記録はこれで取る。

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

委譲の直前と、親が次の工程へ進める最終返答（ハーネスの終了・失敗・取り消しの通知を含む）を受け取った直後に、役割ごとにスクリプトで記録する。試行の番号はスクリプトが決める（最初の試行は 1、4.1節の再委譲は 2）。

```sh
bun <スキルのディレクトリ>/scripts/review.ts agent --work <W の絶対パス> --role standards --event start   # 委譲の直前。Spec 探索は --role spec
bun <スキルのディレクトリ>/scripts/review.ts agent --work <W の絶対パス> --role standards --event received --agent-id <ハーネスが返した担当 ID>   # 最終返答を受け取った直後
```

- `parent/agents.md`（と `parent/agents.json`）に、役割・定義名・試行の番号・担当 ID・委譲の開始と最終返答の受領の時刻が残る。担当 ID が委譲の時点で分かれば `start` にも `--agent-id` を付けてよい。反証・受け入れ確認も `--role refute`・`--role acceptance` で同じく記録する。
- `start` は、4.1節で利用枠の上限・利用者による中止として止めた後、4.1節で委譲し直してよいと返されていない役割の2回目以降、`refute-input`（6節）が準備完了を返す前の反証では、終了コード 2 を返して記録しない。そのときは委譲しない。

### 4.1 有効な結果が無い役割の扱い（全役割に共通）

どの役割の担当でも、有効な結果が返らなかったときはこの節で扱う。有効かどうかは5節（探索）・7節（反証）・9節（受け入れ確認）の検査で決める。理由と不足箇所（未確認なら確かめる担当も）を示した未確認と、不足理由を示した受け入れ確認の「確かめられず」は有効な結果であり、不都合な指摘・判定・点数と同じく、委譲し直す理由にしない。親は判定の中身を見て委譲し直すかを決めない。

1. 失敗の種類を、ハーネスの終了通知・担当の返答・エラーの文言・検査の結果など観測できるものだけで決める。
   - **利用枠の上限**: HTTP 429、プロバイダの利用枠・rate limit の上限を示すエラー（`rate_limit_error`・`usage_limit_reached`・usage limit など）、またはプロバイダの待ち要求が retry の上限を超えた旨（omp では `Provider requested <N>ms wait, exceeds retry.maxDelayMs`）が出ている。
   - **利用者による中止**: 利用者が担当またはレビューを止めた。
   - **判定と無関係な無効**: 上の2つ以外のすべて。SKILL.md 2節の禁止規則への違反などの境界違反、引き渡し形式違反（出力ファイルが無い、必須項目の欠落、禁止項目の混入、担当行の欠落）、指定と異なる SHA・要求版の参照、入力不備（役割指定の不備・不一致）、担当の終了・失敗（認証などの実行失敗を含む）。利用枠の上限の印が無い失敗は、原因が利用枠かもしれなくてもここに入れる（観測できない原因を利用枠と推測して止めない）。
2. 判定と無関係な無効は、その役割だけを1回だけ委譲し直す。委譲し直せるかはスクリプトが決め、親は結果を変えない。
   1. 隔離・記録・同じ入力の確認をスクリプトで行う。

      ```sh
      bun <スキルのディレクトリ>/scripts/review.ts retire-attempt --work <W の絶対パス> --role <standards|spec|refute|acceptance> \
        --failure invalid --reason '<無効の理由>' [--retries '<omp 内部の再試行>']
      ```

      - `--reason` は無効の理由（検査の番号と違反の箇所、または終了通知の状態とエラーの文言）。`--retries` は omp 内部の再試行で、担当のセッションの中でハーネスが行った retry（終了通知や担当のセッション記録に出る retry の回数・待ち・エラーの文言。同じプロバイダの別の認証情報への切り替えを含む）であり、親による再委譲とは分けて書く。分からなければ省く（「記録なし」と書かれる）。
      - スクリプトは、その役割の最新の試行のサブディレクトリ（`standards/`・`spec/`・`refute/`・`acceptance/`）を中身ごと `parent/attempts/<役割>-<試行の番号>/` へ移し、同じ名前の空のサブディレクトリと `notes/` を作り直し、移したファイルの sha256 を記録する。担当は `parent/` を読まない（SKILL.md 2節）ので、委譲し直した担当も後続の担当も無効な試行の出力を読まない。無効な試行の結果は後続の担当（反証・受け入れ確認など）へ渡らない（6節の写しは隔離した試行を写さない）。
      - 続けて同じ入力を確かめる: `input/` の各ファイルと `manifest.md` の sha256 が `parent/prepare.json` の記録と一致し、依存の写しの指紋の一覧を2.2節と同じ方法で作り直して `input/deps-files.sha256` と一致し、限定 clone の確認（2.1節）をやり直して `prepare` の結果と同じになること。反証では `refute-input/` の各ファイルの sha256 も写したときの記録（`parent/refute-input.json`）と、受け入れ確認では `acceptance-input/` の各ファイルの sha256 も写したときの記録と比べる（受け入れ確認の写しは取り直さない）。
      - 結果は `parent/attempts.md`（と `parent/attempts.json`。役割・定義名・試行の番号・担当 ID・失敗の種類・無効の理由・omp 内部の再試行・隔離先と各ファイルの sha256・同じ入力の確認・委譲し直すか）と `parent/identity.md` に書かれる。標準出力の JSON の `redelegate` が委譲し直せるか、`status`・`finalReason` が委譲し直せないときの最終状態 `未完了` とその理由を示す。
      - 同じ入力でなければ `redelegate` は false で、`未完了`（理由: 有効な結果なし（<役割>。同じ入力を固定できず委譲し直さなかった））になる。委譲し直さない。
   2. 委譲し直す（`redelegate` が true のときだけ）: 同じ定義へ、最初の試行と一字も違わない依頼本文（4節・6節・8節）と同じ共通の context で、新しいタスクとして新しいコンテキストで起動する。最初の担当への追送や再開は使わない。依頼本文・context に、最初の試行があったこと・無効の理由・その出力を入れない。モデルやアカウントを指定・変更しない。委譲の前後は4節と同じく `agent` で記録する（試行の番号 2 になる）。
   3. 検査する: 委譲し直した担当の結果を、最初と同じ検査（5節・7節・9節）にかける。有効ならその結果を使う。無効なら、同じく `retire-attempt` で `parent/attempts/<役割>-2/` へ移して記録する。スクリプトは `redelegate` を false、`未完了`（理由: 有効な結果なし（<役割>。1回の再委譲の後も））を返し、それ以上委譲し直さない。委譲し直した担当が利用枠の上限で失敗した場合は、3と同じく `--failure usage-limit` にする。
   - 委譲し直すのは役割ごとに1回だけ。最初の試行と委譲し直した結果を比べて選ばない。無効な出力を、修正の依頼・担当の再開・親の補筆で有効にしない。
   - 探索の片方だけが無効なら、その役割だけを委譲し直し、有効だった役割の結果はそのまま使う。両方が無効なら、両方を同じ手順で同時に委譲し直す。他方の探索の終了を待たずに委譲し直してよい。両探索の有効な結果がそろうまで反証を起動しない。
3. 利用枠の上限による失敗は、委譲し直さず、その時点で止める。`retire-attempt --failure usage-limit --reason '<終了通知の状態とエラーの文言>' [--retries '<omp 内部の再試行>']` で、2の1と同じく隔離して記録する。スクリプトは `redelegate` を false、`未完了`（理由: 利用枠の上限、有効な結果なし（<役割>））を返す。
   - それ以後はどの役割も委譲し直さず、まだ起動していない担当（反証・受け入れ確認など）を起動しない（`agent --event start` も終了コード 2 を返す）。並列で実行中の担当は打ち切らずに終了を待ち、受領済みの成果として `agent --event received` で記録する（有効でも反証は起動しない）。
   - 別アカウントへの切り替え、利用枠の回復待ち、利用枠のリセットの使用、別モデルへの切り替えをしない。
4. 利用者による中止は委譲し直さず、`retire-attempt --failure aborted --reason '<中止の状況>'` で記録する。スクリプトは `未完了`（理由: 利用者による中止）を返し、以後の `agent --event start` は終了コード 2 を返す。

## 5. 探索の引き渡し用ファイルを検査する

親は引き渡し用ファイルを書き換えない（補筆・削除・要約・整形をしない）。各担当の最終返答を受け取ったら（4節の `received` の後）、役割ごとに次の1〜8を確かめる。1と、7のうち本文への混入は親が確かめ、それ以外はスクリプトで機械的に検査する。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-explore --work <W の絶対パス> --role standards   # Spec 探索は --role spec
```

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない（親が返答で確かめる。入力不備・失敗なら、検査せずに4.1節へ進む）。
2. 指定したパスに `handoff.md` がある。
3. 役割・定義名・対象版・要求資料・依存の写しが書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する（merge-base と head の SHA があり、それ以外の SHA が無い。`mode: local` では `local/` の各ファイルの sha256 もある）。終了状態、未確認と理由、判断を見送った事項の節がある（無いことを明示していてもよい）。
4. 各候補に必須項目（SKILL.md の4節）がそろい、候補 ID が役割の接頭辞を持ち重複しない。候補一覧または「候補0件」の明示がある。証拠を取得できなかった候補には理由と不足箇所がある。
5. Standards 探索: 規約の一覧と今回の差分への適用判断がある。Spec 探索: 要求資料の判別の節がある。
6. Spec 探索: 要求ごとの対応表が雛形の4列（要求の出典・状態・証拠または不足理由・候補ID）で、`requirements/` のすべてのファイルを出典に含み、状態が SKILL.md の語彙だけを使う（「受け入れ確認担当」は反証だけが付ける状態だが、Spec 探索が書いていても形式違反にしない。反証が確かめ直して確定する）。未充足・未確認の行に候補 ID があり、対応表が参照する ID がすべて候補一覧にある。列の確認は雛形の見出しと各行の「出典・状態・候補ID」の位置で行い、セル内のコードや文字列に含まれる `|` だけを理由に列数違反としない（Markdown の表示上で列が崩れていても、出典・状態・候補ID が読み取れれば形式違反にしない）。
7. 禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が項目名にも本文にも無い。スクリプトは見出し・箇条の項目名・表の見出しだけを調べる。項目名だけの検査では内容の混入まで保証できないので、スクリプトの検査に通った引き渡しは、親が本文を通読して確かめる（探索2件だけ。反証の判定本文と受け入れ確認の結果は通読しない）。
8. 担当が共通入力・依存の写し・限定 clone を変えていない（スクリプトが4.1節の2の1と同じ同一性の確認をやり直す）。

- 結果は標準出力の1行の JSON（`valid`、`violations` の検査の番号と違反の箇所、検査した `handoff.md` の `sha256`、`identity`）と、`parent/checks.md`（と `parent/checks.json`。担当のサブディレクトリの各ファイルの sha256 を含む）に書かれる。同一性の確認は `parent/identity.md` にも残る。
- 有効な結果は、1を親が確かめ、スクリプトの `valid` が true で、7の本文の通読で混入が無かったものだけとする。

全確認単位を覆っているかの意味上の判断は反証担当が行う。親とスクリプトの検査は形式と参照の確認であり、内容の正しさの保証ではない。
どちらかの担当に違反・欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は `retire-attempt --failure invalid --reason '<5節の番号と違反の箇所>'` で隔離し、その役割だけを1回だけ委譲し直して同じ検査をする）。両探索の有効な結果がそろうまで反証を起動しない。4.1節の後もどちらかの有効な結果が無ければ、反証を起動せず、最終状態を `未完了` とする（10節へ進む）。

## 6. 反証への入力を写し、反証を委譲する

両探索が5節の検査を通過したときだけ、検査済みの引き渡し用ファイルと共通入力を、内容を変えずにスクリプトで `refute-input/` へ写す。4.1節で委譲し直した役割は、委譲し直した担当の引き渡し用ファイル（同じ場所にある）が写る。

```sh
bun <スキルのディレクトリ>/scripts/review.ts refute-input --work <W の絶対パス>
```

- スクリプトは、両探索の最新の試行がスクリプトの検査に合格し、隔離されていないときだけ、`standards/handoff.md` を `refute-input/standards-handoff.md`、`spec/handoff.md` を `refute-input/spec-handoff.md` へ、`input/` の `target.md`・`manifest.md`・`requirements/`・`local/`（`mode: local` のときだけ）・`deps-files.sha256`（依存の写しを準備できたときだけ）を `refute-input/` へ写す。そろっていなければ終了コード 2 を返して何も写さない（反証を起動しない）。
- 写した各ファイルの sha256 を、検査時に記録した引き渡し用ファイルの指紋と `prepare` の `input/` の指紋に照合し、共通入力・依存の写し・限定 clone の同一性もやり直して、`parent/fingerprints.md` に書く。結果は標準出力の JSON と `parent/refute-input.json`（`ready`、写しの各ファイルの sha256 の `files`、照合の `comparison`、`identity`）に出る。
- `ready` が false なら `status` は `未完了`、`reason` は `反証への入力を固定できず、反証の有効な結果なし` で、写し直さず、反証を起動しない（10節へ進む）。
- 探索のサブディレクトリ全体、`notes/`、一時ファイル、探索の返答・会話出力、`parent/attempts/` の無効な試行、親の要約は写さない。

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

反証担当の最終返答を受け取ったら（4節の `received` の後）、`verdict.md` を書き換えずに次の1〜7を確かめる。1のうち返答が入力不備・失敗でないことは親が確かめ、それ以外はスクリプトで機械的に検査する。親は判定本文を通読しない。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-refute --work <W の絶対パス>
```

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない（親が返答で確かめる。入力不備・失敗なら、検査せずに4.1節へ進む）。指定したパスに `verdict.md` がある。
2. 役割・定義名・対象版・受け取った入力・依存の写し・終了状態が書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。
3. 両方の引き渡し用ファイルのすべての候補 ID と反証で追加した発見（`REF-<n>`）が採否一覧に1回ずつあり、判定が語彙のどれかで、根拠がある。要対応には影響度 0〜4 があり、要対応以外には影響度が無い。要対応の節の各見出し（`CAUSE-<n>` か候補 ID）が採否一覧の要対応の候補とその同一原因に一致し（同一候補の判定の不一致が無い）、同一原因の影響度が、含まれる要対応の候補の影響度の最小値と同じ。
4. 要求ごとの対応表が雛形の4列で（列の確認は5節の6と同じく、セル内の `|` だけを理由に違反としない）、状態が語彙だけを使い、未充足の行に採否一覧で要対応の候補 ID があり、参照する候補 ID がすべて採否一覧にある。Spec 探索の対応表のすべての行が、同じ要求の出典の行として、または「分割・追加した行」の節の分割元の出典として確定している。Spec 探索の行と同じ出典でない対応表の行には、すべて分割・追加した行の節に分割元の出典（足した行は「なし（追加）」）がある。
5. 反証で追加した発見（無ければ「反証で追加した発見なし」の明示）と、判断を見送った事項がある。未確認と理由が雛形の表で、判定が未確認のすべての候補と状態が未確認の対応表のすべての行が、軸・種別・理由・確かめる担当・不足箇所とともにある。軸ごとの要対応と未確認の件数が、要対応の節の軸ごとの件数と、未確認と理由の表の軸ごとの行数と一致する。
6. 受け入れ確認担当の行の節がある（行が無ければ「なし」の明示）。対応表で状態が「受け入れ確認担当」の行がすべてこの節に同じ要求の出典であり、各行に確かめること（成果物・作業・手順・配置）と必要な外部の正本（要らなければ「なし」）がある。この節にあって対応表に無い行が無い。
7. `refute-input/` の各ファイルの sha256 が写したときの記録（`parent/refute-input.json`）と一致する。依存の写しの指紋の一覧と限定 clone の確認を5節の8と同じくやり直し、委譲前と同じ結果になる。

- 結果は標準出力の1行の JSON（`valid`、`violations` の検査の番号と違反の箇所、検査した `verdict.md` の `sha256`、`identity`、受け入れ確認担当の行の件数 `acceptanceRows` と `acceptanceRequired`）と、`parent/checks.md`（と `parent/checks.json`）に書かれる。スクリプトは読み取れない欄・食い違う欄を推測で補わず、違反として返す。
- `valid` が true のときだけ、スクリプトは読み取った構造（採否一覧、要対応の節、対応表の全行と分割元の出典、未確認と理由の表、受け入れ確認担当の行、軸ごとの件数）を `parent/refute-structure.json` に、受け入れ確認担当の行を `parent/acceptance/rows.md` に書く。10節の点数と確認が残る事項は、この構造から求める。
- 有効な結果は、1を親が確かめ、スクリプトの `valid` が true のものだけとする。

欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は `retire-attempt --role refute --failure invalid --reason '<7節の番号と違反の箇所>'` で隔離し、反証だけを1回だけ委譲し直して同じ検査をする。探索の結果はそのまま使う）。4.1節の後も有効な結果が無ければ、受け入れ確認担当を起動せず `未完了` とする（10節へ進む）。理由と確かめる担当を示した未確認は有効な結果であり、それだけでは `未完了` にせず、委譲し直す理由にもしない。
反証の有効な結果を受け取ったら8節へ進む。

## 8. 受け入れ確認への入力を写し、受け入れ確認を委譲する

7節の `check-refute` は、検査を通過した `refute/verdict.md` の「要求ごとの対応表（確定）」で状態が「受け入れ確認担当」の行の件数と各行（要求の出典・確かめること・必要な外部の正本・候補ID）を `parent/acceptance/rows.md` に書く（結果の `acceptanceRows`・`acceptanceRequired`）。

- 0行（`acceptanceRequired` が false）なら受け入れ確認担当を起動せず、`acceptance-input/` も作らない（8.1節のスクリプトは終了コード 2 を返す）。報告に「受け入れ確認担当の行なし（起動せず）」と書いて10節へ進む。
- 1行以上なら、受け入れ確認担当は必要な担当である。起動し忘れたまま10節へ進んで `完了` にしない。委譲できない・有効な結果が返らない場合は4.1節で扱い、有効な結果が無ければ `未完了` とする。

### 8.1 写しを取る

委譲の直前に、次の2つのスクリプトの呼び出しで写しを取る。親が行うのは、その間の写す参照の一覧の決定（2）だけで、中身を選別・要約・抜粋・改変しない（CI の結果の印による除外だけを例外とし、スクリプトが行う）。探索の引き渡し用ファイル、反証の `notes/`、担当の返答、`parent/` の記録（CI の照合の記録 `parent/ci/`、依存の準備の記録 `parent/deps/`、無効な試行 `parent/attempts/` を含む）は写さない。

1. 共通入力・反証の判定本文・Activity・添付 Document を写す。

   ```sh
   bun <スキルのディレクトリ>/scripts/review.ts acceptance-records --work <W の絶対パス>
   ```

   - `input/` の `target.md`・`manifest.md`・`requirements/`・`local/`（`mode: local` のときだけ）・`deps-files.sha256`（依存の写しを準備できたときだけ）と、検査を通過した反証の判定本文を丸ごと（該当行だけを抜き出さずに）`acceptance-input/refute-verdict.md` へ写す。
   - Issue があれば、委譲の直前の Activity の全件（`nod --json issue show` の `.activity`。作業ログ・コメント・返信・イベント）と、Issue に現在リンクされたすべての Document（kind を問わない。`nod --json doc show` の本文）を写す。元の写しは `parent/acceptance/issue-snapshot.json`・`parent/acceptance/activity.json`・`parent/acceptance/documents/document-<ID>.md` に残り、CI の結果を除いた写しが `acceptance-input/records/activity.json`・`acceptance-input/records/documents/document-<ID>.md` になる。取得時刻・Document ID・kind・パスと、実行したコマンドが `parent/acceptance/records.json` に記録される。
   - 写した Activity の本文・Document の本文と、反証の判定本文の「受け入れ確認担当の行」の「必要な外部の正本」の欄から、絶対パス・URL・Document ID（Issue にリンクされたものを除く）を場所付きで機械的に挙げ、`parent/acceptance/ref-candidates.json`（`--refs` にそのまま渡せる形）と `parent/acceptance/ref-candidates.md`（候補の表と、リポジトリの分からない Git の revision らしい文字列）に書く。
2. 親が写す参照の一覧を決める。`ref-candidates.md` の各候補を、場所の列が指す写しの該当箇所で確かめ、明示参照でないものを除き、候補に漏れた明示参照を足す（`evidence/` に写すのは下の2種類だけ）。要否や関連では選ばず、明示参照をすべて渡す。Git のリポジトリと revision の参照は `type` を `git` にして `revision`（名指しが無ければ省く）と `path`（版履歴なら `history: true`）を足す。一覧は `ref-candidates.json` と同じ形の JSON の配列で、親専用領域（`parent/acceptance/` など）に置く。各要素は `type`（`file`・`git`・`document`・`url`）、`source`（絶対パス・Git のリポジトリの絶対パス・Document ID・URL）、`revision`・`path`・`history`（`git` だけ）、`kind`（`参照された記録`・`外部の正本`・`明示された証拠`）、`from`（参照元: `activity:<id>`・`activity@<時刻>`・`document:<ID>`・`受け入れ確認担当の行 <要求の出典>`・`利用者の明示`）、`at`（写しの該当箇所）、`quote`（参照の原文）、`version`（参照で指定された版。原文のまま、無ければ「記載なし」）。写す参照が無ければ `[]` とする。
3. 証拠を取得し、目録と指紋を作る。

   ```sh
   bun <スキルのディレクトリ>/scripts/review.ts acceptance-input --work <W の絶対パス> --refs <2の一覧の JSON の絶対パス>   # 評価用の事例では --refs を省く
   ```

   - 一覧に読めない要素があれば、終了コード 2 を返して何も写さない。一覧を直して実行し直す。
   - 同じ出典・版の参照は1項目にまとめ、1件ごとに `evidence/<n>/` を作って、出典の形に応じて下の表のどれか1つの読み取りだけで、まず親専用領域の `parent/acceptance/evidence/<n>/`（元の写し）へ写し、その各ファイルから CI の結果を印だけで除いて `acceptance-input/evidence/<n>/` の同じ名前へ写す。表のどれにも当たらない、または読み取りが失敗した場合は、写しを作らずに取得不能と理由を記録する。
   - 「受け入れ確認担当の行」で必要な外部の正本が「なし」でない行のうち、その行を参照元（`from`）とする外部の正本が一覧に無い行は、取得不能（出典の場所が名指しされていない）として記録する（場所を探さない）。
   - 目録 `acceptance-input/records.md`、親専用の記録（下）、委譲前の指紋 `parent/acceptance/fingerprints.md` を作り、写した共通入力の sha256 を `input/` の指紋と、`refute-verdict.md` の sha256 を `check-refute` で検査した `refute/verdict.md` の指紋と、`records/` と `evidence/` の各ファイルを写したときの記録と照合し、共通入力・依存の写し・限定 clone の同一性もやり直す。結果は標準出力の JSON と `parent/acceptance-input.json`（`ready`、`acceptance-input/` の全ファイルの sha256 の `files`、照合の `comparison`、`identity`、取得不能の項目の一覧 `unavailable`）に出る。
   - `ready` が false なら `status` は `未完了`、`reason` は `受け入れ確認への入力を固定できず、受け入れ確認の有効な結果なし` で、写し直さず、受け入れ確認担当を起動しない（`agent --role acceptance --event start` も終了コード 2 を返す。10節へ進む）。

- 写しの元は、委譲の直前に取った Activity と、Issue に現在リンクされたすべての Document（kind を問わない）の本文とする。
- CI の結果（3節）は印だけで除く。除くのは、本文が `[ci-result]` で始まる Activity の作業ログ・コメント（その返信を含む）、残したコメントの返信のうち本文が `[ci-result]` で始まるもの（入れ子があればその中も）、`records/` の Document と `evidence/<n>` の各ファイル（Issue にリンクされていない Document、通常のファイル、Git のファイル、URL の本文などを含む）の `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の印の行の間（「（CI の結果は親だけが扱うため除いた）」に置き換える）と、本文が `[ci-result]` で始まる Document・ファイル（本文全体を同じ文に置き換える）だけとする。本文の意味で選別しない。印の無い記録に CI の結果が混ざっていても除かず、担当が SKILL.md 2節のとおり使わずに混入として報告する。
- 除く前の元の写し（`parent/acceptance/activity.json`・`parent/acceptance/documents/`・`parent/acceptance/evidence/<n>/`）は親専用領域に残る。10節の3と13節の再照合は元の写しと比べ、除いた項目も親自身の記録かどうか（own-logs）の扱いを変えない。`scripts/copy-evidence.ts` の観測（`observation.txt` の行と結果の `observationSha256`）は元の写しに対するもので、置き換えた後の写しの指紋ではない。
- Issue の無い単独レビューでは Activity と Document を写さず、利用者が証拠として明示したファイル・Document だけを、`kind` を `明示された証拠`・`from` を `利用者の明示` として一覧に入れ、下の参照された記録と同じ条件で `evidence/` に写す。明示が無ければ `[]` を渡し、`records.md` に「Issue なし、明示された証拠なし」と書かれる。反証が名指しした外部の正本は、Issue の有無にかかわらず下のとおり写す。
- 評価用の事例（`prepare --case` で作った作業ディレクトリ）では、nod から取らず、`--refs` を省く。スクリプトは事例の入力に固定した証拠（`inputs/<case-id>/evidence/` の各ファイル）を `copy-evidence.ts` を通さずに `evidence/<n>/` へ写し、sha256 を事例の `manifest.md` と照合する（一致しなければ `ready` は false）。固定した証拠が無ければ `records.md` に「明示された証拠なし」と書かれ、名指しされた外部の正本は取得不能（当時の版を取れない）になる。
- `evidence/` に写すのは次の2種類だけとする。証拠の要否や関連を親が判断して選ばない。親が自分で正本や証拠を探したり、作ったりしない。
  - 参照された記録: `records/` に写した Activity の本文と Document の本文が明示的に参照する成果物・実行記録・配置先（パス・URL・Document ID・Git のリポジトリと revision）。
  - 名指しされた外部の正本: 検査を通過した反証の判定本文の「受け入れ確認担当の行」の節の「必要な外部の正本」の欄に書かれた出典と版（版履歴の出典が書かれていれば、それも1件として扱う）。出典の場所（パス・URL・Document ID・Git のリポジトリ）が書かれていなければ一覧に入れず、スクリプトが取得不能（出典の場所が名指しされていない）とする。

| 出典の形（`type`） | 読み取り（スクリプトはこれだけを行う） | 識別情報として記録するもの |
|---|---|---|
| 絶対パス（`~` で始まるものを含む）の通常のファイル（`file`） | このスキルの `scripts/copy-evidence.ts` で、本文を開く前にパスの名前と各要素の種類・大きさを検査し、通ればそのファイル1つを `evidence/<n>/copy` へ写し、観測を `evidence/<n>/observation.txt` に書く。このレビューの作業ディレクトリ `<W>` の配下は呼ぶ前に取得不能にする | `observation.txt` の sha256（結果の `observationSha256`） |
| Git のリポジトリのパスと revision（とファイル）、またはその版履歴（`git`） | `git -C <dir> rev-parse --verify '<revision>^{commit}'` で commit を固定し（revision の指定が無ければ取得時の `HEAD`）、ファイルは `git -C <dir> --no-pager show --no-textconv <commit>:<file>` を `evidence/<n>/<file の名前>` へ、版履歴は `git -C <dir> --no-pager log --no-ext-diff --no-textconv --format='%H%x09%cI%x09%aI%x09%s' <commit> -- <file>` を `evidence/<n>/history.txt` へ写す（ファイルの指定が無ければ同じ形式の `log -1` を `commit.txt` へ）。`fetch`・`checkout` など Git の状態を変える操作と、作業ツリーを読む操作（`status`・`diff`）はしない | 固定した commit の SHA、名前で指した revision（ブランチ・タグ）とそれが指す commit |
| Issue にリンクされていない Document の ID（`document`） | `nod --json doc show <ID>` の `.content` を `evidence/<n>/document-<ID>.md` へ写す（Issue にリンクされた Document は `document:<ID>` として写し済みなので写さない） | 本文の sha256 |
| `https://` の URL（`url`） | 認証情報・cookie・設定ファイルを使わない GET を1回だけ行う: `curl -q -fsS --proto '=https' --proto-redir '=https' --max-redirs 5 --max-time 60 --max-filesize 20000000 -D <dir>/headers.txt -o <dir>/body -w '%{http_code} %{url_effective}\n' '<URL>'` | 応答の状態と最終の URL、本文の sha256（`ETag`・`Last-Modified` があれば写す） |

- 通常のファイルとして写すのは、明示的に参照されたファイル1つだけとする。リンクは辿らず、ディレクトリの配下も写さない。`copy-evidence.ts` は本文を開く前に、まず名前だけで、SKILL.md 2節の秘密候補の名前（パスのどこかの要素が当たるもの）、`.`・`..`・空の要素（`//`・末尾の `/`）を含むパス（書かれたパスと読むパスがずれ得る）、レビューの作業ディレクトリ（`~/.local/share/nod/code-reviews/` の配下。過去のレビューと、このレビューの `<W>` とその親専用領域 `<W>/parent/` を含む）と常設データセット（`~/.local/share/nod/review-evaluation/` の配下）を調べる。この2つの領域は大文字小文字を区別せずに比べる。続けてルートから出典までの各要素を `lstat` だけで調べ、どれかの要素がシンボリックリンク、出典がディレクトリか通常のファイル以外（FIFO・デバイス・ソケット）、大きさが上限の 20000000 バイト（URL の行の `--max-filesize` と同じ）を超える、のどれかなら本文を読まない。読むときは最後の要素のリンクを開かない指定で開き、検査したファイルと同じであることを確かめてから読み、読んだ後に各要素がリンクに変わっていない・置き換わっていないことを確かめ直す。
- `copy-evidence.ts` の取得不能の理由（目録の取得の可否と理由の欄に `code` と `message` が書かれる）: `SECRET_CANDIDATE`（秘密候補。当たったパスも書かれる）、`NON_CANONICAL_PATH`（`.`・`..`・空の要素を含む）、`FORBIDDEN_AREA`（レビューの作業ディレクトリ・親専用領域・常設データセットの配下）、`SYMLINK_IN_PATH`（パスのどこかの要素がシンボリックリンク。検査の後や読む間にリンクへ変わったものを含む）、`NOT_REGULAR_FILE`（ディレクトリ、または FIFO・デバイス・ソケットなどの通常のファイル以外）、`TOO_LARGE`（上限サイズを超える）、`NOT_FOUND`（存在しない）、`READ_FAILED`（権限などの読み取りの失敗、検査の後や読む間に別のファイルへ置き換わった）、`UNEXPECTED_ERROR`（写しの途中の失敗。作りかけの写しは消す）。観測は `file<TAB><出典のパス><TAB><バイト数><TAB><sha256>` の1行とする。
- 取得不能になった参照を、親は別の方法（リンク先やディレクトリの中のファイルを親が選んで写す、リンクを辿る、別の URL を探すなど）で取り直さない。その証拠に依存する行は受け入れ確認担当が「確かめられず」とし、確認が残る事項に入るので、マージ可にならない（10節）。
- 取得不能とするもの（写さない）: 秘密情報を含み得るパス（SKILL.md 2節の名前。Git のリポジトリのパスとファイルも同じ）と、利用者情報（`user:pass@`）や名前に `token`・`key`・`secret`・`password`・`signature`・`sig`・`credential`・`X-Amz-` を含むクエリを持つ URL（秘密候補）、絶対パスのうちパスのどこかにシンボリックリンクを含むもの・ディレクトリ・通常のファイル以外・上限サイズを超えるもの・`.` や `..` や空の要素を含むもの、過去のレビューの作業ディレクトリ・このレビューの作業ディレクトリ `<W>`（親専用領域 `<W>/parent/` を含む。担当へ渡さない）・常設データセット（`~/.local/share/nod/review-evaluation/`）の配下、存在しないもの、`https://` 以外の URL・別のホスト（`ssh` など）・認証が要るもの（HTTP 401・403・407 など）・表の外のコマンドやスクリプトの実行が要るもの（読み取り手段が無い）、名指しの Git の revision が無いもの（名指しの版との対応を示せない）。
- リポジトリ内の相対パスと、対象リポジトリの commit（限定 clone にある commit）: 写さない。担当が限定 clone の固定版で読む（目録にそう書かれる）。
- 親は2の一覧の決定のほかに、任意のスクリプトの実行、対象コードの再現、デプロイ、書き込み、認証情報の引き渡しをしない。既存の実行記録を写して読むことは、要実行確認の解消にも、3節の CI の結果の代わりにもならない。名指し・参照された版と写しの対応を親は判断しない。Git の revision を commit に固定できたとき以外は「親は確かめていない（出典の場所が示すのは取得時刻の内容）」と記録され、判断は担当に任せる。
- 目録 `acceptance-input/records.md`（受け入れ確認担当が読む）は、項目ごとに1行の表と、ファイルの表、CI の結果の除外の表からなる。
  - 項目の表の列: 項目 ID（Activity のコメント・作業ログ・返信は `activity:<id>`、それ以外の項目は `activity@<時刻>`、Issue にリンクされた Document は `document:<ID>`、証拠は `evidence/<n>`）・種類・参照元・出典・参照で指定された版・取得方法の種別・取得物の識別情報・親が示せた版の対応（または未確認）・参照の原文（写しの該当箇所）・取得の可否と理由・取得時刻・写し先と sha256・元の写しの sha256（Document と `evidence/<n>` は置き換えた写しと元の写しの両方）。
  - ファイルの表: `acceptance-input/` の各ファイル（`records.md` を除く）の sha256 と出典（共通入力は `manifest.md` と同じ出典、反証の判定本文は `refute/verdict.md` と担当 ID、Activity は Issue ID と取得時刻、Document は ID・kind・パス・取得時刻）。
  - CI の結果の除外の表: 除いた Activity の項目 ID（返信は `activity:<コメントの id> の返信 <返信の id>`）、印の間または本文全体を置き換えた Document の ID と `evidence/<n>` のファイルのパスと、それぞれの元の本文の sha256。除いたものが無ければ「なし」。
- 実際に実行した読み取りのコマンドの全文・終了コード・出力と取得の詳細は、目録に入れず親専用領域に置く（10節の3で同じ方法で取り直すため、取り直しに要る情報を省かない）: `parent/acceptance/evidence.json`（項目ごとの参照の一覧・出典・revision・path・取得の方法・コマンドの argv と終了コード・固定した commit・名前で指した revision・最終の URL・元の写しの sha256）と `parent/acceptance/evidence.md`（コマンドの一覧）、`parent/acceptance/items.json`（目録の項目と同じもの）、`parent/acceptance/records.json`（Activity・Document の取得のコマンドと記録）、`parent/acceptance/refs.json`（渡した参照の一覧）。

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

受け入れ確認担当の最終返答を受け取ったら（4節の `received` の後）、`result.md` を書き換えずに次の1〜6を確かめる。1のうち返答が入力不備・失敗でないことは親が確かめ、それ以外はスクリプトで機械的に検査する。親は結果の本文を通読しない。証拠が十分かどうかの判断はしない（担当の役割）。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-acceptance --work <W の絶対パス>
```

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない（親が返答で確かめる。入力不備・失敗なら、検査せずに4.1節へ進む）。指定したパスに `result.md` がある。
2. 役割・定義名・対象版・受け取った入力が書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。
3. `parent/acceptance/rows.md` のすべての行が、同じ要求の出典で行ごとの判定にある（担当行の欠落・重複・余分が無い）。
4. 各行に、要求の出典・対象版・判定（確認済み／未充足／確かめられず のどれか）・成果物の不変版の存在・作業・手順の実施・現在の配置・外部の正本との内容の一致・更新順序（それぞれ判定か「対象外（要求が求めていない）」で始まる）・証拠・不足理由がある。確認済み以外の行の不足理由が「なし」や空ではない。行の判定が5つの部分の判定と食い違わない（確認済みなら未充足・確かめられずの部分が無い、未充足なら未充足の部分がある、確かめられずなら未充足の部分が無く確かめられずの部分がある）。未充足・確かめられずの行の表に、行ごとの判定で未充足・確かめられずの行が同じ要求の出典・判定で1行ずつあり、不足箇所（5つの部分の名前）と不足理由がある。
5. 判定に使った証拠の表（無ければ「なし」）の各項目が、`records.md` の項目 ID（`parent/acceptance/items.json` の id: `activity:<id>`・`activity@<時刻>`・`document:<ID>`・`evidence/<n>`）か「限定 clone」で、使った行が受け入れ確認担当の行の要求の出典を指す。反証の判定と矛盾する証拠の表（反証の判定の箇所・矛盾する証拠・理由。無ければ「なし」）と、判断を見送った事項の節がある。
6. `acceptance-input/` の各ファイルの sha256 が写したときの記録（`parent/acceptance-input.json`。`parent/acceptance/fingerprints.md` と同じ）と一致する。依存の写しの指紋の一覧と限定 clone の確認を5節の8と同じくやり直し、委譲前と同じ結果になる。

- 結果は標準出力の1行の JSON（`valid`、`violations` の検査の番号と違反の箇所、検査した `result.md` の `sha256`、`identity`、合格なら件数 `rows`・`gaps`・`conflicts`・`used`）と、`parent/checks.md`（と `parent/checks.json`）に書かれる。スクリプトは読み取れない欄・食い違う欄を推測で補わず、違反として返す。
- `valid` が true のときだけ、スクリプトは読み取った構造（行ごとの判定、未充足・確かめられずの行、判定に使った証拠と使った行、反証の判定と矛盾する証拠）を `parent/acceptance-structure.json` に書く。10節はこの構造から求める。
- 反証の判定と矛盾する証拠の報告は有効な結果であり、形式違反ではない（10節の6で確認が残る事項になる）。スクリプトが確かめるのはその表の形だけで、矛盾の中身の当否は判断しない。
- 有効な結果は、1を親が確かめ、スクリプトの `valid` が true のものだけとする。

欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は `retire-attempt --role acceptance --failure invalid --reason '<9節の番号と違反の箇所>'` で隔離し、受け入れ確認だけを1回だけ委譲し直して同じ検査をする。探索と反証の結果はそのまま使う）。4.1節の後も有効な結果が無ければ `未完了` とする。不足理由を示した「確かめられず」と「未充足」は有効な結果であり、それだけでは `未完了` にせず、委譲し直す理由にもしない。不足があっても、同じ実行の中で証拠を足して判定し直させない。

## 10. 最終状態・点数・確認が残る事項・マージ可否を決める（スクリプト）

必要な担当の結果の検査を終えたら（4.1節・5節・7節・9節で止めて `未完了` になったとき、`prepare` が `未実施` を返したときも）、保存の直前に次を1回だけ実行する。スクリプトが次の1〜8と11節（報告の組み立て・保存・照合・作業ログ・merge-ready）を順に行う。親は判定本文・受け入れ確認の結果を読まず、点数・確認が残る事項・マージ可否を手で求めない。

```sh
bun <スキルのディレクトリ>/scripts/review.ts finalize --work <W の絶対パス> [--own-log <写しの後に親が Issue へ書いた記録の id>]...
  # 担当を1つも起動しなかった（委譲できない環境など）ときは --not-run-reason '<理由>' を足す
```

- 終了コード 2 は引数の誤り（実行済み、`parent/ci/1/` が空でない、最終返答の受領を記録していない・検査していない最新の試行がある、`--own-log` が数字でない、など）で、判定ではない。示された記録・検査をしてから実行し直す。実行済みの作業ディレクトリでは保存し直さない（CI の完了後の判定し直しは13節）。
- 結果は標準出力の1行の JSON と `parent/finalize.json` に出る（下の「finalize の結果」）。

1. `mode: local` では、土台の HEAD と差分（指定された未追跡ファイルを含む）を同じ方法で `parent/local-recheck/` へ取り直し、土台の HEAD と `input/local/` の写しの sha256 と比べる。変わっていれば、確認が残る事項に「未コミット変更の土台 HEAD・差分の変化」（出典: 変わった写し、確かめる担当: 人、理由: 固定した変更と現在の変更が異なる）を加える。
2. 要求の本文・資料だけを2.3節と同じ方法で `parent/requirements-recheck/` へ取り直し（Issue の `nod issue show` の全出力は `parent/requirements-recheck/issue-snapshot.json`。評価用の事例は事例の入力 `inputs/<case-id>/` から写し直す）、`input/requirements/` と sha256 で比べる（Issue のタイトルと本文、現在リンクされている `kind=spec` の集合と本文、計画の出典が指す Document、Workspace の規約。単独レビューでは明示された要求）。Activity・進捗・更新日時はここでは比べない（受け入れ証拠は3で扱う）。変わっていれば旧要求に対する結果として保存し、確認が残る事項に「保存時の要求の変化」（出典: 変わった資料、確かめる担当: 人、理由: 現在の要求への適合を確かめていない）を加える。
3. 受け入れ確認担当の有効な結果があるときは、結果の「判定に使った証拠」の表の項目（限定 clone を除く）と、そのうち `evidence/<n>` の参照元（`parent/acceptance/evidence.json` の参照の `from` が `activity:<id>`・`activity@<時刻>`・`document:<ID>` のもの）だけを取り直し、`parent/acceptance-recheck/` に置いて固定時と比べる。固定時は、8.1節で CI の結果を除く前の元の写し（`parent/acceptance/activity.json`・`parent/acceptance/documents/`・`parent/acceptance/evidence/<n>/` と、`parent/acceptance/items.json` に記録した元の写しの sha256）とする。取り直した時刻・比べた結果・実行したコマンドは `parent/acceptance-recheck/recheck.json` に残る。
   - `evidence/<n>`: `parent/acceptance/evidence.json` に記録した参照と読み取りの方法で、同じ出典から取り直す（絶対パスは同じ `scripts/copy-evidence.ts` で、8.1と同じ検査（秘密候補の名前、`.`・`..`・空の要素、レビューの作業ディレクトリ・常設データセットの配下、パスのリンク、通常のファイルか、上限サイズ）をして写しと観測を取り直す。Git は名前で指した revision の解決と同じ commit の読み取り、Document は本文、URL は GET）。写しと観測の sha256（HTTP の応答の見出し `headers.txt` は比べない）、Git の revision が指す commit、最終の URL を固定時と比べる。評価用の事例では事例の入力の同じファイルを写し直して比べる。固定時に写していない項目（取得不能・写さない）は比べる写しが無いので、その旨だけを書く。
   - `activity:<id>`・`activity@<時刻>`、および `evidence/<n>` の参照元の Activity の項目: `nod --json issue show` を `parent/acceptance-recheck/issue-snapshot.json` へ取り直し、目録と同じ付け方の項目 ID で、同じ項目の有無、本文の sha256、解決の状態を比べる（固定の後に足された返信は次の親以外の追記で扱う）。
   - `document:<ID>`、および `evidence/<n>` の参照元の Document: 取り直した Issue に同じ Document がリンクされているかと、`nod --json doc show <ID>` の本文の sha256 を比べる。
   - 固定の後に足された Activity（取り直した Activity のうち、固定時の元の写しに無いコメント・作業ログ・返信・確認依頼と、固定時の確認依頼に付いた回答）は、親自身の記録（3節で id を `parent/acceptance/own-logs.md` に記録したもの）を除いて、1件でもあれば親以外の追記とする。項目の種類・作業ログの種類・書いた人・返信先・本文を問わず、本文の意味や、本文が判定に使った証拠の出典を含むかどうかでは選別しない。親と実装者は同じ書き手（actor）で書くことがあるので、親自身の記録かどうかは書いた人ではなく own-logs の id だけで決める。親以外の追記は、どの証拠に関するかを親は決めないので、判定に使った証拠を使ったすべての行に付ける。Issue のイベント（状態・計画の進捗・ラベル・担当・優先度などの event 項目）は追記に含めない。
   - スクリプトは変化と追記の意味（訂正か、撤回か、無害か）を判断しない。観測ごとに次の理由で、その証拠を使った行（親以外の追記は、判定に使った証拠を使ったすべての行）の要求の出典ごとに、確かめる担当「受け入れ確認担当（新しい実行）」と、項目 ID・出典・固定時と保存直前の指紋（親以外の追記は、追記の項目 ID・時刻・書いた人と、返信先）を添えて、確認が残る事項に加える。

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
   - 監査の再照合の節には、比べた項目と結果、固定の後に足された Activity の件数、親以外の追記の件数と各項目（項目 ID・時刻・書いた人・返信先。確認が残る事項にした）、止めなかった親自身の記録と Issue のイベントの件数が書かれる。
   - 取り直した内容は `parent/acceptance-recheck/` にだけ置く。変化があっても、新しい写しを担当へ渡さず、同じ実行の中で受け入れ確認担当に判定し直させず、担当の判定本文・最終状態・点数を変えない。受け入れ確認の判定（確認済みを含む）は固定時の証拠に対するものとして、そのまま報告する。
   - この再照合が保証するのは取り直した時点の観測までであり、将来の配置状態や正本の版を保証したとは報告しない。
4. 最終状態を SKILL.md の6節で決める。必要な担当（`parent/refute-structure.json` に受け入れ確認担当の行があれば受け入れ確認担当を含む）の有効な結果（最新の試行が隔離されておらず、検査に合格し、反証・受け入れ確認では構造が残ったもの）の有無だけで決める。`prepare` が準備完了でなければ `未実施`（`prepare` の理由）、担当を1つも起動していなければ `未実施`、利用枠の上限・利用者による中止の試行があれば `未完了`（`retire-attempt` の理由）、それ以外で必要な担当の有効な結果が無ければ `未完了`（理由: `retire-attempt` の最終の理由、反証・受け入れ確認への入力を固定できず、起動していない、検査が不合格のどれか。探索が欠けたら、反証を起動しなかったことを書き添え、後の段階の欠落を理由に重ねない）。判定本文の未確認、受け入れ確認の「未充足」「確かめられず」、1〜3の変化では `完了` を `未完了` にしない。
5. `完了` のとき、未確認が残っていても、`parent/refute-structure.json` の要対応（同一原因は1件）の影響度の最小値を確定した要対応の点数とする（要対応0件なら 5）。`未実施`・`未完了` は点数なし。スクリプトは判定・影響度・対応表を変えず、受け入れ確認の結果と3の再照合で点数を変えない。計算の過程（要対応の件数、各要対応の候補 ID と影響度、最小値）は監査に書かれる。
6. 確認が残る事項をまとめる。判定本文の未確認と理由の表の行（対応表の「未確認」の行と、判定「未確認」の候補。要実行確認と要求間の矛盾を含む）を、判定本文の要求の出典（または候補 ID）・確かめる担当・理由（種別・軸・不足箇所を添える）のまま1件ずつ並べる。受け入れ確認の結果で「未充足」「確かめられず」の行を、要求の出典・確かめる担当「受け入れ確認担当」・理由（判定・不足箇所・不足理由を結果の原文のまま）で並べ、反証の判定と矛盾する証拠を、反証の判定の箇所・確かめる担当「人」・理由（受け入れ確認の証拠と反証の判定の矛盾と、証拠・理由の原文）で並べる。受け入れ確認担当の行の候補ID列にあり、確かめる担当を受け入れ確認担当とした判定「未確認」の候補は、別の事項として並べず、その行の受け入れ確認の判定で扱う（SKILL.md の6節。確認済みなら残さず、未充足・確かめられずならその行の事項に候補 ID を書き添える）。1〜3で加えた事項と合わせる。例外を設けず、どれも最終状態と点数を変えない。
7. CI の結果では、4〜6の最終状態・点数・確認が残る事項を変えない。反証担当が確定した対応表の行（「未確認」「自動チェック担当」「受け入れ確認担当」を含む）と受け入れ確認の結果も書き換えない。
8. マージ可否を決める。
   - 先に、3.3節のとおり CI を1回だけ照合し、`parent/ci/1/` に記録する（1〜3の後、マージ可否を決める直前）。未実施・`mode: local`・評価用の事例・基点をブランチ名に解決できない・Workspace の規約を取り直せないときは照合せず、3節・3.1節のとおり `parent/ci/1/not-run.md` に書く。
   - 続けて `mode: commit`（評価用の事例を除く）では、head を固定した元（`parent/prepare.json` の `headSource`。`parent/head-source.md` と同じ）から対象の現在の head を取り直し（PR なら `gh pr view <PR> --json headRefOid,baseRefName`、ref なら `git -C <repo> rev-parse --verify --quiet <ref>^{commit}`）、`target.md` の head の SHA と比べる。PR なら、取り直した `baseRefName` が CI の照合に使った基点（`parent/ci/1/result.json` の `base`）と同じことも確かめる。ref から固定した場合は、基点の指定から解決したブランチ名が CI の照合に使ったブランチ名と同じことを確かめる。使ったコマンド・取得時刻・現在の head と基点・比べた結果を `parent/head-check.md` に書き足す。「ref なし」やコマンドの失敗で取り直せなければ、その旨を書く（不可の理由になる）。
   - `可（人のレビューなしでマージ可）`: 次のすべてを満たすときだけ。
     1. 最終状態が `完了` で、確定した要対応の点数が `5`。
     2. 対応表のすべての行が、反証で「充足」「説明」「対象外」のどれかであるか、「自動チェック担当」で同じ head SHA の CI 判定が `成功` であるか、「受け入れ確認担当」で受け入れ確認担当が「確認済み」とした行である。
     3. 確認が残る事項が、対応表の内外を問わず0件。
     4. `parent/ci/<n>/result.json` の `head` が `target.md` の head の SHA と同じで、CI 判定（`verdict`）が `成功`。
     5. 直前に取り直した対象の現在の head が `target.md` の head の SHA と同じで、現在の基点（PR なら取り直した `baseRefName`、ref から固定したなら基点の指定）が CI の照合に使った基点（`result.json` の `base`）と同じ（`parent/head-check.md`）。
   - `不可（人の判断が要る）`: それ以外のすべて。最終状態とその理由、確定した要対応の点数または点数なし、満たしていない対応表の行、確認が残る事項の件数、CI 判定とその理由（必須のチェックごとの結果、head SHA の一致）、現在の head と基点の照合の結果を不可の理由としてすべて並べる（確認が残る事項の中身は報告の未確認と監査の確認が残る事項の節）。CI 判定が `成功` 以外（`失敗`・`未確定`・`結果なし`・`取得できず`・`必須のチェックなし`・`必須のチェックを決められず`・`対象外（未コミット）`・照合せず）なら、ほかの条件をすべて満たしていても不可とする。現在の head が固定した head と違う（理由: 対象版が現在の head と違う（追加コミット））、または取り直せない（理由: 現在の head を取り直せない）とき、現在の基点が CI の照合に使った基点と違う、または取り直せない（理由: 基点が変わった）ときも、ほかの条件をすべて満たしていても不可とする。
   - 対応表の「自動チェック担当」の行は、マージ可否の判定でだけ同じ head SHA の CI 判定 `成功` で満たしたことにする（点数の対象外という扱いは変えない）。CI 判定が `成功` でなければ、満たしていない理由として並べる。
   - 対応表の「受け入れ確認担当」の行は、受け入れ確認担当が「確認済み」とした行だけを、マージ可否の判定で満たしたことにする（点数の対象外という扱いは変えない）。CI の成功では満たさない。
   - 対応表の「未確認」の行と、受け入れ確認の「未充足」「確かめられず」の行は、CI の成功では消えない（確認が残る事項として残り、マージ可否は `不可`）。
   - CI 判定の成否で、最終状態・点数・対応表・受け入れ確認の結果・確認が残る事項を変えない。
   - `可` でも、リポジトリの既存のマージ条件（ブランチ保護・必須のレビューなど）は省かず、迂回しない。

結果は固定した対象版と要求に対するものであり、別の commit の承認に使わない。CI 判定は照合した時点の観測であり、その後の CI の結果は13節の CI の再照合で扱う。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果として報告する。

### finalize の結果

標準出力の1行の JSON（と `parent/finalize.json`）には次が出る。

- `status`・`reason`、`score`（数か `点数なし`）と `scoreValue`（数か null）、`remaining`（確認が残る事項の `ref`・`owner`・`reason`・`from`）と `remainingCount`
- `merge`（保存・照合の失敗や付ける直前の head・基点の変化も含めた現在のマージ可否）、`reportedMerge`（報告に書いたマージ可否）、`blockers`（不可の理由）
- `ci`（`verdict`・`reason`・`base`・`resultHead`・`observedAt`・`record`（`parent/ci/1/result.json`・`not-run.md`・`ci-checks.log`）・`sha256`・`required`）、`head`（現在の head と基点の照合。照合しないときは null）
- `recheck`（1〜3の観測の要約）、`acceptance`（受け入れ確認の有効な結果を使ったか）
- `report`・`audit`（原稿 `parent/report.md`・`parent/audit.md` のパス）と `reportSha256`・`auditSha256`、`documents`（監査 `audit` と結果 `report` の Document ID・パス・照合の問題。Issue なし・評価用の事例は null）、`saved`・`saveProblems`
- `logs`（要約の作業ログの id `summary`、`[ci-result]` の作業ログの id `ci`、`--own-log` で記録した id `ownLogs`）、`label`（merge-ready の `operation` と `error`。Issue なしは `扱わない（Issue なし）`、評価用の事例は `扱わない（評価用の事例）`）、`logProblem`（要約の作業ログを書けなかった理由）
- `reportStartedAt`（報告の組み立て・保存の直前の時刻）・`savedAt`（保存と保存後の指紋照合が終わった時刻）

親が読むのは `status`・`reason`・`score`・`merge`・`blockers`・`remainingCount`・`documents` の ID・`saved`・`saveProblems`・`label` だけで、利用者・呼出元へは12節のとおり短い結果を返す。`saved` が false なら保存失敗として報告する（保存できた Document は保持し、再保存のためレビューを流し直さない）。

## 11. 報告を作り、保存する（スクリプト）

`finalize` が10節に続けて行う。親は報告を手で書かず、`nod doc create`・`nod issue log`・`nod issue update` を手で実行しない。

報告は2つに分かれる。[監査の雛形](../assets/audit.md)の形で `parent/audit.md`、[結果の雛形](../assets/report.md)の形で `parent/report.md` が作業ディレクトリの記録から組み立てられ、同じ runId・対象SHAで対応付けられる。判定・採点・マージ条件は変えない。

- 監査記録には、管理情報（runId・作業ディレクトリ・最終状態・点数と計算・確認が残る事項の件数・対象版・限定 clone（`parent/clone.md`）・依存の写し（`manifest.md`）・受け入れ確認への写し（`acceptance-input/records.md` と `parent/acceptance/`）・未コミット変更の差分確認）、確認が残る事項の全件、CI の結果（`parent/ci/<n>/`）、要求の出典と写しの指紋、保存時の要求変化の確認、保存直前の受け入れ証拠の再照合（`parent/acceptance-recheck/`）、担当（モデルは各担当の申告と出典だけで、不明は未確認。実効モデルの証明として扱わない）、試行の記録（`parent/agents.md`・`parent/attempts.md` から、無効だった試行と委譲し直した試行の両方を、担当 ID・無効の理由・保存場所・指紋とともに、担当のセッション内の omp 内部の再試行と親による再委譲を分けて）、原本の場所と指紋、後続判断、独立性の限界が入る。反証の `refute/verdict.md` と、起動した受け入れ確認の `acceptance/result.md` は、それぞれ印（`<!-- refute-verdict:begin -->`〜`<!-- refute-verdict:end -->`、`<!-- acceptance-result:begin -->`〜`<!-- acceptance-result:end -->`）の間へ一字も変えずに入る。本文が無ければ「未受領」と理由、担当行が無ければ「受け入れ確認担当の行なし（起動せず）」が入る。生の API 応答は場所と指紋だけになる。
- 利用者向け結果は、結論（最終状態・点数・確認が残る事項の件数・対象 SHA と、印の中のマージ可否・理由・CI 判定・merge-ready）、Severity 付きの要対応（反証の要対応の題・影響・場所を転記し、共通規則の対応で Severity と影響度の数値を併記する。判定や影響度を再評価せず、原因の統合や省略をしない）、未確認（確認が残る事項を不具合と分け、確認する担当と不足を Severity なしで全件）、監査への参照だけになる。原文・全対応表・指紋・担当履歴は結果へ転載しない。
- 結果・監査の両方で、CI の結果を含む部分（マージ可否・理由・現在head・merge-readyを含む）は `<!-- ci-result:begin -->` と `<!-- ci-result:end -->` の間だけに書かれる。後のレビューの入力から除く境界は3節と同じで、結果を短くしても隔離を弱めない。

Issue がある場合は、最終状態にかかわらず監査・結果をそれぞれ `kind=doc` の別 Document として Issue に添付する。監査を先に保存し、その ID と参照先を結果へ記入してから結果を保存する。名前は `<Issue IDの小文字>-code-review-audit-<YYYYMMDD>-<runIdの先頭8文字>.md`（タイトル `<Issue ID> コードレビュー監査（<runIdの先頭8文字>）`）と `<Issue IDの小文字>-code-review-<YYYYMMDD>-<runIdの先頭8文字>.md`（タイトル `<Issue ID> コードレビュー結果（<runIdの先頭8文字>）`）で、日付は UTC。

- 保存したそれぞれを `nod --json doc show` で読み直し、kind が doc で Issue にリンクされていること、タイトル見出しを除いた本文が原稿と同じであることを確かめる。監査は、印の間の反証の判定本文・受け入れ確認の結果の sha256 を、検査（`check-refute`・`check-acceptance`）した原本の sha256 と比べる（原稿の段階でも比べる）。どれかの保存・リンク・同一性・指紋の確認が失敗したら保存失敗（`saved` が false、`saveProblems` に理由）とし、merge-ready を付けない（付いていれば外す）。保存できた Document は保持し、再保存のためレビューを流し直さない。
- 作業ログ（保存の後に1件）: `完了` は `--kind progress` に、状態・確定した要対応の点数・要対応の要点（Severity と題）・受け入れ確認の行ごとの判定（起動したとき）・確認が残る事項の件数と要点（要求の出典・確かめる担当・理由）・結果 Document ID と監査 Document ID（保存・照合の問題があればその旨）・runId・起動した全担当の役割と定義名と ID と試行・無効な試行（担当 ID・無効の理由・委譲し直したか）を書く。`未実施`・`未完了` は `--kind blocker` に、独立レビューが未実施・未完了であること・原因（`未完了` なら有効な結果が無い担当と理由。利用枠の上限ならそのこと）・試行の記録・受領済みの成果・点数なし・Document ID・runId・Done・In Review・PR へ進めないことを書く。どちらも CI 判定・マージ可否・merge-ready は書かず、下の `[ci-result]` の記録を参照する旨だけを書く（3節）。返った id は `parent/acceptance/own-logs.md` に記録される。担当の ID はこの作業ログでもレビューと対応付ける。ID が異なることだけで、会話を引き継いでいないことを証明したとは扱わない。
- merge-ready ラベル（Issue があるときだけ。最終状態にかかわらず、報告の保存と上の作業ログの後に行う）: ラベルは、固定した head SHA に対する現在のマージ可否の表示であり、自動マージの指示ではない。ブランチ保護・必須のレビューなど既存のマージ条件を迂回しない。
  - マージ可否が `可` で保存に失敗していなければ、付ける直前に10節の8と同じ方法で対象の現在の head と基点を取り直し、`parent/head-check.md` に書き足す。`target.md` の head の SHA と同じで、現在の基点が CI の照合に使った基点と同じときだけ `nod issue update <Issue ID> --add-label merge-ready` で付ける。違う、取り直せない、または保存に失敗したときは付けず、付いていれば `--remove-label merge-ready` で外し、マージ可否を `不可`（理由: 対象版が現在の head と違う（追加コミット）、基点が変わった、現在の head を取り直せない、報告の保存・照合に失敗）として扱う（報告 Document は書き換えず、下の記録と `finalize` の結果の `merge`・`blockers` に書く）。`不可` で merge-ready が付いていれば外し、付いていなければ付けない。
  - 付けた／外した／付けていない（とその理由）と、判定した head SHA・現在の head と基点の照合の結果・基点・CI 判定と必須のチェックごとの結果（出典・check run の URL）・報告の Document ID・runId・CI の記録の場所（`<W>/parent/ci/<n>/` と `result.json` の sha256）を、本文を `[ci-result]` で始めて `nod --json issue log <Issue ID> "<記録>" --kind test` に1件残し、返った id を `parent/acceptance/own-logs.md` に記録する（3節）。ラベルの操作に失敗したら、その旨も同じ記録に書く（報告 Document は書き換えない）。
- Issue の無い単独レビューは、`parent/report.md` と `parent/audit.md` を残し、結果から監査（`parent/audit.md` の絶対パス）へ参照する。作業ログは書かず、merge-ready ラベルは扱わない。チャットでは短い結果だけを返す。
- 評価用の事例（`prepare --case`）では nod へ保存せず、`parent/report.md`・`parent/audit.md` までにし、ラベルも扱わない（CI の照合を省いたことは `parent/ci/1/not-run.md` と監査に書かれる）。
- 要求の写し・限定 clone と `parent/clone.md`・引き渡し用ファイル・メモ・反証の結果・受け入れ確認への写し（`acceptance-input/`・`parent/acceptance/`）と受け入れ確認の結果・保存直前の取り直し（`parent/requirements-recheck/`・`parent/local-recheck/`・`parent/acceptance-recheck/`）・無効な試行の記録（`parent/attempts/`・`parent/attempts.md`）・CI の照合の記録（`parent/ci/<n>/`）・`parent/finalize.json` と構造（`parent/refute-structure.json`・`parent/acceptance-structure.json`）は作業ディレクトリに残す（13節の CI の再照合で使う）。依存の写し（`deps/`）は保存を終えた後に片付けてよい（lockfile の sha256 と `deps-files.sha256` で同一性を確かめ直せる）。片付けたら、そのことと時刻を `parent/deps/` の記録に書き足す。

## 12. 後続

- 実装後レビューでは、`finalize` の結果から短い結果（結論・Severity付きの要対応・未確認は `parent/report.md` のとおり）と結果Document ID・監査Document IDを呼出元へ返す。単独レビューのチャットも結論・Severity付きの要対応・未確認・結果と監査への参照だけにする。詳細は監査に残し、チャットへ繰り返さない。
- `未実施`・`未完了`: Issue を Done にも In Review にもせず、PR も出さない（PR 不要の依頼でも Done に進めない）。`未完了` は4.1節の手順（判定と無関係な無効は1回だけ委譲し直し、利用枠の上限では委譲し直さない）を終えた結果であり、さらに委譲し直したり、担当を再開したり、利用枠の回復を待って流し直したりして代替しない。
- `完了` でマージ可否が `不可`: 確認が残る事項は、提出・完了に必要な確認の不足として扱い、合格・指摘なし・確認済みへ読み替えない。後続の判断は既存の提出・完了条件に委ねる。保存直前の再照合で見つかった証拠の変化を確かめ直すには、新しいレビューで写しを取り直す（このレビューの判定を新しい証拠で書き換えない）。
- マージ可否が `不可（人の判断が要る）` なら、人の判断なしにマージへ進めない。`可` でもリポジトリの既存のマージ条件を省かず、このレビューからはマージしない。merge-ready ラベルを自動マージ・承認の代わりにしない。
- CI 判定が `未確定`・`結果なし`（push 前・PR 前・CI の実行中など）でマージ可否が `不可` のときは、CI の完了後に13節の CI の再照合（`review.ts recheck-ci`）で判定し直す（レビューはやり直さない。完了を待って polling しない）。
- merge-ready が付いた後に、追加コミット・要求や使用証拠の変化・CI の失敗や未確定で条件を満たさなくなった、または判定が古くなったと分かった時点で、ラベルを外して理由を記録する（13節）。
- 次の判断が必要な場合だけ、具体的な選択肢を番号付きで示し、おすすめと理由を添える。

## 13. CI の再照合（同じ head SHA）

保存したレビューの CI 判定が `未確定`・`結果なし`（push 前・PR 前・CI の実行中など）だった場合や、merge-ready の判定を新しくする場合に、レビューをやり直さずに、同じ head SHA の CI の結果とマージ可否を照合し直す。担当へ委譲せず、親も自分でレビューしない。実装を進める親や PM もこの節に従ってよい。CI の完了を待って polling しない（完了の後に行う）。

```sh
bun <スキルのディレクトリ>/scripts/review.ts recheck-ci --work <W の絶対パス> [--own-log <保存の後に親・PM が Issue へ書いた記録の id>]...
```

親（または実装を進める親・PM）が行うのは、結果 Document の監査参照から監査 Document を読み、その管理情報の「作業ディレクトリ」を `<W>` として渡すこと、保存の後に自分が書いた（と PM から渡された）Issue への記録の id を `--own-log` で渡すこと（照合の前に `parent/acceptance/own-logs.md` に記録される）、結果を利用者に返すことだけである。スクリプトが次の1〜8を行う。

1. `parent/finalize.json`（保存した最終状態・点数・確認が残る事項・CI の基点・Document ID）を読み、監査 Document があれば `nod --json doc show` で、その管理情報の runId・対象版が作業ディレクトリと同じことを確かめる。再照合の番号 `<n>` は `parent/ci/` と `parent/recheck-<n>/` の番号の最大の次とし、`parent/recheck-<n>/` を作る。10節の8と同じ方法で現在の head（PR なら基点も）を取り直し、`input/target.md` の head SHA と比べる（`parent/head-check.md` に書き足す）。原判定・点数・対応表・受け入れ確認結果・既存の確認事項は、監査と同じ保存時の記録（`parent/finalize.json`・`parent/refute-structure.json`・`parent/acceptance-structure.json`）から読み、結果だけで代用しない。過去の Document は書き換えない。
2. head が違う（追加コミット）か取り直せないなら照合しない。merge-ready が付いていれば外し、「判定が古い（追加コミット）」（または取り直せない理由）と、報告の head SHA・現在の head SHA・報告の Document ID を、本文を `[ci-result]` で始めて `--kind test` に記録し、8の `record.md` を書いて終える（`parent/ci/<n>/` は作らない）。新しい head には新しいレビュー（1節から）が要る。
3. 報告の最終状態が `完了` でない、確定した要対応の点数が `5` でない、報告の確認が残る事項が1件以上ある、`mode: local` である、4〜6で使う作業ディレクトリの記録（`input/target.md`・`input/requirements/`・`input/manifest.md`、Issue があるときは `parent/acceptance/own-logs.md`、受け入れ確認担当の有効な結果を使ったときは `acceptance-input/records.md`・`acceptance/result.md`・`parent/acceptance-structure.json`・`parent/acceptance/items.json`・`parent/acceptance/evidence.json`、Issue があるときはさらに `parent/acceptance/activity.json`）のどれかが無い、または監査 Document の runId・対象版が一致しないなら、照合し直してもマージ可否は `可` にならない。照合せず、merge-ready が付いていれば外し、理由（無い記録はそのパス）を2と同じく記録し、8の `record.md` を書いて終える（`parent/ci/<n>/` は作らない）。Issue の無い単独レビューでは own-logs.md を求めない（Issue へ記録を書かないので作られない）。
4. head が同じなら、10節の2・3を同じ方法で `parent/recheck-<n>/`（要求は `parent/recheck-<n>/requirements/`、受け入れ証拠は `parent/recheck-<n>/acceptance/`）へやり直す。比べる相手は固定時（`input/requirements/`、判定に使った証拠の項目は `parent/acceptance-structure.json`、取り直しの方法は `parent/acceptance/evidence.json`、元の写しは CI の結果を除く前の `parent/acceptance/activity.json`・`parent/acceptance/documents/`・`parent/acceptance/evidence/<n>/` と `parent/acceptance/items.json` の sha256）で、Issue があるときは親自身の記録の扱い（own-logs.md の id）も同じとする。Issue の無い単独レビューでは Activity・Document を写していないので、受け入れ証拠は `evidence/<n>` だけを取り直し、own-logs は使わない。見つかった変化は10節と同じ理由で確認が残る事項に加える。報告 Document は書き換えず、加えた事項は8の `record.md` と7の記録に書く。
5. 3.3節のとおり CI を `parent/ci/<n>/` へ1回だけ照合する（`--rules` は `parent/recheck-<n>/requirements/workspace-rules.md`、`--base` は報告の CI の基点、`--head` は `target.md` の head の SHA）。PR の `baseRefName` が報告の基点と違えば、CI 判定を `必須のチェックを決められず` として扱い、「基点が変わった」を不可の理由にする。
6. 報告の最終状態・確定した要対応の点数・対応表・受け入れ確認の結果と、報告の確認が残る事項に4で加えた事項を合わせ、10節の8と同じ規則でマージ可否を決める（`parent/ci/<n>/result.json` の `head` が `target.md` の head の SHA と同じで、CI 判定が `成功`）。報告の判定本文・最終状態・点数・対応表は変えない。
7. 11節と同じく merge-ready を付ける・外す（付ける直前に現在の head と基点を取り直す）。付けた／外した／付けていないことと、判定した head SHA・基点・CI 判定と必須のチェックごとの結果（出典・check run の URL）・報告の Document ID・runId・再照合の番号 `<n>`・CI の記録の場所（`<W>/parent/ci/<n>/` と `result.json` の sha256）・4で加えた確認が残る事項を、本文を `[ci-result]` で始めて `nod --json issue log <Issue ID> "<記録>" --kind test` に1件残し、返った id を own-logs.md に記録する。
8. 再照合の記録を `parent/recheck-<n>/record.md` に書く（2・3で照合せずに終えるときも書く）。書くのは、報告の Document ID と runId、比べた head（報告の head の SHA・現在の head の SHA と基点、取得に使ったコマンドと取得時刻）、照合せずに終えたならその理由（2の追加コミット、3の条件と無い記録のパス）、要求と受け入れ証拠の再照合の結果（4。比べた資料と変化の有無、加えた確認が残る事項。照合しなかったときは「照合せず」）、CI の記録の場所 `parent/ci/<n>/` と `result.json` の sha256・CI 判定（照合しなかったときは「照合せず」）、マージ可否と理由、ラベルの操作（付けた／外した／付けていない）、この再照合で書いた作業ログの id である。

- 結果は標準出力の1行の JSON（と `parent/recheck-ci.json`。最新の再照合だけ）に出る: `n`、`checked`（CI を照合したか）、`reason`（照合せずに終えた理由）、`merge`・`blockers`、`ci`、`head`、`added`（4で加えた確認が残る事項）、`label`（`operation`・`error`・`log`）、`ownLogs`、`record`（`record.md` のパス）。終了コード 2 は引数の誤り（`parent/finalize.json` が無い、評価用の事例、Issue なしでの `--own-log`、`--own-log` が数字でない）。
- レビューの保存後から再照合までに、実装を進める親・PM が同じ Issue へ書いた記録（作業ログ・コメント・返信。PR の URL や提出・受理の記録を含む）は、`--own-log` で渡した id（または own-logs.md に記録済みの id）だけを親自身の記録とする。それ以外は、書いた人を問わず親以外の追記とする（10節の3）。
- Issue の無い単独レビューでも照合し直してよいが、ラベルは扱わず、結果はチャットで報告する。
- 再照合の結果は、照合した時点の観測である。その後に追加コミット・要求や使用証拠の変化・CI の失敗や未確定で条件を満たさなくなった、または判定が古くなったと分かった時点で、merge-ready を外して理由を記録する（実装を進める親・PM の手順でも同じ。照合し直すなら `recheck-ci`）。
