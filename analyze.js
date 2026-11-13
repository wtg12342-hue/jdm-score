/* Score page analysis for scanned or exported drum sheet music.
   prepPage(canvas)   -> {canvas}  whitened, deskewed copy
   findStaves(canvas) -> {sp, staves:[{top,bot,x0,x1,bars:[x...], at(x)->{t,b}}]}
*/
(function scoreScanModule(global){
"use strict";

/* a page is read several times (ink at different thresholds): its grey values are worked out once per canvas */
const GRAY=new WeakMap();
function gray(ctx,W,H){
  const hit=GRAY.get(ctx.canvas);if(hit&&hit.length===W*H)return hit;
  const d=ctx.getImageData(0,0,W,H).data,g=new Uint8Array(W*H);
  for(let i=0,j=0;j<g.length;i+=4,j++)g[j]=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8;
  if(ctx.canvas)GRAY.set(ctx.canvas,g);return g;
}

/* paper brightness estimate: block max, then smooth */
function background(g,W,H,B){
  const bw=Math.ceil(W/B),bh=Math.ceil(H/B),bm=new Float32Array(bw*bh);
  for(let by=0;by<bh;by++)for(let bx=0;bx<bw;bx++){
    // 90th percentile of the block, robust to a few bright specks
    const hist=new Uint32Array(256);let n=0;
    const y1=Math.min(H,(by+1)*B),x1=Math.min(W,(bx+1)*B);
    for(let y=by*B;y<y1;y+=2)for(let x=bx*B;x<x1;x+=2){hist[g[y*W+x]]++;n++}
    let k=n*0.1,v=255;for(;v>0;v--){k-=hist[v];if(k<=0)break}
    bm[by*bw+bx]=v;
  }
  // dilate (max) twice so dense ink areas take the paper value from neighbours, then blur
  let a=bm;
  for(let it=0;it<2;it++){const o=new Float32Array(a.length);
    for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){let m=0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const yy=y+dy,xx=x+dx;if(yy<0||xx<0||yy>=bh||xx>=bw)continue;const v=a[yy*bw+xx];if(v>m)m=v}
      o[y*bw+x]=m}a=o}
  {const o=new Float32Array(a.length);
    for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){let s=0,c=0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const yy=y+dy,xx=x+dx;if(yy<0||xx<0||yy>=bh||xx>=bw)continue;s+=a[yy*bw+xx];c++}
      o[y*bw+x]=s/c}a=o}
  return {a,bw,bh,B};
}
function bgAt(bg,x,y){
  const fx=Math.min(bg.bw-1.001,Math.max(0,x/bg.B-0.5)),fy=Math.min(bg.bh-1.001,Math.max(0,y/bg.B-0.5));
  const x0=fx|0,y0=fy|0,tx=fx-x0,ty=fy-y0,a=bg.a,w=bg.bw;
  const x1=Math.min(bg.bw-1,x0+1),y1=Math.min(bg.bh-1,y0+1);
  return (a[y0*w+x0]*(1-tx)+a[y0*w+x1]*tx)*(1-ty)+(a[y1*w+x0]*(1-tx)+a[y1*w+x1]*tx)*ty;
}

/* normalise lighting: ink -> black, paper -> white */
function whiten(src){
  const W=src.width,H=src.height,ctx=src.getContext('2d',{willReadFrequently:true});
  const g=gray(ctx,W,H);
  const bg=background(g,W,H,Math.max(24,Math.round(W/60)));
  const out=document.createElement('canvas');out.width=W;out.height=H;
  const octx=out.getContext('2d',{willReadFrequently:true});const img=octx.createImageData(W,H),d=img.data,go=new Uint8Array(W*H);
  // (the curve 255*v^1.15 from a table: Math.pow for every pixel was most of the time spent here)
  if(!whiten.lut){const N=1<<16,t=new Uint8Array(N+1);for(let k=0;k<=N;k++)t[k]=Math.round(255*Math.pow(k/N,1.15));whiten.lut=t}
  const lut=whiten.lut,N=1<<16;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const b=x%8===0?bgAt(bg,x,y):undefined; // cheap: refresh every 8 px
      if(b!==undefined)whiten._b=Math.max(60,b);
      const n=g[y*W+x]/whiten._b; // 1 = paper
      let v=(n-0.40)/(0.93-0.40);v=v<0?0:v>1?1:v;v=lut[Math.round(v*N)];
      const j=y*W+x,i=j*4;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;go[j]=v;
    }
  }
  octx.putImageData(img,0,0);GRAY.set(out,go);return out;
}

function inkMask(c,thr){
  const W=c.width,H=c.height,g=gray(c.getContext('2d',{willReadFrequently:true}),W,H),m=new Uint8Array(W*H);
  for(let i=0;i<g.length;i++)m[i]=g[i]<thr?1:0;
  return m;
}

/* find skew angle by maximising the sharpness of the horizontal projection */
function skewAngle(m,W,H){
  const s=4,w=(W/s)|0,h=(H/s)|0,pts=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let k=0;for(let dy=0;dy<s;dy++){const row=(y*s+dy)*W+x*s;for(let dx=0;dx<s;dx++)k+=m[row+dx]}if(k>=s*s*0.35)pts.push(x,y)}
  let best=0,bestScore=-1;
  const test=a=>{const t=Math.tan(a*Math.PI/180),hist=new Float64Array(h+w+4),off=w*Math.abs(t)+2;
    for(let i=0;i<pts.length;i+=2){const yy=Math.round(pts[i+1]+pts[i]*t+off);if(yy>=0&&yy<hist.length)hist[yy]++}
    let sc=0;for(let i=0;i<hist.length;i++)sc+=hist[i]*hist[i];return sc};
  for(let a=-5;a<=5.001;a+=0.25){const sc=test(a);if(sc>bestScore){bestScore=sc;best=a}}
  const c=best;for(let a=c-0.25;a<=c+0.25;a+=0.05){const sc=test(a);if(sc>bestScore){bestScore=sc;best=a}}
  return best; // degrees; rows with y' = y + x*tan(a) are level
}

function rotate(src,deg){
  const W=src.width,H=src.height,out=document.createElement('canvas');out.width=W;out.height=H;
  const ctx=out.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  ctx.translate(W/2,H/2);ctx.rotate(deg*Math.PI/180);ctx.drawImage(src,-W/2,-H/2);
  return out;
}

function prepPage(src,opts){
  opts=opts||{};
  let c=whiten(src);
  const m=inkMask(c,140);
  const a=skewAngle(m,c.width,c.height);
  if(Math.abs(a)>=0.1)c=rotate(c,a);
  return {canvas:c,angle:a};
}

/* ---------- staff + barline detection ---------- */
function median(a){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]}

