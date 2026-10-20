import json
import os
import subprocess
import sys
from pathlib import Path

cfg = json.loads(Path(sys.argv[1]).read_text())
args = sys.argv[2:]
env = dict(os.environ)
env.update(
    NOD_DB=cfg['dbPath'], NOD_ACTOR='codex', NOD_ORCA='0',
    NOD_DOCS_DIR=cfg['docs'], NOD_ATTACHMENTS_DIR=cfg['attachments'],
    TYPESAFE_API_KEY='',
)
# コマンド名・サブコマンド名・IDの前にあるグローバルオプションを読み飛ばす。
# それ以降の本文などからグローバルオプションを取り除かない。
# 不明なオプションや引数不足は実CLIに渡し、通常のエラーを維持する。
offset = 0
command = []
while offset < len(args) and len(command) < 3:
    option = args[offset]
    if option == '--json':
        offset += 1
    elif option in ['-w', '--workspace'] and offset + 1 < len(args):
        offset += 2
    elif option.startswith('--workspace=') or (option.startswith('-w') and len(option) > 2):
        offset += 1
    else:
        command.append(option)
        offset += 1
command.extend(args[offset:])
is_help = '--help' in args or '-h' in args
message = None
fault = None
if not is_help:
    if cfg['name'] == 'failure' and command[:2] == ['template', 'list']:
        message = '評価用にテンプレート一覧の取得失敗を再現しました。'
    elif cfg['name'] == 'update-failure' and command[:2] == ['issue', 'update']:
        message = '評価用に本文の更新失敗を再現しました。'
    elif (cfg['name'] == 'multi-update-failure' and command[:2] == ['issue', 'update']
          and len(command) > 2 and command[2].upper() in ['EVAL-2', '2']):
        # このfixtureは空のWorkspace EVALで始まり、2件目だけ更新不能にする。
        message = '評価用に2件目の本文更新の失敗を再現しました。'

if message:
    out = json.dumps({'error': {'code': 'DB_BUSY', 'message': message}}, ensure_ascii=False) + '\n'
    err, code = '', 1
else:
    result = subprocess.run(
        [cfg['bun'], 'run', cfg['main'], *args], cwd=cfg['repo'], env=env,
        capture_output=True, text=True,
    )
    out, err, code = result.stdout, result.stderr, result.returncode
    if (cfg['name'] == 'multi-response-lost' and command[:2] == ['issue', 'create']
            and not is_help and code == 0):
        history = [json.loads(line) for line in Path(cfg['log']).read_text().splitlines()]
        created = sum(entry.get('command', entry['args'])[:2] == ['issue', 'create']
                      and not entry.get('isHelp', '--help' in entry['args'] or '-h' in entry['args'])
                      and entry['exitCode'] == 0
                      for entry in history)
        if created == 1 and not any(entry.get('fault') == 'response-lost' for entry in history):
            # CLIによる保存は終えてから応答だけ失わせ、照合による復旧を評価する。
            fault = 'response-lost'
            out = json.dumps({'error': {'code': 'CONNECTION_LOST', 'message':
                '作成要求の応答を取得できませんでした。成否は不明です。'}}, ensure_ascii=False) + '\n'
            err, code = '', 1
with open(cfg['log'], 'a') as log:
    log.write(json.dumps({'args': args, 'command': command, 'isHelp': is_help, 'exitCode': code,
                         'stdout': out, 'stderr': err, 'fault': fault}, ensure_ascii=False) + '\n')
sys.stdout.write(out)
sys.stderr.write(err)
sys.exit(code)
