---
name: pstack-omp
description: "pstack のスキルにある Cursor の名前（Task、AskQuestion、todolist、subagent_type、モデルの slug、pstack-models.mdc、agent-transcripts、/loop、cloud agent など）を OMP の仕組みに読み替える表。pstack のスキルの先頭の案内に従い、セッションごとに1回読む。"
---

# pstack を OMP で使うときの読み替え

pstack のスキルは Cursor の名前で書かれている。OMP では、pstack のスキルに従う前に、この表をセッションごとに1回読む。スキルに出てくる Cursor の名前は、下の表で OMP の仕組みに読み替える。各表の最初の列が Cursor の名前、次の列が OMP での扱いである。

## 一般則

- 表に行の無い Cursor の項目は落とし、落としたことを返答に1行書く。
- ツールのスキーマに無い項目や値は渡さない。Cursor の項目を、OMP のツールにそのまま渡さない。
- 「使わない。行き当たったら止まって報告する」と書いた項目に当たったら、その手順を始めずに止まる。どのスキルのどの手順の、どの項目で止まったかを報告する。子なら、親への最終の返答に書く。黙って飛ばさない。代わりの仕組みを自分で組まない。
- 別の pstack のスキル（`/name`、「the **name** skill」、`../<name>/SKILL.md`）は、`read` で `skill://<name>` を読んで従う。スキルの中のファイルは `skill://<name>/<path>` で読む。cursor-team-kit の `deslop`（`/deslop`）、`control-ui`、`control-cli` も同じで、`skill://deslop` のように読む。利用者に入力してもらうときは `/skill:<name>` と書く。
- 子に pstack のスキルを読ませるときは、brief の初めに、先に `skill://pstack-omp` を読むよう書く。`poteto-agent` で起動した子は、この表を自動で読む。

## ツール

| Cursor | OMP |
| --- | --- |
| `Task`（Task tool、Task subagent、Task call） | `task` ツール。1回の呼び出しに `{ context, tasks: [...] }` を渡し、`tasks` の1項目が子1つになる。`context` は全部の子に渡る共通の背景で、省けない。項目には `name`、`agent`、`task`、`solutionSpace` のように、スキーマにある項目だけを書く。「N 個の子を1つのメッセージで起動する」は、`tasks` に N 項目を並べた1回の呼び出しにする。 |
| `AskQuestion` | `ask` ツール。質問は `html` に1つの `<form>` で書き、選択肢は `type="radio"` か `type="checkbox"` にする。UI の無いセッションと子では `ask` を使えない。そのときは、未決の問いを最終の返答に書く。 |
| todolist（todolist tool、todo list） | `todo` ツール。`op: "init"` と `list`（`phase` と `items` の組の配列）で作り、`op: "start"` と `op: "done"`（`task` に項目の文言をそのまま書く）で進め、`op: "append"` で足す。子には `todo` が無いので、子は一覧を返答の中で持つ。 |

## 子の起動の項目

