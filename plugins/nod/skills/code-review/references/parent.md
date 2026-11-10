# 親の手順

単独レビューでは利用者のセッションが、実装後レビューでは実装を進行する親エージェントが、この手順で親になる。
親は自分でレビューしない。対象と要求を固定し、レビュー担当エージェントへ委譲し、引き渡しを検査し、判定を変えずに状態・点数・報告を記録する。

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
- 明示された未コミット変更のレビュー（`mode: local`）: 明示されたときだけ行い、commit や stash を作らない。土台の HEAD の SHA を固定し、merge-base は基点と土台の HEAD から求める。差分は `git -C <repo> --no-optional-locks diff --binary HEAD` で写し、未追跡ファイルは指定されたものだけを写す。
- 差分が空なら委譲せず、`未実施`（理由: 差分なし）・点数なしとして報告する。

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
| `parent/` | 親専用領域（取得結果、検査記録、指紋、担当の対応表、報告の原稿） | 親 | 親だけ |

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
(cd "$W/input" && find . -type f ! -name manifest.md | LC_ALL=C sort | xargs shasum -a 256)   # manifest.md の指紋
```

- 計画の出典が Document に解決できない、または本文を読めない場合は、別の計画で代用せず写さない。`target.md` と `manifest.md` に「計画の出典を解決できず不足（<plan.source>）」と書く。計画の出典が無い場合は「計画の出典なし」と書く。
- `kind=spec` の Document の本文を読めない場合も写さず、`manifest.md` に取得できなかった Document と理由を書く。
- Issue の無い単独レビューでは、`issue.md`・`spec-*`・`plan-*` の代わりに、利用者が明示した要求の原文（Document やファイル）だけを `requirements/request-<n>.md` に丸ごと写し、`target.md` に「Issue なし」と書く。明示された要求が無ければ「Workspace の規約以外の要求資料なし」と書く。`workspace-rules.md` はどちらの場合も写す。
- `nod issue show` の全出力、Activity（作業ログ・コメント）、実装の完了報告、過去のレビュー、自動チェックの結果、計画の進捗状態は `input/` に入れない。Spec・計画に混ざった結果の節を要求から外す判断は担当に任せ、親は削らない。

## 3. 両探索を並列に委譲する

Standards 探索担当と Spec 探索担当を、それぞれ新しいコンテキストで、1回の委譲で同時に起動する。依頼本文は次の最小限だけにする。

```text
役割: Standards 探索
作業ディレクトリ: <W の絶対パス>
読んでよい入力: <W>/input/ 配下（target.md・manifest.md・requirements/・local/）と、target.md に固定した SHA から読む対象リポジトリ
書いてよい場所: <W>/standards/（handoff.md と notes/）と自分の一時ファイル
出力: <W>/standards/handoff.md
```

Spec 探索は `役割: Spec 探索`、書いてよい場所を `<W>/spec/`、出力を `<W>/spec/handoff.md` に置き換える。
共通の context を持つハーネスでは、それを空にする。空にできない場合は「指定された役割・入力・出力だけを使う独立レビュー。自動チェックは実行しない。」のような固定の1文だけにする。要求の要約、親の見立て、実装者の自己評価、作業ログ、探索の返答を入れない。

担当が実行中でまだ返っていない間は、待機中として状況を報告するだけにする。経過時間だけで失敗と判定せず、ハーネスの終了・失敗・取り消しの通知を使う。ハーネスが実行中のままで応答しない場合はその状態を利用者へ報告し、停止を確認できないときは停止済みと報告しない。

ハーネスが返した各担当の ID を `parent/agents.md` に役割・定義名と対応付けて記録する。

## 4. 探索の引き渡し用ファイルを検査する

親は引き渡し用ファイルを書き換えない（補筆・削除・要約・整形をしない）。次だけを確かめ、結果と各ファイルの sha256 を `parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。
2. 指定したパスに `handoff.md` がある。
3. 役割・定義名・対象版・要求資料が書かれ、役割と定義名が委譲した担当と一致し、対象版が `target.md` と一致する。終了状態、未確認と理由、判断を見送った事項の節がある（無いことを明示していてもよい）。
4. 各候補に必須項目（SKILL.md の4節）がそろい、候補 ID が役割の接頭辞を持ち重複しない。証拠を取得できなかった候補には理由と不足箇所がある。
5. Standards 探索: 規約の一覧と今回の差分への適用判断、候補一覧または「候補0件」の明示、探索上の不足・判断を見送った事項がある。
6. Spec 探索: 要求ごとの対応表が4列（要求の出典・状態・証拠または不足理由・候補ID）で、`requirements/` のすべてのファイルを出典に含み、状態が SKILL.md の語彙だけを使う。未充足・未確認の行に候補 ID があり、その ID が候補一覧にある。
7. 禁止項目（暫定の重大度・確信度・要約・推論・総合判断・原因の統合）が項目名にも本文にも無い。項目名だけの検査では内容の混入まで保証できないので、本文も読んで確かめる。
8. `input/` の各ファイルの sha256 が `manifest.md` と一致する（担当が共通入力を変えていない）。

全確認単位を覆っているかの意味上の判断は反証担当が行う。親の検査は形式と参照の確認であり、内容の正しさの保証ではない。
どちらかの担当に違反・欠落・失敗があれば、その結果を有効とせず、反証を起動しない。最終状態を `未実施` とし、自動で修正を依頼したり、再委譲・担当の再開で代替したりしない（7節へ進む）。

## 5. 反証への入力を写し、反証を委譲する

両探索の検査を通過したときだけ、検査済みの引き渡し用ファイルと共通入力を、内容を変えずに `refute-input/` へ写す。

