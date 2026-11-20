# 親の手順

単独レビュー・実装後レビューとも、0.1節で起動した新しい隔離セッションが親になる。利用者・実装者の既存セッションからレビュー担当を直接起動しない。
親は自分でレビューしない。対象と要求を固定し、レビュー担当エージェント（Standards 探索・Spec 探索・反証。Spec 探索は要求の範囲で2体に分けることがある）へ委譲し、引き渡しを検査し、判定を変えずに状態・点数・報告を記録する。このレビューはコードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は確かめず、別のフローで扱う。
あわせて、レビューの最終状態・確定した要対応の点数・確認が残る事項と、現在の head と基点がレビューした版と同じかから「マージ可否」を決め、Issue があれば判定を merge-ready ラベルで示す。親はテスト・Lint・ビルドを実行せず、CI の結果を照合しない（CI が落ちた PR のマージを止めるのは GitHub の必須ステータスチェック（ブランチ保護・ルールセット）の役割で、マージ可否の条件に含めない）。

## 親の最小操作の流れ

親が呼ぶのは次のサブコマンドだけで、それ以外の定型作業（固定・写し・指紋・検査・再照合・算出・報告の組み立てと保存・計測）はスクリプトが行う。各節の詳しい規則は、スクリプトの結果を読み違えないための参照である。`<S>` はこのスキルのディレクトリ、`<W>` は `prepare` が返した作業ディレクトリ。
スクリプトが行う処理の詳しい規則と、有効な結果が無い担当の扱い（4.1節）は、付録 [parent-details.md](parent-details.md) に同じ節の番号で分けてある。親が常に読むのはこの本体だけで、付録は下の「付録を読むとき」に当たったときに、示された節だけを読む。

| 順 | 親が呼ぶもの | 親に残る判断 |
|---|---|---|
| 1 | `bun <S>/scripts/review.ts prepare ...`（2節） | 対象・基点・Issue（または明示された要求）の特定（1節）。`ready` が false なら委譲せず 7 へ。`spec` で Spec 探索の担当（1体か2体）を確かめる |
| 2 | 担当ごとに `agent --role standards --event start`・`agent --role spec [--assignee <担当>] --event start` → 探索の全担当を同時に委譲（4節。omp の eval で `agent()` を使えれば、2と3を1つのセルで行う） | 依頼本文を最小限にする |
| 3 | 最終返答ごとに `agent ... --event received --agent-id <ID>` → `check-explore --role <役割> [--assignee <担当>]`（5節）→ 探索の全担当の受領の後に `check-boundary`（0.1節） | 返答が入力不備・失敗でないか、引き渡し本文に禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が無いかを通読で確かめる（探索の引き渡しだけ）。`check-boundary` の目印と観測できなかった項目から、担当の入力境界を確かめる |
| 4 | 無効なら `retire-attempt`（4.1節）→ `redelegate` が true のときだけ、その担当を同じ依頼で1回だけ委譲し直す | 失敗の種類（判定と無関係な無効・利用枠の上限・利用者による中止）の分類 |
| 5 | `refute-input` → `agent --role refute --event start` → 委譲 → `received` → `check-refute`（6節・7節）→ `check-boundary`（0.1節。omp の eval では1つのセルで行う） | 返答が入力不備・失敗でないか（判定本文は読まない）。`check-boundary` の結果から反証の担当の入力境界を確かめる |
| 6 | `finalize`（10節・11節・14節） | omp 以外で `PI_SESSION_FILE` が無ければ `--session` で親のセッション記録を渡す。利用者・呼出元への短い説明（12節） |

### 付録を読むとき

次のどれかに当たったときだけ、付録の示された節を読む。

| スクリプトの出力・状況 | 付録で読む節 |
|---|---|
| 担当の返答が入力不備・失敗、ハーネスの終了・失敗・取り消しの通知、eval の await の例外 | 4.1節（失敗の種類の分類と `retire-attempt`） |
| `check-explore` が `valid: false` を返した | 5節（`violations` の番号の検査項目）と4.1節 |
| `check-refute` が `valid: false` を返した | 7節（`violations` の番号の検査項目）と4.1節 |
| `retire-attempt` を使う、または `agent --event start` が終了コード 2 を返した | 4.1節 |
| `refute-input` が `ready: false` か終了コード 2 を返した | 6節 |
| どれかの結果の `identity` が不一致（`ok: false`） | 2.1〜2.3節（同一性の確認でやり直す確認の中身） |
| `prepare` の `unavailable`・依存の写しを準備しなかった理由、作業ディレクトリの場所ごとの用途を確かめる | 2節・2.2節・2.3節 |
| `finalize` の `status`（`未実施`・`未完了`）・`merge`・`blockers`・`saved: false` の理由を利用者・呼出元へ説明する | 10節・11節 |
| 計測の範囲や定義を説明する、`usage` で作業ディレクトリの無い記録を集計する | 14節 |