| Cursor | OMP |
| --- | --- |
| `subagent_type` | `tasks` の項目の `agent`。値は下の行で読み替える。 |
| `generalPurpose`（`subagent_type: generalPurpose`） | `agent` を省く。既定の `task` エージェントで動く。 |
| poteto-agent（`subagent_type: "poteto-agent"`） | `agent: "poteto-agent"`。nod の OMP 向けのディレクトリにある定義で、モデルは役割 `task` で決まり、この表を自動で読む。上流の定義の「`~/.cursor/plugins/` を探す」手順は使わない。スキルが「このスキルの絶対パスを渡す」と書くところは、bash で `realpath skill://poteto-mode` が出すパスを渡す。 |
| comment-sicko（`subagent_type: "comment-sicko"`） | OMP にこの名前の定義は無い。`agent` を省いて起動し、`task` の1行目に、上流の定義ファイルを読んでその本文に従うよう書く。定義ファイルは、`realpath skill://poteto-mode` が出す `<X>/generated/pstack/skills/poteto-mode` の `<X>` を使った `<X>/generated/pstack/agents/comment-sicko.md` である。定義の規則を brief に書き写さない。 |
| `readonly: true`、`readonly: false`、readonly/Ask | OMP の子に readonly の項目は無い。`readonly: true` の子は `agent` を省いて起動し、brief に「ファイルを書き換えない」と書く。子が終わったら `git status` で変更が無いことを確かめる。`readonly: false` は省く。OMP の子は readonly かどうかによらず、親の MCP を使える。 |
| `run_in_background: true` | 省く。OMP の `task` の子は既定でバックグラウンドのジョブになり、終わると結果が自動で届く。ほかにすることが無く結果を待つときだけ `wait` を使う。 |
| `resume` | `write` で `agent://<id>` に続きの指示を送る。`<id>` は起動の結果に出る子の名前で、parked の子も起き上がる。 |
| `file_attachments` | 省き、ファイルのパスを `task` か `context` に書く。 |
| `environment: "local"` | 省く。OMP の子は手元で動く。 |
| Project worker | OMP に Cursor の Project の worker は無い。Task subagent に当てる決まり（kickoff の1行目など）は、`task` で起動する子に当てる。Project worker を起動する手順は、使わない。行き当たったら止まって報告する。 |
| 入れ子の委譲（子がさらに子を起動する） | 起動できるのは、メイン、子、孫までである（`task.maxRecursionDepth` の既定は 2）。孫には `task` が無いので、孫は委譲せずに自分で作業する。 |

## モデル

OMP では、子のモデルと思考の水準を OMP の設定で決める。エージェント定義の `model`（`poteto-agent` は役割 `task`）と、利用者の設定の役割 `modelRoles` である。`task` の項目に `model` と `effort` を渡さない。`model` は `task.perCallModel` が `on` のときしか通らず、既定の `off` では起動前の検査で失敗する。利用者の OMP の設定を書き換えない。

| Cursor | OMP |
| --- | --- |
| `claude-*`、`gpt-*`、`grok-*`、`gemini-*` などの Cursor のモデルの slug（`claude-opus-5-5-xhigh-fast` など。`-fast` 付きも同じ） | `model` に渡さない。スキルが役割の既定として書く slug は、OMP の設定で決まるモデルに置き換わる。「Task ツールが slug を拒んだら別の slug に落とす」手順も要らない。 |
| 子ごとの推論の水準（「Pick each subagent's reasoning level」、`-high`、`-xhigh` などの段） | `effort` を渡さない。子は定義と役割の水準で動く。 |
| 別のモデルや別のベンダーで並べる座席（arena の runners と cross-judge、interrogate の reviewers、「another vendor's model」） | 子のモデルを呼び出しごとに選べないので、どの座席も OMP の設定のモデルで動く。座席はスキルの数のまま起動し、返答に「どの座席も同じ設定のモデルで動いた」「ベンダーの確認は走らなかった」と書く。 |
| `inherit-parent`、`auto`（役割の値） | OMP には役割の行が無いので、この値に当たることはない。`model` を渡さないのは同じである。「`inherit-parent` なら `generalPurpose` で起動する」という分かれ道は使わず、手順が指す `agent` のまま起動する。 |
| pstack-models.mdc（`~/.cursor/rules/pstack-models.mdc`、役割の行、`# budget` の行） | OMP には無い。読まず、書かない。役割ごとのモデルは OMP の設定（エージェント定義と `modelRoles`）にある。スキルが「規則やその行が無ければ既定の slug を使う」と書くところも、slug を渡さず、OMP の設定のモデルで動かす。 |

## setup-pstack

`/setup-pstack` は使わない。OMP では、モデルを OMP の設定（エージェント定義と役割 `modelRoles`）で決める。`/setup-pstack` を求められたら、実行せずにそう答える。モデルを変えたいときは、利用者が `~/.omp/agent/config.yml` の `modelRoles` を変える（`/model` の Roles でも変えられる）。スキルが「`/setup-pstack` をもう一度実行して予算やモデルを選び直す」と案内するところも、同じく OMP の設定の案内に読み替える。

## パス

