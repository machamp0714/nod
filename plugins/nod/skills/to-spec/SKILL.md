---
name: to-spec
description: "nod の Issue の仕様を、grilling と別モデルの独立回答で詰め、仕様書（kind=spec の Document）の本文を Gemini 4 Argon に書かせて Issue に添付する。人やオーケストレーターが Issue ID を指定して仕様書の作成（nod:to-spec）を求めたときと、needs-spec の Issue で nod:implement や nod:pm から案内されたときだけ使い、一般的な仕様の相談では起動しない。"
---

<!-- mattpocock/skills の engineering/to-spec（c55ee46）を元に、nod 向けに書き換えた。grilling は呼び出す。 -->

# nod:to-spec

nod の Issue 1 件を対象に、未決の論点を grilling で詰め、仕様書の本文を Gemini 4 Argon に書かせて Issue に添付する。

引数: `<Issue id>`（必須）。任意で照会先のモデルと effort（例: `--reviewer-model gpt-6-astra --reviewer-effort high`）、執筆者 Argon の effort（`--writer-effort low|medium|high`、既定 medium）。執筆者のモデル自体は引数で変えられない。

## 0. 準備

- Codex で動いているときは、nod に書き込む前に `export NOD_ACTOR=codex` を実行する。
- 仕様書の本文（新規・作り直し・追記）は、agy コマンド経由の Gemini 4 Argon（`gemini-4-argon-low|medium|high`、effort に対応）が書く。§4 の同梱スクリプトが執筆を依頼する。実行には agy のインストールとログインが必要。agy や Argon を使えない場合、スクリプトは理由付きで失敗する。
- 実装計画（`nod:to-plan`）、`nod:wayfinder`、一般の Document の書き手は変えない。
- `nod issue show <id>` で説明・Documents・Activity を読む。既に kind=spec の Document があれば、作り直すのか追記するのかをユーザーに聞く。
- リポジトリを調べる。`CONTEXT.md` があれば用語をそれに合わせ、触る領域の ADR を守る。

## 1. 前提を決める

- **Issue 本文に明記されている内容（例文・決定事項・受け入れ条件）は前提であり、論点にしない。** 変えたほうがよいと思ったら「Issue の記述を変える提案」と明示して別に出し、照会先と一致しても勝手に確定させない。
- **問いと答えの記録を、最初から nod の Document にする。** 一時ディレクトリに置くと、セッションの再開などで消えて原文が残らないため。grilling を始める前に `nod doc list` で同名が無いことを確かめ、`nod doc create <id を小文字にしたもの>-grilling-YYYYMMDD.md --title "<id> grilling の問いと答え" --kind doc --issue <id> --body "<冒頭の説明>"` で作って添付する。冒頭の説明には、照会先のモデル・effort と、Issue 本文を前提として問わないことを書く。
- この Document（作られた Markdown ファイル）が決定ログを兼ねる。以後はファイルを直接編集して、ラウンドごとに追記する（`nod doc create` は既存のファイルを上書きしないので、作り直さない）。

## 2. grilling（別モデルとの照合つき）

Skill ツールで `grilling` を呼び、その手順（設計の木、frontier、ラウンド制、各問に推奨を添える）に従う。各ラウンドを次のように進める。

1. **自分の推奨を先に固定する。** frontier の質問と自分の推奨・理由をファイルに書く。事実が要る問いは、推奨の前にコードで確かめる。
2. **もう一方のモデルに独立に答えさせる。** 推奨を取り除いた質問だけを、Issue 本文と決定ログと一緒に渡す。プロンプトには次を入れる。
   - Issue 本文と決定ログは確定事項で、覆さないこと（懸念は「変更の提案」と明示して別に書く）
   - 各問に「回答（選択肢の記号か独自案）・理由・根拠（file:line、調べていなければ『推測』）」で答えること
   - 確かめてほしい事実（あれば）
   - 最後に「まだ決まっていない論点」を最大 3 つ。実装者が決めてよい細部は挙げない