## 0. 委譲先と前提

- 委譲先は役割別の3定義だけ: Standards 探索は `code-reviewer-standards`、Spec 探索は `code-reviewer-spec`、反証は `code-reviewer-refute`。
- これらが使えない（定義が見つからない、起動を許可されていないなど）場合も、旧 `code-reviewer` やバンドル済みの `reviewer` などで代用しない。
- レビュー担当エージェントへ委譲できない環境（委譲の仕組みが無いハーネスなど）では、親は自分でレビューせず、最終状態を `未実施`（理由: 委譲できない環境）として記録・報告する。
- 担当のモデルは設定側の責務であり、この手順では扱わない。モデル情報は担当の申告と出典を記録するだけで、停止条件にしない。
- 有効な結果が返らなかった担当は4.1節で扱う。判定の中身と関係しない無効は、その担当だけを同じ入力・新しいコンテキストで1回だけ委譲し直す。利用枠の上限による失敗は委譲し直さず、その時点で止める。別モデル・別アカウントへの切り替えや利用枠の回復待ちはしない。
- 全体期限や担当ごとの打ち切り期限は設けない。担当の実行時間はハーネスに任せる。
- 指摘は直さない。修正は別作業で行い、再レビューは新しい委譲で行う。このレビューから commit・push・PR 投稿・マージをしない。

### 0.1 通常レビューも隔離した親から開始する

配置確認・評価だけでなく、単独レビューと implement・PM からの通常の実装後レビューにも同じ起動経路を使う。既存セッションは対象の絶対パス・基点・head・Issue（または利用者が明示した要求）を特定して、新しい親へ引き継ぐ。実装報告・作業ログ・テストの結果・過去レビュー・見立て・会話履歴は渡さない。呼出元は起動した親の結果を待ち、同じレビューを二重起動しない。

```sh
empty=$(mktemp -d)
sessions=$(mktemp -d)
env -u PI_SESSION_FILE -u PI_SESSION_ID omp -p --cwd "$empty" --no-context-files --no-rules \
  --session-dir "$sessions" "<使用するcode-reviewスキルの親として、対象repo・基点・head・Issueまたは明示要求を指定した依頼>"
# 作業ツリー版を使う場合は --config <一時オーバーレイ> も渡す。
# skills.customDirectories に固定した plugins/nod/skills を指定し、接頭辞なし code-review を名指しする。
```

すでにこの経路で新規起動された親は、さらに親を起動せず1節以降を行う。親の起動引数・空の cwd・新しい session-dir・読んだスキルの実パスを記録する。担当の最初の入力と `session_init` の systemPrompt、`skill-prompt` の実パスで、元の作業ツリーの規約・プロジェクトのスキル一覧が混ざっていないことを確かめる。記録を調べるときは書込ペイロードを表示せず、反証本文を親へ露出させない。固定 head の規約は担当が限定 clone から読む。空 cwd やフラグだけを入力分離の証明にせず、観測できない範囲は限界として記録する。

