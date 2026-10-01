#!/usr/bin/env python3
"""Heurion 2.0 全链路 e2e：draft → @heurion 评论 → 追问多轮 → PPT → 评审数据。"""
import json, time, hmac, hashlib, sys, urllib.request, urllib.error

BASE = 'http://127.0.0.1:8787'
TOKEN = 'dev'
SECRET = None
results = []

try:
    for line in open('.env'):
        if line.startswith('HEURION_SECRET='):
            SECRET = line.strip().split('=', 1)[1]
except FileNotFoundError:
    pass
SECRET = SECRET or 'dev-secret-not-for-production-use!'

def req(method, path, body=None, headers=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    h = {'Authorization': f'Bearer {TOKEN}'}
    if body is not None: h['Content-Type'] = 'application/json'
    if headers: h.update(headers)
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw.strip() else {}

def check(name, ok, detail=''):
    mark = '✅' if ok else '❌'
    results.append((name, ok))
    print(f"{mark} {name}" + (f" — {detail}" if detail and not ok else ""))
    return ok

def sse_chat(path, body, max_seconds=300):
    """POST SSE 并收集事件（drain 流，不做长连接解析）。"""
    data = json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, data=data, headers={
        'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}, method='POST')
    events = []
    with urllib.request.urlopen(r, timeout=max_seconds) as resp:
        for line in resp:
            line = line.decode().strip()
            if line.startswith('data: '):
                try: events.append(json.loads(line[6:]))
                except Exception: pass
    return events

def doc_token(doc_id):
    sig = hmac.new(SECRET.encode(), f'mcp:{doc_id}'.encode(), hashlib.sha256).digest()
    return f"{doc_id}." + __import__('base64').urlsafe_b64encode(sig).decode().rstrip('=')

print('=' * 62)
print('Heurion 2.0 全链路 e2e')
print('=' * 62)

# ── 第 1 步：Word 起草（含文献检索与引用）─────────────────────────
t0 = time.time()
doc = req('POST', '/api/docs', {'title': 'e2e 二甲双胍综述', 'kind': 'docx'})
did = doc['id']
check('S1a 新建 Word 文档', did is not None)

events = sse_chat(f'/api/docs/{did}/chat', {'message':
    '请起草一篇「二甲双胍的心血管保护作用」医学综述的引言部分，约 300 字，'
    '要求引用 2-3 篇真实文献并规范标注。'}, max_seconds=280)
types = [e['type'] for e in events]
versions = [e for e in events if e['type'] == 'version']
audit = [e for e in events if e['type'] == 'citation_audit']
check('S1b 起草回合完成', 'turn_end' in types and versions, f'耗时 {time.time()-t0:.0f}s')
check('S1c 引用校验通过', audit and audit[-1].get('ok'))
check('S1d 落版', len(versions) >= 1, f'{len(versions)} 版')

detail = req('GET', f'/api/docs/{did}')
check('S1e 引用已登记', len(detail['citations']) >= 2, f'{len(detail["citations"])} 条')
proj = req('GET', f'/api/docs/{did}/projection')
nnodes = len((proj['projection'].get('nodes') or []))
check('S1f 投影已生成', nnodes > 3, f'{nnodes} 节点')

# ── 第 2 步：编辑器内 @heurion 评论 → 自动触发 ────────────────────
# 模拟 Collabora：下载 head → 注入原生评论 → PutFile
import zipfile, io
head_seq = detail['head_seq']
raw = urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/api/docs/{did}/versions/{head_seq}/file?token={TOKEN}",
    headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60).read()
zin = zipfile.ZipFile(io.BytesIO(raw))
out = {n: zin.read(n) for n in zin.namelist()}
zdoc = out['word/document.xml'].decode()
target = '二甲双胍'
anchor_paraid = None
m = re_pat = None
import re as _re
# 找目标文字所在段落的 paraId（没有就取第一个 w:p）
for pm in _re.finditer(r'<w:p\b[^>]*w14:paraId="([0-9A-Fa-f]+)"[^>]*>([\s\S]*?)</w:p>', zdoc):
    if target in pm.group(2):
        anchor_paraid = pm.group(1); break
if not anchor_paraid:
    anchor_paraid = _re.search(r'w14:paraId="([0-9A-Fa-f]+)"', zdoc).group(1)
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
zdoc = zdoc.replace('<w:body>', 
    f'<w:p w14:paraId="E2E00001"><w:commentRangeStart w:id="42"/><w:r><w:t>{target}</w:t></w:r>'
    f'<w:commentRangeEnd w:id="42"/></w:p>', 1)
out['word/document.xml'] = zdoc.encode()
comments_xml = (f'<?xml version="1.0"?><w:comments {W} {W14}>'
    '<w:comment w:id="42" w:author="测试员" w:date="2026-10-01T10:00:00Z">'
    '<w:p><w:r><w:t>@heurion 请给这段补充一句 RCT 证据的概括</w:t></w:r></w:p>'
    '</w:comment></w:comments>')
out['word/comments.xml'] = comments_xml.encode()
zin.close()
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for n, d in out.items(): z.writestr(n, d)

# PutFile（带当前 LastModifiedTime）
info = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/wopi/files/{did}?access_token={doc_token(did)}",
    headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60).read())
lmt = info['LastModifiedTime']
preq = urllib.request.Request(f"{BASE}/wopi/files/{did}/contents?access_token={doc_token(did)}",
    data=buf.getvalue(), headers={'Content-Type': 'application/octet-stream', 'X-COOL-WOPI-Timestamp': lmt}, method='POST')