3. **突き合わせる。** 一致した問いは確定として扱う。割れた問いだけを、両方の案・根拠・自分の推奨（照会先の根拠で考えが変わったらそう書く）を添えてユーザーに聞く。照会先が示した事実は、判断に使う前に自分でも確かめる。
4. **ラウンドの記録を Document に追記する。** ユーザーの回答が出そろったら、`## Round N` の見出しの下に、問いごとに「問い・自分の推奨・照会先の回答・決定・決定者（一致／ユーザー／差し戻し）」を表で書く。照会先の回答の原文は、`<details>` に折りたたんでそのまま貼る。前提の訂正や、決定の見直し（どの問いを、なぜ変えたか）もここに書く。
5. 照会先が挙げた新しい論点は、次のラウンドの候補にする。ユーザーの回答で前提が変わったら、その影響を受ける問いを見直す。
6. frontier が空になり、ユーザーが合意を確認したら終える。合意したテストの seam（3）も Document に追記する。

照会先は「いま動いていないほうのモデル」にする。執筆者の Argon は照会先にしない。

- Claude Code から: `codex exec -m <model> -c model_reasoning_effort=<effort> -s read-only --skip-git-repo-check -o <回答ファイル> - < <プロンプトファイル>`（既定は gpt-6-astra・high。バックグラウンドで実行するときも標準入力をファイルから渡す。渡さないと入力待ちで止まる）
- Codex から: `claude -p --permission-mode plan --model <model> < <プロンプトファイル> > <回答ファイル>`（既定は opus）

## 3. テストの seam を確認する

テストする境界（seam）を書き出し、ユーザーに確認する。既存の seam を優先し、できるだけ高い層に置き、数は少なく（理想は 1 つ）。各 seam に、手本になる既存のテストを添える。

## 4. Argon に執筆を依頼する

本文は Gemini 4 Argon が書く。主担当は入力をそろえて依頼し、原稿を照合するだけで、本文を自分では書かない・直さない。執筆ルールと仕様書テンプレートは `references/spec-writing.md`（このスキルのディレクトリ内）が正本で、スクリプトがその全文を依頼文に入れる。主担当も照合に使う。

1. **入力をそろえる。** Argon に渡るのは次だけ。会話の全文や認証情報は入れない。
   - Issue: `nod issue show <id> --json > <作業用の一時ディレクトリ>/issue.json`
   - 決定ログ: §1 の Document のファイルそのもの（`nod doc show <Document id>` の 2 行目のパス）。写しを渡さない
   - 関連する既存の正式仕様書: 主担当が選ぶ。Issue 本文や決定ログが明示的に参照する Issue の kind=spec の Document。ファイルは各 Document のパス（`nod doc show` の 2 行目）を渡す
   - 作り直し・追記では、改訂の対象の仕様書（`--target` で渡す。`--related` には重ねない）
   - **実行の前に**、選んだ関連 Document（ID・題・選んだ理由。無ければ「なし」）と改訂の対象を決定ログの末尾に書く。
2. **スクリプトを実行する。** スクリプトはこのスキルのディレクトリ（この SKILL.md があるディレクトリ。Claude Code では「Base directory for this skill」として示される）から解決する。リポジトリの作業ディレクトリの `plugins/` を使わない。

   ```sh
   bun <スキルのディレクトリ>/scripts/write-spec.ts --issue <id> --issue-json <issue.json> \
     --decision-log <決定ログのパス> [--related <Document id>=<パス>]... \
     [--mode new|rebuild|append] [--target <Document id>=<パス>] \
     [--feedback <指摘ファイル> --previous-record <前回の files.record>] \
     [--effort <--writer-effort の値、既定 medium>] [--timeout <秒、既定 600>]
   ```

   - `--mode` は新規 `new`（既定）、作り直し `rebuild`、追記 `append`。`rebuild`・`append` では `--target` が要る。
   - 標準出力に結果の JSON が 1 つ出る（`ok`・`code`・`message`・`attempt`・`files`・`draftSha256`・`openQuestions`・`changeProposals`）。依頼文・生ログ・原稿・実行記録は決定ログと同じディレクトリに `<id を小文字にしたもの>-argon-<NN>-{request.md,events.jsonl,draft.md,record.json}` として保存され、既存ファイルは上書きされない。
   - スクリプトは nod に書き込まない。
   - agy の `--print` に依頼文の全文を渡し、`--output-format stream-json` の完了イベントを読む。effort はモデルIDの末尾と `--effort` の両方に指定する。空の一時ディレクトリで `--sandbox --disable-slash-commands` を使い、権限の自動承認はしない。ツール不使用は依頼文で指示するが、agy のツール自体を無効にするものではない。
