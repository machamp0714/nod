---
name: to-plan
description: "nod の Issue の仕様を、縦切り（tracer bullet）の Task に分けて、Issue の計画として取り込む。Issue の分解（Sub-issue 化）はしない。"
disable-model-invocation: true
---

<!-- mattpocock/skills の engineering/to-tickets（c55ee46）の分割ルールを元に、出力先を nod の計画に書き換えた。 -->

# nod:to-plan

Issue の仕様を **Task** に分け、`nod issue plan` で Issue の計画にする。各 Task は縦切り（tracer bullet）で、依存する Task を明示する。Issue は分解しない。

引数: `<Issue id>`（必須）。

## 1. 材料を集める

- Codex で動いているときは、nod に書き込む前に `export NOD_ACTOR=codex` を実行する。
- `nod issue show <id>` を読み、kind=spec の Document（`nod doc show <Document id>`）を全文読む。仕様が無ければ、会話の内容を材料にするか、先に `nod:to-spec` を勧める。
- 既に計画があれば、作り直すのかをユーザーに聞く。

## 2. コードを調べる

まだなら、コードの現状を調べる。Task のタイトルと内容は `CONTEXT.md` の用語に合わせ、触る領域の ADR を守る。実装を楽にする事前リファクタ（prefactor）を探す。「変更を簡単にしてから、簡単な変更をする」。

## 3. 縦切りで分ける

<vertical-slice-rules>

- 各 Task は、すべての層（スキーマ・API・UI・テスト）を細く貫く完全な経路にする。1 つの層だけを横に切らない
- 終わった Task は、それだけでデモか検証ができる
- 各 Task は、新しいコンテキスト 1 回分に収まる大きさにする
- 事前リファクタは先頭に置く

</vertical-slice-rules>

各 Task に、先に終わっていないと始められない Task（依存先）を付ける。依存の無い Task はすぐ始められる。

**広範囲のリファクタは例外。** 1 つの機械的な変更（列名の変更、共有の型の変更など）が全体に波及し、どの縦切りもテストを通せないときは、expand–contract で並べる。新しい形を古い形と並べて足す（expand）→ 呼び出し元をまとまりごとに移す（migrate。各まとまりが 1 Task で expand に依存）→ 呼び出し元が無くなったら古い形を消す（contract。全 migrate に依存）。

## 4. ユーザーに確認する

番号付きの一覧で示す。各 Task に次を書く。

- **タイトル**
- **依存先**（無ければ「なし」）
- **終わると何が動くか**（デモできる振る舞い。層の名前ではなく）

次を聞き、承認されるまで直す。

- 粒度は合っているか（粗すぎ・細かすぎ）
- 依存は本当に必要なものだけか
- まとめる・分ける Task はあるか

「終わったら何をデモできるか」に答えられない Task は横切りなので、直してから示す。

## 5. 計画として取り込む

1. 計画書を書く。Task は `### Task N: <タイトル>（依存: なし | 依存: 1, 3）` の形にする（nod の計画には依存の欄が無いので、タイトルの末尾に書く）。各 Task の下に、受け入れ条件を `- [ ] **Step M: <条件>**` で並べる。冒頭に、元にした仕様の Document id を書く。ファイルパスとコード片は書かない。
2. `nod doc list` で同名のファイルが無いことを確かめ、`nod doc create <id を小文字にしたもの>-plan-YYYYMMDD.md --title "<id> 実装計画" --kind plan --issue <id> --body - < <計画書>` で **nod の Documents ディレクトリに** 作る。一時ファイルから `--from` で取り込むと、一時ファイルを指す Document が残るため。
3. 作った Document のパスで `nod issue plan <id> --from <パス>` を実行する。
4. `nod issue show <id>` で Task と Step の数が計画書と合うことを確かめる。

## 6. 完了時のネクストアクション

番号付きで示し、おすすめを 1 つ理由つきで添えて、ユーザーの選択を待つ（自分から次へ進まない）。

1. 作業ブランチ（または worktree）を用意して `nod:implement` に進む（おすすめ。`nod:implement` はデフォルトブランチ上では止まるため。ブランチ名は `nod issue branch-name <id>` で得られる。nod の Issue ID を含まない名前になっている）
2. 計画を見直す