with urllib.request.urlopen(preq, timeout=120) as pr:
    check('S2a PutFile 成功', pr.status == 200)

time.sleep(3)
comments = req('GET', f'/api/docs/{did}/comments')['comments']
thread = next((c for c in comments if any('@heurion' in r['text'] for r in c['replies'])), None)
check('S2b 评论已同步', thread is not None)
check('S2c 锚点=范围文字', thread and '二甲双胍' in (thread['anchor'].get('text_snippet') or ''))
check('S2d 自动触发已登记', thread and thread.get('last_auto_reply_id'))

# 等自动回合完成（轮询 busy）
t0 = time.time()
for _ in range(40):
    d = req('GET', f'/api/docs/{did}')
    if not d['busy'] and d['head_seq'] > head_seq + 1: break
    time.sleep(5)
detail = req('GET', f'/api/docs/{did}')
check('S2e 自动回合落版', detail['head_seq'] > head_seq + 1, f"v{head_seq}→v{detail['head_seq']}，耗时 {time.time()-t0:.0f}s")
comments = req('GET', f'/api/docs/{did}/comments')['comments']
thread = next((c for c in comments if c.get('last_auto_reply_id')), None)
ai_reply = thread and thread['replies'][-1]['role'] == 'ai'
check('S2f 线程出现 AI 回复', bool(ai_reply), thread['replies'][-1]['text'][:60] if thread else '无线程')
located = next((c for c in req('GET', f'/api/docs/{did}/comments')['comments'] if c.get('last_auto_reply_id')), {})
check('S2g 锚点仍定位（无漂移）', located.get('located') is True and located.get('drifted') is False)

# ── 第 3 步：线程内追问（Ask Heurion，多轮）────────────────────────
cid = located['id']
ask = req('POST', f'/api/docs/{did}/comments/{cid}/ask', {'text': '再把这句压缩到 20 字以内'})
check('S3a 追问入队', ask.get('queued'))
t0 = time.time()
for _ in range(40):
    d = req('GET', f'/api/docs/{did}')
    if not d['busy']: break
    time.sleep(5)
comments = req('GET', f'/api/docs/{did}/comments')['comments']
thread = next((c for c in comments if c['id'] == cid), None)
n_replies = len(thread['replies']) if thread else 0
check('S3b 追问回合完成（多轮成立）', not req('GET', f'/api/docs/{did}')['busy'] and n_replies >= 4, f'{n_replies} 条回复，耗时 {time.time()-t0:.0f}s')

# ── 第 4 步：PPT 起草 + 投影/评论 ────────────────────────────────
t0 = time.time()
deck = req('POST', '/api/docs', {'title': 'e2e 质子治疗', 'kind': 'pptx'})
devents = sse_chat(f'/api/docs/{deck["id"]}/chat', {'message':
    '请创建一份 3 页的质子治疗科普 PPT：标题页 + 原理页 + 适应症页，简洁版式。'}, max_seconds=560)
dversions = [e for e in devents if e['type'] == 'version']
check('S4a PPT 起草落版', bool(dversions), f'耗时 {time.time()-t0:.0f}s')
dproj = req('GET', f'/api/docs/{deck["id"]}/projection')
dslides = dproj['projection'].get('slides') or []
check('S4b PPT 投影', len(dslides) == 3, f'{len(dslides)} 页')
dchars = sum(len(s.get('text') or '') for sl in dslides for s in sl['shapes'])
check('S4c 页面有文字', dchars > 50, f'{dchars} 字符')

# PPT 原生评论（legacy p:cm 注入）
draw = urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/api/docs/{deck['id']}/versions/{req('GET', f'/api/docs/{deck['id']}')['head_seq']}/file?token={TOKEN}",
    headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60).read()
dzin = zipfile.ZipFile(io.BytesIO(draw))
dout = {n: dzin.read(n) for n in dzin.namelist()}
cm = ('<?xml version="1.0"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      '<p:cm id="1" authorIdx="0" dt="1"><a:t type="body">@heurion 给标题页加一句副标题</a:t></p:cm></p:cmLst>')
dout['ppt/comments/comment1.xml'] = cm.encode()
dzin.close()
dbuf = io.BytesIO()
with zipfile.ZipFile(dbuf, 'w', zipfile.ZIP_DEFLATED) as z:
    for n, d2 in dout.items(): z.writestr(n, d2)
dinfo = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/wopi/files/{deck['id']}?access_token={doc_token(deck['id'])}",
    headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60).read())
dpreq = urllib.request.Request(f"{BASE}/wopi/files/{deck['id']}/contents?access_token={doc_token(deck['id'])}",
    data=dbuf.getvalue(), headers={'Content-Type': 'application/octet-stream', 'X-COOL-WOPI-Timestamp': dinfo['LastModifiedTime']}, method='POST')
with urllib.request.urlopen(dpreq, timeout=120) as pr:
    check('S4d PPT PutFile 成功', pr.status == 200)
time.sleep(3)
dcomments = req('GET', f'/api/docs/{deck["id"]}/comments')['comments']
dthread = next((c for c in dcomments if 'heurion' in json.dumps(c['replies'])), None)
check('S4e PPT 评论按页锚定', dthread and (dthread['anchor'].get('slide_id') or '').startswith('ppt/slides/'))

# ── 汇总 ────────────────────────────────────────────────────────
print('=' * 62)
passed = sum(1 for _, ok in results if ok)
print(f'结果：{passed}/{len(results)} 通过')
sys.exit(0 if passed == len(results) else 1)