担当の最初の入力・`session_init` の systemPrompt・`skill-prompt` の実パスは、親が担当のセッション記録を自分で読まず、`check-boundary` の結果で確かめる。探索の全担当の最終返答の受領（4節の `received`）の後と、反証の受領の後に呼ぶ（4節の eval のセルの中で呼んでもよい）。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-boundary --work <W の絶対パス> [--session <親のセッション記録の絶対パス>]   # --session が無ければ PI_SESSION_FILE
```

- スクリプトは `parent/agents.json` の各試行について、担当の記録（親の記録と同名のディレクトリの `<担当 ID>.jsonl`）の最初の応答より前の記録だけを読み、3項目（最初の入力、`session_init` の systemPrompt、`skill-prompt` の実パス）ごとに、観測できたか（`observed`。できなければ理由の `reason`）と、混入を疑う目印（`marks`）を返す。
- 目印は、`<repo-rules>`・規約ファイル（`<file path=…>`）・元のリポジトリのパスがあること、元の作業ツリーのプロジェクトのスキル（`.omp/skills`・`.claude/skills`・`.agents/skills`・`.codex/skills`）の名前がスキル一覧にあること、担当の作業ディレクトリ（`session` の記録の cwd）が元のリポジトリの中にあること、最初の入力が4節・6節の依頼本文の雛形と違うこと（役割の値、項目の欠落、雛形に無い項目）、`skill-prompt` がこのスキルの `SKILL.md` でないか記録に無いことである。
- 依頼本文・systemPrompt・`skill-prompt` の本文は写さず、sha256・大きさ・項目の有無と観測の限界を `parent/boundary.md`（と `boundary.json`）に書く。書込ペイロードと反証の本文は読まない。
- 雛形の項目外にある自由文、箇条書き、コメントも行番号を目印として残す（本文は写さない）。先頭にハーネスが付ける `Complete assignment thoroughly:` の1行と、反証の入力一覧にある指定先の行は除く。
- 既知の項目も値全体を4節と6節の雛形と照合し、不一致と項目の重複を目印にする。反証の入力一覧は、固定した入力ファイルと指定されたリポジトリと依存の写しの行だけを認め、行末への自由文の追加も目印にする。
- 未知の項目は値が空でも行番号を目印にし、未知の項目名自体は写さない。反証の入力一覧では固定入力一式、探索の全担当の引き渡し、対象の限定 clone、準備できた依存の写しの欠落も目印にする。
- 目印が混入に当たるかは親が判断する。`observed` が false の項目は観測できなかった範囲として限界に記録し、目印が無いことと読み替えない。

この新規親を起動できなければ、既存セッションからの直接委譲へ切り替えず、独立レビューを未実施（理由: 入力を分離した親を起動できない）として報告する。スキル同梱スクリプトはモデルを起動しない。起動は呼出元のハーネスが行い、利用者の永続設定やインストール済み plugin を変更しない。

## 1. 対象・基点・要求を特定する

- 依頼や実装工程から引き継いだ対象リポジトリ・基点・対象版・Issue・Document は聞き直さない。対象リポジトリまたは基点が依頼に無いときだけ利用者に確認する。
- PR を指定された場合は `gh pr view <PR> --json url,headRefOid,baseRefName` などで実際のリポジトリ・基点・head の SHA を特定する。Issue をブランチ名から推測しない。
- コミットのレビューは `mode: commit`（head は SHA、またはブランチ名・`HEAD` などの ref）。明示された未コミット変更のレビューは、明示されたときだけ `mode: local` とし、commit や stash を作らない。未追跡ファイルは指定されたものだけを渡す。
- Issue の無い単独レビューでは、利用者が明示した要求（ファイルか Document）だけを渡す。

## 2. 対象を固定し、共通入力を作る（スクリプト）

1節で決めた値で、このスキルの `scripts/review.ts prepare` を1回実行する。スクリプトが、対象の SHA の固定、空差分の検査、担当用の限定 clone と確認（2.1節）、依存の写しと指紋（2.2節）、共通入力と目録（2.3節）、head を固定した元の記録を行う。親はこれらを手で繰り返さず、テストを実行しない。

```sh
# スクリプトはこのスキルのディレクトリ（SKILL.md があるディレクトリ。Claude Code では「Base directory for this skill」として示される）から解決する。リポジトリの作業ディレクトリの plugins/ を使わない
bun <スキルのディレクトリ>/scripts/review.ts prepare --repo <元のリポジトリの絶対パス> --base <基点の指定> \
  --mode commit --head <head の SHA か ref> [--pr <PR の URL>]   # PR なら --head は gh で解決した40桁の SHA
  # mode: local なら --mode local [--untracked <リポジトリのルートからの相対パス>]...（土台の HEAD を固定する）
  # 要求: --issue <Issue ID>、Issue が無ければ --request <ファイルの絶対パス>... / --request-doc <Document ID>...（無ければ省く）