function findStaves(c,_boost){
  const W=c.width,H=c.height,m=_boost||inkMask(c,150),m2=inkMask(c,185);if(_boost)for(let i=0;i<m2.length;i++)if(_boost[i])m2[i]=1;
  // content x-range
  let cx0=W,cx1=0;
  { const colInk=new Uint32Array(W);for(let y=0;y<H;y+=2)for(let x=0;x<W;x++)colInk[x]+=m[y*W+x];
    for(let x=0;x<W;x++)if(colInk[x]>H*0.01){if(x<cx0)cx0=x;if(x>cx1)cx1=x} }
  if(cx1<=cx0){cx0=0;cx1=W-1}
  // keep only long horizontal strokes: staff lines (noteheads and text are short)
  const hm=new Uint8Array(W*H),Lr=Math.max(12,Math.round(W/80));
  for(let y=0;y<H;y++){const row=y*W,up=y>0?row-W:row,dn=y<H-1?row+W:row;let st=-1;
    for(let x=0;x<=W;x++){const v=x<W?(m[row+x]|m[up+x]|m[dn+x]):0;if(v){if(st<0)st=x}else if(st>=0){if(x-st>=Lr)for(let k=st;k<x;k++)hm[row+k]=m[row+k];st=-1}}}
  const K=24,sw=(cx1-cx0)/K,strips=[];
  for(let k=0;k<K;k++){
    const a=Math.round(cx0+k*sw),b=Math.round(cx0+(k+1)*sw),r=new Float32Array(H);
    for(let y=1;y<H-1;y++){let n=0;const row=y*W;for(let x=a;x<b;x++)n+=(hm[row+x]|hm[row-W+x]|hm[row+W+x]);r[y]=n/(b-a)}
    // line rows
    const lines=[];
    for(let y=0;y<H;y++){if(r[y]>0.3){const L=lines[lines.length-1];if(L&&y-L.b<=1){L.b=y;L.s+=r[y]*y;L.w+=r[y]}else lines.push({a:y,b:y,s:r[y]*y,w:r[y]})}}
    strips.push({a,b,c:(a+b)/2,raw:lines.filter(l=>l.b-l.a<=14),thick:lines.filter(l=>l.b-l.a>14)});
  }
  // staff lines are thin; beams and thick rules are not
  const th=median(strips.flatMap(s=>s.raw.map(l=>l.b-l.a+1)))||2;
  strips.forEach(s=>{s.lines=s.raw.filter(l=>l.b-l.a+1<=Math.max(th*2.2,th+5)).map(l=>l.s/l.w)});
  // staff spacing: most common gap between neighbouring line rows
  const gaps=[];strips.forEach(s=>{for(let i=1;i<s.lines.length;i++){const g=s.lines[i]-s.lines[i-1];if(g>=4&&g<=80)gaps.push(g)}});
  if(!gaps.length)return {sp:0,staves:[]};
  const hist=new Map();gaps.forEach(g=>{const k=Math.round(g);hist.set(k,(hist.get(k)||0)+1)});
  let sp=0,bc=0;for(const [k,v] of hist){const v2=v+(hist.get(k-1)||0)+(hist.get(k+1)||0);if(v2>bc){bc=v2;sp=k}}
  // refine
  sp=median(gaps.filter(g=>Math.abs(g-sp)<=sp*0.2))||sp;

  // a multi-bar rest is a thick bar over the middle line: where two lines are two spaces apart with a thick band
  // centred between them, the hidden line is there
  strips.forEach(s=>{const bands=(s.thick||[]).concat(s.raw).filter(t=>t.b-t.a+1>=sp*0.4&&t.b-t.a+1<=sp*1.7);if(!bands.length)return;
    const L=s.lines,add=[];for(let i=1;i<L.length;i++){const d=L[i]-L[i-1];if(d<sp*1.7||d>sp*2.3)continue;const mid=(L[i]+L[i-1])/2;
      if(bands.some(t=>Math.abs((t.a+t.b)/2-mid)<sp*0.3))add.push(mid)}
    if(add.length)s.lines=L.concat(add).sort((a,b)=>a-b)});
  // per-strip staff candidates: runs of lines with ~sp spacing
  const cands=[];
  strips.forEach((s,k)=>{
    const L=s.lines;let i=0;
    while(i<L.length){
      let j=i,g0=0;while(j+1<L.length){const g=L[j+1]-L[j];if(!g0){if(g>sp*0.6&&g<sp*1.6){g0=g;j++}else break}else if(Math.abs(g-g0)<=g0*0.22)j++;else break}
      const n=j-i+1;
      if(n>=4&&n<=6){let top=L[i],bot=L[j];
        if(n===4){/* one line missed: decide side later by clustering */}
        if(n===6){ // stray ledger line: keep the 5 with the most even spacing
          const e1=Math.abs((L[j-1]-L[i])-4*g0),e2=Math.abs((L[j]-L[i+1])-4*g0);if(e1<e2)bot=L[j-1];else top=L[i+1]}
        cands.push({k,top,bot,n:Math.min(n,5),c:(top+bot)/2,g:g0});
      }
      i=j+1;
    }
  });
  // cluster across strips
  cands.sort((a,b)=>a.c-b.c);
  const clusters=[];
  cands.forEach(cd=>{const cl=clusters.find(q=>Math.abs(q.c-cd.c)<sp*2.2&&!q.items.some(it=>it.k===cd.k));
    if(cl){cl.items.push(cd);cl.c=cl.items.reduce((s,x)=>s+x.c,0)/cl.items.length}else clusters.push({c:cd.c,items:[cd]})});
  // (the last line of a song can be a single short bar: fewer strips are enough for a line below all the others, when
  // its strips sit side by side and each shows all five lines)
  const need=Math.max(3,Math.round(K*0.16)),lowest=Math.max(-1,...clusters.filter(q=>q.items.length>=need).map(q=>q.c));
  const shortLast=q=>{if(global.__noShortLast||lowest<0||q.c<lowest+sp*6||q.c>lowest+sp*40||q.items.length<2)return false;
    const ks=q.items.map(it=>it.k).sort((a,b)=>a-b);return ks[ks.length-1]-ks[0]<=(_boost?ks.length*2:ks.length-1)&&q.items.every(it=>it.n===5)};
  if(global.__cl)global.__cl.push(clusters.map(q=>[Math.round(q.c),q.items.length,q.items.map(it=>it.k+':'+it.n).join(',')]));
  let staves=clusters.filter(q=>q.items.length>=need||shortLast(q)).map(q=>{
    const by=new Array(K).fill(null);
    q.items.forEach(it=>{let t=it.top,b=it.bot;if(it.n===4){const h=b-t;if(h<it.g*3.6){b=t+4*it.g}}by[it.k]={t,b}});
    // fill 4-line strips using neighbours' centre
    let pts=by.map((v,k)=>v?{x:strips[k].c,t:v.t,b:v.b}:null).filter(Boolean);
    // drop strips that latched onto a different set of lines
    pts=pts.filter((p,i)=>{const nb=pts.slice(Math.max(0,i-3),i+4).map(q=>q.t);return Math.abs(p.t-median(nb))<=sp*0.5});
    if(!pts.length)pts=[{x:strips[0].c,t:q.c-2*sp,b:q.c+2*sp}];
    const n=pts.length;
    const ext=(p,q2,x)=>{const f=(x-p.x)/((q2.x-p.x)||1);return {t:p.t+(q2.t-p.t)*f,b:p.b+(q2.b-p.b)*f}};
    const at=x=>{if(n===1)return pts[0];if(x<=pts[0].x)return ext(pts[0],pts[Math.min(n-1,2)],x);if(x>=pts[n-1].x)return ext(pts[Math.max(0,n-3)],pts[n-1],x);
      for(let i=1;i<pts.length;i++)if(x<=pts[i].x){const p=pts[i-1],q2=pts[i],f=(x-p.x)/(q2.x-p.x);return {t:p.t+(q2.t-p.t)*f,b:p.b+(q2.b-p.b)*f}}};
    const ks=q.items.map(it=>it.k);
    return {pts,at,top:Math.min(...pts.map(p=>p.t)),bot:Math.max(...pts.map(p=>p.b)),sx0:strips[Math.min(...ks)].a,sx1:strips[Math.max(...ks)].b};
  });
  staves.sort((a,b)=>a.top-b.top);
  // drop staves overlapping a bigger neighbour
  staves=staves.filter((s,i)=>!(staves[i-1]&&s.top<staves[i-1].bot));

  // follow each staff left and right column by column, so curved pages are traced exactly
  const lineHits=(x,t,b)=>{let hit=0;for(let l=0;l<5;l++){const y=Math.round(t+(b-t)*l/4);if((y>0&&y<H-1)&&(m2[y*W+x]||m2[(y-1)*W+x]||m2[(y+1)*W+x]))hit++}return hit};
  const gapFill=(x,t,b)=>{let f=0;for(let l=0;l<4;l++){const y=Math.round(t+(b-t)*(l+0.5)/4);if(y>=0&&y<H&&m[y*W+x])f++}return f};
  // (a line can be printed in two pieces with a gap between them: each piece is traced as its own staff)
  const queue=staves.slice();staves=[];
  while(queue.length){const s=queue.shift();s._at0=s._at0||s.at;
    const P=s._seed||s.pts[s.pts.length>>1];
    const span=P.b-P.t,g=span/4;
    const trace=seed=>{
      const tt=new Float32Array(W).fill(NaN),bb=new Float32Array(W).fill(NaN);let x0=Math.round(P.x),x1=x0,score=0;
      for(const dir of [1,-1]){
        let t=seed,last=Math.round(P.x);
        for(let x=Math.round(P.x);x>=0&&x<W;x+=dir){
          let best=-1,bd=0;
          for(const d of [0,-1,1,-2,2,-3,3]){const h=lineHits(x,t+d,t+d+span);if(h>best){best=h;bd=d}}
          const gf=gapFill(x,t+bd,t+bd+span);
          if((best>=4&&gf<=2)||(best===3&&gf===0)){t+=bd;last=x;tt[x]=t;bb[x]=t+span;if(best===5)score++}
          else if(Math.abs(x-last)>sp*5)break;
        }
        if(dir>0)x1=last;else x0=last;
      }
      return {tt,bb,x0,x1,score};
    };
    // a cymbal ledger row can pass for a sixth line: try the neighbouring positions and keep the one with the most complete 5-line columns
    let best=null;
    for(const o of [g,0,-g]){const r=trace(P.t+o);if(!best||r.score>best.score*1.08)best=r}
    s.offDbg=[best.score];
    const {tt,bb,x0,x1}=best;
    // fill holes by interpolation
    let prev=-1;for(let x=x0;x<=x1;x++){if(!isNaN(tt[x])){if(prev>=0&&x-prev>1)for(let k=prev+1;k<x;k++){const f=(k-prev)/(x-prev);tt[k]=tt[prev]+(tt[x]-tt[prev])*f;bb[k]=bb[prev]+(bb[x]-bb[prev])*f}prev=x}}
    const old=s.at;
    s.at=x=>{const xi=Math.round(x);if(xi>=x0&&xi<=x1&&!isNaN(tt[xi]))return {t:tt[xi],b:bb[xi]};return old(x)};
    s.x0=x0;s.x1=x1;
    let mn=Infinity,mx=-Infinity;for(let x=x0;x<=x1;x++){if(!isNaN(tt[x])){if(tt[x]<mn)mn=tt[x];if(bb[x]>mx)mx=bb[x]}}
    if(mn<Infinity){s.top=mn;s.bot=mx}
    staves.push(s);
    for(const grp of [s.pts.filter(p=>p.x>s.x1+sp*4),s.pts.filter(p=>p.x<s.x0-sp*4)])if(grp.length&&queue.length+staves.length<80)
      queue.push({pts:grp,at:s._at0,_at0:s._at0,_seed:grp[grp.length>>1],top:s.top,bot:s.bot,sx0:s.sx0,sx1:s.sx1});
  }
  // drop a piece traced twice; order: line by line, left to right
  staves=staves.filter((s,i)=>!staves.some((o,j)=>j<i&&Math.abs(o.top-s.top)<sp*2&&Math.min(o.x1,s.x1)-Math.max(o.x0,s.x0)>sp*2));
  staves.sort((a,b)=>Math.abs(a.top-b.top)<sp*2?a.x0-b.x0:a.top-b.top);
  const maxW=Math.max(1,...staves.map(s=>s.x1-s.x0));
  staves=staves.filter(s=>s.x1-s.x0>maxW*0.15); // (a last line of one or two bars is short)
  // a section label in a box (Chorus, Bridge) touching the staff: its edges and letters line up with the staff lines and
  // the trace runs on into it, so that line starts left of all the others. It starts where all five lines are there, run after run
  // (only on a page of full-width lines: a page of small exercise staves side by side is not this)
  if(!global.__x0Old&&staves.length>=3&&staves.every(s=>s.x1-s.x0>maxW*0.6)){const med=median(staves.map(s=>s.x0));
    staves.forEach(s=>{if(s.x0>=med-sp*2||s.x0<med-sp*9)return;const h5=x=>{const q=s.at(x);return lineHits(x,Math.round(q.t),Math.round(q.b))>=5};
      // walk left from where the other lines start while all five lines go on (a pixel or two missing is noise)
      let x=Math.round(med+sp),miss=0,st=x;if(!h5(x))return;
      for(;x>=s.x0;x--){if(h5(x)){st=x;miss=0}else if(++miss>2)break}
      if(st>s.x0+sp*1.5)s.x0=st})}

  // barlines
  staves.forEach(s=>{
    const cols=[],ext={};s.why=[];const why=(x,r,extra)=>{s.why.push([x,r,extra])};
    for(let x=s.x0;x<=s.x1;x++){
      const {t,b}=s.at(x);const T=Math.round(t),B=Math.round(b);
      const h=B-T,col=y=>(y>=0&&y<H)&&(m2[y*W+x]||m2[y*W+x-1]||m2[y*W+x+1]);
      // longest dark run through the staff middle
      const mid=Math.round((T+B)/2);if(!col(mid))continue;
      let y0=mid,y1=mid,miss=0;
      for(let y=mid-1;y>=T-sp*2.5;y--){if(col(y)){y0=y;miss=0}else if(++miss>1)break}
      miss=0;for(let y=mid+1;y<=B+sp*2.5;y++){if(col(y)){y1=y;miss=0}else if(++miss>1)break}
      if(y0>T+sp*0.3||y1<B-sp*0.3){
        // a faint scan prints a barline broken into dashes: allow short gaps when the column is still mostly dark
        // through the staff (a plain column through the staff is dark only at its five lines)
        let ok=false;if(!global.__noDash){const gap=Math.max(2,Math.round(sp*0.45));let a0=mid,a1=mid,m=0;
          for(let y=mid-1;y>=T-sp*2.5;y--){if(col(y)){a0=y;m=0}else if(++m>gap)break}
          m=0;for(let y=mid+1;y<=B+sp*2.5;y++){if(col(y)){a1=y;m=0}else if(++m>gap)break}
          // (and it stops at the staff's edges, as a barline does: a note's stem runs on above or below the staff)
          if(a0<=T+sp*0.3&&a1>=B-sp*0.3&&a0>=T-sp*0.6&&a1<=B+sp*0.6){let dk=0,gaps=0,prev=true;for(let y=T;y<=B;y++){const c=col(y);if(c)dk++;if(!c&&prev)gaps++;prev=c}
            // (broken in four places or more, like a dotted line: a stem through noteheads breaks two or three times)
            // (and no notehead hangs on it: a stem in a noisy scan breaks up too, but it carries heads a space wide)
            let nh=0;if(dk>=(B-T+1)*0.85&&gaps>=4&&!global.__dashHeadOld){for(let y=T;y<=B;y++){if(!m2[y*W+x]&&!m2[y*W+x-1]&&!m2[y*W+x+1])continue;let l=x,r=x;
                while(l>x-sp*3&&m2[y*W+l-1])l--;while(r<x+sp*3&&m2[y*W+r+1])r++;const w=r-l+1;if(w>=sp*0.8&&w<=sp*2.2)nh++}}
            if(dk>=(B-T+1)*0.85&&gaps>=4&&nh<sp*0.5){y0=a0;y1=a1;ok=true;why(x,'dash',[gaps,dk,B-T+1,nh])}else if(dk>=(B-T+1)*0.85&&gaps>=4)why(x,'dashHead',[nh])}}
        if(!ok){if(y1-y0>h*0.6)why(x,'short',[y0-T,y1-B]);continue}}
      // an ending bracket's hook may stand on the barline: the line goes up to a long horizontal rule
      let hooked=false;
      if(y0<T-sp*0.6&&y1<=B+sp*0.6&&y0>T-sp*8){let L=0,R=0;for(const dy of [0,1,2,3]){const yy=y0+dy;if(yy<0||yy>=H)continue;
          let a=0;for(let xx=x+1;xx<W&&xx<x+sp*6;xx++){if(m[yy*W+xx])a++;else break}let b=0;for(let xx=x-1;xx>0&&xx>x-sp*6;xx--){if(m[yy*W+xx])b++;else break}R=Math.max(R,a);L=Math.max(L,b)}
        // (a bracket's rule is thin; a beam joining stems is thick)
        const dir=R>=L?1:-1,thin=(()=>{let ok=0,n=0;for(let k=1.2;k<=2.4;k+=0.4){const xx=Math.round(x+dir*k*sp);let top=-1,bot=-1;for(let yy=y0-4;yy<=y0+Math.round(sp*0.8);yy++){if(yy>=0&&yy<H&&m[yy*W+xx]){if(top<0)top=yy;bot=yy}else if(top>=0)break}n++;if(top>=0&&bot-top+1<=Math.max(3,sp*0.28))ok++}return ok>=n-1})();
        if(Math.max(L,R)>=sp*2.5&&thin){y0=T;hooked=true}}
      if(y0<T-sp*0.6||y1>B+sp*0.6){why(x,'long',[y0-T,y1-B]);continue}
      // the same test on the full picture (the staff-line removal can cut a stem where it crosses a line):
      // a stem runs on past the staff to its beam or flag, a barline stops at the outer lines
      {const cf=y=>y>=0&&y<H&&(m[y*W+x]||m[y*W+x-1]||m[y*W+x+1]);let up=0,miss=0;
       if(!hooked)for(let y=T-1;y>=T-sp*2.5;y--){if(cf(y)){up=T-y;miss=0}else if(++miss>1)break}
       let dn=0;miss=0;for(let y=B+1;y<=B+sp*2.5;y++){if(cf(y)){dn=y-B;miss=0}else if(++miss>1)break}
       if(up>sp*0.9||dn>sp*0.9){why(x,'stem',[up,dn]);continue}}
      // a barline stands alone; stems carry noteheads right beside them
      const side=dx=>{const xx=x+dx;if(xx<1||xx>=W-1)return 0;let k=0;for(let y=T;y<=B;y++)k+=m[y*W+xx]?1:0;return k/(h+1)};
      const o=Math.max(2,Math.round(sp*0.6));
      if(Math.min(Math.max(side(-o),side(-o-1)),Math.max(side(o),side(o+1)))>0.6){why(x,'side');continue}
      // noteheads hug stems: look for a dense blob right beside the column
      const box=(xa,xb,ya,yb)=>{let k=0,c=0;for(let y=Math.round(ya);y<=Math.round(yb);y++){if(y<0||y>=H)continue;for(let xx=xa;xx<=xb;xx++){if(xx<0||xx>=W)continue;c++;k+=m[y*W+xx]}}return c?k/c:0};
      const bw=Math.max(3,Math.round(sp*0.7)),bh=sp*0.7;let blob=false;
      for(const yy of [y0-sp*0.35,y0-sp*0.1,y0+sp*0.15,y1-bh-sp*0.15,y1-bh+sp*0.1,y1-bh+sp*0.35]){
        if(box(x-2-bw,x-2,yy,yy+bh)>0.5||box(x+2,x+2+bw,yy,yy+bh)>0.5)blob=true}
      if(blob&&window.__blob){why(x,'blob');continue}why(x,'OK');
      cols.push(x);ext[x]=[y0-T,y1-B];why(x,"E",[y0-T,y1-B]);(s.info=s.info||[]).push([x,Math.round(T),Math.round(B),y0,y1,+side(-o).toFixed(2),+side(o).toFixed(2)]);
    }
    const runs0=[];cols.forEach(x=>{const L=runs0[runs0.length-1];if(L&&x-L.b<=1)L.b=x;else runs0.push({a:x,b:x})});
    // a stem touches its notehead; a barline leaves a little gap before the next note
    const touches=q=>{const xm=Math.round((q.a+q.b)/2),{t,b}=s.at(xm),bw=Math.max(4,Math.round(sp*0.9));
      const hit=(x0,x1,xn,ya,yb)=>{let near=0;for(let y=Math.round(ya);y<=Math.round(yb);y++)if(y>=0&&y<H&&m[y*W+xn])near++;
        if(near<sp*0.45)return false;let k=0,c=0;for(let y=Math.round(ya);y<=Math.round(yb);y++)for(let x=x0;x<=x1;x++){if(y<0||y>=H||x<0||x>=W)continue;c++;k+=m[y*W+x]}return c&&k/c>0.42};
      const L=[q.a-2-bw,q.a-2,q.a-2],R=[q.b+2,q.b+2+bw,q.b+2];
      const top=[t-sp*0.6,t+sp*0.7],bot=[b-sp*0.7,b+sp*0.6];
      const upStem=hit(...L,...bot),downStem=hit(...R,...top);
      const otherTop=hit(...L,...top)||hit(...R,...top),otherBot=hit(...L,...bot)||hit(...R,...bot);
      // a stem has its notehead at one end only; a barline crowded by notes is touched at both ends
      (s.tdbg=s.tdbg||[]).push([q.a,upStem,downStem,otherTop,otherBot]);return (upStem&&!otherTop)||(downStem&&!otherBot)};
    const bars=[];runs0.filter(q=>q.b-q.a>=2&&!(global.__touch&&touches(q))).forEach(q=>{const L=bars[bars.length-1];if(L&&q.a-L.b<=sp*0.9)L.b=q.b;else bars.push({a:q.a,b:q.b})});
    let bx=bars.filter(q=>q.b-q.a>=2&&q.b-q.a<=sp*1.6).map(q=>(q.a+q.b)/2);
    bx=bx.filter(x=>x>s.x0+sp*3.8&&x<s.x1-sp*1.2); // (nothing that close to the clef is a barline: a time signature digit can look like one)
    // a time signature printed right after a barline in the middle of a line (6/4 -> 4/4): the two stacked 4s make one
    // tall stroke that passes for a barline. Keep the real barline (just left of the numbers), drop the digit
    {const colFull=x=>{const q=s.at(x);let k=0,c=0;for(let y=Math.round(q.t+1);y<=Math.round(q.b-1);y++){c++;if(m[y*W+x])k++}return c&&k/c>0.9};
     for(let i=0;i<bx.length;i++){const x=bx[i];if(x<s.x0+sp*6)continue;let r=null;const pv=i>0?bx[i-1]:-1e9;try{r=timeSigAt(m,W,H,s,Math.max(pv+sp*0.25,x-sp*2.2),x+sp*1.4,true)}catch(e){}
      if(global.__bxdbg)global.__bxdbg.push([Math.round(x),r]);
      if(!r||r[3]==null||!(r[3]<=x+2&&r[2]>=x-2))continue;
      let bar=null;for(let xx=Math.round(r[3]-2);xx>=r[3]-sp*1.6;xx--)if(colFull(xx)){bar=xx;break}
      const prev=i>0?bx[i-1]:-1e9;
      if(bar!=null&&bar-prev>sp*1.5){bx[i]=bar}else if(prev>=r[3]-sp*2){bx.splice(i,1);i--}else bx[i]=r[3]-sp*0.3}}
    // a stroke inside a multi-bar rest (the thick bar on the middle line runs on at both sides of it, or starts right at it
    // at the head of the line) is not a barline
    {const thick=x=>{const q=s.at(x),gg=(q.b-q.t)/4,mid=(q.t+q.b)/2;let k=0;for(let y=Math.round(mid-gg*0.7);y<=Math.round(mid+gg*0.7);y++)k+=m[y*W+x];return k>=gg*0.38};
     const frac=(x0,x1)=>{let r=0,c=0;for(let xx=Math.round(x0);xx<=Math.round(x1);xx++){c++;if(thick(xx))r++}return c?r/c:0};
     for(let i=0;i<bx.length;i++){const x=bx[i];
       const L=frac(x-sp*0.8,x-3),R=frac(x+3,x+sp*0.8);
       // (a long stretch on both sides: note heads touching a barline from both sides are never that long)
       const inside=Math.max(L,R)>0.8&&Math.min(L,R)>0.45&&Math.max(frac(x-sp*3,x-3),frac(x+3,x+sp*3))>0.9,headTick=x<s.x0+sp*9&&frac(x+3,x+sp*2)>0.85&&frac(x-sp*1.2,x-3)<0.3;
       if(global.__mrdbg)global.__mrdbg.push([Math.round(x),+L.toFixed(2),+R.toFixed(2),+frac(x-sp*2,x-3).toFixed(2),+frac(x+3,x+sp*2).toFixed(2),+frac(x-sp*3,x-3).toFixed(2),+frac(x+3,x+sp*3).toFixed(2)]);
       if(headTick&&!global.__offHead){bx.splice(i,1);i--}}}
    // (a line found only by its pale ink: a note's stem right after the clef is not a barline)
    if(_boost&&_boost.fromY!=null&&s.top>_boost.fromY)while(bx.length&&bx[0]-s.x0<sp*6)bx.shift();
    // merge measures that are implausibly narrow (stray detections)
    const edges=[s.x0,...bx,s.x1];
    let changed=true;
    while(changed&&edges.length>2){changed=false;
      const w=[];for(let i=1;i<edges.length;i++)w.push(edges[i]-edges[i-1]);
      const med=w.length<=3?median([...w].sort((a,b)=>a-b).slice(0,-1)):median(w);
      // (a squeezed last bar - a one-bar rest at the end of a line - is real when merging it would make a bar far too wide)
      const keepLast=i=>!global.__narrowOld&&i===w.length-1&&i>0&&w[i]>=sp*6&&w[i-1]+w[i]>med*1.6;
      for(let i=0;i<w.length;i++){if(w[i]<med*0.4&&!keepLast(i)&&edges.length>2){
        // drop the inner edge that bounds the narrow measure
        const drop=i===0?1:(i===w.length-1?edges.length-2:(w[i-1]<w[i+1]?i:i+1));
        edges.splice(drop,1);changed=true;break}}
    }
    s.bars=edges.slice(1,-1);
    // repeat signs: two dots in the middle spaces right before (end) or after (start) a barline
    s.repStart=[];s.repEnd=[];
    {const box=(cx,cy,r)=>{let k=0,c=0;for(let y=Math.round(cy-r);y<=Math.round(cy+r);y++)for(let x=Math.round(cx-r);x<=Math.round(cx+r);x++){if(y<0||y>=H||x<0||x>=W)continue;c++;k+=m[y*W+x]}return c?k/c:0};
     // (the traced staff can be a few pixels off at the line's ends: let the pair of dots sit a little higher or lower)
     const box2=(cx,cy,r)=>{let k=0,c=0;for(let y=Math.round(cy-r);y<=Math.round(cy+r);y++)for(let x=Math.round(cx-r);x<=Math.round(cx+r);x++){if(y<0||y>=H||x<0||x>=W)continue;c++;k+=m2[y*W+x]}return c?k/c:0};
     const dotsAt=(xc,qq)=>{const q=qq||s.at(xc),g=(q.b-q.t)/4,r=g*0.2;
       for(let dy=-Math.round(g*0.35);dy<=Math.round(g*0.35);dy++){const t=q.t+dy;if(global.__ddbg&&dy===0)global.__ddbg.push([xc,Math.round(q.t),+box(xc,t+1.5*g,r).toFixed(2),+box(xc,t+2.5*g,r).toFixed(2),+box(xc,t+0.5*g,r).toFixed(2),+box(xc,t+3.5*g,r).toFixed(2)]);
         if(!(box2(xc,t+1.5*g,r)>0.45&&box2(xc,t+2.5*g,r)>0.45&&box(xc,t+0.5*g,r)<0.3&&box(xc,t+3.5*g,r)<0.3))continue; // (a light grey dot counts as a dot)
         // a dot is short sideways (a staff line runs on both ways; a dot touched by a slur or bracket still ends on one side)
         const isDot=yd=>{const y=Math.round(yd);let best=1e9;for(let dy2=-2;dy2<=2;dy2++){const yy=y+dy2;if(yy<0||yy>=H||!m2[yy*W+xc])continue;let a=xc,b=xc;while(a>xc-g*2&&m2[yy*W+a-1])a--;while(b<xc+g*2&&m2[yy*W+b+1])b++;best=Math.min(best,b-a+1,2*Math.min(xc-a,b-xc)+1)}return best<=g*0.95};
         if(!isDot(t+1.5*g)||!isDot(t+2.5*g))continue;
         // two separate dots, not one bar (a percussion clef is a pair of bars through the middle)
         let k=0,c=0;for(let y=Math.round(t+1.5*g);y<=Math.round(t+2.5*g);y++){c++;if(m[y*W+xc])k++}
         let k2=0,c2=0;for(let y=Math.round(q.t+g);y<=Math.round(q.t+3*g);y++){c2++;if(m[y*W+xc])k2++}
         // each dot stands free on at least one side (the gap between the two strokes of a drum clef is not a dot)
         // (or, for a :|| crowded by a fill's bracket on its left, the barline right beside it)
         const barNext=[1,-1].some(dir=>{for(let k=Math.round(g*0.35);k<=Math.round(g*1.1);k++){const xx=Math.round(xc+dir*k);const qq=s.at(Math.min(s.x1,Math.max(s.x0,xx))),gg=(qq.b-qq.t)/4;let full=true;for(let y=Math.round(qq.t+gg*0.3);y<=Math.round(qq.b-gg*0.3);y++)if(!m[y*W+xx]){full=false;break}if(full)return true}return false});
         const small=yd=>box(xc,yd,g*0.45)<0.5; // (a dot, not a note head)
         const free=yd=>box(xc-g*0.5,yd,r*0.6)<0.2||box(xc+g*0.5,yd,r*0.6)<0.2||(barNext&&xc>s.x0+sp*4.5&&small(yd));
         // and nothing tall runs through them (a clef stroke spans both spaces)
         let run=0;const rw=Math.max(3,Math.round(g*0.3));for(let xx=xc-rw;xx<=xc+rw;xx++){let cur=0;for(let y=Math.round(t+0.8*g);y<=Math.round(t+3.2*g);y++){if(m[y*W+xx]){cur++;if(cur>run)run=cur}else cur=0}}
         if(run>g*1.85)continue;
         if(k/c<0.8&&k2/c2<0.85&&free(t+1.5*g)&&free(t+2.5*g)){if(global.__ddbg)global.__ddbg.push([Math.round(q.t),xc,dy,+(k/c).toFixed(2),+(k2/c2).toFixed(2),box(xc-g*0.5,t+1.5*g,r*0.6)<0.2||box(xc+g*0.5,t+1.5*g,r*0.6)<0.2,barNext,+box(xc,t+1.5*g,g*0.45).toFixed(2),+box(xc,t+2.5*g,g*0.45).toFixed(2),run]);return true}}
       return false};
     const scan=(from,to,qq)=>{const st=from<to?1:-1;for(let x=Math.round(from);st>0?x<=to:x>=to;x+=st)if(dotsAt(x,qq))return true;return false};
     const nearest=x=>{let bi=0,bd=1e9;edges.forEach((e,i)=>{const d=Math.abs(e-x);if(d<bd){bd=d;bi=i}});return bi};
     // a repeat barline is a thick line with a thin one: a plain barline with dots near it (a repeat-bar sign) is not
     // (thicker than this staff's ordinary barlines too: a blurred scan makes every line fat)
     const bw0=bars.filter(q=>q.b-q.a<=sp*1.6&&q.a>s.x0+sp*2&&q.b<s.x1-sp*2).map(q=>q.b-q.a+1).sort((a,b)=>a-b),bmed0=bw0.length>=2?bw0[bw0.length>>1]:0;
     const thick=(xa,xb)=>{let run=0,best=0;for(let x=Math.round(xa);x<=Math.round(xb);x++){const {t,b}=s.at(x),g=(b-t)/4;let full=true;for(let y=Math.round(t+g*0.5);y<=Math.round(b-g*0.5);y++)if(!m[y*W+x]){full=false;break}if(full){run++;if(run>best)best=run}else run=0}if(global.__vdbg)global.__vdbg.push(['thick',Math.round(s.top),Math.round(xa),best,bmed0,bw0.join('/')]);return best>=sp*0.28};
     for(const q of bars){if(q.b-q.a>sp*1.6)continue;const xc=(q.a+q.b)/2;
       // a repeat barline is two lines (thin and thick; blurred together they make one wide line), never a single plain one
       const fullC=x=>{const {t,b}=s.at(x),g=(b-t)/4;for(let y=Math.round(t+g*0.5);y<=Math.round(b-g*0.5);y++)if(y<0||y>=H||!m[y*W+x])return false;return true};
       const dbl=(xa,xb)=>{const runs=[];let st=-1;for(let x=Math.round(xa);x<=Math.round(xb)+1;x++){const f=x<=xb&&fullC(x);if(f&&st<0)st=x;if(!f&&st>=0){runs.push(x-st);st=-1}}return runs.length>=2||runs.some(w=>w>=sp*0.5)};
       const end=scan(q.a-sp*0.35,q.a-sp*1.3)&&thick(q.a-sp*0.2,q.b+sp*1.0)&&dbl(q.a-sp*0.3,q.b+sp*1.0),start=scan(q.b+sp*0.35,q.b+sp*1.3)&&thick(q.a-sp*1.0,q.b+sp*0.2)&&dbl(q.a-sp*1.0,q.b+sp*0.3);
       if(!end&&!start)continue;
       let bi=nearest(xc);
       // a start repeat right after the clef belongs to the first measure
       if(start&&xc<edges[0]+(edges[1]-edges[0])*0.45)bi=0;
       if(end&&xc>edges[edges.length-1]-sp*2)bi=edges.length-1;
       if(start&&bi<edges.length-1)s.repStart.push(bi);
       if(end&&bi>0)s.repEnd.push(bi-1)}
     // the closing :|| at the very end of the line (a bracket above may hide it from the barline search)
     if(!s.repEnd.includes(edges.length-2)){let xr=-1;for(let x=Math.round(s.x1+sp*0.6);x>=s.x1-sp*1.5;x--){const {t,b}=s.at(Math.min(s.x1,x)),g=(b-t)/4;let full=true;for(let y=Math.round(t+g*0.5);y<=Math.round(b-g*0.5);y++)if(y<0||y>=H||!m[y*W+x]){full=false;break}if(full){xr=x;break}}
       if(xr>0){let xl=xr;while(xl>xr-sp){const {t,b}=s.at(Math.min(s.x1,xl-1)),g=(b-t)/4;let full=true;for(let y=Math.round(t+g*0.5);y<=Math.round(b-g*0.5);y++)if(!m[y*W+xl-1]){full=false;break}if(!full)break;xl--}
         if(global.__vdbg)global.__vdbg.push(['endrep',Math.round(s.top),xr,xl,scan(xl-sp*0.5,xl-sp*2.0)]);
         // (the staff's trace is least sure at its very end: take the line positions from a little further in)
         const qin=s.at(s.x1-sp*3);
         // :|| is dots, a thin line, then the thick one: find the thin line just left of the thick one (a gap between them)
         const full=x=>{const {t,b}=s.at(Math.min(s.x1,x)),g=(b-t)/4;for(let y=Math.round(t+g*0.5);y<=Math.round(b-g*0.5);y++)if(!m[y*W+x])return false;return true};
         let thin=-1,gapSeen=false;for(let x=xl-1;x>=xl-sp*1.1;x--){if(!full(x)){gapSeen=true;continue}if(gapSeen){thin=x;break}}
         let thinL=thin;if(thin>0)while(thinL>thin-sp*0.4&&full(thinL-1))thinL--;
         const thinOk=thin>0&&thin-thinL+1<=Math.max(3,(xr-xl+1)*0.7);
         // and the thick line is clearly thicker than this staff's ordinary barlines
         const bw=bars.filter(q=>q.b-q.a<=sp*1.6&&q.b<s.x1-sp*2).map(q=>q.b-q.a+1).sort((a,b)=>a-b),bmed=bw.length?bw[bw.length>>1]:0;
         if(global.__vdbg)global.__vdbg.push(['endrep2',Math.round(s.top),xr-xl+1,thin,thinL,bmed]);
         // (with its own thin line found, the pair is a repeat barline however wide a blurred scan makes the lines)
         if(xr-xl+1>=sp*0.28&&thinOk&&thin>0&&(scan(thinL-sp*0.2,thinL-sp*1.5)||scan(thinL-sp*0.2,thinL-sp*1.5,qin)))s.repEnd.push(edges.length-2)}else if(global.__vdbg)global.__vdbg.push(['endrep',Math.round(s.top),'nothick'])}}
    // how the line ends: a final barline (thin + thick), a :|| , a double bar, or a plain one (the piece goes on)
    {const fullAt=x=>{const {t,b}=s.at(Math.min(s.x1,Math.max(s.x0,x))),g=(b-t)/4;let k=0,n=0;for(let y=Math.round(t+g*0.3);y<=Math.round(b-g*0.3);y++){n++;if(y>=0&&y<H&&m[y*W+x])k++}return k>=n*0.92};
     let xr=-1;for(let x=Math.round(s.x1+sp*0.8);x>=s.x1-sp*1.2;x--)if(fullAt(x)){xr=x;break}
     s.endKind='single';
     if(xr>0){let xl=xr;while(xl>xr-sp*1.2&&fullAt(xl-1))xl--;const w1=xr-xl+1;
       let x2=-1;for(let x=xl-2;x>=xl-sp*1.0;x--)if(fullAt(x)){x2=x;break}
       let w2=0;if(x2>0){let k=x2;while(k>x2-sp&&fullAt(k-1))k--;w2=x2-k+1}
       const bw=bars.filter(q=>q.b-q.a<=sp*1.6&&q.a>s.x0+sp*2&&q.b<s.x1-sp*2).map(q=>q.b-q.a+1).sort((a,b)=>a-b),thin=bw.length?bw[bw.length>>1]:Math.max(2,sp*0.15);
       const dots=(()=>{const L=x2>0?x2-w2:xl;for(let x=Math.round(L-sp*0.3);x>=L-sp*1.4;x--){const q=s.at(x),g=(q.b-q.t)/4;let a=0,b2=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(m[Math.round(q.t+1.5*g+dy)*W+x+dx])a++;if(m[Math.round(q.t+2.5*g+dy)*W+x+dx])b2++}if(a>=6&&b2>=6&&!m[Math.round(q.t+2*g)*W+x])return true}return false})();
       if(dots||s.repEnd.includes(edges.length-2))s.endKind='repeat';else if(x2>0&&w1>=Math.max(Math.min(thin,w2)*1.8,sp*0.28))s.endKind='final';else if(x2>0)s.endKind='double';
       s.endDbg=[xr,w1,x2,w2,thin,dots];if(global.__endDbg)global.__endDbg.push([s.endKind,s.endDbg,s.repEnd,edges.length])}}
    // time signatures: two stacked numbers filling the upper and lower half of the staff,
    // right after the clef or right after a barline
    s.tsig=[];
    for(let i=0;i<edges.length-1;i++){
      const xa=i===0?edges[0]+sp*1.2:edges[i]+sp*0.25,xb=Math.min(edges[i+1]-sp*0.5,i===0?edges[0]+sp*8:edges[i]+sp*4.5);
      let r=timeSigAt(m,W,H,s,xa,xb);
      // two stacked numbers we cannot read in the middle of a line (after a 6/4 bar, say): almost always 4/4
      if(!r&&i>0){const dbl=(()=>{const e=Math.round(edges[i]);let gap=false;for(let x=e-1;x>=e-sp*0.9;x--){const q=s.at(x);let k=0,c=0;for(let y=Math.round(q.t+1);y<=Math.round(q.b-1);y++){c++;if(m[y*W+x])k++}const full=c&&k/c>0.9;if(!full)gap=true;else if(gap)return true}return false})();
        if(dbl){const r2=timeSigAt(m,W,H,s,xa,Math.min(xb,edges[i]+sp*3),true);if(r2&&r2[4]==='?'&&r2[3]<edges[i]+sp*1.6)r=[4,4,r2[2],r2[3]]}}
      if(r){s.tsig.push([i,r[0],r[1]]);(s.tsigEnd=s.tsigEnd||{})[i]=r[2];(s.tdbgs=s.tdbgs||[]).push([i,r])}}
    // a warning time signature at the very end of a line (after a 2/4 bar, the 4/4 that the next line starts with)
    if(!global.__tsStrict&&edges.length>2){const e=edges[edges.length-1];const r=timeSigAt(m,W,H,s,Math.max(edges[edges.length-2]+sp*2,e-sp*3.2),e+sp*0.3);if(r&&r[3]>e-sp*3)s.tsigNext=[r[0],r[1]]}
    // how much is written in each measure (ink in and around the staff, without the staff lines): empty or whole-rest bars stay low
    // (not too far below the staff: lyrics sit there; a time signature at the start is not counted)
    s.ink=[];
    {let lt=1;const runs=[];for(let x=Math.round(s.x0);x<s.x1;x+=7){const qq=s.at(x),ly=Math.round(qq.t);if(!m[ly*W+x])continue;let a=ly,b=ly;
       while(a>0&&m[(a-1)*W+x]&&ly-a<8)a--;while(b<H-1&&m[(b+1)*W+x]&&b-ly<8)b++;runs.push(b-a+1)}if(runs.length)lt=Math.max(0.5,median(runs)/2);
     for(let i=0;i<edges.length-1;i++){const xa=Math.round(edges[i]+sp*(i===0?2.5:0.6)+(s.tsig.some(t=>t[0]===i)?sp*(i===0?4:3.2):0)),xb=Math.round(edges[i+1]-sp*0.6);let k=0,c=0;
       let y0=1e9,y1=-1e9,x0=1e9,x1=-1e9,ki=0,kc=0;const q4=[0,0,0,0];
       for(let x=xa;x<xb;x+=2){const qq=s.at(x),gg=(qq.b-qq.t)/4;for(let y=Math.round(qq.t-gg*2);y<=Math.round(qq.b+gg*0.9);y+=2){if(y<0||y>=H)continue;c++;
         if(!m[y*W+x])continue;let line=false;for(let l=0;l<5;l++)if(Math.abs(y-(qq.t+gg*l))<=lt+0.5)line=true;if(!line){k++;if(y<=qq.b+gg*0.5)kc++;q4[Math.min(3,Math.floor((x-xa)/Math.max(1,xb-xa)*4))]++;
           if(y>qq.t-gg*0.6&&y<qq.b+gg*0.6){ki++;const yy=(y-qq.t)/gg;if(yy<y0)y0=yy;if(yy>y1)y1=yy;if(x<x0)x0=x;if(x>x1)x1=x}}}}
       s.ink.push(c?k/c:0);(s.inkc=s.inkc||[]).push(c?kc/c:0);(s.inkq=s.inkq||[]).push(q4);
       // a "repeat the previous bar" mark (a slash with two dots in the middle of an otherwise empty bar): the drums keep playing.
       // A whole rest is a short block hanging from a line; the slash spans about two spaces of the staff.
       {const g0=(s.at((xa+xb)/2).b-s.at((xa+xb)/2).t)/4,wx=(x1-x0)/g0,cx=((x0+x1)/2-xa)/Math.max(1,xb-xa);
        if(ki>0&&y1-y0>=1.4&&y1-y0<=3.6&&wx>=0.9&&wx<=4.5&&cx>0.25&&cx<0.75&&k/(c||1)<0.03)(s.sim=s.sim||{})[i]=true;
        // the two-bar sign sits on the barline between the two bars: each bar sees half of it at its edge
        (s.simHalf=s.simHalf||[])[i]=ki>0&&y1-y0>=2.2&&y1-y0<=4.2&&wx<=2&&k/(c||1)<0.03?(cx>0.85?'R':cx<0.15?'L':''):''}}
     if(s.simHalf)for(let i=0;i+1<s.simHalf.length;i++)if(s.simHalf[i]==='R'&&s.simHalf[i+1]==='L'){(s.sim=s.sim||{})[i]=true;s.sim[i+1]=true}}
    // where the notes of each measure begin: the play cursor should sweep from the first note, not from the clef,
    // the time signature or a repeat sign at the start of the line (those take up width but no time)
    s.cx=[];
    {let lt=1;const runs=[];for(let x=Math.round(s.x0);x<s.x1;x+=7){const qq=s.at(x),ly=Math.round(qq.t);if(!m[ly*W+x])continue;let a=ly,b=ly;
       while(a>0&&m[(a-1)*W+x]&&ly-a<8)a--;while(b<H-1&&m[(b+1)*W+x]&&b-ly<8)b++;runs.push(b-a+1)}if(runs.length)lt=Math.max(0.5,median(runs)/2);
     for(let i=0;i<edges.length-1;i++){
       let xa=Math.round(edges[i]+(i===0?sp*0.6:Math.max(2,sp*0.15)));const xb=Math.round(edges[i+1]-sp*0.3);
       if(s.tsigEnd&&s.tsigEnd[i]!=null)xa=Math.max(xa,Math.round(s.tsigEnd[i]+1));
       // per column: ink inside the staff spaces, and above/below it (stems, beams, cymbal heads, ledger notes)
       const col=[];for(let x=xa;x<xb;x++){const qq=s.at(x),gg=(qq.b-qq.t)/4;let inn=0,out=0,full=0;
         for(let y=Math.round(qq.t-gg*3);y<=Math.round(qq.b+gg*1.5);y++){if(y<0||y>=H||!m[y*W+x])continue;const rel=(y-qq.t)/gg;
           let onLine=false;for(let l=0;l<5;l++)if(Math.abs(y-(qq.t+gg*l))<=lt+0.5)onLine=true;
           if(rel<-0.4||rel>4.4)out++;else if(!onLine)inn++;if(rel>=0.1&&rel<=3.9)full++}
         col.push({x,inn,out,full,gg})}
       // clusters of written things, left to right
       const cl=[];let a=-1;for(let j=0;j<=col.length;j++){const c=col[j];const on=c&&(c.inn+c.out)>=Math.max(2,c.gg*0.3);
         if(on&&a<0)a=j;if(!on&&a>=0){const L=cl[cl.length-1];if(L&&j>a&&col[a].x-L.x1<=sp*0.3)L.x1=col[j-1].x,L.j1=j-1;else cl.push({x0:col[a].x,x1:col[j-1].x,j0:a,j1:j-1});a=-1}}
       let start=null;const kept=[];
       for(const c of cl){let out=0,inn=0,tall=0;for(let j=c.j0;j<=c.j1;j++){out+=col[j].out;inn+=col[j].inn;if(col[j].full>=col[j].gg*3.4)tall++}
         const w=c.x1-c.x0+1,inStaff=out<=w*sp*0.08;
         // the clef at the start of a line (with the measure number printed above it); a barline or repeat sign
         // (full-height strokes and dots) at the start of a measure
         if(i===0&&c.x0<edges[i]+sp*3.6)continue;
         if(inStaff&&tall>0&&w<=sp*1.6&&c.x0<edges[i]+sp*1.5)continue;
         kept.push({...c,w,inStaff})}
       // a whole-bar rest sits in the middle of an empty bar: the cursor then sweeps the whole bar
       if(kept.length===1&&kept[0].inStaff&&kept[0].w<=sp*2.2)start=null;else if(kept.length)start=kept[0].x0;
       s.cx.push(start!=null?Math.max(edges[i],start-sp*0.25):null)}}
    // multi-measure rests: a thick bar on the middle line with a number above it
    s.multi={};
    for(let i=0;i<edges.length-1;i++){
      const xa=Math.round(edges[i]),xb=Math.round(edges[i+1]),wdt=xb-xa;if(wdt<sp*3)continue;
      const mx=Math.round((xa+xb)/2),q=s.at(mx),g=(q.b-q.t)/4;
      // follow the middle line (pages curve) and look for a long stretch where it is thick
      let run=0,bestRun=0,bestEnd=0;
      for(let x=xa+Math.round(g);x<xb-Math.round(g);x++){const qq=s.at(x),gg=(qq.b-qq.t)/4,mid=(qq.t+qq.b)/2;
        let k=0;for(let y=Math.round(mid-gg*0.7);y<=Math.round(mid+gg*0.7);y++)k+=m[y*W+x];
        if(k>=gg*0.38){run++;if(run>bestRun){bestRun=run;bestEnd=x}}else run=0}
      (s.mdbg=s.mdbg||[]).push([i,bestRun,+g.toFixed(1)]);
      if(bestRun<Math.max(wdt*0.12,g*2.2)){
        // no thick bar: some editions write the rest as text on an empty staff ("7bars", "7")
        const n2=textRest(m,W,H,s,xa,xb,g,i===0);s.mdbg.push(['text',n2]);if(n2>=2&&n2<=99)s.multi[i]=n2;continue}
      const ra=bestEnd-bestRun+1,rb=bestEnd;
      // the rest of the measure must be empty: no notes in the staff spaces
      let busy=0,tot=0;
      // (the whole bar: a multi-bar rest stands alone in it)
      const tsE=s.tsigEnd&&s.tsigEnd[i]!=null?s.tsigEnd[i]+g*0.5:-1;
      for(let x=xa+Math.round(g);x<xb-Math.round(g);x++){if(x>ra-g*0.6&&x<rb+g*0.6)continue;if(i===0&&x<ra)continue;if(x<tsE)continue;tot++;const qq=s.at(x),gg=(qq.b-qq.t)/4;
        for(let l=0;l<4;l++){const y=Math.round(qq.t+gg*(l+0.5));if(m[y*W+x]){busy++;break}}}
      // (a few specks - the rest's end ticks, a dotted barline - are not notes: notes leave many more)
      if(tot&&busy/tot>0.08&&(global.__busyOld||busy>g*0.35)){s.mdbg.push(['busy',busy,tot]);continue}
      const n=readNumber(m,W,H,xa,xb,q.t-g*3.2,q.t-g*0.15,g);
      s.mdbg.push(['n',n]);if(n>=2&&n<=99)s.multi[i]=n;
    }
    // a line that opens with a multi-bar rest: a stroke of the rest's bar (or its end tick) can split off a sliver with
    // only the clef and time signature in it. That sliver is not a bar: it belongs to the rest
    if(!global.__offSliver&&s.multi[1]&&!s.multi[0]&&edges.length>2){const w0=edges[1]-edges[0],w1=edges[2]-edges[1];
      if(w0<w1*0.35&&w0<sp*7){
        const sh=o=>{const r={};for(const k in o){const j=+k;if(j>=1)r[j-1]=o[k]}return r};
        edges.splice(1,1);s.bars=edges.slice(1,-1);
        for(const f of ['ink','inkc','inkq','cx','simHalf'])if(Array.isArray(s[f])&&s[f].length)s[f].splice(0,1);
        s.multi=sh(s.multi);if(s.sim)s.sim=sh(s.sim);if(s.tsigEnd)s.tsigEnd=sh(s.tsigEnd);
        if(s.tsig)s.tsig=s.tsig.map(([i,a,b])=>[Math.max(0,i-1),a,b]);
        s.repStart=(s.repStart||[]).map(i=>Math.max(0,i-1));s.repEnd=(s.repEnd||[]).filter(i=>i>=1).map(i=>i-1)}}
  });
  // signs above the staff: 1st/2nd ending brackets, coda and segno signs (also when they are drawn, not written)
  const m3=inkMask(c,225);
  staves.forEach((s,si)=>{let pj=si-1;while(pj>=0&&Math.abs(staves[pj].top-s.top)<sp*2)pj--;const prevBot=pj>=0?staves[pj].bot:-1e9;try{navImage(m,W,H,s,sp,prevBot,m2,m3)}catch(e){if(global.__vdbg)global.__vdbg.push(['ERR',String(e&&e.stack)]);s.volta=s.volta||[];s.signs=s.signs||[]}});
  // two staves joined at the left by one line form one system: the lower one is the same bars written out again
  // (in a drum part: what to play the second time through)
  for(let i=1;i<staves.length;i++){const a=staves[i-1],b=staves[i],ya=Math.round(a.bot+3),yb=Math.round(b.top-3);if(yb-ya<sp||Math.abs(a.top-b.top)<sp*2)continue;
    const xm=Math.min(a.x0,b.x0);let best=0;
    for(let x=Math.round(xm-sp*2.5);x<=Math.round(xm+sp*0.6);x++){let k=0;for(let y=ya;y<=yb;y++){let h=false;for(let dx=-1;dx<=1;dx++){const xx=x+dx;if(xx>=0&&xx<W&&m[y*W+xx])h=true}if(h)k++}best=Math.max(best,k/(yb-ya+1))}
    a.joinDbg=a.joinDbg||0;b.joinDbg=+best.toFixed(2);if(best>0.92)b.joinPrev=true}
  // a last short line printed (or scanned) so faintly that its staff lines are lost, while its notes and the final
  // barline are there: a tall upright stroke standing alone below the last line. Look again with the pale ink of that
  // band counted in.
  if(!_boost&&!global.__noFaint&&staves.length&&sp>0){
    const last=staves.reduce((a,b)=>a.bot>b.bot?a:b),ya=Math.round(last.bot+sp*5),yb=Math.min(H-1,Math.round(last.bot+sp*45));
    const xa=Math.max(0,Math.round(Math.min(...staves.map(s=>s.x0)))),xb=Math.min(W-1,Math.round(Math.max(...staves.map(s=>s.x1))));
    let found=-1;for(let x=xa;x<=xb&&found<0;x++){let run=0;for(let y=ya;y<=yb;y++){if(m[y*W+x]){run++;if(run>=sp*3.3){found=y;break}}else run=0}}
    if(found>=0){const g=gray(c.getContext('2d',{willReadFrequently:true}),W,H),mb=m.slice(),y0=Math.max(ya,Math.round(found-sp*7)),y1=Math.min(yb,Math.round(found+sp*3));
      for(let y=y0;y<=y1;y++)for(let x=Math.max(0,xa-Math.round(sp));x<=Math.min(W-1,xb+Math.round(sp));x++)if(g[y*W+x]<236)mb[y*W+x]=1;
      mb.fromY=last.bot+sp*4;const r2=findStaves(c,mb);
      if(r2.staves.length>staves.length&&r2.staves.some(s2=>s2.top>last.bot+sp*4))return r2}}
  return {sp,staves,debug:clusters.map(q=>({c:Math.round(q.c),n:q.items.length})),strips};
}
/* ending brackets: a thin straight line above the staff, a few spaces long, with a hook down at its left end (and
   none along it: a beam has stems all along). Coda: a ring crossed by a vertical and a horizontal stroke. Segno: a
   slanted S with a stroke through it and a dot on each side. */
