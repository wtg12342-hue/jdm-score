# Fake Firebase modules (app/auth/firestore) for tests. Data lives in Python (shared by all pages) through bindings.
APP = "export function initializeApp(c){return {cfg:c}}"
AUTH = r"""
let cbs=[],cur=null;
function mk(uid,email){if(!uid)return null;return {uid,email,async delete(){await window.fbDeleteUser(uid);localStorage.removeItem('fakeUid');cur=null;cbs.forEach(f=>f(null))}}}
export function getAuth(){const u=localStorage.getItem('fakeUid');cur=u?mk(u,u+'@test.com'):null;return {get currentUser(){return cur}}}
export function onAuthStateChanged(a,cb){cbs.push(cb);setTimeout(()=>cb(cur),10);return ()=>{}}
export class GoogleAuthProvider{setCustomParameters(){}}
export async function signInWithPopup(a,p){const uid=window.__fakeLoginAs||'userA';localStorage.setItem('fakeUid',uid);cur=mk(uid,uid+'@test.com');cbs.forEach(f=>f(cur));return {user:cur}}
export async function reauthenticateWithPopup(){}
export async function signOut(){localStorage.removeItem('fakeUid');cur=null;cbs.forEach(f=>f(null))}
"""
FS = r"""
const P=a=>a.join('/');
export function initializeFirestore(app,o){return {app}} export function persistentLocalCache(){return {}} export function getFirestore(app){return {app}}
const me=()=>localStorage.getItem('fakeUid');
export function doc(db,...p){return {path:P(p)}} export function collection(db,...p){return {path:P(p)}}
export async function getDocs(c){const r=await window.fbList(c.path,me());if(r==='DENIED')throw Object.assign(new Error('denied'),{code:'permission-denied'});
  const docs=r.map(d=>({id:d.id,ref:{path:c.path+'/'+d.id},data:()=>d.data}));return {docs,forEach:f=>docs.forEach(f),size:docs.length}}
export function writeBatch(db){const ops=[];return {set(r,v,o){ops.push(['set',r.path,JSON.parse(JSON.stringify(v)),!!(o&&o.merge)])},delete(r){ops.push(['del',r.path])},
  async commit(){const r=await window.fbCommit(ops,me());if(r==='DENIED')throw Object.assign(new Error('denied'),{code:'permission-denied'})}}}
export async function deleteDoc(r){const x=await window.fbCommit([['del',r.path]],me());if(x==='DENIED')throw new Error('denied')}
"""
YT = r"""
window.YT={PlayerState:{UNSTARTED:-1,ENDED:0,PLAYING:1,PAUSED:2,BUFFERING:3,CUED:5},Player:class{constructor(el,o){this.o=o||{};this.vid=(o&&o.videoId)||'';const ev=this.o.events||{};
 setTimeout(()=>{ev.onReady&&ev.onReady({target:this})},30)}
 getVideoData(){return {title:'Fake video',video_id:this.vid}} getDuration(){return 180} getCurrentTime(){return 0} getPlayerState(){return 5}
 playVideo(){} pauseVideo(){} stopVideo(){} seekTo(){} mute(){} unMute(){} isMuted(){return false} setVolume(){} getVolume(){return 100} setPlaybackRate(){} getPlaybackRate(){return 1}
 getAvailablePlaybackRates(){return [0.5,1,1.5]} loadVideoById(v){this.vid=typeof v==='string'?v:v.videoId} cueVideoById(v){this.loadVideoById(v)} destroy(){} getIframe(){return document.createElement('iframe')} getVideoUrl(){return ''}}};
setTimeout(()=>{window.onYouTubeIframeAPIReady&&window.onYouTubeIframeAPIReady()},20);
"""
class Store:
    def __init__(s): s.d={}; s.deleted_users=[]
    def ok(s,path,uid): return uid and path.startswith('users/'+uid) and (path=='users/'+uid or path.startswith('users/'+uid+'/'))
    def lst(s,path,uid):
        if not s.ok(path,uid): return 'DENIED'
        pre=path+'/'; return [{'id':k[len(pre):],'data':v} for k,v in s.d.items() if k.startswith(pre) and '/' not in k[len(pre):]]
    def commit(s,ops,uid):
        for o in ops:
            if not s.ok(o[1],uid): return 'DENIED'
        for o in ops:
            if o[0]=='set':
                if o[3] and o[1] in s.d: s.d[o[1]].update(o[2])
                else: s.d[o[1]]=o[2]
            else: s.d.pop(o[1],None)
        return 'ok'
def install(ctx,store):
    def route(r):
        u=r.request.url
        if 'firebase-app.js' in u: body=APP
        elif 'firebase-auth.js' in u: body=AUTH
        elif 'firebase-firestore.js' in u: body=FS
        else: return r.abort()
        r.fulfill(status=200,content_type='application/javascript',body=body,headers={'access-control-allow-origin':'*'})
    ctx.route('https://www.gstatic.com/**',route)
    ctx.route('https://www.youtube.com/iframe_api*',lambda r:r.fulfill(status=200,content_type='application/javascript',body=YT))
    ctx.route(lambda u: not u.startswith('http://127.0.0.1') and 'gstatic.com' not in u and 'youtube.com/iframe_api' not in u, lambda r:r.abort())
    ctx.expose_function('fbList',lambda p,u:store.lst(p,u))
    ctx.expose_function('fbCommit',lambda o,u:store.commit(o,u))
    ctx.expose_function('fbDeleteUser',lambda u:store.deleted_users.append(u))
