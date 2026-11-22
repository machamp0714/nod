#!/bin/bash
# Studio から Air の nod を SSH で呼ぶラッパー。nod の DB と Web UI は Air にある。
# - Workspace はリポジトリ本体のパスで判定する（Studio と Air で同じパスに置く前提）。Air ではその本体へ cd する
# - 実行元の worktree とブランチは NOD_WORKTREE・NOD_BRANCH で渡す（Air の checkout と混ぜない）
# - Air の Orca を操作しないよう NOD_ORCA=0 にする
# - ファイルは転送しない。ファイル入力に手元のパスが指定されたら、Air の同じパスの別ファイルを読ませないよう実行せずに止める。
#   通すのは、Air の nod doc create が返す Documents ディレクトリの絶対パスと、標準入力を受ける入力の - だけ
# - タイトルや本文などファイル入力でない値は、手元のファイル名と一致しても書き換えも拒否もしない
# 稼働中のラッパーとして使うときは ~/.local/bin/nod に置く（Air の nod は ~/.local/bin/nod）
set -euo pipefail
AIR=air
DOCS_DIR=$HOME/.local/share/nod/documents
# Workspace のキー（英大文字と数字の2〜6文字。nod は大文字にそろえて引く）。ロケールに左右されないよう文字を列挙する
KEY_RE='^[0-9ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]{2,6}$'

# nod と同じく、-- より前に --json があればエラーを JSON で標準出力に出す
JSON=0
for a in "$@"; do
  if [[ $a == -- ]]; then break; fi
  if [[ $a == --json ]]; then JSON=1; fi
done