```

- 作業ディレクトリ `<W>` は実行ごとに `$HOME/.local/share/nod/code-reviews/<runId>`（runId は小文字の uuid）に作られる。結果は標準出力の1行の JSON と、同じ内容の `parent/prepare.json` に出る（`work` が `<W>`、`runId`、`mergeBase`・`head`（`mode: local` では土台の HEAD）、`headSource`、`clone`、`deps`、`inputs`（`input/` の各ファイルの sha256）、`unavailable`（取得できなかった資料と理由）、`spec`（Spec 探索の担当。下））。
- `spec` は Spec 探索の担当を示す。要求資料（`input/requirements/` のファイルをパスの順に並べた全行）を、行数がほぼ半分になる要求資料の境目か Markdown の見出しの直前で2つに分けられれば、`split` が true で、`assignees` は `spec1`・`spec2` の2件になる。各件の `id` が担当、`dir` が書いてよい場所、`prefix` が候補 ID の接頭辞、`range` が担当範囲、`request` が依頼本文の「担当範囲」の値で、`target.md` の末尾に「Spec 探索の担当範囲」の節が足される。分けられなければ `split` が false、`reason` が理由で、`assignees` は `spec` の1件（`range`・`request` は null）になり、今までどおり1体に委譲する。
- 終了コード 2 は引数の誤り（相対パス、解決できない ref、追跡済みのファイルを `--untracked` に渡したなど）で、判定ではない。呼び出しを直して実行し直す。それ以外の 0 以外の終了コードは予期しない失敗で、委譲しない。
- `ready` が false なら `status` は `未実施` で、委譲せず、10節の `finalize` で報告する（`reason` を理由・点数なし・マージ可否 `不可（人の判断が要る）` として報告と作業ログが書かれる）。理由は、差分なしか、担当用の限定 clone を作れない（<通らなかった確認>）のどちらか。

ディレクトリの分離は担当への指示の境界であり、アクセス遮断ではない。以下、元のリポジトリを `<repo>`、担当用の限定 clone を `<W>/repo` と書く。担当には元のリポジトリを渡さない。

head を固定した元の記録、作業ディレクトリの場所ごとの用途、限定 clone・依存の写し・共通入力の作り方（2.1〜2.3節）は付録の2節にある。

## 4. 探索を並列に委譲する

Standards 探索担当と、`prepare` の `spec.assignees` が示す Spec 探索の担当（分けたときは `spec1`・`spec2` の2体、分けないときは `spec` の1体）を、それぞれ新しいコンテキストで、1回の委譲で同時に起動する（同時に最大3体）。依頼本文は次の最小限だけにする。

```text
役割: Standards 探索
作業ディレクトリ: <W の絶対パス>
読んでよい入力: <W>/input/ 配下（target.md・manifest.md・deps-files.sha256・requirements/・local/）、対象リポジトリ <W>/repo（target.md の担当用の限定 clone）、依存の写し <W>/deps/（準備できたときだけ）
書いてよい場所: <W>/standards/（handoff.md と notes/）と自分の一時ファイル
出力: <W>/standards/handoff.md
```

Spec 探索は `役割: Spec 探索`、書いてよい場所を `<W>/<担当>/`、出力を `<W>/<担当>/handoff.md` に置き換える（`<担当>` は `spec.assignees` の `id`。分けないときは `spec`）。分けたときは、読んでよい入力の次の行に「担当範囲」の項目を足し、値に `spec.assignees` の `request` をそのまま写す。Standards 探索と、分けないときの Spec 探索には「担当範囲」を書かない。分けたときの Spec 探索（`spec1`。`spec2` も同じ形）の依頼本文は次のとおり。

```text
役割: Spec 探索
作業ディレクトリ: <W の絶対パス>
読んでよい入力: <W>/input/ 配下（target.md・manifest.md・deps-files.sha256・requirements/・local/）、対象リポジトリ <W>/repo（target.md の担当用の限定 clone）、依存の写し <W>/deps/（準備できたときだけ）
担当範囲: spec1（requirements/issue.md:L1-L26、requirements/spec-863.md:L1-L82。候補 ID は SPC1-<n>）
書いてよい場所: <W>/spec1/（handoff.md と notes/）と自分の一時ファイル
出力: <W>/spec1/handoff.md
```

共通の context を持つハーネスでは、固定の1文「指定された役割・入力・出力だけを使う独立レビュー。自動チェックは実行しない。」だけを渡す。omp の task は空の context を拒否するので、空にはしない。要求の要約、親の見立て、実装者の自己評価、作業ログ、探索の返答を入れない。

担当が実行中でまだ返っていない間は、待機中として状況を報告するだけにする。経過時間だけで失敗と判定せず、ハーネスの終了・失敗・取り消しの通知を使う。ハーネスが実行中のままで応答しない場合はその状態を利用者へ報告し、停止を確認できないときは停止済みと報告しない。

委譲の直前と、親が次の工程へ進める最終返答（ハーネスの終了・失敗・取り消しの通知を含む）を受け取った直後に、担当ごとにスクリプトで記録する。試行の番号はスクリプトが担当ごとに決める（最初の試行は 1、4.1節の再委譲は 2）。

```sh
bun <スキルのディレクトリ>/scripts/review.ts agent --work <W の絶対パス> --role standards --event start   # 委譲の直前。Spec 探索は --role spec（分けたときは --assignee spec1 か spec2 も付ける）
bun <スキルのディレクトリ>/scripts/review.ts agent --work <W の絶対パス> --role standards --event received --agent-id <ハーネスが返した担当 ID>   # 最終返答を受け取った直後
```

- `parent/agents.md`（と `parent/agents.json`）に、役割・担当・定義名・試行の番号・担当 ID・委譲の開始と最終返答の受領の時刻が残る。担当 ID が委譲の時点で分かれば `start` にも `--agent-id` を付けてよい。反証も `--role refute` で同じく記録する。
- `--assignee` は、分けた作業ディレクトリの Spec 探索では必須（`agent`・`check-explore`・`retire-attempt` で同じ）。分けない作業ディレクトリと Standards 探索・反証に付けると、終了コード 2（引数の誤り）になる。
- `start` は、4.1節で利用枠の上限・利用者による中止として止めた後、4.1節で委譲し直してよいと返されていない担当の2回目以降、`refute-input`（6節）が準備完了を返す前の反証では、終了コード 2 を返して記録しない。そのときは委譲しない。

### omp の eval で委譲と待機を1回の呼び出しにまとめる

omp の親で、eval の `agent()` と handle の await を使えるときは、探索の全担当の起動から終了までを eval の1つのセルで行い、`wait` を繰り返し呼ばない（反証は1担当で同じ）。使えないハーネスでは、上のとおりハーネスの委譲と待機を使う。

- 委譲先・依頼本文・記録は上と同じにする。`agent()` の `agent` に役割の定義名を、`label` に担当名（例: `StandardsExplore`・`SpecExplore`・`RefuteReview`。分けたときの Spec 探索は `SpecExplore1`・`SpecExplore2`）を渡し、`--agent-id` には返された handle の `id` を使う。`agent()` は共通の context を持たないので、依頼本文だけを渡す。Spec 探索の担当と依頼本文は `parent/prepare.json` の `spec.assignees` から作る。
- 担当の終了は handle ごとに並行に待ち、それぞれの終了の直後に `received` と検査（探索は `check-explore`、反証は `check-refute`）を呼ぶ。全担当の終了を待ってから、まとめて `received` を記録しない（14節の試行の範囲が後ろへずれる）。
- await が例外を返した（起動・実行の失敗、取り消し）担当も `received` を記録し、その担当だけを付録の4.1節で扱う。エラーの文言は `failure` に残る。
- セルが出力するのは、親が確かめるのに要るもの（各担当の最終返答と、スクリプトの出力の JSON）だけにする。引き渡し用ファイル・判定本文・担当のセッション記録は出力しない。
- スクリプトは同時に起動しない（`parent/` の記録を読み書きするため）。eval の `sh()` は終わるまで戻らないので、下のセルではスクリプトの呼び出しが1つずつになる。
- eval の `sh()` には `PI_SESSION_FILE` が渡らないので、`check-boundary` には `--session` で親の記録を渡す。

```python
import asyncio, json, os, shlex

