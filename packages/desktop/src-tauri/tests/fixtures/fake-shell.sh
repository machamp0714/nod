#!/bin/sh
# ログインシェルの代役。`-ilc <script>` で呼ばれ、rc のノイズを出し、PATH を補完してから script を実行する。
echo "Last login: Sat Oct 10 00:00:00 on ttys000"
echo "rc: loading plugins..." >&2
export PATH="/stub/bin:$PATH"
/bin/sh -c "$2"
status=$?
echo "rc: goodbye"
exit $status