function navImage(m,W,H,s,sp,prevBot,m2,m3){
  s.volta=[];s.signs=[];
  const X0=Math.round(s.x0),X1=Math.round(s.x1);
  const ink=(x,y)=>x>=0&&x<W&&y>=0&&y<H&&m[y*W+x]===1;
  // --- brackets: follow thin lines pixel by pixel (a photographed page bends them a little)
  const lines=[];
  {const ya=Math.round(Math.max(prevBot+sp*1.5,s.top-sp*10)),yb=Math.round(s.top-sp*1.1),XA=Math.max(1,X0-Math.round(sp*1.5));
   const seen=new Uint8Array((yb-ya+3)*(X1-XA+3)),vi=(x,y)=>(y-ya+1)*(X1-XA+3)+(x-XA+1);
   const d=Math.max(2,Math.round(sp*0.35));
   for(let y=Math.max(1,ya);y<yb;y++)for(let x=XA;x<X1;x++){
     if(!ink(x,y)||ink(x-1,y)||seen[vi(x,y)])continue;
     let cy=y,gap=0,xe=x,thick=0,cnt=0,ymin=y,ymax=y,ye=y;const tk=[];
     for(let xx=x;xx<X1;xx++){
       if(ink(xx,cy)){}else if(ink(xx,cy-1)&&cy-1>=ya)cy--;else if(ink(xx,cy+1)&&cy+1<yb)cy++;else{if(++gap>2)break;continue}
       gap=0;xe=xx;ye=cy;if(cy<ymin)ymin=cy;if(cy>ymax)ymax=cy;if(cy>=ya-1&&cy<=yb+1)seen[vi(xx,cy)]=1;
       // thin: the line's own thickness is small (look a third of a space above and below)
       if(((xx-x)&1)===0){cnt++;if(ink(xx,cy-d)||ink(xx,cy+d))thick++;
         if(((xx-x)&7)===0){let a=0,b=0;while(a<sp&&ink(xx,cy-a-1))a++;while(b<sp&&ink(xx,cy+b+1))b++;tk.push(a+b+1)}}}
     const L=xe-x;if(global.__vdbg&&L>=sp*3)global.__vdbg.push(['run',x,xe,y,ye,+(thick/cnt).toFixed(2),tk.slice().sort((a,b)=>a-b)[tk.length>>1]]);const tmed=tk.length?tk.slice().sort((a,b)=>a-b)[tk.length>>1]:0;     if(L>=sp*4.5&&thick/cnt<0.35&&tmed<=Math.max(4,sp*0.42)&&ymax-ymin<=Math.max(4,L*0.03))lines.push({x0:x,x1:xe,y:Math.round((ymin+ymax)/2),ys:y,ye})}}
  // merge rows of the same line
  lines.sort((a,b)=>a.y-b.y||a.x0-b.x0);const L2=[];if(global.__vdbg)global.__vdbg.push(['lines',Math.round(s.top),lines.length]);
  for(const l of lines){const o=L2.find(q=>Math.abs(q.y2-l.y)<=2&&Math.min(q.x1,l.x1)-Math.max(q.x0,l.x0)>0.7*Math.min(q.x1-q.x0,l.x1-l.x0));
    if(o){o.y2=l.y;if(l.x0<o.x0){o.x0=l.x0;o.ys=l.ys}if(l.x1>o.x1){o.x1=l.x1;o.ye=l.ye}}else L2.push({...l,y2:l.y})}
  for(const l of L2){const y=Math.round((l.y+l.y2)/2),hook=(x,y0)=>{const y=y0!=null?y0:Math.round((l.y+l.y2)/2);let k=0,c=0;for(let yy=y+2;yy<=y+Math.round(sp*1.2);yy++){c++;let h=false;for(let dx=-2;dx<=2;dx++)if(ink(x+dx,yy))h=true;if(h)k++}return c?k/c:0};
    const ys=l.ys!=null?l.ys:y,ye=l.ye!=null?l.ye:y,slope=(ye-ys)/Math.max(1,l.x1-l.x0);let left=0,right=0;for(let k=-Math.round(sp*0.5);k<=Math.round(sp*0.5);k+=2){left=Math.max(left,hook(l.x0+k,Math.round(ys+slope*k)));right=Math.max(right,hook(l.x1-k,Math.round(ye-slope*k)))}if(global.__vdbg)global.__vdbg.push(['line',l.x0,l.x1,ys,ye,+left.toFixed(2),+right.toFixed(2)]);if(left<0.7)continue;
    // no stems hanging from the middle of it
    // (the number under its left end is not a stem: start looking past it)
    const stem=(x,y0)=>{let k=0,c=0,gap=false;for(let yy=y0+2;yy<=y0+Math.round(sp*2);yy++){c++;let h=false;for(let dx=-1;dx<=1;dx++)if(ink(x+dx,yy))h=true;if(h)k++;else if(yy<y0+sp*0.5)gap=true}return gap?0:c?k/c:0}; // a stem hangs from the beam itself
    let mid=0;for(let x=l.x0+Math.round(sp*1.2);x<l.x1-Math.round(sp*0.8);x+=Math.max(1,Math.round(sp*0.25))){const yy=Math.round(ys+(ye-ys)*(x-l.x0)/Math.max(1,l.x1-l.x0));let up=0;for(let k=3;k<=Math.round(sp*0.5);k++)for(let dx=-1;dx<=1;dx++)if(ink(x+dx,yy-k)){up++;break}
      if(stem(x,yy)>0.8&&up<sp*0.25)mid++}if(global.__vdbg)global.__vdbg.push(['mid',mid]);if(mid>1)continue;
    if(s.volta.some(v=>Math.abs(v.x0-l.x0)<sp*1.5&&Math.abs(v.y-y)<sp*1.5))continue;
    // (thin strokes of a small number break up in a light scan: read it on the darker mask when the plain one fails)
    let num=null;try{const d1=readVolta(m,W,H,l.x0,ys,sp),d2=m2?readVolta(m2,W,H,l.x0,ys,sp):null;
      // (several numbers in one bracket run on: 1.2. or 1.2.3.; take the reading that does)
      const ok=d=>d&&d.every((x,i)=>i===0||x===d[i-1]+1);
      // (a single number: the darker mask keeps its strokes whole)
      let d=(d2&&d2.length===1&&(!d1||d1.length===1))?d2:ok(d1)?d1:ok(d2)?d2:(d1||d2);
      // (numbers that do not run on one by one: only the first is the ending's - the rest is a letter, a sticking mark)
      if(d&&!ok(d))d=[d[0]];if(d)num=+d.join('')}catch(e){}
    s.volta.push({x0:l.x0,x1:l.x1,y,closed:right>=0.7,num})}
  // --- coda: search the band above the staff for a ring with a cross through it (it may touch stems or flags)
  {const ya=Math.round(Math.max(prevBot+sp*1.2,s.top-sp*9)),yb=Math.round(s.top-sp*0.3),found=[];
   const ringAt=(cx,cy,r)=>{let k=0;for(let a=0;a<16;a++){const an=a*Math.PI/8;let h=false;for(const f of [0.88,1,1.12])if(ink(Math.round(cx+Math.cos(an)*r*f),Math.round(cy+Math.sin(an)*r*f)))h=true;if(h)k++}return k};
   for(let r=Math.round(sp*0.45);r<=Math.round(sp*1.3);r+=Math.max(1,Math.round(sp*0.12)))
     for(let cy=ya+r;cy<yb-r;cy+=2)for(let cx=Math.max(r,X0-Math.round(sp*2.5));cx<X1;cx+=2){
       if(!ink(cx,cy))continue; // the cross goes through the centre
       let arms=0;for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])if(ink(Math.round(cx+dx*r*0.5),Math.round(cy+dy*r*0.5)))arms++;if(arms<4)continue;
       let holes=0;for(const [dx,dy] of [[1,1],[1,-1],[-1,1],[-1,-1]])if(!ink(Math.round(cx+dx*r*0.4),Math.round(cy+dy*r*0.4)))holes++;
       if(global.__cpt&&Math.abs(cx-global.__cpt[0])<4&&Math.abs(cy-global.__cpt[1])<4)global.__cpt.push([cx,cy,r,holes,ringAt(cx,cy,r)]);
       if(holes<4)continue;
       if(ringAt(cx,cy,r)<14)continue;
       // hollow quarters between the arms of the cross (letters and beam blocks are not)
       {let e=0;for(let q=0;q<4;q++)for(const da of [35,45,55])for(const f of [0.4,0.55]){const an=(q*90+da)*Math.PI/180;if(!ink(Math.round(cx+Math.cos(an)*r*f),Math.round(cy+Math.sin(an)*r*f)))e++}if(e<20)continue}
       let out=0;for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])if(ink(Math.round(cx+dx*r*1.25),Math.round(cy+dy*r*1.25)))out++;if(out<2)continue;
       // standing alone: nothing around the ring but its four arms (beams, heads and stems fail here)
       // (measured from the ring's outer edge: a bold sign has a thick ring)
       let ro=0,romax=0;{let sum=0,k=0;for(let a=0;a<8;a++){const an=(a*45+22.5)*Math.PI/180;let d=r*0.88;while(d<r*2&&ink(Math.round(cx+Math.cos(an)*d),Math.round(cy+Math.sin(an)*d)))d++;sum+=d;k++;romax=Math.max(romax,d)}ro=sum/k}
       if(ro>r*1.45||romax>r*1.6)continue;
       if(ro<r*0.98)continue;
       // the cross reaches out past the ring on at least three sides (a block of beams does not)
       {let o2=0;for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){let h=false;for(const dd of [2,4,6]){const d=Math.max(r*1.2,ro+dd);if(ink(Math.round(cx+dx*d),Math.round(cy+dy*d)))h=true}if(h)o2++}if(o2<3)continue}
       let clear=0,tot=0,cl=[0,0],tl=[0,0];for(let a=0;a<24;a++){const deg=a*15;if(deg%90===0)continue;const an=deg*Math.PI/180,side=Math.cos(an)<0?0:1;tot++;tl[side]++;let e=true;for(const dd of [sp*0.3,sp*0.5,sp*0.7]){const d=Math.max(r*1.4,ro+dd);if(ink(Math.round(cx+Math.cos(an)*d),Math.round(cy+Math.sin(an)*d)))e=false}if(e){clear++;cl[side]++}}
       // (the word "Coda" may stand right beside it: one side clear is enough then)
       if(clear/tot<0.85&&!(Math.max(cl[0]/tl[0],cl[1]/tl[1])>=0.9&&Math.min(cl[0]/tl[0],cl[1]/tl[1])>=0.35))continue;
       if(global.__cdbg)global.__cdbg.push([cx,cy,r,+ro.toFixed(1),romax,clear,tot]);
       found.push({x:cx,y:cy,r})}
   const keep=[];for(const f of found){if(!keep.some(k=>Math.hypot(k.x-f.x,k.y-f.y)<sp*1.5))keep.push(f)}
   if(global.__cfound)keep.forEach(f=>global.__cfound.push([+(f.r/sp).toFixed(2)]));
   keep.forEach(f=>s.signs.push({k:'coda',x:f.x,y:f.y,r:f.r}))}
  // --- signs: separate shapes above the staff
  const ya=Math.max(prevBot+sp*1.2,s.top-sp*9),yb=s.top-sp*0.2;
  // (signs are often printed in a light colour: look at them in the mask that keeps light ink)
  const MM=m2||m,ML=m3||MM,inkC=(x,y)=>x>=0&&x<W&&y>=0&&y<H&&ML[y*W+x]===1;
  const codaShape=(c,comps)=>{const w=c.x1-c.x0+1,h=c.y1-c.y0+1;
    // coda drawn as one shape (an oval of any width with a cross through it, often with little caps on the arms):
    // a line through the middle each way, and off the middle both ways three crossings (ring, bar, ring)
    if(h>=sp*1.1&&h<=sp*4.5&&w>=sp*0.8&&w<=sp*4&&w/h<2.2&&h/w<3.2){let cx=Math.round((c.x0+c.x1)/2),cy=Math.round((c.y0+c.y1)/2);
      const rowRuns=y=>{let r=0,p=0;for(let x=c.x0;x<=c.x1;x++){const v=inkC(x,y)?1:0;if(v&&!p)r++;p=v}return r},colRuns=x=>{let r=0,p=0;for(let y=c.y0;y<=c.y1;y++){const v=inkC(x,y)?1:0;if(v&&!p)r++;p=v}return r};
      // (the cross is not always in the middle of the box: the arms can differ in length)
      let bx=cx,by=cy;
      const lineV=(()=>{let best=0;const R=Math.max(2,Math.round(w*0.12));for(let dx=-R;dx<=R;dx++){let k=0;for(let y=c.y0;y<=c.y1;y++)if(inkC(cx+dx,y)||inkC(cx+dx-1,y)||inkC(cx+dx+1,y))k++;if(k/h>best+0.02||(Math.abs(k/h-best)<=0.02&&Math.abs(dx)<Math.abs(bx-cx))){best=Math.max(best,k/h);bx=cx+dx}}return best})();
      const lineH=(()=>{let best=0;const R=Math.max(2,Math.round(h*0.12));for(let dy=-R;dy<=R;dy++){let k=0;for(let x=c.x0;x<=c.x1;x++)if(inkC(x,cy+dy)||inkC(x,cy+dy-1)||inkC(x,cy+dy+1))k++;if(k/w>best+0.02||(Math.abs(k/w-best)<=0.02&&Math.abs(dy)<Math.abs(by-cy))){best=Math.max(best,k/w);by=cy+dy}}return best})();
      const cx0=cx,cy0=cy;cx=bx;cy=by;
      const r3=(f,base,g)=>{let ok=0;for(const d of [-1,1]){let hit=false;for(const k of [0.17,0.22,0.27])if(f(Math.round(base+d*k*g))>=3)hit=true;if(hit)ok++}return ok===2};
      const rowsOK=r3(rowRuns,cy,h),colsOK=r3(colRuns,cx,w);
      // hollow between the ring and the cross
      const holesAt=(X,Y)=>{let k=0;for(const [dx,dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]){let e=0;for(const f of [0.1,0.13,0.16])if(!inkC(Math.round(X+dx*w*f),Math.round(Y+dy*h*f)))e++;if(e>=2)k++}return k}; // (an x through a ring - a crash note - fills them)
      const holes=Math.max(holesAt(cx,cy),holesAt(cx0,cy0),holesAt(cx0,cy),holesAt(cx,cy0));
      
      // (the side arms may be printed apart from the ring: small marks level with its middle on both sides)
      const arm=side=>comps.some(d=>d!==c&&(d.x1-d.x0)<sp*1.2&&(d.y1-d.y0)<sp*1.2&&Math.abs((d.y0+d.y1)/2-cy)<h*0.2&&(side<0?c.x0-d.x1:d.x0-c.x1)>=-2&&(side<0?c.x0-d.x1:d.x0-c.x1)<sp*0.8);
      const armsApart=arm(-1)&&arm(1);
      // the cross sticks out of the ring: on the middle row the ink reaches further out than on the rows above and below
      const ext=(y,dir)=>{if(dir<0){for(let x=c.x0;x<=c.x1;x++)if(inkC(x,y))return x;return c.x1}for(let x=c.x1;x>=c.x0;x--)if(inkC(x,y))return x;return c.x0};
      const midL=Math.min(...[-2,-1,0,1,2].map(d=>ext(cy+d,-1))),midR=Math.max(...[-2,-1,0,1,2].map(d=>ext(cy+d,1)));
      const ringL=Math.min(ext(Math.round(cy-h*0.22),-1),ext(Math.round(cy+h*0.22),-1)),ringR=Math.max(ext(Math.round(cy-h*0.22),1),ext(Math.round(cy+h*0.22),1));
      const armsOut=(midL<ringL-1||arm(-1))&&(midR>ringR+1||arm(1));
      // no beam across its top or bottom (a beamed group of notes can look like a crossed ring)
      const cov=y=>{let k=0;for(let x=c.x0;x<=c.x1;x++)if(inkC(x,y))k++;return k/w};let topC=0,botC=0;
      for(let y=c.y0;y<=c.y0+h*0.2;y++)topC=Math.max(topC,cov(y));for(let y=Math.round(c.y1-h*0.2);y<=c.y1;y++)botC=Math.max(botC,cov(y));
      const closed=topC<0.75&&botC<0.75;
      // (and the ring is even about the cross - an S is not)
      const sym=[-0.22,0.22].every(f=>{const y=Math.round(cy+f*h),L=ext(y,-1),R=ext(y,1);return Math.abs((L+R)/2-cx)<w*0.16});
      if(global.__cdbg2)global.__cdbg2.push([c.x0,c.y0,w,h,+lineV.toFixed(2),+lineH.toFixed(2),rowsOK,colsOK,holes,armsOut,armsApart,cx-c.x0,cy-c.y0,sym,closed]);
      if(lineV>0.7&&rowsOK&&holes>=2&&sym&&closed&&((lineH>0.85&&armsOut)||(lineH>0.5&&armsApart))){return {k:'coda',x:cx,y:cy,hw:w/2,hh:h/2}}}
    return null};
  const comps=components(MM,W,H,X0-sp*3,ya,X1+sp*2.5,yb);
  // (light printing breaks a sign apart in the darker mask: try the codas again on the light one)
  const compsL=components(ML,W,H,X0-sp*3,ya,X1+sp*2.5,yb);
  if(global.__cc)global.__cc.push([Math.round(s.top),comps.length,compsL.length,Math.round(ya),Math.round(yb)]);
  const addCoda=g=>{if(g&&!s.signs.some(o=>Math.abs(o.x-g.x)<sp*1.5&&Math.abs(o.y-g.y)<sp*1.5))s.signs.push(g)};
  for(const c of comps){const w=c.x1-c.x0+1,h=c.y1-c.y0+1;
    {const g=codaShape(c,comps);if(g){addCoda(g);continue}}
    // segno body: taller than wide, with two small dots beside it
    if(h>=sp*1.4&&h<=sp*4.2&&w>=sp*0.8&&w<=sp*3.2&&h>=w*0.75){const cx=(c.x0+c.x1)/2,cy=(c.y0+c.y1)/2;
      const dots=comps.filter(d=>d!==c&&(d.x1-d.x0)<=sp*0.7&&(d.y1-d.y0)<=sp*0.7&&(d.x1-d.x0)>=sp*0.15&&Math.abs((d.y0+d.y1)/2-cy)<h*0.5&&Math.abs((d.x0+d.x1)/2-cx)<w*0.95);
      const l=dots.some(d=>(d.x0+d.x1)/2<cx),r=dots.some(d=>(d.x0+d.x1)/2>cx);
      // the stroke through the S: ink crossing the middle at a slant (the centre itself is inked)
      let centre=false;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(ink(Math.round(cx)+dx,Math.round(cy)+dy))centre=true;
      // and alone: no other shapes close by except its dots
      const near=comps.filter(d=>d!==c&&!dots.includes(d)&&!(d.x0>c.x1+2)&&!(d.x0>=c.x0-sp*0.3&&d.x1<=c.x1+sp*0.3&&d.y0>=c.y0-sp*0.3&&d.y1<=c.y1+sp*0.3)&&d.n>sp*sp*0.12&&d.x1>=c.x0-sp*0.3&&d.x0<=c.x1+sp*0.3&&d.y1>=c.y0-sp*0.3&&d.y0<=c.y1+sp*0.3&&!(d.y0>c.y1-sp*0.25&&(d.x0>(c.x0+c.x1)/2||d.x1<(c.x0+c.x1)/2))&&!(d.y1>c.y1+sp*0.5&&((d.x0+d.x1)/2>c.x1||(d.x0+d.x1)/2<c.x0))).length; // (a note beside it, head below, does not count)
      if(global.__sdbg)global.__sdbg.push([c.x0,c.y0,c.x1,c.y1,c.n,l,r,centre,near,dots.length,JSON.stringify(comps.filter(d=>d!==c&&!dots.includes(d)&&d.n>sp*sp*0.12&&d.x1>=c.x0-sp*0.3&&d.x0<=c.x1+sp*0.3&&d.y1>=c.y0-sp*0.3&&d.y0<=c.y1+sp*0.3))]);
      // one dot can run into the S in a blurred scan: then the slash across it has to be there
      let slash=0,sn=0;{for(let f=-0.35;f<=0.35;f+=0.05){sn++;const x=Math.round(cx+f*w),y=Math.round(cy-f*h);let hit=false;for(let d=-2;d<=2;d++)if(ink(x+d,y))hit=true;if(hit)slash++}}
      // the dots sit across the slash: the left one lower, the right one higher
      const dl=dots.filter(d=>(d.x0+d.x1)/2<cx),dr=dots.filter(d=>(d.x0+d.x1)/2>cx),my=d=>(d.y0+d.y1)/2;
      const dotsDiag=(dl.length?dl.some(d=>my(d)>cy-h*0.05):true)&&(dr.length?dr.some(d=>my(d)<cy+h*0.05):true)&&(!(dl.length&&dr.length)||Math.max(...dl.map(my))>Math.min(...dr.map(my)));
      if(global.__sg)global.__sg.push([c.x0,c.y0,w,h,l,r,+(sn?slash/sn:0).toFixed(2),near,JSON.stringify(comps.filter(d=>d!==c&&!dots.includes(d)&&!(d.x0>c.x1+2)&&d.n>sp*sp*0.12&&d.x1>=c.x0-sp*0.3&&d.x0<=c.x1+sp*0.3&&d.y1>=c.y0-sp*0.3&&d.y0<=c.y1+sp*0.3).map(d=>[d.x0,d.y0,d.x1,d.y1])),dots.map(d=>[Math.round((d.x0+d.x1)/2-cx),Math.round((d.y0+d.y1)/2-cy)])]);
      if(centre&&near===0&&c.n>sp*sp*0.6&&((l&&r&&sn&&slash/sn>=0.6&&dotsDiag)||(l!==r&&sn&&slash/sn>=0.85&&h>=sp*1.8&&dotsDiag)))s.signs.push({k:'segno',x:cx,y:cy,hw:w/2,hh:h/2})}}
  for(const c of compsL){addCoda(codaShape(c,compsL))}
  // a sign standing in a line of text (a lyric syllable, a word) is part of that text: letters of about its size on both sides
  s.signs=s.signs.filter(g=>{const hw=g.hw||(g.r||sp)*1.2,hh=g.hh||(g.r||sp)*1.2,x0=g.x-hw,x1=g.x+hw,y0=g.y-hh,y1=g.y+hh,H2=y1-y0;
    const side=d=>comps.some(c=>{const h=c.y1-c.y0+1,w=c.x1-c.x0+1;if(h<H2*0.6||h>H2*1.5||w>H2*2.5)return false; // (letters about as tall as the sign: a sign is usually taller than lyrics)
      const ov=Math.min(c.y1,y1)-Math.max(c.y0,y0);if(ov<Math.min(h,H2)*0.5)return false;
      if(Math.abs(c.y1-y1)>H2*0.3&&Math.abs(c.y0-y0)>H2*0.3)return false; // (letters of a line share their top or their bottom)
      const gap=d<0?x0-c.x1:c.x0-x1;return gap>-2&&gap<H2*6});
    if(global.__tf)global.__tf.push([g.k,Math.round(g.x),Math.round(g.y),side(-1),side(1)]);
    // or a word going on to one side: two or more letters of its size on the same line
    const run=d=>comps.filter(c=>{const h=c.y1-c.y0+1,w=c.x1-c.x0+1;if(h<H2*0.8||h>H2*1.25||w>H2*2||w<H2*0.3)return false;
      if(Math.abs(c.y1-y1)>H2*0.25&&Math.abs(c.y0-y0)>H2*0.25)return false;const gap=d<0?x0-c.x1:c.x0-x1;return gap>-2&&gap<H2*3}).length;
    return !(side(-1)&&side(1))&&run(-1)<3&&run(1)<3});
}