S = "<スキルのディレクトリ>"
W = "<W の絶対パス>"
SESSION = os.environ.get("PI_SESSION_FILE")  # 親のセッション記録（eval の sh() には渡らない）
with open(f"{W}/parent/prepare.json", encoding="utf-8") as f:
    SPEC = json.load(f)["spec"]  # Spec 探索の担当（2節）

def review(*args):
    # 終了コード 0 なら出力の JSON。それ以外は終了コードと出力（2 は引数の誤り。start なら委譲しない）
    try:
        return json.loads(sh(shlex.join(["bun", f"{S}/scripts/review.ts", *args])))
    except Exception as e:
        return {"ok": False, "exitCode": getattr(e, "exit_code", None), "output": getattr(e, "output", str(e))}

def explore_prompt(role, name, request=None):
    # 上の探索の依頼本文。Spec 探索を分けたときだけ「担当範囲」の項目を足す
    return "\n".join([
        f"役割: {role}",
        f"作業ディレクトリ: {W}",
        f"読んでよい入力: {W}/input/ 配下（target.md・manifest.md・deps-files.sha256・requirements/・local/）、対象リポジトリ {W}/repo（target.md の担当用の限定 clone）、依存の写し {W}/deps/（準備できたときだけ）",
        *([f"担当範囲: {request}"] if request else []),
        f"書いてよい場所: {W}/{name}/（handoff.md と notes/）と自分の一時ファイル",
        f"出力: {W}/{name}/handoff.md",
    ])

