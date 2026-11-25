import sys,threading,http.server,functools,json,time,os
from playwright.sync_api import sync_playwright
from fake_firebase import Store,install
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(s,*a):pass
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8765),Q);threading.Thread(target=srv.serve_forever,daemon=True).start()
URL='http://127.0.0.1:8765/index.html'
fails=[]
def check(name,cond,extra=''):
    print(('PASS ' if cond else 'FAIL ')+name+(' '+str(extra) if extra and not cond else ''));
    if not cond: fails.append(name)
store=Store()
def newpage(b,errs,gst):
    ctx=b.new_context(service_workers='block',viewport={'width':1280,'height':850});install(ctx,store);ctx.add_init_script("for(const k of ['guideSeen','guideSeen6','pinHintSeen'])localStorage.setItem('jdmsp.'+k,'1')")
    p=ctx.new_page();p.on('pageerror',lambda e:errs.append(str(e)))
    p.on('console',lambda m:errs.append(m.text) if m.type=='error' else None)
    p.on('request',lambda r:gst.append(r.url) if 'gstatic' in r.url else None)
    p.goto(URL);p.wait_for_timeout(1500);return ctx,p
OPEN="""async()=>{const f=new File([sampleXML()],'groove.musicxml',{type:'application/xml'});await openScoreFile([f]);await new Promise(r=>setTimeout(r,800));return [S.name,S.measures.length]}"""
with sync_playwright() as pw:
    b=pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    # 1. without login nothing changes and nothing is loaded from the server
    e1,g1=[],[];c1,p=newpage(b,e1,g1)
    check('no login: page loads without errors',not e1,e1)
    check('no login: firebase not loaded',not g1,g1)
    check('version 2.86',p.evaluate("document.getElementById('appVer').textContent")=='v2.86')
    p.click('#settingsBtn');p.wait_for_timeout(500)
    check('drawer: account field visible',p.is_visible('#acctField'))
    check('drawer: google button',p.is_visible('#acctIn') and '구글로 계속하기' in p.inner_text('#acctIn'))
    check('drawer open preloads firebase',len(g1)>0)
    nm=p.evaluate(OPEN);check('score opens (no login)',nm[1]>0,nm)
    sid=p.evaluate("async()=>{const e=await libSave(true);return e&&e.id}")
    check('save works without login',bool(sid))
    check('nothing uploaded without login',not store.d,list(store.d))
    # give the saved song a youtube video + fitted timing, as if fitted on this device
    p.evaluate("""async(id)=>{const e=await LDB.get(id);e.media={type:'yt',id:'abcdefghijk',title:'테스트 영상'};e.sync={bpm:123,offset:1.25,map:null};await LDB.put(e);
      store.set('sync.y:abcdefghijk|'+S.name+':'+S.measures.length,{bpm:123,offset:1.25,map:null,order:null})}""",sid)
    # 2. log in: this device's songs move to the account
    p.click('#acctIn');p.wait_for_timeout(2500)
    check('logged in UI',p.is_visible('#acctOut') and p.is_visible('#acctDel'))
    keys=list(store.d);print('  server:',keys)
    check('song moved to account','users/userA/songs/'+sid in store.d)
    song=json.loads(store.d.get('users/userA/songs/'+sid,{}).get('d','{}'))
    check('song has measures + yt + sync, no file data',song.get('measures')==nm[1] and song.get('media',{}).get('id')=='abcdefghijk' and song.get('sync',{}).get('bpm')==123 and 'blob' not in json.dumps(song),song)
    check('timing moved to account',any('/kv/' in k and store.d[k]['k'].startswith('sync.y:abcdefghijk') for k in keys))
    # a memo written after login is saved too
    p.evaluate("store.set('ann.'+S.name+':'+S.measures.length,{m:[[1,2,'메모']]})");p.wait_for_timeout(2000)
    check('memo saved to account',any('/kv/' in k and store.d[k]['k'].startswith('ann.') for k in store.d))
    # reload: stays logged in, no errors
    e1.clear();p.reload();p.wait_for_timeout(2500)
    check('reload: still logged in',p.evaluate("CLOUD.user()&&CLOUD.user().uid")=='userA')
    check('reload: no errors',not e1,e1)
    # 3. another device: same account, same score file -> timing, memo and video come back
    e2,g2=[],[];c2,q=newpage(b,e2,g2)
    q.click('#settingsBtn');q.wait_for_timeout(400);q.click('#acctIn');q.wait_for_timeout(2500)
    check('device B: timing pulled',q.evaluate("Object.keys(localStorage).some(k=>k.startsWith('jdmsp.sync.y:abcdefghijk'))"))
    check('device B: memo pulled',q.evaluate("Object.keys(localStorage).some(k=>k.startsWith('jdmsp.ann.'))"))
    q.evaluate("document.getElementById('drawer').hidden=true");q.click('#libBtn');q.wait_for_timeout(800)
    t=q.inner_text('#libList');check("device B: '다른 기기에서 저장한 곡' listed",'다른 기기에서 저장한 곡' in t and 'groove' in t,t)
    q.evaluate("document.getElementById('libOv').hidden=true")
    q.evaluate(OPEN);q.wait_for_timeout(3000)
    st=q.evaluate("({lib:S.libId,bpm:P.bpm,yt:typeof yt!=='undefined'?yt.id:null,synced:P.synced})");print('  device B state:',st)
    check('device B: same score -> saved song attached',st['lib']==sid)
    check('device B: timing applied',st['bpm']==123 and st['synced'])
    check('device B: youtube video loaded',st['yt']=='abcdefghijk')
    check('device B: no errors',not e2,e2)
    # 4. other account sees nothing of userA
    e3,g3=[],[];c3,r=newpage(b,e3,g3)
    r.evaluate("window.__fakeLoginAs='userB'");r.click('#settingsBtn');r.wait_for_timeout(400);r.click('#acctIn');r.wait_for_timeout(2000)
    check('other account: nothing pulled',not r.evaluate("Object.keys(localStorage).some(k=>k.startsWith('jdmsp.sync.y:abcdefghijk'))"))
    check('other account: denied reading userA (fake rules)',store.lst('users/userA/kv','userB')=='DENIED')
    # 5. log out keeps local songs
    q.evaluate("document.getElementById('drawer').hidden=false");q.click('#acctOut');q.wait_for_timeout(800)
    check('logout: local song kept',q.evaluate(f"LDB.get('{sid}').then(e=>!!e)"))
    check('logout: UI back',q.is_visible('#acctIn'))
    # 6. delete account (from device A)
    p.evaluate("document.getElementById('drawer').hidden=false");p.wait_for_timeout(300)
    p.click('#acctDel');p.wait_for_timeout(200);p.click('#acctDel');p.wait_for_timeout(2500)
    left=[k for k in store.d if k.startswith('users/userA')]
    check('delete: all userA data gone',not left,left)
    check('delete: auth user deleted','userA' in store.deleted_users)
    check('delete: UI logged out',p.is_visible('#acctIn'))
    check('delete: local song still on device',p.evaluate(f"LDB.get('{sid}').then(e=>!!e)"))
    check('device A: no errors',not e1,e1)
    # 7. privacy + delete pages
    e4,g4=[],[];c4,d=newpage(b,e4,g4);d.goto('http://127.0.0.1:8765/delete.html');d.wait_for_timeout(800)
    check('delete.html loads',d.is_visible('#in') and not e4,e4)
    d.goto('http://127.0.0.1:8765/privacy.html');check('privacy mentions login data','구글로 계속하기' in d.inner_text('body') and 'delete.html' in d.content())
    b.close()
srv.shutdown()
print('\nRESULT:', 'ALL PASS' if not fails else 'FAILED: '+', '.join(fails))
