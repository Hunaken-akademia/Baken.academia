# 結果・ログを非公開の表（wake_research_results）に保存する。python save.py <名前の頭> <ファイル>...
import os, sys, json, urllib.request, pathlib, time
def tok():
    for i in range(5):
        try:
            r = urllib.request.Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=wake-research-v1',
                                       headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
            return json.load(urllib.request.urlopen(r))['value']
        except Exception: time.sleep(5 * (i + 1))
prefix = sys.argv[1]
for f in sys.argv[2:]:
    p = pathlib.Path(f)
    if not p.exists(): continue
    text = '\n'.join(p.read_text(errors='replace').splitlines()[-600:])
    name = f"{os.environ['GITHUB_RUN_ID']}/{prefix}/{p.parent.name}-{p.name}"
    body = json.dumps({'action': 'save', 'job': os.environ['JOB'], 'name': name, 'content': text}).encode()
    for i in range(3):
        try:
            urllib.request.urlopen(urllib.request.Request(os.environ['WAKE_BROKER_URL'], data=body, method='POST',
                                   headers={'Authorization': 'Bearer ' + tok(), 'Content-Type': 'application/json'})).read()
            print('saved', name); break
        except Exception as e: print('save failed', name, e); time.sleep(5)