/* ---------- tiny digit reader for multi-rest counts ---------- */
/* a time signature between xa and xb: [num, den] or null */
function timeSigAt(m,W,H,s,xa,xb,loose){
  xa=Math.round(xa);xb=Math.round(xb);if(xb-xa<4)return null;
  const q=s.at(Math.round((xa+xb)/2)),g=(q.b-q.t)/4;
  // half the line thickness
  let lt=1;{const runs=[];for(let x=xa;x<xb;x+=2){const qq=s.at(x),ly=Math.round(qq.t);if(!m[ly*W+x])continue;let a=ly,b=ly;
      while(a>0&&m[(a-1)*W+x]&&ly-a<8)a--;while(b<H-1&&m[(b+1)*W+x]&&b-ly<8)b++;runs.push(b-a+1)}if(runs.length)lt=Math.max(0.5,median(runs)/2)}
  // per column: ink in the staff spaces of the upper half, of the lower half, and outside the staff
  const col=[];
  for(let x=xa;x<xb;x++){const qq=s.at(x),gg=(qq.b-qq.t)/4;let up=0,lo=0,out=0;
    for(let y=Math.round(qq.t-gg*1.2);y<=Math.round(qq.b+gg*1.2);y++){if(y<0||y>=H||!m[y*W+x])continue;
      const rel=(y-qq.t)/gg;let onLine=false;for(let l=0;l<5;l++)if(Math.abs(y-(qq.t+gg*l))<=lt+0.5)onLine=true;
      if(rel<-0.25||rel>4.25){out++;continue}if(onLine)continue;if(rel<2)up++;else lo++}
    col.push({x,up,lo,out})}
  const runsOf=key=>{const rs=[];let a=-1;col.forEach((c,i)=>{const on=c[key]>=Math.max(2,g*0.25);if(on&&a<0)a=i;if((!on||i===col.length-1)&&a>=0){const b=on?i:i-1;rs.push([col[a].x,col[b].x]);a=-1}});
    // merge digits of one number (a small gap between them)
    const mg=[];rs.forEach(r=>{const L=mg[mg.length-1];if(L&&r[0]-L[1]<=g*0.45)L[1]=r[1];else mg.push([...r])});return mg.filter(r=>r[1]-r[0]+1>=g*0.6)};
  const U=runsOf('up'),D=runsOf('lo');
  for(const u of U)for(const d of D){
    const ov=Math.min(u[1],d[1])-Math.max(u[0],d[0]);if(ov<Math.min(u[1]-u[0],d[1]-d[0])*0.5)continue;
    const x0=Math.min(u[0],d[0]),x1=Math.max(u[1],d[1]);if(x1-x0>g*5.5)continue;
    // numbers stay inside the staff (notes have stems and flags sticking out)
    let out=0;for(const c of col)if(c.x>=x0&&c.x<=x1)out+=c.out;if(out>(x1-x0+1)*g*0.15)continue;
    let top=readStack(m,W,H,s,u,q.t,q.t+2*g,g,lt),bot=readStack(m,W,H,s,d,q.t+2*g,q.b,g,lt);
    // thin digits in some engravings read with less certainty: a weaker reading still counts when it makes a usual
    // time signature (2, 3, 4 or 6 over 4 or 8) - nothing else stacks two digits in the staff right after a barline
    if((top<1||![1,2,4,8,16].includes(bot))&&!global.__tsStrict){readStack.conf=null;const t2=readStack(m,W,H,s,u,q.t,q.t+2*g,g,lt,0.15),c1=readStack.conf;readStack.conf=null;const b2=readStack(m,W,H,s,d,q.t+2*g,q.b,g,lt,0.15),c2=readStack.conf;
      // (one of the two has to look clearly like its digit: a cymbal note over a bass-drum note after a barline reads
      // weakly as '2 over 4' too, and turned a whole 4/4 song into 2/4)
      if([2,3,4,6].includes(t2)&&[4,8].includes(b2)&&(global.__tsWeakOld||Math.max(c1||0,c2||0)>=0.38)){top=t2;bot=b2}}
    if(global.__tsdbg)global.__tsdbg.push({u,d,top,bot});
    if(top<1||top>16||![1,2,4,8,16].includes(bot)){const c=commonTime(m,W,H,s,x0,x1,g,lt);if(c)return [c[0],c[1],x1,x0];
      // (loose: numbers we could not read. A digit has a stroke across it somewhere - the bar of a 4, the base of a 2 -
      // a barline pair is two separate upright strokes)
      if(loose){let best=0;for(let y=Math.round(q.t+lt+1);y<=Math.round(q.b-lt-1);y++){let on=false;for(let l=0;l<5;l++)if(Math.abs(y-(q.t+g*l))<=lt+1)on=true;if(on)continue;
          let k=0;for(let x=x0;x<=x1;x++)if(m[y*W+x])k++;best=Math.max(best,k/(x1-x0+1))}
        if(best>=0.8)return [0,0,x1,x0,'?']}
      continue}
    return [top,bot,x1,x0];
  }
  return null;
}
/* the "C" (common time, 4/4) and cut-time (2/2) signs */
function commonTime(m,W,H,s,x0,x1,g,lt){
  const w=x1-x0+1;if(w<g*0.9||w>g*2.4)return null;
  const q=s.at(Math.round((x0+x1)/2)),t=q.t;
  const ink=(x,y)=>{if(x<0||y<0||x>=W||y>=H||!m[y*W+x])return false;for(let l=0;l<5;l++)if(Math.abs(y-(t+g*l))<=lt+0.5)return false;return true};
  let y0=1e9,y1=-1;for(let x=x0;x<=x1;x++)for(let y=Math.round(t-g*1.5);y<=Math.round(t+g*5.5);y++)if(ink(x,y)){if(y<y0)y0=y;if(y>y1)y1=y}
  if(y1<0)return null;
  const slash=y0<t-g*0.3||y1>t+g*4.3;   // a stroke through the C sticking out of the staff: cut time
  // the bowl of the C: between line 1 and line 3, open on the right at the middle
  let cy0=1e9,cy1=-1;for(let x=x0;x<=x1;x++)for(let y=Math.round(t+g*0.4);y<=Math.round(t+g*3.6);y++)if(ink(x,y)){if(y<cy0)cy0=y;if(y>cy1)cy1=y}
  if(global.__tsdbg)global.__tsdbg.push({C:[x0,x1,y0,y1,cy0,cy1,+(t).toFixed(1),+g.toFixed(1)]});
  if(cy1-cy0<g*1.4||cy1-cy0>g*2.8)return null;
  const mid=(cy0+cy1)/2;let left=0,right=0;
  for(let y=Math.round(mid-g*0.3);y<=Math.round(mid+g*0.3);y++){for(let x=x0;x<x0+w*0.35;x++)if(ink(x,y))left++;for(let x=Math.round(x0+w*0.6);x<=x1;x++)if(ink(x,y))right++}
  if(global.__tsdbg)global.__tsdbg.push({LR:[left,right,slash]});
  if(left<g*0.4||right>(slash?g*0.9:Math.max(g*0.25,left*0.15)))return null;
  // the top and bottom arcs reach the right side
  let tr=0,br=0;for(let x=Math.round(x0+w*0.55);x<=x1;x++){for(let y=cy0;y<cy0+g*0.5;y++)if(ink(x,y))tr++;for(let y=Math.round(cy1-g*0.5);y<=cy1;y++)if(ink(x,y))br++}
  if(global.__tsdbg)global.__tsdbg.push({TB:[tr,br]});
  if(tr<g*0.3||br<g*0.3)return null;
  return slash?[2,2]:[4,4];
}
/* read a number that fills half the staff (between ya and yb) in the columns of run r */
function readStack(m,W,H,s,r,ya,yb,g,lt,minConf){
  ya=Math.round(ya-lt);yb=Math.round(yb+lt);
  // split the run into digits at empty columns
  const digs=[];let a=-1;
  for(let x=r[0];x<=r[1]+1;x++){let k=0;if(x<=r[1])for(let y=ya;y<=yb;y++){if(y<0||y>=H)continue;const rel=(y-ya);if(m[y*W+x]){let line=false;
        for(let l=0;l<5;l++){const ly=s.at(x).t+g*l;if(Math.abs(y-ly)<=lt+0.5)line=true}if(!line)k++}}
    if(k>0&&a<0)a=x;if(k===0&&a>=0){if(x-a>=g*0.4)digs.push([a,x-1]);a=-1}}
  if(!digs.length||digs.length>2)return -1;
  let v=0;
  for(const [x0,x1] of digs){let y0=1e9,y1=-1;
    for(let y=ya;y<=yb;y++)for(let x=x0;x<=x1;x++)if(y>=0&&y<H&&m[y*W+x]){let line=false;for(let l=0;l<5;l++){const ly=s.at(x).t+g*l;if(Math.abs(y-ly)<=lt+0.5)line=true}
      if(!line){if(y<y0)y0=y;if(y>y1)y1=y}}
    if(y1<0||y1-y0<g*1.2)return -1;
    // digits touch the lines at top and bottom: include those rows
    const r1=classifyS(m,W,{x0,y0:Math.max(ya,Math.round(y0-lt*2)),x1,y1:Math.min(yb,Math.round(y1+lt*2))});
    if(global.__tsdbg)global.__tsdbg.push({dig:[x0,x1,y0,y1],r1});
    if(r1[1]<(minConf!=null?minConf:0.45))return -1;v=v*10+r1[0];readStack.conf=Math.min(readStack.conf==null?1:readStack.conf,r1[1])}
  return v;
}
/* an empty measure holding only a short text like "7bars": read the leading number */
function textRest(m,W,H,s,xa,xb,g,first){
  const mx=Math.round((xa+xb)/2),q=s.at(mx);
  const X0=Math.round(xa+(first?g*5:g*1.5)),X1=Math.round(xb-g*1.5),Y0=Math.max(0,Math.round(q.t-g*3)),Y1=Math.min(H,Math.round(q.b+g*0.4));
  const w=X1-X0,h=Y1-Y0;if(w<g*6||h<=0)return -1;
  // half the real staff-line thickness, measured on the line through this measure
  let lt=1;{const runs=[];for(let x=X0;x<X1;x+=3){const qq=s.at(x);const ly=Math.round(qq.t);let a=ly,b=ly;if(!m[ly*W+x])continue;
      while(a>0&&m[(a-1)*W+x]&&ly-a<8)a--;while(b<H-1&&m[(b+1)*W+x]&&b-ly<8)b++;runs.push(b-a+1)}
    if(runs.length)lt=Math.max(0.5,median(runs)/2)}
  // ink without the staff lines (keep strokes that cross a line)
  const L=new Uint8Array(w*h);
  for(let x=X0;x<X1;x++){const qq=s.at(x),gg=(qq.b-qq.t)/4;const lines=[0,1,2,3,4].map(l=>qq.t+gg*l);
    for(let y=Y0;y<Y1;y++){if(!m[y*W+x])continue;
      let onLine=false;for(const ly of lines)if(Math.abs(y-ly)<=lt+0.5){const up=Math.round(ly-lt-1),dn=Math.round(ly+lt+1);
        if(!(up>=0&&m[up*W+x])&&!(dn<H&&m[dn*W+x]))onLine=true}
      if(!onLine)L[(y-Y0)*w+(x-X0)]=1}}
  const comps=[],seen=new Uint8Array(w*h);
  for(let k0=0;k0<w*h;k0++){if(!L[k0]||seen[k0])continue;const st=[k0];seen[k0]=1;const b={x0:1e9,y0:1e9,x1:-1,y1:-1,n:0};
    while(st.length){const k=st.pop(),x=k%w,y=(k/w)|0;b.n++;if(x<b.x0)b.x0=x;if(x>b.x1)b.x1=x;if(y<b.y0)b.y0=y;if(y>b.y1)b.y1=y;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;const kk=ny*w+nx;if(L[kk]&&!seen[kk]){seen[kk]=1;st.push(kk)}}}
    if(b.n>=Math.max(4,g*0.6))comps.push({x0:b.x0+X0,x1:b.x1+X0,y0:b.y0+Y0,y1:b.y1+Y0,n:b.n})}
  if(global.__tdbg)global.__tdbg.push({X0,X1,Y0,Y1,n:comps.length,c:comps.slice(0,16).map(c=>[c.x0,c.y0,c.x1,c.y1,c.n])});
  if(!comps.length||comps.length>14)return -1;
  // everything must be one short line of text
  const ax=Math.min(...comps.map(c=>c.x0)),bx=Math.max(...comps.map(c=>c.x1)),ay=Math.min(...comps.map(c=>c.y0)),by=Math.max(...comps.map(c=>c.y1));
  if(bx-ax>(xb-xa)*0.5||by-ay>g*3.2)return -1;
  comps.sort((a,b)=>a.x0-b.x0);
  const d0=comps[0],h0=d0.y1-d0.y0+1;if(h0<g*0.8||h0>g*3)return -1;
  // digits: same height and baseline as the first glyph; letters after them end the number
  let v=0,nd=0;
  for(const c of comps){const hc=c.y1-c.y0+1;
    if(Math.abs(hc-h0)>h0*0.12||Math.abs(c.y1-d0.y1)>g*0.3)break;
    // a glyph stroke can lie exactly on a staff line (the top of a 7): also try it with the line rows put back
    const qq=s.at(Math.round((c.x0+c.x1)/2)),gg=(qq.b-qq.t)/4;let ya=c.y0,yb=c.y1;
    for(let l=0;l<5;l++){const ly=qq.t+gg*l;if(ly>=c.y0-lt-2.5&&ly<c.y0+lt+1)ya=Math.min(ya,Math.floor(ly-lt-0.5));if(ly<=c.y1+lt+2.5&&ly>c.y1-lt-1)yb=Math.max(yb,Math.ceil(ly+lt+0.5))}
    const r1=classifyS(subMask(L,w,X0,Y0,c),c.x1-c.x0+1,{x0:0,y0:0,x1:c.x1-c.x0,y1:c.y1-c.y0});
    const r2=(ya<c.y0||yb>c.y1)?classifyS(m,W,{x0:c.x0,y0:Math.max(0,ya),x1:c.x1,y1:Math.min(H-1,yb)}):[-1,-1];
    const r=r2[1]>r1[1]?r2:r1;const d=r[1]>(nd?0.72:0.6)?r[0]:-1;
    if(global.__digits)global.__digits.push(['t',d,c,r1,r2]);
    if(d<0)break;v=v*10+d;nd++;if(nd>=2)break}
  return nd?v:-1;
}
function subMask(L,w,X0,Y0,c){
  const W2=c.x1-c.x0+1,H2=c.y1-c.y0+1,mm=new Uint8Array(W2*H2);
  for(let y=0;y<H2;y++)for(let x=0;x<W2;x++)mm[y*W2+x]=L[(c.y0-Y0+y)*w+(c.x0-X0+x)];
  return mm;
}
let TPL=null;
const TPL_DATA=[[0,0.617,"0007cffd920002dff65fff300cffb009fff15fff7003fff7afff4001fffbefff3000fffeffff3000ffffffff3000ffffffff3000ffffffff3000ffffffff3000ffffbfff3000fffc6fff7003fff80effa007fff203fff32eff600019dffda300"],[1,0.557,"00001bff3000004bffff30006cffffff3000a725ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000005ffff30000237ffff6320ffffffffffff"],[2,0.625,"29cefffc93003fd634bfffb03f60000cfff53f100007fff900000007fff900000007fff80000000dfff30000004fff70000001fff70000000dff40000002dfb00000004ff600000007fd20000000bffa99999999ffffffffffffffffffffffff"],[3,0.63,"4acffffc72007fd536dfff607f30001ffff17f00000cfff30000000cfff30000000ffff0000003bfff40000cfffe8000000579dffd600000000afff700000003fffd00000000fffff6000003fffefb000008fffaff61017fffd1acdffffd9500"],[4,0.709,"0000000aff600000005fff60000002ffff6000000cfeff6000007f3fff600003f80fff60000ed00fff60009f300fff6004f6000fff600ea0000fff60bfa9999fffc9ffffffffffffcccccccfffec0000000fff600000000fff600000000fff60"],[5,0.637,"0fffffffffb00fffffffffb00fc9999999700f70000000000f70000000000f70000000000fb7999730000ffa9aeffe600000000cfff500000005fffb00000003fffe30000003fffef8000003fffcfd000008fff5ff95338fff708bcffffc8300"],[6,0.642,"00018dfffca1006ffe536ff303fff40008f30dffd00003f35fff70000000afff30000000dfff67997300fffffeefffb0ffff0008fff8ffff0000effebfff3000cfff8fff3000cfff2fff7000cfff0affd000effa00cff706fff20007bfffc710"],[7,0.633,"fffffffffffffffffffffffdffcccccccff7fa0000001ff193000000bf8000000004ff100000000ef7000000008ff000000002ff700000000afe000000003ff700000000cfe000000007ff700000001ffe00000000bff800000004fff1000000"],[8,0.642,"003bdffeb40007fff54dffb02fff8005fff57fff6002fff97fff5001fff93fff7003fff607ffe11bffb0005ffffff60006ffd54cff804fff3000fff7dfff0000cffdffff0000cfffffff0000cfffafff1000effb1dffb008fff3008cefffc810"],[9,0.654,"003aeffe910007ffe43eff304fff6007ffe0bfff3003fff5ffff3000fff9ffff3000fffcbfff3000fffd4fff8000ffff07fffb9bffff0028ccb8fffc00000000fffc00000002fff83c200006fff33f50000cff903fc3007ffc001bdfffeb5000"],[0,0.617,"0007cffd920002df5005ff300cf700004ff15ff000000df7afc0000009fbefb0000007feffa0000006ffff70000003ffff70000003ffff90000006ffffb0000007ffbfc0000009fc6ff000000df80ef500003ff203ff2002df600019dddda300"],[1,0.532,"000017e700000039eff700006cc79ff7000040005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff7000000005ff700009bccffffccc9"],[2,0.608,"17bdfffb81003fb63349ff703f0000008ff43a0000002ffa000000000ffb000000003ff8000000006ff200000000df8000000009fb000000007f700000000bf400000003db200000007f700000002bd200000000ffdcccccccccffffffffffff"],[3,0.605,"3acffffc93007f730017ff707c0000009ff1450000003ff5000000003ff5000000009ff100000006ff400006cffe700000013369fe70000000002ff80000000008fe0000000006ff9000000007fff30000000cfbfa100001bff29cdeddddb600"],[4,0.709,"00000000eb0000000008fb000000005ffb00000003fafb0000000e66fb0000009a06fb000006e006fb00003f3006fb0000e60006fb000a900006fb006d000006fc00ffffffffffff9999999cfe9900000006fb0000000006fb0000000006fb00"],[5,0.6,"3fffffffff703fcccccccc603f00000000003f00000000003f00000000003f00000000003f35666310003cc999bffb30000000008ff3000000000dfd000000000bff000000000affc00000000bfef50000003ff7fc410016ff707bdffffc8300"],[6,0.63,"00018dfffcb1004fd40039f303fe000000f30ef7000000205ff200000000aff000000000cfb003664000ffdbeccdff90ffc100004ff8ffb0000009febfd0000007ff8ff0000003ff2ff3000007ff0bf800000afa00cf40004ff20006cdddc810"],[7,0.62,"fffffffffffffffffffffffbf500000003f3f00000000cb0000000007f2000000001f8000000000be0000000004f5000000000ec0000000008f3000000003f8000000000bf1000000004f7000000000ec0000000008f3000000003fb00000000"],[8,0.617,"003adffeb50007ff4003dfb02ff600002ff57ff300000ff97ff300000ff93ff400001ff507fd2000bfb0004ffdcff70004fd7337df706ff100000cf8efa0000006feff70000003ffff70000004ffbfc0000009fc3ff700005ff5017cddddc930"],[9,0.63,"003aeffe920008fc3004ff407ff200007ff1dfc000000ff7ffb000000bfbffb0000007fdcfe0000007ff4ff7000008ff04ffb99acdff0005998507ff000000000afc000000000df9000000003ff43d000000cfb03f30000afb002cdeddda5000"],[0,0.667,"00003afffa200006ff77eff3006ff6006ffa01ffe0003ffe08ff70003fff0eff30003fff2fff00004ffe7ffc00007ffcbff90000bff9cff70000eff5fff60001fff1fff60005ffb0dff6000aff30aff7003ff9001ffd24dfb00003befeb50000"],[1,0.57,"000000006df80000017efff60005bffffff2000a744ffff00000007fffb0000000bfff70000000efff30000002ffff00000005fffd00000008fff90000000cfff60000000ffff30000005fffe00000009fffa0000133efff7320effffffffffd"],[2,0.734,"0004adfffa30000cf968fff3000f70007ffe002f00003fff000200003fff000000008ffa00000000eff300000009ff800000007ffa00000009ff900000009ff70000000afa10000001cf600000004ef766666640cfffffffff80ffffffffff50"],[3,0.725,"0007cfffea30000ed536fff5001f30007ffc004d00006fff000000006ffd00000000bff70000003affb00000bfffc300000058bffc1000000007ffc000000001fff202000000fff37c000003fff0af00000aff90bf8435bffa00acffffca3000"],[4,0.734,"000000000aff000000006ffd00000003fffa0000002efff7000001fc8ff500000ed1cff20000ce20fff00008f301ffc0006f5005ff9003f80007ff602ee6666cff86bffffffffffebccccccfffc90000003ffb000000007ff800000000bff600"],[5,0.688,"000cfffffffe000ffffffffb003f96666663007f2000000000af0000000000dc0000000001fc7998500003ffcceffe300130000cffd000000004fff300000003fff311000003fff3ac000007fff0cc00001fff70ff7336eff700acffffc72000"],[6,0.7,"000003beffda0000afd537ec001dfc0000ca00bff100009705ff800000000cff300000002ffe38cc93008fffeaefff50bff8000affc0fff60005fff0fff30003fff0fff30005ffe0bff70008ffa04ffb000dff2009ff73bfe400007dffc81000"],[7,0.747,"02ffffffffff04fffffffffa07f999999ff10aa000005f7007300001ed000000000af5000000006fb000000001ff200000000bf8000000006fe100000001ff700000000bfd000000006ff300000002ffa00000000cff200000009ff800000000"],[8,0.691,"00005cfffc70000cff83aff8008ffa003fff00cff6003fff00fff3004ffe00cff3008ff8005ff904ffc0000afffff70003dfe76cff501eff1001ffe0aff90000fff3eff40000fff2fff30003fff0bff40008ffa03ffd205ffd1003aeffec7000"],[9,0.7,"00008dffc600003ffc35ffa001eff100aff507ffa0006ffb0cff80003ffe0cff60003fff0cff80003fff08ffd0006ffc01effe9cfffa0017cca6cff600000000eff100000004ffa06c00000cff109c00007ff200df733afe2000acfffb600000"],[0,0.671,"0018dffd810001efffffff200bfffaafffd04fff2003fff4affb0000cff9dff900008ffcfff600007ffefff600007ffffff600007ffffff600007ffedff900007ffcaffa0000bff94ffe1002fff40cffd77effd002ffffffff30002adffd9200"],[1,0.663,"0005dfff000003bfffff00009fffffff0000ffe57fff0000f7007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000033339fff3333ffffffffffffffffffffffff"],[2,0.69,"0029effeb40003ffffffff900efffa9efff37fff3000dffa479700009ffc00000000cff900000007fff30000009fffa000001cfffa000003efff9000003ffff6000003effc1000001effc0000000bfffb9999998ffffffffffffffffffffffff"],[3,0.694,"0018dffea30003efffffff900efffaaefff36fff3001eff946870000bff900000000eff70000356cffc000009fffc50000009ffffc5000001248fff6000000007ffe668500005fffdffd1000afff4fffe87cfffa08ffffffffe1004adffec710"],[4,0.771,"000000cfff00000005ffff0000000dffff0000008fedff000003ff5fff00000dfa0fff00007ff20fff0001ff700fff000afc000fff005ff2000fff00efd7777fff77ffffffffffffcccccccfffcc0000000fff000000000fff000000000fff00"],[5,0.702,"0cfffffffff30efffffffff30fff866666610fff200000001fff000000003fff069951003fffeffffe305ffffeeffff47fff5004fffb000000008fff000000006fff224200006fffeffc0000cffc7fffc77dfff509ffffffff90005beffea400"],[6,0.682,"0003bfffc500007fffffff8005fffc9dfff20dff8000cdc54ffe000000009ffa00000000bff95cffea10dffeffffffe1ffffc538fff9dffe10008ffebffc00003fff7ffd00003fff1fff30009ffd08fff76afff700cfffffffc00007cfffc600"],[7,0.675,"ffffffffffffffffffffffffbcccccccdfff00000000bff800000006ffe00000002eff40000000eff700000008ffd00000001fff500000008ffe00000001fff700000007fff10000000effd00000001fff900000003fff700000006fff400000"],[8,0.694,"0029effea30005ffffffff801fffc66cfff37fff1000eff87fff0000cff94fff1000eff60affc65bffc0005efffff70005efffffff705fff4003eff7effa00007ffefff900006fffeffb00009ffe7fff8337fff80cffffffffd0005beffec700"],[9,0.682,"0029effe910003ffffffff301ffffaafffd09ffe2001eff5fffa00008ffbfff900006ffedffc00009fff7fff6004ffff0efffeefffff03cffffd6fff000266205ffd000000008ffa4bdd0001eff41fffc67effc007fffffffe10005beffc8100"],[0,0.635,"0004bbbc5000007fd00af80005ff7006ff600dff3003fff15fff3003fff7bfff3003fffcefff3003fffeffff3003ffffffff3003ffffffff3003ffffbfff3003fffc7fff3003fff81eff3003fff307ff7005ff8000bfb009fc000006c99c7000"],[1,0.542,"0000017ca0000037dfffa0008baeffffa0002004ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000003ffffa0000005ffffd00077bffffffd97"],[2,0.663,"0003bffd8000007ffffffd1005feceffffa00c50009ffff04500000dfff000000007ffe000000009ff800000000efe100000007fe200000001ef300000000ca000000000c9000008000c7000006c00bffffffff80cfffffffff5bffffffffff1"],[3,0.635,"0003beffb60000aecfffff800960009ffff01500000efff00000000dffb00000003ffa00000017fffa100003dffffff3000003affffb00000004ffff000000005fff000000000ffe021000000ff6bff900003fb0ffffd403d8001adffec82000"],[4,0.663,"00000002ef600000001dff60000000bfff60000007dfff6000004c6fff600004d16fff60002e206fff6001d5006fff600a80006fff606b00006fff60feddddefffedffffffffffff999999cfffc90000006fff600000006fff600000006fff60"],[5,0.646,"000bfffffffe001ffffffff8005ffffffff300a40000000000e00000000003fffca6000009fffffff7000fffffffffa001347aeffff500000006fff8000000002ff90000000008f80310000007f3cffb30000c90fffffb77d8003aeffec82000"],[6,0.635,"0000000159b8000003bfc50000009ff70000001dff70000002fffa0000000bfff40000003ffffaddb500afffb36fffd0bfff4007fff8ffff3003fffddfff3001ffffbfff3000ffff4fff5000fffb0cff8001fff501dfe003ff700007cb7ba400"],[7,0.679,"0dfffffffffe0ffffffffff84ffffffffff38c4333338fc0c1000000cf7020000002ff1000000009fb000000001ff4000000007fe000000000cf8000000002ff3000000008fd000000000ef5000000005fe000000000cf9000000003ff300000"],[8,0.635,"0018caaeb70006ff4002ffd02ffc0000bff77fff10007ff97fffc000bff33ffffe33ff6007ffffff9100004efffff8000007ffffffb007ff23dffff77ff9000afffccff60001ffffeff60000bffc8ff80000dff70cfe2004ffb0006cdbbd9400"],[9,0.635,"0018cacc700003ff500cfc000eff3007ffc08fff0004fff6efff0003fffbffff3003fffedfff3003ffff7fff9005fffe0cfff407fffc018dffdefff70000000efff10000007fff50000003fff60000003efd20000008fe70000069a730000000"],[0,0.655,"000003bbab3000007fb00be10008ff3007f8006ffc000bfd02fff5000fff09fff0002fff0fffa0005fff5fff5000affdbfff0000effadffb0003fff5fff70008fff1fff4000eff90cff0005ffe107fe000aff3000ee003ff300001aa8c810000"],[1,0.598,"0000000367ac00007abffffa00000009fff50000000dfff10000003fffc00000008fff60000000efff10000004fffb0000000afff50000000ffff00000005fffa0000000bfff40000000ffff00000006fff90000000dfff6000079effffd9710"],[2,0.683,"000007cffb300000cffffff3000bc437fffc007700009fff001000006fff000000006ffc00000000aff600000003ffb00000000dfb00000000bf800000000af5000000009d200012000bc00000b100cd66667da00cffffffff30dffffffffb00"],[3,0.663,"000003bffd7000007fcffff800077000afff000300003fff000000004ffd00000001dfd20000038ff8000001bfffff30000001afffc00000000bfff000000003fff000000000ffe000000003ff70afb00009fc00fff7003fa0004cffb9930000"],[4,0.756,"0000000000cd000000000cf900000000cff60000000cfff3000000c8ffe000000a65ffa00000970aff60000a700eff1000c6004ffd000a60008ff8007e9999effc80cfffffffffa099999cffd930000009ff700000000cff100000001ffd0000"],[5,0.741,"00001ffffffc00007ffffff70000e9999991000590000000000da4000000003ffff8000000afffffc00000248efff800000000afff000000000dff2000000007ff3000000006ff0000000007fa009f80000de100fff4009e10004cff99500000"],[6,0.711,"0000000017b90000003cfc3000000aff80000001dff60000000eff90000000cffd00000007fffccc70000effc02ef8005fff3009ff10affe000aff50dff7000eff50fff3002fff20bff0007ffd007ff000cff5000df104ff600001acbeb40000"],[7,0.7,"00effffffffc05fffffffff30cfdccccefa04c100000ef1070000008f6000000003fc000000000df2000000008f9000000002ff100000000cf4000000007fa000000002ff200000000cf8000000005fe000000000ef300000000bfa000000000"],[8,0.675,"00001aeceb300002ef201df5000efa0005fe003ff90003ff006ffd0007fe002fffb03ff4000afffce9100000cfffb0000017dcfff90006fd10dfff307fe1001dff90ff800005ff90ff600003ff80ef800005ff303fd0000cf70002ab98ba2000"],[9,0.699,"000018dfca200003efd10cf1001eff1009fa00aff8000afe00fff3000dff03fff0001fff03ffc0007ffe01ffc000cffa00cfe003fff5001dfecfffd00000458fff40000003fff70000001eff80000001eff50000006ff80000008b9510000000"],[0,0.656,"0007cffe810000cffffffe3008fffaafffd00fff6003fff46fff0000bffaaffc00008ffcbffb00006fffbff900006fffdff900006fffbffa00006fffbffc00007ffd7ffe0000affb1fff5001eff50afff77dffe001efffffff400018cffea200"],[1,0.435,"000000009fff00000019ffff00136aefffffffffffffffffffffffffffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff0000000fffff"],[2,0.667,"0019effe920003ffffffff601efffbaefff47fff2000effbbffa00007ffe9cc700006fff00000000bffb00000006fff30000008fff9000004dfff7000008fffd200001cffe6000000cfff10000007fffdaaaaaa8dffffffffffcfffffffffffc"],[3,0.644,"002aeffe910007ffffffff403fffd9bffff1affc0003fff5bff70000fff600000001fff30000135cff7000006ffffa0000005cffffc000000004fff9000000008ffeaaa400006fffeffb0000cffc7fffc67cfff70affffffffa0004beffea400"],[4,0.706,"000002ffff3000000bffff3000005fffff300001efbfff30000afd3fff30003ff33fff3000df903fff3008fd003fff302ff4003fff30cfb2225fff52ffffffffffffffffffffffff7777779fff970000003fff300000003fff300000003fff30"],[5,0.67,"00dffffffff600fffffffff603ffdcccccc506ff3000000008ff000000000bfd7dffc5000effffffff801fffc79dfff416650000effb000000007fff000000006fff555300007ffecffc0000effa5fffc79dfff308ffffffff40004aeffd9200"],[6,0.644,"0004bfffb50000afffffffa007fffb9cfff51eff50009dd96ffd00000000bffa03663000fffbcffffd30fffffedffff2ffff6001effbfffb00005fffeff800003fffaff900003fff4ffe1000bffb0dffe76cfff302efffffff700018cffeb400"],[7,0.706,"ffffffffffffffffffffffffffffffffffff00000001dff50000000bff700000007ffc00000002fff20000000cff700000003ffe00000000bff700000001fff100000007ffc00000000bff700000000fff400000002fff200000005fff000000"],[8,0.667,"0018dffd800004effffffe301fffeaaeffe05ffc1001dff56ff700008ff63ffc0000cff307ffd88dff7001cffffffb101effc77dffe1affb0000cffafff600007ffffff500006fffeffb0000cffc7fffc77dfff50affffffff70004aeffda300"],[9,0.656,"0007dffd700002dffffffc100dfffaafffc07ffe2003eff3cff900009ff9fff600006ffccffa00009fff7fff4005ffff0efffdefffff03efffffbffd0007bca36ffc00000000aff86ddb0002fff23fffc67effa007fffffffc10004aeffc7000"],[0,0.791,"0006dffc600001cfe67efb000cff5007ffa04fff2003fff39fff0001fff8dfff0000fffcffff0000fffdffff0000ffffffff0000ffffffff0000fffeefff0000fffcafff0001fff95fff1002fff40dff4005ffc002efd33dfd100018dffc7000"],[1,0.64,"0006efff700004cfffff7000cfc7ffff7000b503ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70000003ffff70001225ffff9222bfffffffffff"],[2,0.73,"38bdfffc8200cfe756dfff70cf30001efff5cc000009fffb21000006fffd00000006fffd00000008fff90000000dfff20000007ffe30000006ffc10000007ff70000001bfb20002605ee6000006fbffa999999cfffffffffffffffffffffffff"],[3,0.747,"27bcfffd92009fe757efff609f30001ffff29c00000bfff50000000bfff40000001fffe0000036effe300003ffffc4000000029fffc00000000afff800000004fffd21000002fffff8000004fffefd000009fff9ffb424afffc047bdfffda400"],[4,0.831,"000004fffa0000000cfffa0000004ffffa000000dcfffa000006f4fffa00001e92fffa00009f12fffa0002f702fffa000bd002fffa005f4002fffa00df7779fffd77ffffffffffff000002fffa00000002fffa00000024fffb210002fffffffb"],[5,0.719,"3ffffffffff03ffffffffff03fdcccccccc03f20000000003f20000000003f48bdda61003ff969fffe302d40003ffff300000009fffb00000006ffff00000005ffff31000006fffff7000007fffcfd00000efff6ffa424cfff9048bdfffd9300"],[6,0.758,"00029dffeb70007ffc659ff206ffa00004f20eff200000616ffe00000000bffd04775100fffeeedfff40ffffb00afff2ffff4003fffaffff3001fffeefff1000ffffbfff2000ffff5fff3002fffc0cff6004fff702efe43dffb00018cffeb600"],[7,0.747,"fffffffffffffffffffffffffffffffffffffd3333333afafc0000001ff2650000008fa000000001ff2000000008fa000000000ef3000000007fb000000001ff2000000009fa000000002ff3000000009fb000000001ff2000000009f9000000"],[8,0.78,"0029dffeb40005fff76eff801fff9006fff35fff7005fff75fff7005fff71fff9005fff305ffe21cff70003efffff60007ffd33affa05fff4001fff7cfff2000effdffff2000dfffefff2000effe8fff4000fffa0bffd33affd1005beffeb700"],[9,0.758,"003beffc700007ffe67ffd104fff5007ffc0cfff1004fff4ffff0002fff9ffff0002fffdffff0002ffffcfff2004ffff3fff700affff05fffbbfeffd0027aa71cffb00000000fff703000002fff23f400008ff903fe6239ffb0017beffea4000"],[0,0.791,"0006cffc600001cffffffb000bfffbbfffa03fff8009fff29fff0002fff7cffd0000fffbfffc0000dffdfffa0000dffffffa0000dffffffc0000dffddffd0000effc9fff0001fff84fff6007fff30cfff89fffb002effffffd100008dffc7000"],[1,0.701,"58beffff3000ffffffff3000ffffffff3000a741ffff30000000ffff30000000ffff30000000ffff30000000ffff30000000ffff30000000ffff30000000ffff30000000ffff30000000ffff3000ddddffffddddffffffffffffffffffffffff"],[2,0.719,"15acfffd9200cfffffffff90cfffcdfffff5cb40003efffc10000006fffd00000003fffd00000008fff90000005fffe2000008fffe300000afffe100001cfffc100001efff9000005efff7000000ffffffffffffffffffffffffffffffffffff"],[3,0.725,"19cdfffda4003fffffffffa03febabeffff61300000cfffa00000007fff90000000bfff500199aefff80003ffffff800003fffffffd10000015efffa00000004fffe00000002ffff50000008fffdffb878cffff8ffffffffffa06adfffec9300"],[4,0.839,"000006ffff2000000effff2000008fffff200002ffffff20000cfd8fff20006ff47fff2001ffa07fff200aff107fff203ff7007fff20cfd0007fff20ffecccefffdcffffffffffffffffffffffff2222229fff420000007fff200000007fff20"],[5,0.742,"3ffffffffff03ffffffffff03ffffffffff03fff222222203fff000000003fffbddb71003fffffffff503fffdefffff32610002dfffb00000003ffff00000001ffff00000003ffffc500000bfffbfffb9afffff5ffffffffff7048cefffc9200"],[6,0.769,"00017dffeb60003efffffff002ffffcabef00cfff30000503fff600000008fff02552000cffdbffffc10cfffffffffd1effff75afff9cfff7000dffebfff5000afff7fff5000afff1fff9000effc09fffa7cfff500bfffffff900006cffeb300"],[7,0.759,"ffffffffffffffffffffffffffffffffffff33333339fff80000000dfff20000005fffa0000000cfff20000004fffb0000000afff40000002fffd0000000afff50000001fffe00000008fff70000000efff00000007fff80000000efff100000"],[8,0.758,"003aeffeb50007ffffffffb03ffffbbffff68fff7004fffa8fff3000fffa3fff8006fff607fffedfffa0007ffffffa000afffedfffc17fff7005fff9dffe0000cffefffd0000afffcfff1001fffe7fffe98dfffa0bffffffffd1005beffec700"],[9,0.769,"0019dffc600003effffffb001efffbbfffb08fff3008fff3dffe0001fff8fffd0000fffcefff0003fffe9fff701bffff1effffffffff03efffffeffd0007aa82bffb00000001fff60200000bfff10dc979efff700dfffffff80005beffda3000"],[0,0.707,"0007dffe810000cfe43cfe1008ff5002ffc01fff1000dff37ffe0000aff8bffc00009ffcfffc00009ffffffc00006ffffffc00006ffffffc00009fffbffc00009ffc8ffe0000affa2fff0000dff50aff5002ffd001efe43cff300018dffea200"],[1,0.613,"000358df7000cfffffff70009999ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff70000000ffff7000357bffffe863ffffffffffff"],[2,0.667,"004beffeb3000cffe77fffa08fff3007fff7ffff0003fffcdfff1003fffc2cfb2007fffc0000000afff80000002ffff2000000cfff60000008fff80000006fffb0000006fff90000007fff70000006fff93333339fffffffffffffffffffffff"],[3,0.683,"005beffd92000cffc69fff60afff100cfff2effe0009fff79fff1009fff70684000dfff3000005dfff800003ffffd300000169ffff800000002efff700000006fffc7ff70003fffefff70005fffcfffc000afff76fffd9cfffa0029dfffd9300"],[4,0.778,"000006fc500000000eff500000008ffc00000001fff400000008ffa02600000eff10af00008ff70bff0001ffd00eff000aff300fff002ffa000fff00cfffffffffb7accccccfffcc0000000ffc000000000ffc000000000ffc000000000ffc00"],[5,0.691,"05ffffffff900affffffffa00cff866666300dff200000000fff000000000fff000000003fffcffea4001effa9dfff900160000afff500000001fffc00000000fffe3de90000fffddffb0001fffadffd0007fff33fffb68fff80028cfffd9300"],[6,0.707,"00000004aa00000007eff8000001cffb1000001eff70000000eff800000009ffd00000001fff600000009fffbdffd810dfffd76cffe1fffd0000dffafffc00008fffefff00006fff9fff10007fff1fff8000dff806fff86bffc0003adffeb500"],[7,0.691,"fffffffffffceffffffffffcbfe000007ff27fa00002ffa03950000cff200000007ff700000004ffe00000000eff700000008fff00000001fff90000000bfff30000001fffd00000006fff800000009fff700000007fffb00000001aefb20000"],[8,0.732,"0029effea30006fffeefff601fff7008fff26fff0000fff66fff0000fff64fff9004fff10cfffd6eff6000affffff60005ffecffff802fff302afff8affc0000affeeff900005fffdffb00006fff8fff2000cffa1effe76cffe1006beffec700"],[9,0.707,"0039effea20006ffeabfff604fff2007fff2effb0000fff9fff90000cffdfffa0000afffaffe00009fff1dffc55afffd00affffcfffa00003303fff500000008ffd00000003fff40000003fff60000006fff6000003cffb20000009c62000000"],[0,0.7,"0006bffd700000cffffffd1007ffe64affc00eff3000dff55ffb00007ffaaff700003ffebff400001fffcff300000fffcff300000fffbff400001fffaff700003ffe5ffb00007ffa0eff3000dff507ffe64affd000cffffffd100006cffd7000"],[1,0.615,"000009ffb0000002dfffb000007fffffb0000bffffffb000bfff7bffb0000bb20bffb00000000bffb00000000bffb00000000bffb00000000bffb00000000bffb00000000bffb00000000bffb00001333cffc33307ffffffffff07ffffffffff"],[2,0.671,"0005bffe910000bfffffff400bffe87cfff24fff1000dff87df600007ff9000000009ff900000001fff500000009ffd00000007ffe20000008fff30000009ffe2000000bfff2000000cffd2000002dfff7999995cfffffffffffffffffffffff"],[3,0.65,"0006bfffb60000cfffffffb00bffd637fff83fff10007ffc4bc600006ffc000000008ff900000349ffd100000ffffb0000000cdfffd100000001affc000000003fff4aa000003fffdff900007ffe4fffb548fff806ffffffffb0003adffea300"],[4,0.744,"0000000cff300000008fff30000005ffff3000001fffff300000cff5ff300008ff43ff30004ff803ff3001efc003ff300aff2003ff305ff80003ff30ffffffffffffbfffffffffff03333336ff5200000003ff3000000003ff3000000003ff30"],[5,0.646,"008ffffffff600bffffffff600fffcccccb103ff8000000006ff5000000008ff533300000bfffffff9000fffffffffd100450017fff8000000009ffd000000005fff000000007ffd04300000eff97ffb636cfff2affffffffd20027cfffb6000"],[6,0.651,"0000009dff30000009fff70000006fff90000003fffa0000000dffd0000000bffd10000008fffeffc7001fffffffffb09fff933afff8effa0000bffefff400003ffffff400003fffaff80000bffb3fff833afff506ffffffff70003adffd9300"],[7,0.679,"ffffffffffffffffffffffffbcccccccdffb00000000cff400000007ffc00000000eff300000007ffa00000001fff300000009ffb00000002fff30000000affc00000003fff30000000cffb00000005fff30000000dff800000006ffc0000000"],[8,0.639,"0019efffb30003ffffffff400effc33afff26fff1000dff77fff0000bff93fff2000eff509ffe76cffb0008ffffffa0007ffffefffa08fff4002eff8fff900006ffefff700003ffffffb00008ffe8fff7216fff80bffffffffd1005beffeb500"],[9,0.646,"0007cffd810002dfffffff702fffd87cfff5bffc00009ffcfff600001ffffff600001ffffffa00009fff8fffb76bfffb0bfffffffff60039cc9cffc00000007fff20000007fff30000006fff60000005fff90000003fffd0000002fffc200000"],[0,0.725,"0007cfeea20000cf7002ef300afc00005fe12ff800002ff77ff600000ffcbff600000fffbff600000ffffff600000ffffff600000fffcff600000fffbff600000fff7ff600000ffc2ff800002ff80bfc00006ff101ef7003ef500008deeea200"],[1,0.62,"000000ae00003347bfff0000fecabfff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000000007fff000013339fff33337fffffffffff"],[2,0.696,"003adffb70000af966afff608fd30004fff5fffc0000affceffb00009fff187100009ffe00000000eff800000007ffe00000003ffb10000001ef800000002ed300060003fa00004e004e6000009c05fffffffff94ffffffffff7fffffffffff5"],[3,0.713,"003aeffda30005f6001cff700efe0004fff10fff3003fff30afc0006fff00000000cff70000013aff7000004ccef82000000000aff8000000001fff705500000cffecffa0000bffffffc0000effebff50002fff71cd5203cff90007cfffda300"],[4,0.772,"00000000bb0000000006fc000000003ffc00000001effc0000000c7cfc0000009a0cfc000006c00cfc00003e100cfc0001e4000cfc000c70000cfc008a00000cfc00ffffffffffff3333335ffd330000003ffc000000235ffd330000cfffffff"],[5,0.688,"08b853337bc009ffffffff4009ffffffc20009ebcc83000009b00000000009b00000000009d8ecdfb40009f70004ff9003200000cff7000000009ffc4cb100009ffffff800009ffffff70000affb8f500000eff30ad5103dff60005bfffb7100"],[6,0.713,"00006beffa10003efa100ce002ff8000aff30cfe0000bff34ffa00000860aff701320000fff7ac9ef800fffe6000cfc0fffc00007ff7fff900003ffedff600003fff9ff600003fff3ff900005ffb0bfc00009ff501dfb105ff800007cffea300"],[7,0.72,"1f86333333333fffffffffff7ffffffffff4afccccccef60b9000001e800f500000ca000300000ad0000000006f3000000001fc0000000009f8000000000ff6000000005ff5000000008ff300000000bff300000000cff3000000006fc000000"],[8,0.713,"0018cffeb50001e71002bf800bc000000cf10fe1000009f30ffe60000bf10dfffe507f8005fffffef600005ffffffc1002de8effffe12ff1008ffffabf7000019fffff30000007ffff40000000fd9fa0000005f70cfa30037f90005beffea300"],[9,0.713,"0029dffd810006ff5007ff303ffa0000bfe0bff700007ff6fff600003ffafff600003ffddff600007fff7ff80000dfff0afd0007dfff008eeaab4ffe000033206ffb059100008ff71ffc0000dfe11ffa0006ff500be4017ff600008effd81000"],[0,0.625,"0007cefd920002ff9007ff400eff0000dff16ffb0000bff8bffb00007ffcfffb00007ffefffb00007ffffffb00007ffffffb00007ffffffb00007ffffffb00007ffebffb00007ffc7ffd0000bff80eff1000dff203ffb008ff500017cefd9200"],[1,0.557,"000001bf10003357bfff3000eecaefff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30000000bfff30001333cfff63325fffffffffff"],[2,0.608,"003aeffb50000af966bffd408fe7000cfff3ffff3005fffbdfff2003ffff28930003fffd00000008fff70000000fffb0000000aff900000007ff400000007fb200360007f700009c007f400001ea07fffffffff77ffffffffff3fffffffffff2"],[3,0.625,"0029effc930004fa104fff700fff700bfff23ffff00bfff40bff700cfff10010001fff70000013bfe6000002ccff81000000002fff9000000008fff705630007fffdbfff4007ffffffff7007fffcbffd2009fff71df7205fff70006beffc8300"],[4,0.684,"00000000bb0000000006fc000000003ffc00000001effc0000000b9ffc0000008c0ffc000005f10ffc00002e300ffc0000d7000ffc000aa0000ffc006d00000ffc00ffffffffffff3333339ffd330000007ffc000000339ffd320000ffffffff"],[5,0.6,"0bb743347bb00bffffffff200bffffffb2000beccb7300000bb0000000000bb0000000000bd9dceeb3000bf5000cff7003200006fff400000003fffb2ab40003ffffefff0003fffffffc0005fffa8f700009fff30cd5017ffe40006bffeb6000"],[6,0.625,"00004bfffa20002cfc103fe002ffe002fff50cff7003fff55fff30004960afff31330000dfff7caff900ffffc003ffd1ffff5000fff8ffff3000fffdcfff0000bfff9fff0000dfff3fff3000fffb0bff5000fff500dfe218ff800006bffea300"],[7,0.622,"1fb5333333333fffffffffff7ffffffffff59fdcccccff80bb000003fa00f700000eb000300000cd0000000009f5000000004ff000000000efd000000004ffb000000008ff800000000cff700000000eff700000000fff7000000009fd200000"],[8,0.625,"0007cffda30002db3003df700bf100001ff11ff400000ef43fff80000ff20ffffe60af9006fffffff600004ffffffc2002afbffffff22ff702affffabfd00003bffeff9000000bffffb0000007fc8ff100000af70bfd51039fb0004adffda300"],[9,0.625,"0018dffd910004ffb009ff304fff3000ffe1bfff1000fff6ffff0000effaffff0000fffccfff0000ffff6fff2001ffff0bff6008ffff007efabbfffd00002320fffb03860000fff72fff6003fff13fff500aff600bf8019ff600007dffc71000"],[0,0.765,"000007edee800001ec200af7001ef20003fd00bfb00003ff03ff600005ff0aff100008ff0ffd00000cfd4ff800000ffb8ff500004ff7cff100008ff3efd00000dfe0ffa00001ff80ff800007ff10ef70000ef5007fc000cf600006cebc930000"],[1,0.595,"00000000005f0000000007fc00000017eff70004cefefff200026309ffd00000000eff800000003fff300000008ffe00000000dff900000002fff400000007fff00000000cffa00000001fff500000006fff00001333bffc3320dffffffffff3"],[2,0.778,"000007ecec500001da100cf6000c953006fd006d049007ff00e605800aff01f30c200efc00e8c6005ff600262003ff900000003ef700000018fc20000004fd500000006f7000005605f5000001e71ee997667ef28e36efffff60e60017dfc400"],[3,0.765,"000007ddde900001da1006fa000da60003ff005f093004ff006d0c1008fd000ac4000ef700000000afc000001ccfe7000000066ef60000000005ff1001000006ff508fc00008ff30ffc0000eff00fb10003ff7009c0002ef800007cccc930000"],[4,0.578,"0000000006f9000000000ff9000000005ff300000000cfa000000004ff200000000df7000000007fa000000004fb000000003fa0af600004fa01ff70008e5006ff106dfffc9dfc025400028fffeb0000005ff200000000bfd000000000cf5000"],[5,0.753,"0000e953358d0003fffffff50007fffffc20000cd9973000000f70000000004f30320000008fbdaee50000ce3004ff3000510003ff9000000005ffc008700008ffa0aff3000eff60efe1001ffe10ec10009ff5008e2007ff600007edec820000"],[6,0.72,"0000005adfc300002cf810ce0003ff3009ff001ff7000cfc00bfe000036103ff803300000bff8caee5001fffb100ef507fff1000ffc0bff80001ffc0fff30005ffb0fff00009ff70ffc0000eff10bfb0003ff6003fe102ef800004cedda30000"],[7,0.84,"00c8aee1005d04fffff704f40bffa8aecfa02fa100019f20ab000001f90062000009f1000000003fa000000000cf4000000004fe000000000cf9000000003ff4000000008ff000000000efa000000003ff6000000007ff1000000005f9000000"],[8,0.744,"000003adfc8000007e5104fa0005f300009f000ef00000af003ff60001fb003fffa00cf3001ffffecd300006fffff900004dddffff8006fc008fffe03fe00004fff0bf6000007fe0ff3000008f80ef300000ee008fa0003ce10006ceddc71000"],[9,0.732,"000017cfea300003ef701ef2003ff70009f900dff0000afc05ffb0000dfd09ff70001ffc0cff30006ffa0bff0000dff705ff0009fff3009fa6b8ffe000036626ff700100000cfe008fc0003ff500ffc000cf9000ee102cf800004ceed9200000"],[0,0.896,"0005cffc600000affbaffc1007ff5001ef900efa00006ff15ff500002ff6aff100000ffacff000000afbfff000000afefff000000affcff000000afbaff100000ffa5ff500002ff60efa00006ff106ff5001ef9000affbaffc100005cffc7000"],[1,0.604,"dfffffffffff257dfffff8550000cffff0000000affff0000000affff0000000affff0000000affff0000000affff0000000affff0000000affff0000000affff0000000affff0000000affff0000000effff000255dfffff853dfffffffffff"],[2,0.694,"0003aafc810000afffffff500affeadffff15ffa0003eff8dff000008ffaffa000005ff8afe000005ff32ff800008fa005fff101fe100015302ee100000005fe100000005fd100000005fe555553005fffffffff05ffffffffff0fffffffffff"],[3,0.533,"0003aeffa300006fa66aff9001f400005ff305f100000ff300fc30005fc000130003e9100000007b300000008bcdb710000020007fe2000000000df9000000000afe000000000aff000000000ffa350000007ff3efe73027fc3018dffec83000"],[4,0.662,"0000002ff000000000cff000000008fff00000003faff0000001e37ff000000b807ff000006c007ff00003e1007ff0000d40007ff0009b33339ff331fffffffffffd3333339ff3310000007ff0000000007ff000000000bff4000000beffffc1"],[5,0.514,"000eb8777bb7000ffffffffc000fdbbbbb71000fa0000000000fa0000000000fa0000000000fcbcc8300000fc437efa0000210006ff6000000000ffc000000000fff000000000fff000000006ffa13000001eff3efe7204cfe403aefffea6100"],[6,0.581,"00003aefea300007f835bff200af700005a004fd000000000df6000000003ff3023100009ff7eddfe700cffd3002cfb0fff400001ff4fff000000cfafff000000afdcff000000afd7ff200000efa0ef600004ff306ff6004efa00029dffeb500"],[7,0.493,"5ffffffffffd9ffffffffff7efd777777df1b90000001eb0000000007f5000000001ef0000000007fa000000000df4000000007fd000000000ef7000000007ff200000000efd000000006ff700000000dff100000005ffb000000006ed300000"],[8,0.568,"0019fffea20004efa436cf500efb00000df14ff7000008f34ff800000af30dfe30001eb003eff945ea10001affffa0000006ecfffe3004eb102bfff32fb000007ffccf2000000bffff00000007ffbf2000000bfc2fe73334afe3018bfffeb600"],[9,0.573,"0005beeb710002cfa438fe401ff800007ff19ff100000ff6eff000000cfbfff000000afcdff000000eff7ff300001fff0afd3001bffc007efbbfbffb000036630ff8000000005ff300000000bfd005500006ff400ffc538ff600029cdcb71000"],[8,0.769,"00000ff7000003bfffffff7007ff7000fff00fff00000ff70fffb30000f70ffffff00ff70ffffffffff307fffffffff307fffffffff70bf77bfffffbff700007ffffff700000bfffffb000007ff70fff0000fff703ffb77fffb00037bfff7000"],[7,0.846,"0007ff0000007ffffffb30bbfffffffffff7fffffffffff7ff303ffffff3070000fffff0000000007fb000000003ff300000000fff00000003fff70000000ffff0000000bfffb0000003ffff70000007ffff70000007ffff70000007ffff3000"],[6,0.769,"00007ffff000003fff7fff3000fff707fff007fff00ffff00fffb00ffff00fff7007fff07fff70003700ffffffffff30fffffffffff0fffff30bfff7ffff7007ffff7fff7000ffff0fff7003fff707ff7007fff703fff00bfff0003ffffff700"],[0,0.636,"0004bfff5000008f8558fa0005fa00007fc00ff000002ff54ff000000ff88fc000000cfa8fa0000008faffa0000008ffffa0000008ffafa0000008fc8fa000000afa5ff000000ff80ff000000ff50af500005ff200cf5002df200028cdff8000"],[1,0.524,"000008ff00000028cfff000008ffbfff0000a5208fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff0000aaaacfffaaaa"],[2,0.595,"48bfffff84008fa55558cfc28f0000004ff8580000000afc0000000008ff000000000bfa000000000ff8000000008ff200000004ff400000002fc200000004fb000000008f800000008f800000000bf400000000cfcaaaaaaaaaffffffffffff"],[3,0.591,"48bffffb80008fa5555aff808f0000008ff3250000000ff7000000000ff8000000005ff500000002cfa00005aaff82000000888bff40000000002cf80000000005ff0000000000ff8000000004fff500000008fdfc2000028ff58acffffca820"],[4,0.714,"00000000fa0000000008fa000000004ffa00000002fafa0000000c85fa000000ba05fa000005f205fa00002c2005fa0000f80005fa0008c00005fa004f000005fa00cdaaaaadffaaaaaaaaacfdaa00000005fa0000000005fa0000000005fa00"],[5,0.581,"8ffffffffff08ffffffffff08f00000000008f00000000008f00000000008f00000000008f00000000008fcfffffaa20000000028ff50000000008fc0000000002ff0000000000ff8000000004fff200000008fdfa2000028ff3aafffffca800"],[6,0.614,"00008bffff82002dc8555af502fd200000f50cf7000000008ff200000000aff000000000fff002555000fffccaacff80fff000004ff8fff000000afcfff0000008ffaff0000008ff4ff5000008ff0cf700000afa00cf50008ff20007cfcfa820"],[7,0.619,"fffffffffffffffffffffffdf800000000f8f50000000af2000000005f5000000000fb0000000008f5000000002fa000000000bf0000000003f5000000000ab0000000002f2000000000c80000000008f5000000002fc000000000cf20000000"],[8,0.636,"0008bfff800002df8555df800cf800005ff30ff000002ff50ff000000ff50cf800005ff302df5002cf80003ffffff50004fb4000cfb02ff200002ff78fa0000008facfa0000008fc8fa0000008fa8fd000000cf80af800008ff2005afdffc800"],[9,0.614,"0005fffc800002cd8557ff502ff700005ff3cff000000afafff0000008fcfff0000008ffaff2000002ff2ffa000002ff04ffb888ffff0007aaa725ff0000000008ff000000000afa000000000ff80a000000aff20f80000afc200afffffa5000"],[0,0.636,"0004bfff5000008ffa8ffa0005fff008ffc00fff8000fff54fff8000fff88fff8000fffa8fff8000fffaffff8000ffffffff8000ffffafff8000fffc8fff8000fffa5fff8000fff80fff8000fff50affc005fff200cff52cff200028cfff8000"],[1,0.571,"00000bff0000002affff00000bffffff0000fa8affff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff00000008ffff2000fffffffffffc"],[2,0.605,"48bffffb80008ffa57cfff808f80000cfff88f000008fffa25000008fffa00000008fffa00000008fff80000002fffc2000002cffc20000008ffb00000008fc80000002cfa00000004ff800000008ff855555555ffffffffffffffffffffffff"],[3,0.636,"08affffb50000fda57fffc200f70002ffff20f50000afff500000008fff50000000cfff2000002afff500008ffffa000000488ffff4000000008fff500000000fffc00000000afffff000000ffff8f000002fff88f82028fffc25adffffca500"],[4,0.714,"0000000aff800000005fff80000000ffff80000008ffff8000005f5fff800002fa0fff80000af20fff80008f200fff8002f8000fff800cc2000fff808f80000fff80ffffffffffffffffffffffff0000000fff800000000fff800000000fff80"],[5,0.628,"0ffffffffff00ffffffffff00fcaaaaaaaa00f80000000000f80000000000f80000000000f85888500000ffcacfffa200000000cfff300000005fffa00000005fffc00000005fffff8000005fffafa000007fff8ff52005dffc0aafffffc8200"],[6,0.636,"00004cfffb80002cff858ff500dff70008f50afff00002f54fff800000008fff80000000cfffa8aa8500ffffcaafffc2ffff0004fffaffff0000dffdafff8000afff8fff8000afff0fff8000afff0afff000dffa00aff808fff20005afffc800"],[7,0.619,"fffffffffffffffffffffffffffffffffffafa0000000af5a20000005fc000000000ff400000000afc000000005ff200000000ffb000000007ff200000000ffb00000000aff200000005ff800000000fff00000000affa00000005fff3000000"],[8,0.636,"0008bfff800002dff78cff800fffa002fff58fff8000fffa8fff8000fffa2fff8000fff708fff20affc2005ffffff80004fff54bffb02fff5000fff7afff0000affcffff0000afffffff0000afff8fff2000cffa0cffc208fff3007affffc820"],[9,0.636,"0028ffff500002dff78ffc205fff8008ffc0cfff0000fff5ffff0000fffaffff0000fffaffff0000fffd5fffa000ffff0bfffa88ffff007cfffafffd00000000fffa00000000fff88f000008fff28f50000cffa08fa202cff8002adfffca3000"],[0,0.622,"00048fff5000005f8205d80005fa00007fc00ff000000ff78fc000000afaffa0000008ffffa0000008ffffa0000008ffffa0000008ffffa0000008ffffa0000008ffafa0000008fc2ff000000ff80af500003ff200af2000cc200008acac8000"],[1,0.409,"0000008b00000058afff00005555afff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000000fff000000005fff0000055afffff855"],[2,0.636,"0008bffb200000affffff8000ca2005cff508a000000cff0f0000000aff0000000005ff000000000af5000000000da0000000008c0000000002f5000000003c200000000280000000004b0000000005c0000000708faaaaaaac88ffffffffff2"],[3,0.568,"0008bfff800002ccaacfff502c200002cff0800000008ff0000000008ff000000000ac200000005cc2000002acffff800000008bfff8000000002cfa0000000005ff0000000000fc0000000000fa000000000af38a850005cc208cffffa82000"],[4,0.674,"00000000fa0000000008fa000000008dfa00000004b5fa0000002c25fa000000c005fa00000b5005fa00005a0005fa0002a00005fa000f200005fa00ca555558fc55ffffffffffff00000005fa0000000005fa0000000005fa0000000005fa00"],[5,0.591,"00004888888a0002fffffff7000aa5555550005c0000000000ff850000000afffffa500005558cffff8000000028fff3000000004ffa000000000afa0000000000fa0000000000fa0000000008f5000000000cc2cfc85005ca208affffa82000"],[6,0.636,"0000000058b5000003ac70000002cf800000005ff500000000ffb00000000aff000000005ffa8cffc800aff82005dff2ffc000002ffaffa000000cfdffa0000008ff8fd0000008ff4ff0000008fa0af500000af700af80005fa00008adaaa200"],[7,0.651,"04ffffffffff0afffffffffa2c30000005f5b40000000bf0000000002fa0000000007f2000000000ab0000000000f50000000008d0000000000fa0000000005f7000000000cf2000000002fb0000000007f5000000000cc0000000002f500000"],[8,0.545,"0008ffff800008f82002cf80af8000000cf5ff80000008f8ffb000000ff8affc20008f8008fff85ca200002cfffc2000000bbffff80008c8028fffc08fa000028ffaff5000000affff40000004ffff80000005ff2ff800002cf2008afaaca800"],[9,0.614,"0005bffc4000008d2007fc200cf500005ff28ff000000cf8fff0000008fffff0000008fffff2000008ff8ff7000008ff0fff40004fff02affaaa8cfc000255502ff700000002cfc000000008ff000000008fc20000005cc50000058852000000"],[0,0.653,"0005cffd800000afa203df5007fc00005fd00df200000cf75ff0000008fa8fa0000005ffcfa0000000ffffa0000000ffffa0000000ffffa0000000ff8fa0000002ff8fd0000008fc0ff000000af808fa00002ff202df5000cf800018ccbca400"],[1,0.5,"00028fff000005afffff0000cfa28fff000080008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff000000008fff00008fffffffffff"],[2,0.625,"05acfffda3008ff70007cfa08f2000002ff8570000000afd000000000aff000000000afa000000000ff300000000af8000000008fa000000008f800000000af500000002cd200000002df500000a05fd2000000f8ffcaaaaaaafffffffffffff"],[3,0.633,"038afffca2008ff70025df808f5000007ff25a0000000ff5000000002ff5000000007fd000000038fc200000ffff800000000025df80000000002ff70000000008fc0000000008ffa500000008fffc0000000cfaff820000aff269bebbbdb820"],[4,0.75,"0000008ff000000002fff00000000cfff00000007f7ff0000002d75ff000000ad05ff000003f305ff00000d8005ff00008d2005ff0003f70005ff000cc00005ff000ffffffffffff0000005ff0000000005ff0000000005ff0000000affffff5"],[5,0.646,"0fffffffffa00fcaaaaaaa700f80000000000f80000000000f80000000000f80555200000fcfcacfd8200fc20000afd0000000002ff70000000008fc0000000008ff0000000008fffa0000000afaff2000003ff3fff70025dfa005acfffc8200"],[6,0.673,"00028cfffc80005dc3005df002da000005f008f3000000500fd0000000008fa0000000008fa3adffa700ffdf8203cfa0fff700000df3fff2000007faaff0000005fd8ff0000005ff0ff0000005fa08f500000cf702dd20008fc00019dcbcb600"],[7,0.66,"fffffffffffffffffffffffffa00000000f8fa0000000af2000000003fc0000000008f5000000000fc000000000af2000000002fc0000000008f5000000000fc0000000007f2000000000cc0000000005f5000000000fd0000000007f7000000"],[8,0.653,"0028cfffa50002df7003dfa00cfa00002ff30ff000000ffa0ff000000cfa0df500000ff705ff2000afd0003afaadc500028fc557dc500df800002cf78fc0000005fdffa0000000ffcfa0000000ff8fd0000008fd0cfc20005ff5006bebbcb940"],[9,0.653,"002adffd820005ff7003df502df200003ff2afa000000cf7ffa0000008fcffa0000008ffcfa000000aff5fd000002fff0afc2000afff008ffaadc2ff0000355200fd0000000008fa000000000cf50f7000003fc00fd20002dc2009bfcbdb6000"],[0,0.796,"0008dffc700000afd75efd2008ff7006ffc02fff2004fff48fff0002fff8afff0000fffbffff0000fffbffff0000fffcffff0000fffeffff0000fffbcfff0000fffbafff0001fff95fff0004fff50cff5005ffd102dfc20bff500019effd9200"],[1,0.625,"0007cfff800007cfffff8000cfa5ffff8000a300ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80000000ffff80002555ffffa5558fffffffffff"],[2,0.729,"28affffc83008ff857dfff808f70002dfff58f000008fffa25000005ffff00000005fffc00000008fff70000000dffd00000007ffd20000005ffa00000008fd50000002cfa20007a05df500000afcffcaaaaaadfffffffffffffffffffffffff"],[3,0.735,"38adfffda300aff857dfff70af30002ffff3ad00000afff50000000afff50000000dfff3000002afff700005ffffd300000257dfff800000000cfff800000005ffff00000000fffff7000002fffffc000007fffdffa2027ffff359befffeb810"],[4,0.812,"000003fffa0000000dfffa0000008ffffa000001f8fffa000009d2fffa00002e70fffa0000ac00fffa0003f500fffa000dd000fffa008f3000fffa00fdaaaafffdaaaaaaaafffdaa000000fffa00000000fffa00000155fffc540004fffffffb"],[5,0.729,"0fffffffffa00fffffffffa00fcaaaaaaa700f50000000000f50000000000f78dffc82000ff857dffd500a50002dfff20000000afff800000005fffc00000005ffff53000005fffcfc00000afff8ff20002ffff2ffd757dfff5005acfffc8200"],[6,0.755,"00028dfffca2005ffd757df805ffd00002f80dff500000327fff20000000afff00553000dfff8ffffd50ffffd20afff4ffff8000fffaffff5000dffedfff5000afffafff5000afff7fff5000dffe0dff8000fffa05ffd20afff20029cfffc920"],[7,0.723,"fffffffffffffffffffffffffffffffffffffc55555558fcfa0000000cf5530000003fd000000000cf7000000003fd000000000cf7000000005fd000000002ff7000000008fd000000002ff7000000008fc000000002ff2000000008f8000000"],[8,0.776,"0028dfffa70005fff85dffd02fffc005fff65fffa005fff95fffa005fff92fffa005fff605fff20affd1002dfffff70005dff65cffa13fff8002fff8afff5000dffeffff5000afffdfff5000cfff8fff7000fffc2dffd108fff4016befffc940"],[9,0.755,"003adffda30005fff75cff503fffa002fff28fff5000dff9afff5000affcdfff5000afffafff5000afff8fff7000ffff2fffc003ffff05dffcafcfff0027aa835fff00000000affb00000000cff80f700002fff10ff7003dff5009befffb9200"]];
function templates(){
  if(TPL)return TPL;
  TPL=TPL_DATA.map(([d,ar,h])=>{const g=new Float32Array(h.length);for(let i=0;i<h.length;i++)g[i]=parseInt(h[i],16)/15;return {d,g:{g,ar}}});
  return TPL;
}
function bbox(m,W,xa,ya,xb,yb){let x0=1e9,y0=1e9,x1=-1,y1=-1;for(let y=ya;y<yb;y++)for(let x=xa;x<xb;x++)if(m[y*W+x]){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}return x1<0?null:{x0,y0,x1,y1}}
const GW=12,GH=16;
function grid(m,W,b){const g=new Float32Array(GW*GH),w=b.x1-b.x0+1,h=b.y1-b.y0+1;
  for(let gy=0;gy<GH;gy++)for(let gx=0;gx<GW;gx++){let k=0,c=0;
    const ya=b.y0+Math.floor(gy*h/GH),yb=b.y0+Math.max(Math.floor(gy*h/GH)+1,Math.floor((gy+1)*h/GH)),xa=b.x0+Math.floor(gx*w/GW),xb=b.x0+Math.max(Math.floor(gx*w/GW)+1,Math.floor((gx+1)*w/GW));
    for(let y=ya;y<yb;y++)for(let x=xa;x<xb;x++){c++;k+=m[y*W+x]}g[gy*GW+gx]=c?k/c:0}
  return {g,ar:w/h}}
