#!/bin/sh
# 終わらないシェルの代役。孫プロセス（sleep）も残す。
echo $$ > "$STUB_PID_FILE"
sleep 30 &
echo $! > "$STUB_CHILD_PID_FILE"
wait