3. **失敗（非 0 終了、`ok: false`）したら**、下の「使えないとき・採用できないとき」に従う。ただし `OPEN_QUESTIONS` は 6 に従う。
4. **成功したら原稿を照合する。** `files.draft` を決定ログと `references/spec-writing.md` に照らし、次を確かめる。
   - 決定ログのすべての決定と合意したテスト seam が反映されている
   - 新しい決定が足されていない。不採用案や未確認の情報が決定として書かれていない
   - テンプレートの 7 節がそろう（追記では不要）
   - ファイルパスとコード片が無い
   - 冒頭に、Issue 本文が前提であること・照合の経緯・Gemini 4 Argon が執筆したこと（追記では追記部分を執筆したこと）がある
5. **食い違いは差し戻す。** 本文を直さない。指摘をファイルに書き、同じ引数に `--feedback <指摘ファイル> --previous-record <前回の files.record>` を加えて再実行する。スクリプトは前回の実行記録から原稿（記録の SHA-256 と照合）を読んで依頼文に入れる。差し戻しは最大 2 回（1 つの依頼で呼び出しは合計 3 回まで）。それでも合わなければ、残った食い違いを理由に失敗として扱う。
6. **未決の疑問（`OPEN_QUESTIONS`）が返ったら**、既決かを決定ログで確かめる。既決なら、疑問ごとに該当する決定（決定ログの問いと決定）を回答として指摘ファイルに書き、5 と同じく `--feedback <指摘ファイル> --previous-record <その試行の files.record>` で差し戻す（5 の回数に含める）。原稿は保存されていないので、スクリプトは前回の実行記録から未決の疑問を読み、回答とともに依頼文に入れる。未決なら §2 の grilling の新しいラウンドに戻り、決まってから 1 から依頼し直す。
7. **変更提案（`changeProposals`）が返ったら**、決定ログに「変更提案（Argon）」の見出しで記録し、ユーザーに伝える。本文には反映させない（差し戻しで入れさせることもしない）。採否はユーザーが決める。
8. **決定ログに「Argon 執筆記録」の節を追記する。** 採用した試行の実行記録（`files.record`）から、試行番号・執筆の種類・実行日時・所要時間・agy のバージョン（`agyVersion`）・要求したモデルと effort・agy が選択したモデルと完了状態（`responded.model`・`responded.status`）・セッション ID・各入力の SHA-256 とバイト数・原稿の SHA-256 と、保存したファイル名を書く。選択モデルは agy の init イベントの報告であり、推論先のモデルを独立に証明する情報ではない。差し戻した・失敗した試行も、試行番号と理由を 1 行ずつ書く。

依頼中（差し戻しを含む）は決定ログを書き換えない。7・8 や失敗の記録は、採用か失敗が決まってから**末尾にだけ**追記する（§5 の比較で、依頼時点の部分をバイト数で切り出すため）。

追記は**追記の控え**を通して行う。追記の控えは、採用か失敗が決まった試行の実行記録（`files.record`）と同じディレクトリにあり、名前の `-record.json` を `-appendix.md` に変えたファイル（例: `nod-60-argon-03-appendix.md`）。採用か失敗が決まったら、追記より先に `touch <追記の控え>` で空の控えを作る。追記する節をファイルに書き、`cat <節のファイル> >> <追記の控え>` と `cat <節のファイル> >> <決定ログのパス>` を続けて実行する。§5 の添付を終えるまで、決定ログへの追記はすべてこの手順で行い、追記の控えはほかの方法で書き換えない。§5 の比較で主担当が追記した節だけを除き、利用者や別のセッションによる追記・変更を見つけるため。

### 使えないとき・採用できないとき

スクリプトの失敗（`AGY_NOT_FOUND`・`ARGON_UNAVAILABLE`・`TIMEOUT`・`AGY_FAILED`・`MODEL_NOT_ARGON`・`STOP_REASON`・`EMPTY_BODY`・`RESPONSE_FORMAT`・`TOP_HEADING`・`SECTION_MISSING`・`INVALID_INPUT`・想定外のエラーの `UNEXPECTED_ERROR`）や、差し戻しの上限に達したとき。`MODEL_NOT_ARGON` は agy が選択したモデルの不一致または欠落、`STOP_REASON` は完了イベントの欠落または `SUCCESS` 以外の状態を表す。

- 仕様 Document を作らない（作り直し・追記では既存の仕様書を変えない）。`needs-spec` を外さず、`ready-for-agent` を付けない。
- 理由コードと説明（`message`）と実行記録のファイル名を決定ログに記録し、ユーザーに伝える。選択肢は「時間をおいて再試行」「執筆者を名指しで変える」。
- 別の執筆者で書くのは、ユーザーが執筆者を名指しで指示したときだけ。「推奨で進めてよい」のような一般的な委任は、執筆者の変更の指示とみなさない。名指しされたら、その執筆者が `references/spec-writing.md` に従って書き、実際の執筆者を仕様書の冒頭・決定ログ・作業記録に書く。Argon 執筆とは記録しない。