| Cursor | OMP |
| --- | --- |
| `.cursor/skills/`、`~/.cursor/skills/` | プロジェクトは `.omp/skills/`、利用者は `~/.omp/agent/skills/`。どちらも `<置き場>/<name>/SKILL.md` の形で、frontmatter に `name` と `description` が要る。`skill://` で読む pstack と cursor-team-kit のスキルは生成した写しなので、編集しない（`plugins/cache/` と同じ扱い）。 |
| `~/.cursor/plugins/`、`.cursor-plugin/plugin.json` | OMP は pstack を、nod のデータ置き場に生成した写しから読む。探さずに `skill://<name>` で読む。物理パスは bash の `realpath skill://<name>` で分かる。pstack の版は、写しの `manifest.json`（`realpath skill://poteto-mode` が出す `<X>/generated/pstack/skills/poteto-mode` の `<X>` を使った `<X>/generated/manifest.json`）の `pin.pstackVersion` にある。 |
| `.cursor/rules/`、always-applied rule（`.mdc`） | OMP は `.mdc` を読まない。いつも効かせる指示は `AGENTS.md` などのコンテキストファイルにある。規則を書く pstack の手順は setup-pstack だけで、それは使わない。 |
| agent-transcripts（`~/.cursor/projects/<slug>/agent-transcripts/`） | OMP のセッションの記録は `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` にある。`<encoded-cwd>` は、ホームの下のワークスペースなら、ホームからの相対パスの `/` を `-` に変えて先頭に `-` を付けたもの（`~/work/proj` なら `-work-proj`）。いまのセッションは、その中の最も新しい `.jsonl` である。並行するセッションがあれば、中の自分のメッセージで確かめる。子の記録は `<ts>_<id>/<子のid>.jsonl`、孫の記録は `<ts>_<id>/<子のid>/<子のid>.<孫のid>.jsonl`。起動した子の記録は `history://<id>` でも読める。いまのワークスペースの置き場だけを読み、ほかのワークスペースの置き場は読まない。 |

## 使わない範囲

クラウドエージェントと、Cursor の仕組みで自分や子を後から起こすことを前提にした手順は、OMP では使わない。次の項目は、使わない。行き当たったら止まって報告する。

| Cursor | OMP |
| --- | --- |
| `environment: "cloud"`（swarm の Phase B などの、クラウドの VM で動く子） | 使わない。行き当たったら止まって報告する。OMP の子は手元のプロセスで動き、クラウドには置けない。 |
| cloud_base_branch | 使わない。行き当たったら止まって報告する。 |
| Cursor-only features: Cursor cloud agents（autopilot-full の PR ごとの owner、shipping の PR ごとの verifier、cloud-agent の URL など） | 使わない。行き当たったら止まって報告する。 |
| Cursor-only features: Cursor Automations（routines、`update_state`、`api2.cursor.sh/automations` の webhook、routine の起床、`SendToUser`） | 使わない。行き当たったら止まって報告する。 |
| Cursor-only features: Bugbot | PR に既にある Bugbot のコメントは、ほかの review thread と同じに仕分ける。Bugbot を起動する、待つ、設定する手順は、使わない。行き当たったら止まって報告する。 |
| /loop（Cursor の組み込みの `/loop` で、自分を後から起こす仕組み。autonomous-run の step 2、autopilot-full の `/loop 1h`、autopilot-stack の tick、shipping の step 5、visual-parity の step 4、bug-fix の step 2、「/loop until done」） | 使わない。行き当たったら止まって報告する。OMP にも `/loop` という名前のコマンドがあるが、別の仕組みとして扱い、置き換えに使わない。 |

## PR

| Cursor | OMP |
| --- | --- |
| origin pr（Origin の CLI。`origin pr view`、`origin pr create` など） | OMP での読み替えは無い。手順のとおり `command -v origin` で確かめ、無ければ `gh` を使う。 |
| Cursor-only features: 組み込みの PR ツール（`draft: false`） | OMP にこの PR ツールは無い。手順の、PR ツールが無いときの書き方（「Without one」）のとおりに PR を作る。`command -v origin` で Origin の CLI が使え、リポジトリを解決できれば `origin pr create --status open`、そうでなければ `gh pr create` を `--draft` を付けずに使う（ready の PR になる）。 |
