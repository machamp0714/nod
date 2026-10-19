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
# Workspaceをコマンドより前に指定した場合も同じ障害を再現する。
command = args[2:] if args[:1] in [['-w'], ['--workspace']] else args
message = None
if '--help' not in args:
    if cfg['name'] == 'failure' and command[:2] == ['template', 'list']:
        message = '評価用にテンプレート一覧の取得失敗を再現しました。'
    elif cfg['name'] == 'update-failure' and command[:2] == ['issue', 'update']:
        message = '評価用に本文の更新失敗を再現しました。'

if message:
    out = json.dumps({'error': {'code': 'DB_BUSY', 'message': message}}, ensure_ascii=False) + '\n'
    err, code = '', 1
else:
    result = subprocess.run(
        [cfg['bun'], 'run', cfg['main'], *args], cwd=cfg['repo'], env=env,
        capture_output=True, text=True,
    )
    out, err, code = result.stdout, result.stderr, result.returncode
with open(cfg['log'], 'a') as log:
    log.write(json.dumps({'args': args, 'exitCode': code, 'stdout': out, 'stderr': err}, ensure_ascii=False) + '\n')
sys.stdout.write(out)
sys.stderr.write(err)
sys.exit(code)