## 5. Issue に添付する

1. **入力が変わっていないことを確かめる。** 添付の直前に取り直し、採用した試行の実行記録（`files.record`）の `inputs` と比べる。
   - Issue 本文: `nod issue show <id> --json | jq -j .description | shasum -a 256` が、`role` が `issue-description` の `sha256` と一致する
   - 決定ログ: `role` が `decision-log` の `bytes` を N として、次の 2 つがともに成り立つ
     - 依頼時点の部分: `head -c N <決定ログのパス> | shasum -a 256` が、その `sha256` と一致する
     - その後の部分: `tail -c +<N+1> <決定ログのパス> | cmp - <採用した試行の追記の控え>` が一致する（終了コード 0）。控えが無いときは一致しないものとして扱う。主担当が §4 の手順で追記した節だけなら一致し、ほかの追記や変更が混ざれば一致しない
   - 関連仕様と改訂の対象: `role` が `related`・`target` の各項目で `shasum -a 256 <file>` が `sha256` と一致する
   - 1 つでも違えば原稿を採用せず、新しい入力で §4 をやり直す。
2. 執筆の種類ごとに添付する。原稿（`files.draft`）は一字も変えない。
   - **新規:** `nod doc list` で同名のファイルがないことを確かめる（`nod doc create` は既存ファイルを上書きしない）。`nod doc create <id を小文字にしたもの>-spec-YYYYMMDD.md --title "<id> 仕様: <短い題>" --kind spec --issue <id> --body - < <原稿>` で作って添付する。
   - **作り直し:** 既存の仕様書の 1 行目がタイトル見出し、2 行目が空行であることを確かめる。改訂前の写しを同じディレクトリに保存する（`<元のファイル名>-before-YYYYMMDDHHMM.md`。既存ファイルがあれば別名にし、上書きしない）。`{ head -n 2 <写し>; cat <原稿>; } > <仕様書のパス>` でタイトル見出しの後を原稿の全文に置き換える。kind と Issue リンクはそのまま保つ。写しのファイル名は決定ログの末尾に記録する。
   - **追記:** 作り直しと同じ要領で改訂前の写しを保存し、既存の本文の末尾に空行を 1 つ置いて原稿をそのまま加える。記録には「追記部分を Gemini 4 Argon が執筆」と書き、元の本文を Argon 執筆とは書かない。
3. **添付を確かめる。** `nod doc show <Document id>` で kind=spec と対象 Issue へのリンクを確かめる。本文の指紋は、新規・作り直しなら `tail -n +3 <仕様書のパス> | shasum -a 256`、追記なら `tail -c <原稿のバイト数> <仕様書のパス> | shasum -a 256` が `draftSha256` と一致することを確かめる。
4. 3 を確認できたら、`nod issue update <id> --remove-label needs-spec` でラベルを外す。作成・更新・添付に失敗した場合や、仕様に未決事項が残る場合は外さない。解除に失敗したら、仕様 Document は保持し、失敗を報告してここで止める。
5. `nod issue update <id> --add-label ready-for-agent` でラベルを付ける。ラベルの定義が無くても付けられる。
6. `nod issue log <id> "<決定の要約と照合の経緯。執筆者（Gemini 4 Argon、effort、試行番号。追記では追記部分の執筆者として）。決定ログの Document id>" --kind rationale` を 1 件残す。
7. Out of Scope に別 Issue へ切り出すものがあれば、ユーザーに確認してから `nod issue create ... --discovered-from <id>` で起票する。
8. `nod issue show <id>` で仕様 Document の添付と `needs-spec` がないことを確認し、完了を報告する。

- nod への書き込みはすべて主担当の書き手（`NOD_ACTOR`）のまま行う。Argon を書き手として偽装しない。
- 添付やラベル更新の途中で失敗したら、保存済みの原稿と実行記録から再開する。執筆をやり直さない。

## 6. 完了時のネクストアクション

番号付きで示し、おすすめを 1 つ理由つきで添えて、ユーザーの選択を待つ（自分から次へ進まない）。

1. `nod:to-plan` で計画を立てる（おすすめ）
2. 仕様書を自分で読んでから進む
