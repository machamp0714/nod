#!/bin/sh
# nod の代役。STUB_MODE: ok（既定）/ silent（URL 行を出さない）/ reused / exit
pwd > "$STUB_RECORD_DIR/cwd"
echo "$PATH" > "$STUB_RECORD_DIR/path"
echo "$@" > "$STUB_RECORD_DIR/args"
case "$STUB_MODE" in
  reused)
    echo "すでに起動している nod ui を開きます: http://127.0.0.1:4700/"
    exit 0 ;;
  exit)
    exit 3 ;;
  silent)
    ;;
  *)
    echo "nod ui: http://127.0.0.1:$STUB_PORT/（DB: /stub/nod.db）"
    echo "止めるには Ctrl+C を押してください" ;;
esac
trap 'exit 0' TERM
while :; do sleep 0.1; done