function classify(m,W,b){const r=classifyS(m,W,b);if(r[1]<=0.45)return -1;
  // a heavy 3 with round ends fills its box almost like an 8: but its waist is open on the left
  if(r[0]===8&&!global.__no38){const w=b.x1-b.x0+1,h=b.y1-b.y0+1;let open=0;
    for(let y=b.y0+Math.round(h*0.38);y<=b.y0+Math.round(h*0.62);y++){let x=b.x0;while(x<=b.x1&&!m[y*W+x])x++;if(x-b.x0>w*0.22)open++}
    if(open>=Math.max(2,h*0.12))return 3}
  return r[0]}
function classifyS(m,W,b){
  const q=grid(m,W,b);let best=-1,bd=-1;
  const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;const mq=mean(q.g);
  for(const t of templates()){const mt=mean(t.g.g);let s=0,na=0,nb=0;for(let i=0;i<q.g.length;i++){const u=q.g[i]-mq,v=t.g.g[i]-mt;s+=u*v;na+=u*u;nb+=v*v}
    let sc=s/Math.sqrt(na*nb||1);sc-=Math.abs(Math.log((q.ar||1)/(t.g.ar||1)))*0.25;if(sc>best){best=sc;bd=t.d}}
  return [bd,best];
}
/* the number of an ending bracket ("1." "2." "1.2."), written just under its left end: small digits 1-4 told apart by
   their shape (any typeface), the first line of text only (a bar number may sit right under it or beside it) */