```sh
cp "$W/standards/handoff.md" "$W/refute-input/standards-handoff.md"
cp "$W/spec/handoff.md" "$W/refute-input/spec-handoff.md"
cp -R "$W/input/target.md" "$W/input/manifest.md" "$W/input/requirements" "$W/refute-input/"
[ -d "$W/input/local" ] && cp -R "$W/input/local" "$W/refute-input/"
(cd "$W/refute-input" && find . -type f | LC_ALL=C sort | xargs shasum -a 256)
```

写した各ファイルの sha256 が、検査時に記録した引き渡し用ファイルの指紋と `input/` の指紋に一致することを確かめ、`parent/fingerprints.md` に書く。一致しなければ写し直さずに `未実施` とする。
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

共通の context は3節と同じく空か固定の1文だけにする。待機と ID の記録は3節と同じ。

## 6. 反証の結果を検査する

`verdict.md` を書き換えずに次を確かめ、`parent/checks.md` に書く。

1. 担当が終了通知とともに返し、返答が入力不備・失敗ではない。指定したパスに `verdict.md` がある。
2. 役割・定義名・対象版・受け取った入力が書かれ、対象版が `target.md` と一致する。
3. 両方の引き渡し用ファイルのすべての候補 ID が採否一覧にあり、判定と根拠がある。要対応には影響度 0〜4 がある。
4. 要求ごとの対応表が4列で、Spec 探索の対応表のすべての行を確定している。
5. 反証で追加した発見（無ければ無いことの明示）、軸ごとの完了状態、未確認と理由、判断を見送った事項がある。
6. `refute-input/` の各ファイルの sha256 が `parent/fingerprints.md` と一致する。

欠落・失敗があれば `未実施` とする（自動の再委譲はしない）。

## 7. 最終状態と点数を決める

1. `mode: local` では、反証の結果を受け取った後に、土台の HEAD と差分（指定された未追跡ファイルを含む）を同じ方法で取り直し、`input/` の写しの sha256 と比べる。変わっていれば `未完了` とする。
2. 保存の直前に、要求の本文・資料だけを2節と同じ方法で `parent/requirements-recheck/` へ取り直し、`input/requirements/` と sha256 で比べる（Issue のタイトルと本文、現在リンクされている `kind=spec` の集合と本文、計画の出典が指す Document、Workspace の規約）。Activity・進捗・更新日時は比べない。変わっていれば旧要求に対する結果として保存し、現在の要求への適合は未確認とし、`未完了` とする。
3. 最終状態を SKILL.md の6節で決める。`未完了` の理由は、判定本文の未確認（必須要求や要対応の判断に必要なもの）・要求間の矛盾・軸ごとの未完了、要求の変化、未コミット変更の変化である。対応表の「説明」「自動チェック担当」「対象外」の行は、それだけでは未完了の理由にしない。
4. `完了` のときだけ、反証担当の判定から規則どおりに点数を計算する。親は判定・影響度・対応表を変えない。計算の過程（要対応の件数、各要対応の影響度、最小値）を記録する。

結果は固定した対象版と要求に対するものであり、別の commit の承認に使わない。

## 8. 報告を作り、保存する

[報告の雛形](../assets/report.md) で `parent/report.md` を作る。管理情報は親が書き、反証担当の判定本文は `refute/verdict.md` を `cat` でそのまま入れる（`未実施` で判定本文が無ければ「未受領」と理由を書く）。
モデル情報は各担当の引き渡し用ファイル・判定本文の申告と、ハーネスが示した情報だけを出典付きで書く。不明は未確認とし、実効モデルの証明として扱わない。

Issue がある場合は、最終状態にかかわらず報告を `kind=doc` の Document として Issue に添付し、作業ログに残す。

```sh
nod doc create <Issue IDの小文字>-code-review-<YYYYMMDD>-<runIdの先頭8文字>.md \
  --title "<Issue ID> コードレビュー結果（<runIdの先頭8文字>）" --kind doc --issue <Issue ID> --body - < "$W/parent/report.md"
nod doc show <Document ID>
awk '/^<!-- refute-verdict:begin -->$/{f=1;next} /^<!-- refute-verdict:end -->$/{f=0} f' <Document のパス> | shasum -a 256
```

- `nod doc show` で kind が doc であり Issue にリンクされたことを確かめる。収録した判定本文の sha256 が `refute/verdict.md` と一致することを確かめ、一致しなければ保存失敗として報告する。指紋は同一性の確認であり、改変を機械的に防ぐものではない。
- `完了`・`未完了`: `nod issue log <Issue ID> "<要約>" --kind progress` に、状態・点数（または点数なし）・要対応と未確認の要点・Document ID・runId・3担当の役割と ID を書く。
- `未実施`: `nod issue log <Issue ID> "<要約>" --kind blocker` に、独立レビュー未実施であること・原因・受領済みの成果・取得できた担当 ID・Document ID・runId を書く。
- 担当の ID はこの作業ログでもレビューと対応付ける。ID が異なることだけで、会話を引き継いでいないことを証明したとは扱わない。
- Issue の無い単独レビューは、`parent/report.md` とチャットでの報告だけにする。
- 要求の写し・引き渡し用ファイル・メモ・反証の結果は作業ディレクトリに残す。

## 9. 後続

- 実装後レビューでは、報告と Document ID を呼出元の手順へ返して終える。単独レビューは報告で終える。
- `未実施`: Issue を Done にも In Review にもせず、PR も出さない（PR 不要の依頼でも Done に進めない）。自動の再委譲や探索担当の再開で代替しない。
- `未完了`: `未実施` へ読み替えず、後続の判断は既存の提出・完了条件に委ねる。
- 次の判断が必要な場合だけ、具体的な選択肢を番号付きで示し、おすすめと理由を添える。