async def delegate(role, definition, label, prompt, check, assignee=None):
    who = ["--work", W, "--role", role, *(["--assignee", assignee] if assignee else [])]
    start = review("agent", *who, "--event", "start")  # 委譲の直前
    if not start.get("ok"):
        return {"role": role, "assignee": assignee, "start": start}
    h = None
    try:
        h = agent(prompt, agent=definition, label=label)
        reply, failure = await h, None
    except Exception as e:  # 起動・実行の失敗、取り消し（付録の4.1節）
        reply, failure = None, str(e)
    received = review("agent", *who, "--event", "received", *(["--agent-id", h.id] if h else []))  # 終了の直後
    checked = review(*check, "--work", W, *(["--assignee", assignee] if assignee else [])) if failure is None else None
    return {"role": role, "assignee": assignee, "agentId": h.id if h else None, "reply": reply, "failure": failure, "received": received, "check": checked}

def boundary():
    return review("check-boundary", "--work", W, *(["--session", SESSION] if SESSION else []))

specs = [
    delegate("spec", "code-reviewer-spec", f"SpecExplore{i}" if SPEC["split"] else "SpecExplore",
             explore_prompt("Spec 探索", a["id"], a["request"]), ["check-explore", "--role", "spec"],
             a["id"] if SPEC["split"] else None)
    for i, a in enumerate(SPEC["assignees"], 1)
]
results = await asyncio.gather(
    delegate("standards", "code-reviewer-standards", "StandardsExplore", explore_prompt("Standards 探索", "standards"), ["check-explore", "--role", "standards"]),
    *specs,
)
print(json.dumps({"results": results, "boundary": boundary()}, ensure_ascii=False))
```

反証は、引き渡しの通読（5節の7）の後に、同じ関数で次のセルを実行する。委譲し直すとき（付録の4.1節）も、その担当の `delegate` だけを最初と同じ引数（同じ依頼本文）で呼ぶ。

```python
ready = review("refute-input", "--work", W)
result = await delegate("refute", "code-reviewer-refute", "RefuteReview", "<6節の反証の依頼本文>", ["check-refute"]) if ready.get("ready") else None
print(json.dumps({"refuteInput": ready, "result": result, "boundary": boundary()}, ensure_ascii=False))
```

### 4.1 有効な結果が無い担当の扱い（全担当に共通）

この節の規則は付録の4.1節にある。担当の返答が入力不備・失敗のとき、ハーネスの終了・失敗・取り消しの通知や eval の await の例外を受けたとき、検査が `valid: false` を返したとき、`retire-attempt` を使うときに読む。

## 5. 探索の引き渡し用ファイルを検査する

親は引き渡し用ファイルを書き換えない（補筆・削除・要約・整形をしない）。各担当の最終返答を受け取ったら（4節の `received` の後）、担当ごとに次の1〜8を確かめる。1と、7のうち本文への混入は親が確かめ、それ以外はスクリプトで機械的に検査する。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-explore --work <W の絶対パス> --role standards   # Spec 探索は --role spec（分けたときは --assignee spec1 か spec2 も付ける）
```

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない（親が返答で確かめる。入力不備・失敗なら、検査せずに4.1節へ進む）。

2〜6と8（スクリプトが機械的に調べる項目）は付録の5節にある。`valid: false` のときは `violations` の番号をそこで確かめる。

7. 禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が項目名にも本文にも無い。スクリプトは見出し・箇条の項目名・表の見出しだけを調べ、コードスパンを除いた名前の全体が禁止項目そのもの（`暫定の` を前に付けたもの、英語の severity・confidence・summary を含む）のときだけ違反にする（`Severity` の表示・buildSummary の呼出元 のような、名前の一部に含むだけの項目名は違反にしない）。項目名だけの検査では内容の混入まで保証できないので、スクリプトの検査に通った引き渡しは、親が本文を通読して確かめる（探索の引き渡しだけ。反証の判定本文は通読しない）。

- 結果は標準出力の1行の JSON（`valid`、`violations` の検査の番号と違反の箇所、検査した `handoff.md` の `sha256`、`identity`）と、`parent/checks.md`（と `parent/checks.json`。担当のサブディレクトリの各ファイルの sha256 を含む）に書かれる。同一性の確認は `parent/identity.md` にも残る。
- 有効な結果は、1を親が確かめ、スクリプトの `valid` が true で、7の本文の通読で混入が無かったものだけとする。

