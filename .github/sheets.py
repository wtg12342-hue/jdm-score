"""마피아니스트 JDM STUDIO 악보 목록을 sheets.json 으로 만든다 (매일 자동)."""
import json, re, urllib.request, time
PROFILE = 'https://www.mapianist.com/profile/693793/sheet/post?page={}'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
items, seen = [], set()
for page in range(1, 31):
    req = urllib.request.Request(PROFILE.format(page), headers={'User-Agent': UA, 'Accept-Language': 'ko-KR,ko'})
    html = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace').replace('\\"', '"')
    new = 0
    for sid, name in re.findall(r'"url":"https://www\.mapianist\.com/sheet/(\d+)","name":"([^"]*?) by 장세형"', html):
        if sid in seen: continue
        seen.add(sid); items.append({'id': int(sid), 'name': name.strip()}); new += 1
    print('page', page, new)
    if not new: break
    time.sleep(1)
if len(items) < 10: raise SystemExit('목록을 거의 못 읽었어요: %d' % len(items))
old = []
try: old = json.load(open('sheets.json'))['items']
except Exception: pass
if sorted(i['id'] for i in old) != sorted(i['id'] for i in items) or old != items:
    json.dump({'items': items}, open('sheets.json', 'w'), ensure_ascii=False, indent=0)
    print('updated', len(items))
else:
    print('no change', len(items))