function readVolta(m,W,H,x0,y,sp){
  const all=components(m,W,H,x0-sp*0.2,y+3,x0+sp*3.6,y+sp*2.6);
  const comps=all.filter(c=>{const h=c.y1-c.y0+1,w=c.x1-c.x0+1;return h>=sp*0.55&&h<=sp*2.2&&w<=h*1.3&&c.y0<=y+sp*1.1&&!(c.x0<x0+sp*0.4&&c.y0<=y+5)});// (not the bracket's own hook)
  if(global.__vnum)global.__vnum.push({x0,y,sp,all:all.map(c=>[c.x0,c.y0,c.x1,c.y1]),comps:comps.length});
  if(!comps.length)return null;
  comps.sort((a,b)=>a.x0-b.x0);const ref=comps.reduce((a,b)=>a.y0<b.y0?a:b);
  const line=comps.filter(c=>Math.abs(c.y1-ref.y1)<sp*0.45&&Math.abs((c.y1-c.y0)-(ref.y1-ref.y0))<sp*0.5);
  const out=[];let last=null;
  // digits run on with a dot between them ("1.2."); a wider gap is something else (a bar number)
  const dotBetween=(a,b)=>all.some(d=>d.x0>a.x1-1&&d.x1<b.x0+1&&(d.y1-d.y0)<sp*0.45&&(d.x1-d.x0)<sp*0.45&&d.y1>a.y1-sp*0.4);
  for(const c of line){if(last&&c.x0-last.x1>(dotBetween(last,c)?sp*1.6:sp*0.6))break;const d=digitShape(m,W,c);if(d<0)break;out.push(d);last=c;if(out.length>=3)break}
  return out.length?out:null}