探索のどれかの担当に違反・欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は `retire-attempt --role <役割> [--assignee <担当>] --failure invalid --reason '<5節の番号と違反の箇所>'` で隔離し、その担当だけを1回だけ委譲し直して同じ検査をする）。探索の全担当の有効な結果がそろうまで反証を起動しない。4.1節の後もどれかの有効な結果が無ければ、反証を起動せず、最終状態を `未完了` とする（10節へ進む）。

## 6. 反証への入力を写し、反証を委譲する

探索の全担当（Spec 探索を分けたときは `spec1` と `spec2` の両方）が5節の検査を通過したときだけ、検査済みの引き渡し用ファイルと共通入力を、内容を変えずにスクリプトで `refute-input/` へ写す。4.1節で委譲し直した担当は、委譲し直した担当の引き渡し用ファイル（同じ場所にある）が写る。

```sh
bun <スキルのディレクトリ>/scripts/review.ts refute-input --work <W の絶対パス>
```

- `ready` が false なら `status` は `未完了`、`reason` は `反証への入力を固定できず、反証の有効な結果なし` で、写し直さず、反証を起動しない（10節へ進む）。
- 写す処理と照合の詳細（写すもの・写さないもの、`parent/fingerprints.md`）は付録の6節にある。

反証担当は、新しいタスクとして新しいコンテキストで1体だけ起動する（無効なら4.1節で、新しい1体へ1回だけ委譲し直す）。探索担当への追送や再開は使わない。探索の候補が0件でも、必要な確認の不足や判断の見送りを確かめさせるため省かない。依頼本文は次だけにする（作業ディレクトリのこれ以外の場所を示さない）。依存の写しは `refute-input/` へ写さず、探索と同じ `<W>/deps/` を渡す。

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

Spec 探索を分けたときは、`<W>/refute-input/spec-handoff.md` の行の代わりに `<W>/refute-input/spec1-handoff.md` と `<W>/refute-input/spec2-handoff.md` の2行を書く。

共通の context は4節と同じ固定の1文だけにする。待機と ID の記録は4節と同じ。

## 7. 反証の結果を検査する

反証担当の最終返答を受け取ったら（4節の `received` の後）、`verdict.md` を書き換えずに次の1〜6を確かめる。1のうち返答が入力不備・失敗でないことは親が確かめ、それ以外はスクリプトで機械的に検査する。親は判定本文を通読しない。

```sh
bun <スキルのディレクトリ>/scripts/review.ts check-refute --work <W の絶対パス>
```

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない（親が返答で確かめる。入力不備・失敗なら、検査せずに4.1節へ進む）。指定したパスに `verdict.md` がある。

2〜6（スクリプトが機械的に調べる項目）と、合格したときに書く構造（`parent/refute-structure.json`）は付録の7節にある。`valid: false` のときは `violations` の番号をそこで確かめる。

- 結果は標準出力の1行の JSON（`valid`、`violations` の検査の番号と違反の箇所、検査した `verdict.md` の `sha256`、`identity`、合格なら構造の場所 `structure`）と、`parent/checks.md`（と `parent/checks.json`）に書かれる。スクリプトは読み取れない欄・食い違う欄を推測で補わず、違反として返す。`finalize` の後は検査し直さない（終了コード 2）。
- 有効な結果は、1を親が確かめ、スクリプトの `valid` が true のものだけとする。

欠落・失敗があれば、その結果を有効とせず、4.1節で扱う（利用枠の上限ならその時点で止め、それ以外は `retire-attempt --role refute --failure invalid --reason '<7節の番号と違反の箇所>'` で隔離し、反証だけを1回だけ委譲し直して同じ検査をする。探索の結果はそのまま使う）。4.1節の後も有効な結果が無ければ `未完了` とする（10節へ進む）。理由と確かめる担当を示した未確認は有効な結果であり、それだけでは `未完了` にせず、委譲し直す理由にもしない。
反証の有効な結果を受け取ったら10節へ進む。

## 10. 最終状態・点数・確認が残る事項・マージ可否を決める（スクリプト）

必要な担当の結果の検査を終えたら（4.1節・5節・7節で止めて `未完了` になったとき、`prepare` が `未実施` を返したときも）、保存の直前に次を1回だけ実行する。スクリプトが次の1〜8と11節（報告の組み立て・保存・照合・作業ログ・merge-ready）を順に行う。親は判定本文を読まず、点数・確認が残る事項・マージ可否を手で求めない。