json_escape() {
  local s
  s=$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\010\013\014\016-\037')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

fail() {
  if ((JSON)); then
    printf '{\n  "error": {\n    "code": "LOCAL_PATH_REJECTED",\n    "message": "%s"\n  }\n}\n' "$(json_escape "$1")"
  else
    printf 'エラー（LOCAL_PATH_REJECTED）: %s\n' "$1" >&2
  fi
  exit 1
}

# Air の nod doc create が作った Document の絶対パスか。.. で Documents ディレクトリの外へ出るものは含めない
is_air_document() {
  local rest=${1#"$DOCS_DIR"/}
  if [[ $1 != "$DOCS_DIR"/* || -z $rest || /$rest/ == */../* ]]; then return 1; fi
  return 0
}

# -w と workspace remove の値。キーと絶対パスは Studio と Air で同じものを指す。空は nod が指定なしとして扱う
is_workspace_ref() {
  if [[ -z $1 || $1 == /* || $1 =~ $KEY_RE ]]; then return 0; fi
  return 1
}

# 拒否するファイル入力ごとの代わりの方法
alternative() {
  case "$LEAF|$1" in
    "issue doc add|<path>")
      ALT="nod doc create <名前>.md --body - --issue <Issue の ID> < '$2' で内容を標準入力から渡して Air に作り、そのままリンクしてください" ;;
    "project doc add|<path>")
      ALT="nod doc create <名前>.md --body - --project <Project> < '$2' で内容を標準入力から渡して Air に作り、そのままリンクしてください" ;;
    "issue doc remove|<path>" | "project doc remove|<path>")
      ALT="nod doc list で Document の id を確かめ、nod doc unlink <id> --issue <Issue の ID>（Project なら --project <Project>）で外してください" ;;
    "issue plan|--from")
      ALT="nod doc create plans/<名前>.md --body - < '$2' で内容を標準入力から渡して Air に作り、表示された絶対パスを --from に指定してください（Task のタイトルだけなら --step を使えます）" ;;
    "issue attach add|--file")
      ALT="リンクなら --url で添付してください。ファイルは、そのファイルがあるマシンの nod で直接添付してください" ;;
    "issue publish|--body-file" | "template add|--from")
      ALT="nod doc create <名前>.md --body - < '$2' で内容を標準入力から渡して Air に作り、表示された絶対パスを $1 に指定してください（先頭に # 見出しが付きます）" ;;
    "workspace rules set|--from")
      ALT="--text \"\$(cat '$2')\" で本文を渡してください" ;;
    *"|--input")
      ALT="--input - < '$2' で内容を標準入力から渡してください" ;;
    "ui|--web-dir")
      ALT="--web-dir を省いて Air の既定の web を使うか、Air で直接 nod ui を実行してください" ;;
    *)
      ALT="そのファイルがあるマシンの nod で直接実行してください" ;;
  esac
}

reject_file() {
  alternative "$1" "$2"
  fail "nod $LEAF の $1 に指定された '$2' は手元のファイルとして使えません。このラッパーはファイルを Air へ転送しないため、Air では同じパスの別のファイルを読むか、見つからずに失敗します。代わりに: ${ALT}。Air の Documents（${DOCS_DIR}）にあるファイルは、その絶対パスで指定できます"
}

reject_workspace() {
  fail "${LEAF:+nod $LEAF の }$1 に指定された '$2' は相対パスです。Air では別のディレクトリを基準に解決され、別の Workspace を指すおそれがあるため実行しませんでした。Workspace のキー（例: -w NOD。nod workspace list で確かめられます）か、Air 上の絶対パスを指定してください"
}

# 種類は f（ファイル）・i（ファイルか標準入力の -）・w（Workspace のキーかパス）。それ以外の値は見ない
check_value() {
  case $1 in
    f) if ! is_air_document "$3"; then reject_file "$2" "$3"; fi ;;
    i) if [[ $3 != - ]] && ! is_air_document "$3"; then reject_file "$2" "$3"; fi ;;
    w) if ! is_workspace_ref "$3"; then reject_workspace "$2" "$3"; fi ;;
  esac
  return 0
}

# spec（「名前:種類」を空白で区切ったもの）から名前の種類を OPT_TYPE に入れる
opt_type() {
  local entry
  for entry in $1; do
    if [[ ${entry%:*} == "$2" ]]; then
      OPT_TYPE=${entry##*:}
      return 0
    fi
  done
  return 1
}

is_option_like() {
  if [[ ${#1} -gt 1 && $1 == -* ]]; then return 0; fi
  return 1
}

# nod の CLI（commander 12）の parseOptions と同じ規則で、1 階層ぶんの引数を分けて値を確かめる。
# 種類は r（値あり）・o（値は省略可）・b（値なし）と、値を確かめる f・i・w。
# 結果は P_OPS（位置引数）と P_UNK（この階層が知らないオプションとその後ろ。下の階層で読み直す）に入れる
parse_level() {
  local spec=$1 arg name dest=ops
  shift
  P_OPS=()
  P_UNK=()
  while (($#)); do
    arg=$1
    shift
    if [[ $arg == -- ]]; then
      if [[ $dest == unk ]]; then P_UNK+=(--); fi
      if (($#)); then
        if [[ $dest == unk ]]; then P_UNK+=("$@"); else P_OPS+=("$@"); fi
      fi
      return 0
    fi
    if is_option_like "$arg" && opt_type "$spec" "$arg"; then
      case $OPT_TYPE in
        b) ;;
        o) if (($#)) && ! is_option_like "$1"; then shift; fi ;;
        *)
          # 値がなければ nod が引数の誤りで止めるので、ここでは見ない
          if ((!$#)); then return 0; fi
          check_value "$OPT_TYPE" "$arg" "$1"
          shift
          ;;
      esac
      continue
    fi
    # -wNOD のように短いオプションに値や別のフラグが続くもの
    if [[ ${#arg} -gt 2 && $arg == -* && $arg != --* ]] && opt_type "$spec" "${arg:0:2}"; then
      case $OPT_TYPE in
        b) set -- "-${arg:2}" "$@" ;;
        o) ;;
        *) check_value "$OPT_TYPE" "${arg:0:2}" "${arg:2}" ;;
      esac
      continue
    fi
    # --from=plan.md のような等号の形
    if [[ $arg == --?*=* ]]; then
      name=${arg%%=*}
      if opt_type "$spec" "$name" && [[ $OPT_TYPE != b ]]; then
        check_value "$OPT_TYPE" "$name" "${arg#*=}"
        continue
      fi
    fi
    if is_option_like "$arg"; then dest=unk; fi
    if [[ $dest == unk ]]; then P_UNK+=("$arg"); else P_OPS+=("$arg"); fi
  done
}

# コマンドの階層ごとのオプションと位置引数（packages/cli/src/commands の定義と合わせる）。
# ファイル入力を持つコマンドとその親だけを載せ、ほかのコマンドの引数は見ない。
# NODE_POS は位置引数ごとの「種類:名前」。groups には --help 以外のオプションがない
describe_node() {
  NODE_LEAF=1
  NODE_OPTS="--cycle:o"
  NODE_POS=""
  case $1 in
    issue | "issue doc" | "issue attach" | project | "project doc" | scrum | sprint | "sprint session" | \
      "sprint execution" | "sprint plan" | workspace | "workspace rules" | template)
      NODE_LEAF=0
      NODE_OPTS=""
      ;;
    "issue doc add" | "project doc add")
      NODE_OPTS="--title:r --kind:r --cycle:o"
      NODE_POS="r:<id> f:<path>"
      ;;
    "issue doc remove" | "project doc remove") NODE_POS="r:<id> f:<path>" ;;
    "issue plan") NODE_OPTS="--from:f --step:r --cycle:o" ;;
    "issue attach add") NODE_OPTS="--url:r --file:f --title:r --cycle:o" ;;
    "issue publish") NODE_OPTS="--title:r --body-file:f --dry-run:b --clear-unknown:b --cycle:o" ;;
    "scrum configure" | "sprint create" | "sprint update" | "sprint plan propose" | "sprint plan accept" | \
      "sprint activate" | "sprint cancel")
      NODE_OPTS="--input:i --cycle:o"
      ;;
    "sprint session begin" | "sprint session resume" | "sprint session observe" | "sprint execution receive" | \
      "sprint execution receive-observation" | "sprint execution confirm-start" | "sprint execution start" | \
      "sprint execution request" | "sprint execution reconcile" | "sprint execution recover")
      NODE_OPTS="--input:i --from:r --environment:r --cycle:o"
      ;;
    "workspace remove")
      NODE_OPTS="--yes:b --cycle:o"
      NODE_POS="w:<keyOrPath>"
      ;;
    "workspace rules set") NODE_OPTS="--text:r --from:f --cycle:o" ;;
    "template add") NODE_OPTS="--from:f --cycle:o" ;;
    ui) NODE_OPTS="--port:r --web-dir:f --no-open:b --cycle:o" ;;
    *) return 1 ;;
  esac
  return 0
}

# commander と同じく、親の階層で位置引数になったものは下の階層で読み直さず、知らないオプションの後ろだけを読み直す
LEAF=""
parse_level "-w:w --workspace:w --json:b -V:b --version:b" "$@"
ops=()
unk=()
if ((${#P_OPS[@]})); then ops=("${P_OPS[@]}"); fi
if ((${#P_UNK[@]})); then unk=("${P_UNK[@]}"); fi
node=""
while ((${#ops[@]})); do
  node="${node:+$node }${ops[0]}"
  if ((${#ops[@]} > 1)); then ops=("${ops[@]:1}"); else ops=(); fi
  if ! describe_node "$node"; then break; fi
  LEAF=$node
  if ((${#unk[@]})); then parse_level "$NODE_OPTS" "${unk[@]}"; else parse_level "$NODE_OPTS"; fi
  if ((${#P_OPS[@]})); then ops+=("${P_OPS[@]}"); fi
  unk=()
  if ((${#P_UNK[@]})); then unk=("${P_UNK[@]}"); fi
  if ((NODE_LEAF)); then
    i=0
    for entry in $NODE_POS; do
      if ((i < ${#ops[@]})); then check_value "${entry%%:*}" "${entry#*:}" "${ops[i]}"; fi
      i=$((i + 1))
    done
    break
  fi
done

repo_root="" wt_root="" branch=""
if wt_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  common=$(git rev-parse --path-format=absolute --git-common-dir)
  repo_root=$(dirname "$common")
  # detached HEAD では HEAD になる。nod はそれをブランチなしとして記録する
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi
# git リポジトリの外で起動したときは、従来どおり Air のホームで実行する
target_dir=${repo_root:-$HOME}

actor=${NOD_ACTOR:-}
if [[ -z $actor && ${CLAUDECODE:-} == 1 ]]; then actor=claude-code; fi

envs="NOD_ORCA=0 NOD_WORKTREE=$(printf %q "$wt_root") NOD_BRANCH=$(printf %q "$branch")"
if [[ -n $actor ]]; then envs+=" NOD_ACTOR=$(printf %q "$actor")"; fi
cmd="cd $(printf %q "$target_dir") && $envs exec ~/.local/bin/nod"
for a in "$@"; do cmd+=" $(printf %q "$a")"; done
exec ssh -o BatchMode=yes "$AIR" "$cmd"