function digitShape(m,W,c){
  const w=c.x1-c.x0+1,h=c.y1-c.y0+1,at=(fx,fy)=>m[Math.min(c.y1,c.y0+Math.round(fy*(h-1)))*W+Math.min(c.x1,c.x0+Math.round(fx*(w-1)))];
  const rowW=fy=>{const y=Math.min(c.y1,c.y0+Math.round(fy*(h-1)));let k=0;for(let x=c.x0;x<=c.x1;x++)k+=m[y*W+x];return k/w};
  const band=(fa,fb,xa,xb)=>{let k=0,n=0;for(let y=c.y0+Math.round(fa*(h-1));y<=c.y0+Math.round(fb*(h-1));y++)for(let x=c.x0+Math.round(xa*(w-1));x<=c.x0+Math.round(xb*(w-1));x++){n++;k+=m[y*W+x]}return n?k/n:0};
  const ar=w/h;
  if(global.__dig){let o='';for(let y=c.y0;y<=c.y1;y++){for(let x=c.x0;x<=c.x1;x++)o+=m[y*W+x]?'#':'.';o+='\n'}global.__dig.push(o)}
  // 1: a single upright stroke (maybe with a foot serif and a flag at the top): the ink stays in one narrow column
  {const cs=[];let wsum=0,n=0;for(let fy=0.22;fy<=0.78;fy+=0.04){const yy=c.y0+Math.round(fy*(h-1));let k=0,sx=0;for(let x=c.x0;x<=c.x1;x++)if(m[yy*W+x]){k++;sx+=x}if(k){cs.push(sx/k);wsum+=k;n++}}
   const rng=cs.length?Math.max(...cs)-Math.min(...cs):1e9;let two=0;for(let fy=0.2;fy<=0.8;fy+=0.05){const yy=c.y0+Math.round(fy*(h-1));let runs=0,prev=0;for(let x=c.x0;x<=c.x1;x++){const v=m[yy*W+x];if(v&&!prev)runs++;prev=v}if(runs>1)two++}
   if(ar<0.3||(ar<0.45&&two<=1)||(ar<0.8&&rng<=Math.max(2.5,w*0.18)&&wsum/Math.max(1,n)<Math.max(w*0.62,h*0.34)&&two<=1))return 1}
  if(ar>1.15)return -1;
  const bot=Math.max(rowW(0.94),rowW(0.97),rowW(1));
  // 4: a full-width crossbar low down, open at the top right of its corner
  {let cross=0;for(let fy=0.55;fy<=0.85;fy+=0.03)cross=Math.max(cross,rowW(fy));if(cross>0.8&&bot<0.6&&band(0,0.2,0,0.25)<0.25)return 4}
  // 2 and 3 differ in their lower half: the 2's stroke runs down to the lower left, the 3's lower bowl stays on the right
  const lefts=[];for(let fy=0.64;fy<=0.785;fy+=0.035){const yy=c.y0+Math.round(fy*(h-1));for(let x=c.x0;x<=c.x1;x++)if(m[yy*W+x]){lefts.push((x-c.x0)/Math.max(1,w-1));break}}
  lefts.sort((a,b)=>a-b);const lowerLeft=lefts.length?lefts[lefts.length>>1]:1;
  if(bot>0.7&&lowerLeft<=0.5)return 2;
  if(lowerLeft>=0.55&&band(0.3,0.42,0,0.22)<0.2&&band(0.4,0.6,0.3,0.8)>0.15)return 3;
  return -1}