```sh
bun <スキルのディレクトリ>/scripts/review.ts finalize --work <W の絶対パス>
  # 担当を1つも起動しなかった（委譲できない環境など）ときは --not-run-reason '<理由>' を足す
  # 計測（14節）: 親のセッション記録は PI_SESSION_FILE から決まる。無い環境では --session <絶対パス>、スキルの読み込みの開始を記録から決められなければ --skill-start <ISO 時刻>
```

- 終了コード 2 は引数の誤り（実行済み、最終返答の受領を記録していない・検査していない最新の試行がある、知らない引数（廃止した `--own-log`・`--auto-check-rows` を含む）など）で、判定ではない。示された記録・検査をしてから実行し直す。実行済みの作業ディレクトリでは保存し直さない（判定し直すには新しいレビューを行う）。
- 1〜8の規則と finalize の結果の各欄は付録の10節にある。親が読む欄は下のとおり。

結果は固定した対象版と要求に対するものであり、別の commit の承認に使わない。現在の head と基点の照合は取り直した時点の観測である。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果として報告する。

親が読むのは `status`・`reason`・`score`・`merge`・`blockers`・`remainingCount`・`documents` の ID・`saved`・`saveProblems`・`label` だけで、利用者・呼出元へは12節のとおり短い結果を返す。`saved` が false なら保存失敗として報告する（保存できた Document は保持し、再保存のためレビューを流し直さない）。

## 11. 報告を作り、保存する（スクリプト）

`finalize` が10節に続けて行う。親は報告を手で書かず、`nod doc create`・`nod issue log`・`nod issue update` を手で実行しない。

報告の中身、Document の保存と照合、作業ログ、merge-ready ラベル、作業ディレクトリに残すものと保存の後に片付けるもの（依存の写しと限定 clone）の規則は付録の11節にある。

## 12. 後続

- 実装後レビューでは、`finalize` の結果から短い結果（結論・Severity付きの要対応・未確認は `parent/report.md` のとおり）と結果Document ID・監査Document IDを呼出元へ返す。単独レビューのチャットも結論・Severity付きの要対応・未確認・結果と監査への参照だけにする。詳細は監査に残し、チャットへ繰り返さない。
- `未実施`・`未完了`: Issue を Done にも In Review にもせず、PR も出さない（PR 不要の依頼でも Done に進めない）。`未完了` は4.1節の手順（判定と無関係な無効は1回だけ委譲し直し、利用枠の上限では委譲し直さない）を終えた結果であり、さらに委譲し直したり、担当を再開したり、利用枠の回復を待って流し直したりして代替しない。
- `完了` でマージ可否が `不可`: 確認が残る事項は、提出・完了に必要な確認の不足として扱い、合格・指摘なし・確認済みへ読み替えない。後続の判断は既存の提出・完了条件に委ねる。保存直前の再照合で見つかった要求資料や未コミット変更の変化を確かめ直すには、新しいレビューを行う（このレビューの判定を書き換えない）。
- マージ可否が `不可（人の判断が要る）` なら、人の判断なしにマージへ進めない。`可` でもリポジトリの既存のマージ条件（ブランチ保護・ルールセットの必須ステータスチェック・必須のレビュー）を省かず迂回せず、このレビューからはマージしない。merge-ready ラベルを自動マージ・承認の代わりにしない。
- merge-ready が付いた後に、追加コミット・基点の変化・要求資料の変化で条件を満たさなくなった、または判定が古くなったと分かった時点で、ラベルを外し、理由と判定した head SHA を、本文を `[merge-ready]` で始めて `--kind progress` の作業ログに記録する。新しい head のマージ可否は新しいレビューでだけ決まる。
- 次の判断が必要な場合だけ、具体的な選択肢を番号付きで示し、おすすめと理由を添える。

## 14. 区間の時間と使用量（計測）

スクリプトが記録・集計する。親が手で時刻やトークンを数えたり、セッション記録を読んだりしない。親が行うのは、4節の `agent` の `start`（委譲の直前）と `received`（最終返答を受け取った直後）を欠かさず呼ぶことだけである。

段階・区間・使用量の定義、記録の場所、3つの値、Spec 探索の時間と Spec 担当全試行の合計使用量、作業ディレクトリの無い記録の集計（`usage`）は付録の14節にある。