function readNumber(m,W,H,xa,xb,ya,yb,g){
  ya=Math.max(0,Math.round(ya));yb=Math.min(H,Math.round(yb));if(yb<=ya)return -1;
  // connected components in the box above the rest
  const seen=new Uint8Array((xb-xa)*(yb-ya)),comps=[];
  for(let y=ya;y<yb;y++)for(let x=xa;x<xb;x++){const k=(y-ya)*(xb-xa)+(x-xa);if(seen[k]||!m[y*W+x])continue;
    const st=[[x,y]];seen[k]=1;let b={x0:x,y0:y,x1:x,y1:y},n=0;
    while(st.length){const [cx,cy]=st.pop();n++;if(cx<b.x0)b.x0=cx;if(cx>b.x1)b.x1=cx;if(cy<b.y0)b.y0=cy;if(cy>b.y1)b.y1=cy;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=cx+dx,ny=cy+dy;if(nx<xa||nx>=xb||ny<ya||ny>=yb)continue;const kk=(ny-ya)*(xb-xa)+(nx-xa);if(!seen[kk]&&m[ny*W+nx]){seen[kk]=1;st.push([nx,ny])}}}
    const h=b.y1-b.y0+1,w=b.x1-b.x0+1;
    if(h>=g*0.9&&h<=g*3.2&&w<=h*1.2&&n>h*1.2)comps.push(b)}
  if(!comps.length)return -1;
  // keep the tallest group that sits on one baseline, nearest the centre
  const cx=(xa+xb)/2;comps.sort((a,b)=>Math.abs((a.x0+a.x1)/2-cx)-Math.abs((b.x0+b.x1)/2-cx));
  const read=ref=>{const grp=comps.filter(c=>Math.abs(c.y1-ref.y1)<g*0.5&&Math.abs((c.y1-c.y0)-(ref.y1-ref.y0))<g*0.6&&Math.abs((c.x0+c.x1)/2-(ref.x0+ref.x1)/2)<g*4).sort((a,b)=>a.x0-b.x0);
    let v=0;for(const c of grp){const d=classify(m,W,c);
      // (a thin upright stroke we cannot read beside the number is the bracket of a label, not a digit)
      if(d<0){if(c!==ref&&!global.__noLabelSkip&&(c.x1-c.x0+1)<=(c.y1-c.y0+1)*0.3)continue;return -1}v=v*10+d}
    return v};
  let v=read(comps[0]);
  // a section label stands beside the number ("[전주] 2") and can be nearer the middle: the number is the one written
  // lowest, right above the staff
  if(v<0&&!global.__noLabelSkip){const low=Math.max(...comps.map(c=>c.y1));
    for(const c of comps.filter(c=>c!==comps[0]&&c.y1>=low-g*0.3&&c.y1>comps[0].y1+g*0.2)){v=read(c);if(v>=0)break}}
  return v;
}


/* ---------- printed tempo mark ("♩ = 100") above the first staff ---------- */
function components(m,W,H,xa,ya,xb,yb){
  xa=Math.max(0,Math.round(xa));xb=Math.min(W,Math.round(xb));ya=Math.max(0,Math.round(ya));yb=Math.min(H,Math.round(yb));
  const w=xb-xa,h=yb-ya;if(w<=0||h<=0)return [];
  const seen=new Uint8Array(w*h),out=[];
  for(let y=ya;y<yb;y++)for(let x=xa;x<xb;x++){const k=(y-ya)*w+(x-xa);if(seen[k]||!m[y*W+x])continue;
    const st=[k];seen[k]=1;const b={x0:x,y0:y,x1:x,y1:y,n:0};
    while(st.length){const q=st.pop(),cx=xa+q%w,cy=ya+((q/w)|0);b.n++;
      if(cx<b.x0)b.x0=cx;if(cx>b.x1)b.x1=cx;if(cy<b.y0)b.y0=cy;if(cy>b.y1)b.y1=cy;
      if(b.n>40000)break;
      for(const d of [1,-1,w,-w]){const nq=q+d;if(nq<0||nq>=w*h)continue;if((d===1&&nq%w===0)||(d===-1&&q%w===0))continue;
        if(!seen[nq]&&m[ya*W+xa+((nq/w)|0)*W+nq%w]){seen[nq]=1;st.push(nq)}}}
    out.push(b)}
  return out;
}
function readTempo(c,staves,sp){
  if(!staves.length||!(sp>0))return null;
  const W=c.width,H=c.height,m=inkMask(c,160);
  const s0=staves[0];
  const cs0=components(m,W,H,0,Math.max(0,s0.top-sp*24),W,s0.top-sp*0.2);
  // two digits printed touching each other: split at the thinnest column
  const cs=[];
  for(const b of cs0){const h=b.y1-b.y0+1,w=b.x1-b.x0+1;
    if(h>=sp*0.7&&h<=sp*2.8&&w>h*1.05&&w<h*2.4){let bx=-1,bv=1e9;
      for(let x=b.x0+Math.round(w*0.3);x<=b.x0+Math.round(w*0.7);x++){let k=0;for(let y=b.y0;y<=b.y1;y++)k+=m[y*W+x];if(k<bv){bv=k;bx=x}}
      if(bv<=h*0.25){const shrink=(x0,x1)=>{let y0=1e9,y1=-1,n=0;for(let y=b.y0;y<=b.y1;y++)for(let x=x0;x<=x1;x++)if(m[y*W+x]){n++;if(y<y0)y0=y;if(y>y1)y1=y}return {x0,x1,y0,y1,n}};
        cs.push(shrink(b.x0,bx-1),shrink(bx+1,b.x1));continue}}
    cs.push(b)}
  const digitsLike=cs.filter(b=>{const h=b.y1-b.y0+1,w=b.x1-b.x0+1;return h>=sp*0.6&&h<=sp*2.8&&w<=h*1.1&&w>=h*0.12&&b.n>=h*1.0});
  const bars=cs.filter(b=>{const h=b.y1-b.y0+1,w=b.x1-b.x0+1;return w>=h*2.2&&h<=sp*0.45&&w>=sp*0.35&&w<=sp*2.2});
  // group digits on one baseline
  digitsLike.sort((a,b)=>a.x0-b.x0);
  const groups=[];
  for(const d of digitsLike){const h=d.y1-d.y0+1;
    const g=groups.find(g=>{const l=g[g.length-1],lh=l.y1-l.y0+1;return d.x0-l.x1<Math.max(lh,h)*0.7&&d.x0>l.x0&&Math.abs(d.y1-l.y1)<h*0.3&&Math.abs(h-lh)<h*0.3});
    if(g)g.push(d);else groups.push([d])}
  let best=null;const dbg=global.__tdbg=[];
  for(const g of groups){if(g.length<2||g.length>3)continue;dbg.push({x:g[0].x0,y:g[0].y0,h:g[0].y1-g[0].y0+1,n:g.length,digits:g.map(d=>classify(m,W,d))});
    const h=Math.max(...g.map(d=>d.y1-d.y0+1)),gx0=g[0].x0,gy0=Math.min(...g.map(d=>d.y0)),gy1=Math.max(...g.map(d=>d.y1));
    // an "=" sign just left of the number: two thin bars stacked
    const eq=bars.filter(b=>b.x1<gx0&&gx0-b.x1<h*2.2&&b.y0>=gy0-h*0.3&&b.y1<=gy1+h*0.3);
    let hasEq=false;for(let i=0;i<eq.length&&!hasEq;i++)for(let j=0;j<eq.length;j++){if(i===j)continue;const A=eq[i],B=eq[j];
      if(Math.abs(A.x0-B.x0)<h*0.4&&Math.abs(A.x1-B.x1)<h*0.4&&Math.abs(A.y0-B.y0)>h*0.15&&Math.abs(A.y0-B.y0)<h*0.8){hasEq=true;break}}
    dbg[dbg.length-1].eq=hasEq;dbg[dbg.length-1].bars=eq.length;if(!hasEq)continue;
    let v=0,ok=true;for(const d of g){const dw=d.x1-d.x0+1,dh=d.y1-d.y0+1;const k=dw<dh*0.38?1:classify(m,W,d);if(k<0){ok=false;break}v=v*10+k}
    if(!ok||v<30||v>260)continue;
    const dist=s0.top-gy1;if(!best||dist<best.dist)best={v,dist}}
  return best?best.v:null;
}

// the whole module's text, so saved page readings are redone when any part of the reading changes
global.ScoreScan={_src:String(scoreScanModule),prepPage,findStaves,readTempo,_readNumber:readNumber,_inkMask:inkMask,_readVolta:readVolta,_digit:digitShape,_components:components};
})(window);
