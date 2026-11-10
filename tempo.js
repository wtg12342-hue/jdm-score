/* Tempo and first-beat estimation.
   Tempo.fromBuffer(AudioBuffer)            -> {bpm, firstBeat, conf}
   Tempo.fromSeries({t:[], f:[], r:[]})     -> same, from live onset measurements (t = media seconds)
*/
(function(global){
"use strict";
const HOP=0.01; // analysis grid: 100 frames per second of music

function fft(re,im){ // in-place radix-2
  const n=re.length;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
  for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);
    for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const a=i+k,b=a+len/2;
      const xr=re[b]*cr-im[b]*ci,xi=re[b]*ci+im[b]*cr;re[b]=re[a]-xr;im[b]=im[a]-xi;re[a]+=xr;im[a]+=xi;
      const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t}}}
}

/* onset strength (log spectral flux) + loudness, 100 frames/s, from decoded audio */
function seriesFromBuffer(buf,maxSec){
  const sr=buf.sampleRate,len=Math.min(buf.length,Math.round((maxSec||180)*sr));
  const mono=new Float32Array(len);
  for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<len;i++)mono[i]+=d[i]/buf.numberOfChannels}
  // ~46 ms window whatever the sample rate (2048 at 44.1 kHz, 256 for a recording made at 8x speed)
  const N=Math.max(128,Math.pow(2,Math.round(Math.log2(sr*0.0464)))),hopF=sr*HOP,win=new Float32Array(N);for(let i=0;i<N;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/N);
  const bins=Math.min(N/2,Math.round(8000/sr*N)); // up to 8 kHz (or what the recording holds)
  const frames=Math.max(0,Math.floor((len-N)/hopF));
  // harmony: a long window (~0.19 s) so low notes are told apart, every 5 frames
  const ch=new Float32Array(frames*12),NC=Math.pow(2,Math.round(Math.log2(sr*0.186))),winC=new Float32Array(NC),pcC=new Int8Array(NC/2).fill(-1);
  for(let i=0;i<NC;i++)winC[i]=0.5-0.5*Math.cos(2*Math.PI*i/NC);
  for(let k=1;k<NC/2;k++){const fq=k*sr/NC;if(fq>=55&&fq<=Math.min(1760,sr/2-1))pcC[k]=((Math.round(12*Math.log2(fq/440))+69)%12+12)%12}
  const reC=new Float32Array(NC),imC=new Float32Array(NC);let c12=new Float32Array(12);
  const f=new Float32Array(frames),r=new Float32Array(frames),fl0=new Float32Array(frames),fm0=new Float32Array(frames),fh0=new Float32Array(frames),fp0=new Float32Array(frames),fn0=new Float32Array(frames);let prevA=new Float32Array(bins);const kF0=Math.max(1,Math.round(150/sr*N));let prev=new Float32Array(bins);
  const kLow=Math.round(200/sr*N),kMid=Math.round(2000/sr*N),kHi=Math.round(4000/sr*N);
  const re=new Float32Array(N),im=new Float32Array(N);
  for(let fr=0;fr<frames;fr++){const o=Math.round(fr*hopF);let e=0;
    if(fr%5===0){const st=o+N/2-NC/2;for(let i=0;i<NC;i++){const v=mono[st+i]||0;reC[i]=v*winC[i];imC[i]=0}fft(reC,imC);c12=new Float32Array(12);
      for(let k=1;k<NC/2;k++)if(pcC[k]>=0)c12[pcC[k]]+=Math.hypot(reC[k],imC[k])}
    for(let c=0;c<12;c++)ch[fr*12+c]=c12[c];
    for(let i=0;i<N;i++){const v=mono[o+i];re[i]=v*win[i];im[i]=0;e+=v*v}
    fft(re,im);let fl=0;const cur=new Float32Array(bins);
    let lo=0,mi=0,hi=0,pn=0,pt=0;
    const curA=new Float32Array(bins);let lsum=0,asum=0,nf=0;
    for(let k=1;k<bins;k++){const am=Math.hypot(re[k],im[k]),mag=Math.log1p(100*am);cur[k]=mag;curA[k]=am;
      if(k>=kF0){const dd=Math.max(0,am-prevA[k]);lsum+=Math.log(dd+1e-4);asum+=dd;nf++}const d=mag-prev[k];if(k>kLow){pt++;if(d>0.35)pn++}if(d>0){fl+=d;if(k<=kLow)lo+=d;else if(k<=kMid)mi+=d;else if(k>=kHi)hi+=d}}
    // noise-like onsets (snare, cymbals): the rise is spread evenly over the spectrum; notes and voices rise in a few peaks
    // (a small floor keeps near-silent frames from blowing up the ratio)
    if(nf){const am=asum/nf,flat=Math.exp(lsum/nf)/(am+1e-4);fn0[fr]=flat*flat*asum}
    prevA=curA;prev=cur;f[fr]=fl;fl0[fr]=lo;fm0[fr]=mi;fh0[fr]=hi;fp0[fr]=pt?pn/pt:0;r[fr]=Math.sqrt(e/N);
  }
  // frame fr describes the window centred at (o+N/2)
  // log-flux peaks a little before the true attack (the window starts to see it early): measured on test songs
  const bias=0.011+Math.max(0,N/sr-0.0464)*0.47;
  // hi band only when the recording reaches 4 kHz
  return {f,r,lo:fl0,mi:fm0,hi:sr>=9000?fh0:null,perc:fp0,noise:fn0,ch,t0:(N/2)/sr+bias};
}

/* resample live measurements (irregular media times) onto the 100 Hz grid */
/* media times read during fast playback jump in steps; the audio clock is exact. Fit media time against it per stretch of
   uninterrupted playback, and use the fitted times. */
function smoothTimes(s){
  const n=s.t.length;if(!s.pt||s.pt.length!==n||n<50)return s.t;
  const out=new Float64Array(n);let a=0;
  const fit=(i0,i1)=>{let sx=0,sy=0,sxx=0,sxy=0,m=i1-i0;for(let i=i0;i<i1;i++){const x=s.pt[i],y=s.t[i];sx+=x;sy+=y;sxx+=x*x;sxy+=x*y}
    const d=m*sxx-sx*sx;const k=d?(m*sxy-sx*sy)/d:(s.R||1),c=(sy-k*sx)/m;return [k,c]};
  while(a<n){let b=a+1;
    // a stretch ends where media time stops following the audio clock (buffering, an ad, a seek)
    while(b<n){const dt=s.pt[b]-s.pt[b-1],dm=s.t[b]-s.t[b-1];if(dt>0.2||dm<-0.05||dm>(s.R||4)*Math.max(dt,0.01)*3+0.3)break;b++}
    if(b-a>=20){const [k,c]=fit(a,b);for(let i=a;i<b;i++)out[i]=k*s.pt[i]+c}else for(let i=a;i<b;i++)out[i]=s.t[i];
    a=b}
  return out}
function seriesFromLive(s){
  const n=s.t.length;if(n<50)return null;
  s={...s,t:smoothTimes(s)};
  const t0=s.t[0],t1=s.t[n-1],frames=Math.floor((t1-t0)/HOP);
  const f=new Float32Array(frames),r=new Float32Array(frames),lo=new Float32Array(frames),mi=new Float32Array(frames),hi=new Float32Array(frames),ch=s.ch&&s.ch.length>=n*12?new Float32Array(frames*12):null;let j=0;
  for(let i=0;i<frames;i++){const t=t0+i*HOP;while(j<n-2&&s.t[j+1]<t)j++;
    const a=s.t[j],b=s.t[j+1]||a+1e-3,w=Math.min(1,Math.max(0,(t-a)/(b-a)));
    f[i]=s.f[j]*(1-w)+s.f[j+1]*w;r[i]=s.r[j]*(1-w)+s.r[j+1]*w;
    if(s.lo){lo[i]=s.lo[j]*(1-w)+s.lo[j+1]*w;mi[i]=s.mi[j]*(1-w)+s.mi[j+1]*w}
    if(s.hi)hi[i]=s.hi[j]*(1-w)+s.hi[j+1]*w;
    if(ch)for(let c=0;c<12;c++)ch[i*12+c]=s.ch[j*12+c]}
  return {f,r,lo:s.lo?lo:null,mi:s.mi?mi:null,hi:s.hi?hi:null,ch,t0};
}

function analyse(S0){
  if(!S0||S0.f.length<400)return null;
  // skip silence / talking before the music: analyse from the first sustained loud part
  let skip=0;{const rs=[...S0.r].sort((a,b)=>a-b),loud=rs[Math.floor(rs.length*0.8)]||0;
    for(let i=0;i<S0.r.length-100;i++){let k=0;for(let j=0;j<100;j++)if(S0.r[i+j]>loud*0.3)k++;if(k>=85){skip=Math.max(0,i-50);break}}
    if(S0.f.length-skip<400)skip=0}
  const sl=a=>a?a.subarray?a.subarray(skip):a.slice(skip):a;
  const S={f:sl(S0.f),r:sl(S0.r),lo:sl(S0.lo),mi:sl(S0.mi),t0:S0.t0+skip*HOP};
  const n=S.f.length;
  // adaptive threshold: keep what rises above the local average, scaled to 0..1
  const onset=src=>{const o=new Float32Array(n),W=25,cs=new Float64Array(n+1);
    for(let i=0;i<n;i++){cs[i+1]=cs[i]+src[i]}
    for(let i=0;i<n;i++){const a=Math.max(0,i-W),b=Math.min(n,i+W+1);const m=(cs[b]-cs[a])/(b-a);o[i]=Math.max(0,src[i]-m)}
    const srt=[...o].sort((a,b)=>a-b),mx=srt[Math.floor(n*0.995)]||0;if(!(mx>0))return null;for(let i=0;i<n;i++)o[i]=Math.min(1,o[i]/mx);return o};
  const o=onset(S.f);if(!o)return null;
  // kick + snare only (no cymbals) decide which octave is the beat
  let ob=o;if(S.lo&&S.mi){const a=onset(S.lo),b=onset(S.mi);if(a&&b){ob=new Float32Array(n);for(let i=0;i<n;i++)ob[i]=a[i]+b[i]}}
  // autocorrelation over 50–220 BPM
  const lagMin=Math.floor(60/(220*HOP)),lagMax=Math.ceil(60/(50*HOP))*4;
  const ac=new Float64Array(lagMax+2);
  for(let L=lagMin;L<=lagMax+1;L++){let s=0;for(let i=0;i+L<n;i++)s+=o[i]*o[i+L];ac[L]=s/(n-L)}
  const acAt=x=>{const i=Math.floor(x),fr=x-i;return i+1<ac.length?ac[i]*(1-fr)+ac[i+1]*fr:0};
  let best=-1,bestL=0;
  const PK=2,PC=110,PS=0.9;
  const score=L=>{let s=0;for(let k=1;k<=PK;k++)s+=acAt(L*k)/k;const bpm=60/(L*HOP);const w=Math.exp(-0.5*Math.pow(Math.log2(bpm/PC)/PS,2));return s*w};
  for(let L=lagMin;L<=Math.ceil(60/(50*HOP));L+=0.25){const sc=score(L);if(sc>best){best=sc;bestL=L}}
  // octave check: a real beat has strong onsets on every beat; an 8th-note grid alternates strong/weak
  const alt=L=>{let bp=-1,ph0=0;for(let ph=0;ph<L;ph+=0.5){let s=0;for(let x=ph;x<n;x+=L)s+=ob[Math.round(x)]||0;if(s>bp){bp=s;ph0=ph}}
    let se=0,so=0,k=0;for(let x=ph0;x<n;x+=L,k++){let m=0;for(let d=-2;d<=2;d++)m=Math.max(m,ob[Math.round(x)+d]||0);if(k%2)so+=m;else se+=m}
    return Math.max(se,so)/Math.max(1e-6,Math.min(se,so))};
  for(let it=0;it<3;it++){
    if(60/(bestL/2*HOP)<=200&&alt(bestL/2)<1.9)bestL/=2;
    else if(60/(bestL*2*HOP)>=55&&alt(bestL)>2.0)bestL*=2;
    else break}
  // refine the period finely with a comb over the whole excerpt
  const comb=T=>{let bestP=0;for(let ph=0;ph<T;ph+=1){let s=0;for(let x=ph;x<n;x+=T)s+=o[Math.round(x)]||0;if(s>bestP)bestP=s}return bestP};
  let T=bestL,bc=comb(T);
  for(let d=-1.5;d<=1.5;d+=0.05){const c=comb(bestL+d);if(c>bc){bc=c;T=bestL+d}}
  let bpm=60/(T*HOP);
  bpm=Math.round(bpm);
  T=60/(bpm*HOP);
  // beat phase
  let bp=-1,phase=0;for(let ph=0;ph<T;ph+=0.5){let s=0;for(let x=ph;x<n;x+=T)s+=o[Math.round(x)]||0;if(s>bp){bp=s;phase=ph}}
  // where the music starts: first sustained loud part
  const rs=[...S.r].sort((a,b)=>a-b),loud=rs[Math.floor(rs.length*0.8)]||0;
  // first beat: the first grid beat from which onsets keep landing on the beat (talking or noise before it does not)
  const N0=S0.f.length;const oF=(()=>{const W2=25,cs=new Float64Array(N0+1),o2=new Float32Array(N0);for(let i=0;i<N0;i++)cs[i+1]=cs[i]+S0.f[i];
    for(let i=0;i<N0;i++){const a=Math.max(0,i-W2),b=Math.min(N0,i+W2+1);o2[i]=Math.max(0,S0.f[i]-(cs[b]-cs[a])/(b-a))}
    const srt=[...o2].sort((a,b)=>a-b),mx=srt[Math.floor(N0*0.995)]||1;for(let i=0;i<N0;i++)o2[i]=Math.min(1,o2[i]/mx);return o2})();
  const pa=skip+phase,hitAt=x=>{let m=0;for(let d=-3;d<=3;d++)m=Math.max(m,oF[Math.round(x)+d]||0);return m};
  const offAt=x=>{let m=0;for(let d=-3;d<=3;d++)m=Math.max(m,oF[Math.round(x)+d]||0);return m};
  const rmsAvg=(a,b)=>{a=Math.max(0,Math.round(a));b=Math.min(N0,Math.round(b));let s=0;for(let i=a;i<b;i++)s+=S0.r[i];return b>a?s/(b-a):0};
  let fb=null;let x=((pa%T)+T)%T;if(x>T-6)x-=T;
  for(;x<N0-9*T;x+=T){
    let on=0,off=0;for(let j=0;j<8;j++){if(hitAt(x+j*T)>0.25)on++;if(offAt(x+j*T+T*0.37)>0.25)off++}
    if(on<7||hitAt(x)<0.25||off>on-3)continue;
    // as loud as the music that follows (speech or noise before the song is quieter)
    if(rmsAvg(x,x+T)<0.45*rmsAvg(x+T,x+9*T))continue;
    fb=x;break}
  if(fb==null)fb=pa;
  // confidence: how much the comb peak stands out
  let mean=0,cnt=0;for(let L=lagMin;L<=Math.ceil(60/(50*HOP));L+=1){mean+=score(L);cnt++}mean/=cnt;
  return {bpm,firstBeat:Math.max(0,S0.t0+fb*HOP),beat:60/bpm,conf:Math.min(1,(best/mean-1)/3)};
}

/* ---------- score-informed alignment ----------
   sc = {bpm: printed tempo or 0, act: [per score quarter-beat 1 = drums play, 0 = rest], bar: beats in the first bar}
   Finds the exact tempo from the drums, the beat grid, which beat is the bar's first beat (kick/snare pattern),
   and where score bar 1 lands (where the drums come in, matched against the rests in the score). */
function onsetN(src,n){if(!src)return null;const o=new Float32Array(n),W=25,cs=new Float64Array(n+1);
  for(let i=0;i<n;i++)cs[i+1]=cs[i]+src[i];
  for(let i=0;i<n;i++){const a=Math.max(0,i-W),b=Math.min(n,i+W+1);o[i]=Math.max(0,src[i]-(cs[b]-cs[a])/(b-a))}
  const srt=[...o].sort((a,b)=>a-b),mx=srt[Math.floor(n*0.995)]||0;if(!(mx>0))return null;for(let i=0;i<n;i++)o[i]=Math.min(1,o[i]/mx);return o}
function align(S0,sc){
  if(!S0||S0.f.length<400)return null;
  const n=S0.f.length,base=analyse(S0);
  const ol=onsetN(S0.lo,n),om=onsetN(S0.mi,n),oh=onsetN(S0.hi,n),of=onsetN(S0.f,n),op=onsetN(S0.perc,n),on=onsetN(S0.noise,n);if(!of)return base;
  // drum envelope: kick band + cymbal/snare band (pianos and voices are weak in both)
  const od=new Float32Array(n);for(let i=0;i<n;i++)od[i]=(ol?ol[i]:0)+(op?op[i]*(oh?0.5:1):0)+(oh?oh[i]*0.5:(op?0:of[i]));
  const sm=new Float32Array(n);for(let i=1;i<n-1;i++)sm[i]=(od[i-1]+2*od[i]+od[i+1])/4;
  const at=x=>{if(x<0||x>=n-1)return 0;const i=Math.floor(x),fr=x-i;return sm[i]*(1-fr)+sm[i+1]*fr};
  const comb=(T,step)=>{let best=-1,ph=0;for(let p=0;p<T;p+=step){let s=0;for(let x=p;x<n;x+=T)s+=at(x);if(s>best){best=s;ph=p}}return [best,ph]};
  // ---- tempo: audio estimate, octave chosen with the printed tempo, then refined finely
  // where to look for the tempo: around the printed tempo (the band may play it a little differently), and around the
  // audio's own estimate (folded to the printed tempo's octave); the drums decide
  let center=base?base.bpm:(sc.bpm||100);const ranges=[];
  // a x/8 score with no printed tempo: the onset-rhythm estimate is tuned for 4/4; take the steadiest grid instead
  if(!(sc.bpm>0)&&sc.unit===2){let bc=-1;for(let b=50;b<=230;b+=1){const T=6000/b;let best=-1,tot=0,c=0;for(let p=0;p<T;p+=1){let s2=0;for(let x=p;x<n;x+=T)s2+=at(x);tot+=s2;c++;if(s2>best)best=s2}const v=best/(tot/c);if(v>bc){bc=v;center=b}}}
  if(sc.bpm>0){ranges.push([sc.bpm*0.92,sc.bpm*1.08]);
    let bc=center,bd=9;for(const k of [0.5,1,2]){const c=center*k;const d=Math.abs(Math.log(c/sc.bpm));if(d<bd){bd=d;bc=c}}
    if(bd<0.2)ranges.push([bc*0.97,bc*1.03])}
  // no printed tempo: the audio's own estimate, and its double and half (a band's 8ths can pass for the beat); tempos
  // near the usual range win unless the audio clearly says otherwise
  else{const tc=sc.tempoCenter||105;ranges.push([center*0.96,center*1.04]);if(center>tc*1.57)ranges.push([center*0.48,center*0.52]);if(center<tc*0.57)ranges.push([center*1.92,center*2.08])}
  let bestB=center,bestS=-1;
  // the printed tempo is a strong hint: a short or sparse intro must not pull the grid a few % off it
  const wP=b=>{if(!(sc.bpm>0))return 0.5+0.5*Math.exp(-0.5*Math.pow(Math.log2(b/(sc.tempoCenter||105))/0.6,2));let w=0;for(const k of [0.5,1,2])w=Math.max(w,Math.exp(-0.5*Math.pow(Math.log(b/(sc.bpm*k))/(global.__wsig||0.08),2)));return 0.35+0.65*w};
  for(const [a0,a1] of ranges)for(let b=a0;b<=a1;b+=0.1){const T=6000/b;const [v]=comb(T,1);const sN=v/(n/T)*wP(b);if(sN>bestS){bestS=sN;bestB=b}}
  for(let b=bestB-0.12;b<=bestB+0.12;b+=0.01){const T=6000/b;const [v]=comb(T,0.5);const sN=v/(n/T)*wP(b);if(sN>bestS){bestS=sN;bestB=b}}
  // most songs are recorded to a whole-number click
  // a printed tempo can be wrong (another version of the song, a typo): when the audio's own tempo is far from it and
  // locks much better (onsets on the grid vs between), and the score still fits in the song's length, the audio wins
  let tempoFree=false;
  if(sc.bpm>0&&base){const raw=b=>{const T=6000/b;let best=-1,tot=0,c=0;for(let p=0;p<T;p+=1){let s=0;for(let x=p;x<n;x+=T)s+=at(x);tot+=s;c++;if(s>best)best=s}return best/(tot/c)};
    // (over stretches of ~20 s: a live band drifts a little, and a whole-song comb would blur the true tempo most)
    const rawL=b=>{const T=6000/b,Wn=Math.round(2000);let sum=0,c=0;for(let a=0;a+Wn<=n;a+=Wn){let best=-1,tot=0,cc=0;for(let p=0;p<T;p+=1){let s2=0;for(let x=a+p;x<a+Wn;x+=T)s2+=at(x);tot+=s2;cc++;if(s2>best)best=s2}if(tot>0){sum+=best/(tot/cc);c++}}return c?sum/c:raw(b)};
    const rIn=Math.max(raw(bestB),0)&&rawL(bestB);let fB=0,fS=-1;
    for(const k of [0.5,1,2]){const c=base.bpm*k;if(c<50||c>220||[0.5,1,2].some(q=>Math.abs(Math.log(c/(sc.bpm*q)))<0.08))continue;for(let b=c*0.97;b<=c*1.03;b+=0.05){const v=raw(b);if(v>fS){fS=v;fB=b}}}
    if(fB)fS=rawL(fB);if(global.__tfDbg)global.__tfDbg.push({bestB,rIn,fB,fS,base:base.bpm});
    const fits=!sc.dur||!(sc.act&&sc.act.length)||sc.act.length*60/fB<=sc.dur+5;
    if(fB&&fS>rIn*1.2&&fits){bestB=fB;bestS=fS;tempoFree=true;for(let b=fB-0.12;b<=fB+0.12;b+=0.01){const v=raw(b);if(v>bestS){bestS=v;bestB=b}}
      {const T=6000/bestB;const [v]=comb(T,0.5);bestS=v/(n/T)}}}
  {const w=tempoFree?(()=>1):wP;const ri=Math.round(bestB),T=6000/ri,[v]=comb(T,0.5);if(v/(n/T)*w(ri)>=bestS*(Math.abs(bestB-ri)<0.1?0.92:0.985))bestB=ri}
  // a slow song (ballad) read at double speed: with no printed tempo, the hi-hat 8ths can win as the beat. Then kick and
  // snare take turns every 2 beats of that grid (one bar of a slow 4/4 = 8 such beats), not every beat. Halve it.
  let halved=false;
  if(!(sc.bpm>0)&&bestB>=100&&ol&&om){const T0=6000/bestB,[,p0]=comb(T0,0.5),pk=(arr,x)=>{let m=0;for(let d=-3;d<=3;d++){const v=arr[Math.round(x)+d]||0;if(v>m)m=v}return m};
    const X=[0,0,0,0],C=[0,0,0,0];let ml=0,mm=0,c=0;for(let k=0;p0+k*T0<n-4;k++){const x=p0+k*T0;ml+=pk(ol,x);mm+=pk(om,x);c++}ml=ml/c||1;mm=mm/c||1;
    for(let k=0;p0+k*T0<n-4;k++){const x=p0+k*T0;X[k%4]+=pk(ol,x)/ml-pk(om,x)/mm;C[k%4]++}for(let p=0;p<4;p++)X[p]/=C[p]||1;
    const c4=Math.abs(X[0]-X[2])+Math.abs(X[1]-X[3]),c2=Math.abs(X[0]+X[2]-X[1]-X[3]);
    if(global.__halfDbg)global.__halfDbg={X,c4,c2,bestB};
    // (never when the whole score would no longer fit in the song at half the speed)
    const L=sc.act&&sc.act.length,avail=(sc.dur||0)-(sc.startAt||0),fitsHalf=!L||!(avail>0)||L*60/(bestB/2)<=avail*1.08;
    if(c4>0.5&&c4>0.9*c2&&fitsHalf){bestB/=2;halved=true}}
  // no printed tempo and the score cannot fit in the song at this tempo (a whole score is never longer than the song):
  // it is the double
  if(!(sc.bpm>0)&&sc.act&&sc.act.length>=32){const L=sc.act.length,avail=(sc.dur||0)-(sc.startAt||0);
    if(avail>0&&L*60/bestB>avail*1.08&&L*60/(bestB*2)<=avail*1.08&&bestB*2<=240){bestB*=2;halved=false}}
  let bpm=Math.round(bestB*100)/100,T=6000/bpm,steadySd=null,rawBpm=null;
  let [,ph]=comb(T,0.5);{let bs=-1,bp=ph;for(let p=ph-0.6;p<=ph+0.6;p+=0.1){let s=0;for(let x=p;x<n;x+=T)s+=at(x);if(s>bs){bs=s;bp=p}}ph=bp}
  // ---- the tempo exactly: the beat's position in each stretch of 16 beats, along the whole song. With the right tempo
  // it stays put; a tempo a hair off makes it creep. A straight line through those positions corrects tempo and phase.
  // Songs recorded to a click land on a whole number: snap to it when the line says so.
  const phaseLine=(Tq,phq)=>{const pts=[];const W=16;for(let k0=0;phq+(k0+W)*Tq<n;k0+=W/2){let best=-1,bo=0;const sc=[];
      for(let o=-Tq*0.3;o<=Tq*0.3;o+=0.5){let v=0;for(let j=0;j<W;j++){const x=phq+(k0+j)*Tq+o;v+=at(x)+0.5*at(x+Tq/2)}sc.push(v);if(v>best){best=v;bo=o}}
      const srt=[...sc].sort((a,b)=>a-b),med=srt[srt.length>>1];const w=best>0?(best-med)/best:0;if(w>0.15)pts.push([phq+(k0+W/2)*Tq,bo,w])}
    if(pts.length<6)return null;
    // weighted least squares, then once more without the stretches far off the line (breaks, fills)
    const fit=P=>{let sw=0,sx=0,sy=0,sxx=0,sxy=0;for(const [x,y,w] of P){sw+=w;sx+=w*x;sy+=w*y;sxx+=w*x*x;sxy+=w*x*y}const d=sw*sxx-sx*sx;if(!d)return null;const a=(sw*sxy-sx*sy)/d,c=(sy-a*sx)/sw;return {a,c}};
    let f=fit(pts);if(!f)return null;const res=pts.map(([x,y])=>Math.abs(y-(f.c+f.a*x)));const rs=[...res].sort((a,b)=>a-b),lim=Math.max(1.5,rs[Math.floor(rs.length*0.7)]*1.5);
    const P2=pts.filter((p,i)=>res[i]<=lim);if(P2.length>=6)f=fit(P2)||f;
    let sd=0,sw=0;for(const [x,y,w] of P2){const e=y-(f.c+f.a*x);sd+=w*e*e;sw+=w}return {...f,sd:Math.sqrt(sd/(sw||1)),n:P2.length}};
  if(!(sc.unit===2)){
    for(let it=0;it<2;it++){const L=phaseLine(T,ph);if(!L||Math.abs(L.a)>0.01)break;const T2=T*(1+L.a),ph2=ph+L.c+L.a*ph;T=T2;ph=ph2;bpm=Math.round(6000/T*100)/100}
    const ri=Math.round(bpm);rawBpm=bpm;
    if(Math.abs(bpm-ri)<0.07){const Ti=6000/ri,Li=phaseLine(Ti,ph),Lb=phaseLine(T,ph);
      // whole-number tempo unless it clearly creeps against the song (more than a quarter frame per 100 beats)
      if(Li&&(Math.abs(Li.a*Ti*100)<2.5||(Lb&&Li.sd<=Lb.sd*1.3))){T=Ti;bpm=ri;ph=ph+Li.c+Li.a*(n/2)}}
    {const Lf=phaseLine(T,ph);steadySd=Lf?Lf.sd:null}
    if(global.__tempoDbg)global.__tempoDbg.push({bestB,bpm,steadySd})}
  ph=((ph%T)+T)%T;
  // ---- per beat: drum activity, accents
  const K=Math.floor((n-1-ph)/T)+1,peak=(arr,x)=>{if(!arr)return 0;let m=0;for(let d=-3;d<=3;d++){const v=arr[Math.round(x)+d]||0;if(v>m)m=v}return m};
  const D=new Float32Array(K),Kk=new Float32Array(K),Sn=new Float32Array(K),Cr=new Float32Array(K),Mu=new Float32Array(K);
  const rs=[...S0.r].sort((a,b)=>a-b),loud=rs[Math.floor(n*0.85)]||1;
  // activity locked to the beat grid (on the beat and the 8th) above the background of the beat: speech and noise
  // make onsets anywhere, music makes them on the grid
  // drum envelope: kick band, cymbal band when the recording has it, and noise-like onsets (which survive fast recordings)
  const de=new Float32Array(n);for(let i=0;i<n;i++)de[i]=(ol?ol[i]*0.5:0)+(oh?oh[i]:0)+(on?on[i]*(oh?0.5:1.2):(op?op[i]:of[i]));
  const locked=(env,x)=>{let b=0,c=0;for(let y=Math.round(x-T*0.1);y<Math.round(x+T*0.9);y++){if(y<0||y>=n)continue;b+=env[y];c++}b=c?b/c:0;
    return Math.max(0,0.6*peak(env,x)+0.4*peak(env,x+T/2)-1.2*b)};
  for(let k=0;k<K;k++){const x=ph+k*T;let e=0,c=0;
    for(let y=Math.round(x-T*0.1);y<Math.round(x+T*0.9);y++){if(y<0||y>=n)continue;e+=S0.r[y];c++}
    D[k]=locked(de,x);Mu[k]=Math.min(c?e/c/loud:0,1)*0.3+locked(of,x);Kk[k]=peak(ol,x);Sn[k]=peak(op||om,x)+peak(oh,x);Cr[k]=peak(of,x)}
  {const ds=[...D].sort((a,b)=>a-b),hiD=ds[Math.floor(K*0.8)]||1;for(let k=0;k<K;k++)D[k]=Math.min(1.5,D[k]/hiD)}
  {const ms=[...Mu].sort((a,b)=>a-b),hiM=ms[Math.floor(K*0.8)]||1;for(let k=0;k<K;k++)Mu[k]=Math.min(1.5,Mu[k]/hiM)}
  // ---- chord changes per beat (harmony usually changes on the first beat of the bar)
  const Hc=new Float32Array(K);
  if(S0.ch){const cv=k=>{const v=new Float32Array(12);if(k<0||k>=K)return v;const a=Math.max(0,Math.round(ph+k*T)),b=Math.min(n,Math.round(ph+(k+1)*T));
      for(let y=a;y<b;y++)for(let c=0;c<12;c++)v[c]+=S0.ch[y*12+c];let m=0;for(let c=0;c<12;c++)m+=v[c]*v[c];m=Math.sqrt(m)||1;for(let c=0;c<12;c++)v[c]/=m;return v};
    const V=[];for(let k=0;k<K;k++)V.push(cv(k));
    for(let k=1;k<K;k++){const a=V[k],b=V[k-1],a2=V[Math.min(K-1,k+1)],b2=V[Math.max(0,k-2)];let d=0,d2=0;
      for(let c=0;c<12;c++){d+=a[c]*b[c];d2+=(a[c]+a2[c])*(b[c]+b2[c])}
      Hc[k]=Math.max(0,1-d)+Math.max(0,1-d2/4)}}
  // ---- which beat starts the bar: kick on 1 (and 3), snare on the backbeats, crash and chord change on 1
  const B=Math.max(1,Math.round(sc.bar||4));const acc=new Float32Array(B);
  if(B>=2){for(let p=0;p<B;p++){let s=0,c=0,h=0,hc=0;
      for(let k=p;k+B<=K;k+=B){h+=Hc[k];hc++;if(D[k]<0.35&&D[k+1]<0.35)continue;c++;
        let v=Kk[k]+0.5*Cr[k]-Sn[k]*0.6;
        if(B===4)v+=0.5*Kk[k+2]+Sn[k+1]+Sn[k+3]-0.4*(Kk[k+1]+Kk[k+3])-0.5*Sn[k+2]-0.3*Cr[k+2];
        else for(let j=1;j<B;j++)v+=(Sn[k+j]-0.4*Kk[k+j])/(B-1);
        s+=v}
      acc[p]=(c?s/c:0)+(hc?h/hc:0)*2}
    // as a z-score, so it can be weighed against the rest matching
    let mu=0;for(const v of acc)mu+=v/B;let sd=0;for(const v of acc)sd+=(v-mu)*(v-mu)/B;sd=Math.sqrt(sd)||1;for(let p=0;p<B;p++)acc[p]=(acc[p]-mu)/sd}
  let p0=0;for(let p=1;p<B;p++)if(acc[p]>acc[p0])p0=p;
  const sortedAcc=[...acc].sort((a,b)=>b-a);const pc=B>1?sortedAcc[0]-sortedAcc[1]:0;
  // ---- where bar 1 lands: match the score's playing/resting beats with the drum activity, plus the bar accents
  const bo=(((sc.barOff||0)%B)+B)%B;
  const act=sc.act&&sc.act.length?sc.act:null;let k0=p0-bo,fitBest=-1e9;const fits=[];
  const firstOn=act?act.indexOf(1):-1,hasRest=act&&firstOn>0;
  for(let k=-B*2;k<K;k++){if(ph+k*T<-T*0.5)continue;if(hasRest&&k+firstOn>K-6)break;let f=0;
    if(act){for(let j=0;j<act.length;j++){const kk=k+j;if(kk<0)continue;if(kk>=K)break;f+=(Math.min(1,D[kk])-0.45)*(act[j]?1:-1)}}
    else{for(let kk=Math.max(0,k);kk<K;kk++)f+=Math.min(1,D[kk])-0.45}
    // the first beat sits in music (grid-locked onsets), not in silence or talking before the song
    if(k>=0){let mu=0;for(let j=0;j<4&&k+j<K;j++)mu+=Mu[k+j]/4;if(mu<0.3)f-=3*(0.3-mu)/0.3+1}
    {let pre=0,np=0;for(let j=1;j<=4;j++)if(k-j>=0){pre+=Mu[k-j];np++}if(np&&!act){f-=Math.max(0,pre/np-0.35)*2}}
    f+=1.6*acc[(((k+bo)%B)+B)%B];
    fits.push([k,f]);if(f>fitBest+1e-9){fitBest=f;k0=k}}
  const srtF=fits.map(a=>a[1]).sort((a,b)=>b-a);const fitMargin=srtF.length>1?srtF[0]-srtF[1]:9;
  // ---- real recordings: the score's bar 1 is where the music starts. Find the first sustained musical sound (loud,
  // and locked to the beat grid), take the first beat at or after it, and move on to the bar's first beat (chord changes
  // and drum accents after that point decide which beat that is). A sound just before is a pickup.
  // per beat: how much of its onset strength sits on the 8th grid (null = hardly any onsets); talking before a song
  // puts its onsets anywhere
  const Mg=new Array(K).fill(null);for(let k=0;k<K;k++){let on=0,all=0;const a=Math.max(0,Math.round(ph+k*T-T/4)),b=Math.min(n,Math.round(ph+(k+1)*T-T/4));
    for(let y=a;y<b;y++){const v=of[y];if(!(v>0.1))continue;all+=v;const q=(y-ph)/(T/2),dq=Math.abs(q-Math.round(q))*(T/2);if(dq<=3)on+=v}
    if(all>=0.15)Mg[k]=on/all}
  const beatT=k=>S0.t0+(ph+k*T)*HOP;let ts=-1,kS=-1,k0m=null,pm=p0,pmc=0,pickupBeats=null;
  {const R=S0.r,sm=new Float32Array(n);for(let i=0;i<n;i++){let a=0,c=0;for(let j=-10;j<=10;j++){const v=R[i+j];if(v!=null){a+=v;c++}}sm[i]=a/c}
    // loud enough compared with the quiet before the song (a soft intro still counts as music)
    const srt=[...sm].sort((a,b)=>a-b),p80=srt[Math.floor(n*0.8)]||0,p05=srt[Math.floor(n*0.05)]||0,thr=Math.min(Math.max(p05*4,p80*0.04),p80*0.2);
    const find=strict=>{for(let i=0;i<n-400&&p80>0;i++){if(sm[i]<thr)continue;let k=0;for(let j=0;j<400;j++)if(sm[i+j]>thr*0.4)k++;
      if(k<300)continue;
      // a sound followed by 5 s of near silence is a video's opening, not the song
      {let run=0,gapEnd=-1;for(let q=i;q<Math.min(n,i+2500);q++){if(sm[q]<p80*0.08){run++;if(run>=500)gapEnd=q}else{if(gapEnd>0)break;run=0}}if(gapEnd>0){i=gapEnd;continue}}
      // locked to the beat: talking or sound effects before a song are loud too, but not on the grid
      const kk=Math.max(0,Math.ceil(((i*HOP+S0.t0)-S0.t0)/HOP/T-ph/T));let mu=0,c=0;for(let j=0;j<8&&kk+j<K;j++){mu+=Mu[kk+j];c++}
      let gs=0,gn=0;for(let j=0;j<8&&kk+j<K;j++)if(Mg[kk+j]!=null){gs+=Mg[kk+j];gn++}
      if(global.__findDbg&&global.__findDbg.length<40&&c&&mu/c<0.25)global.__findDbg.push(['mg',i,gn,gn?+(gs/gn).toFixed(2):null]);
      if(c&&mu/c<0.25&&!(global.__mgT!=null&&gn>=6&&gs/gn>=global.__mgT)){if(global.__findDbg&&global.__findDbg.length<40)global.__findDbg.push(['mu',strict,i,+(mu/c).toFixed(2)]);continue}
      // when the score has drums right from the start, the music start is where the drums start (talking is not):
      // strict = clear drums at once, loose = some drum hits (a band starting softly)
      if(act&&firstOn>=0&&firstOn<8){let hit=0,dn=0,dd=0,d4=0;for(let j=0;j<16&&kk+firstOn+j<K;j++){dn++;const v=Math.min(1,D[kk+firstOn+j]);if(v>=0.3)hit++;if(j<4){dd+=v;d4++}}
        if(dn>=8&&(strict?(dd/d4<0.4||hit<10):hit<Math.min(4,dn/2))){if(global.__findDbg&&global.__findDbg.length<40)global.__findDbg.push(['drum',strict,i,hit,+(dd/d4).toFixed(2)]);continue}}
      let a=i;const lvl=sm.slice(i,i+50).reduce((x,y)=>x+y)/50;while(a>0&&R[a-1]>lvl*0.1&&i-a<150)a--;return a}return -1};
    let a=find(false);
    // a song that is loud and steady right from its first second (a drum machine intro, a band starting together) is
    // music even where the beat grid of the whole song does not quite fit its first bars: when the score plays from
    // bar 1, the music starts there, not at the first place the grid locks
    if(a>800&&act&&firstOn===0&&!global.__noLoudStart){let f0=-1;for(let i=0;i<Math.min(n-400,300);i++){if(sm[i]<p80*0.3)continue;let k=0;for(let j=0;j<400;j++)if(sm[i+j]>p80*0.25)k++;if(k>=360){f0=i;break}}
      if(f0>=0){const md=srt[Math.floor(n*0.5)]||0;let x=0;for(let q=f0;q<a;q++)x+=sm[q];x/=Math.max(1,a-f0);
        if(global.__findDbg)global.__findDbg.push(['loud',f0,a,+(x/md).toFixed(2)]);
        if(x>=md*0.6){let b=f0;while(b>0&&R[b-1]>sm[f0]*0.1&&f0-b<150)b--;a=b}}}
    // (only for a score that plays from the start for several bars: one with early rests is placed by its pattern)
    const steadyStart=act&&firstOn>=0&&firstOn<8&&act.slice(firstOn,firstOn+32).every(v=>v===1);
    if(a>=0&&steadyStart){const b=find(true);
      // a soft start counts when it sounds like the song that follows (about as loud), not like talking before it
      if(b>a+100){let x=0,y=0;for(let q=a;q<b;q++)x+=sm[q];for(let q=b;q<Math.min(n,b+800);q++)y+=sm[q];x/=b-a;y/=Math.max(1,Math.min(n,b+800)-b);if(x<0.5*y)a=b}}
    if(a>=0)ts=S0.t0+a*HOP}
  if(ts>=0){kS=Math.ceil((ts-0.1-S0.t0)/HOP/T-ph/T);
    // which beat is the bar's first, judged only on the music after the start
    const sc2=new Float32Array(B);let mu=0,sd=1;
    if(B>=2){for(let p=0;p<B;p++){let h=0,c=0,d=0,dc=0;for(let k=kS+((p-kS)%B+B)%B;k+B<=K;k+=B){h+=Hc[k];c++;
          if(D[k]>=0.35||D[k+1]>=0.35){let v=Kk[k]+0.5*Cr[k]-Sn[k]*0.6;if(B===4)v+=0.5*Kk[k+2]+Sn[k+1]+Sn[k+3]-0.4*(Kk[k+1]+Kk[k+3])-0.5*Sn[k+2];d+=v;dc++}}
        sc2[p]=(c?h/c:0)*2+(dc?d/dc:0)*0.5}
      mu=0;for(const v of sc2)mu+=v/B;sd=0;for(const v of sc2)sd+=(v-mu)*(v-mu)/B;sd=Math.sqrt(sd)||1;
      pm=0;for(let p=1;p<B;p++)if(sc2[p]>sc2[pm])pm=p;const z=[...sc2].map(v=>(v-mu)/sd).sort((a,b)=>b-a);pmc=z[0]-z[1]}
    // candidates: the bar starts on the first sound, or 1..B-1 beats later (a pickup); harmony/accents decide,
    // with a lean towards "on the first sound" and "one-beat pickup", the common cases
    let bestC=kS,bv=-1e9;const zz=p=>(sc2[p]-mu)/sd;
    for(let j=0;j<B;j++){const c=kS+j,v=zz((((c+bo)%B)+B)%B)+(j===0?(global.__lean0!=null?global.__lean0:0.35):j===1?0.2:0);if(global.__candDbg)global.__candDbg.push([j,c,+zz((((c+bo)%B)+B)%B).toFixed(2),+v.toFixed(2)]);if(v>bv){bv=v;bestC=c}}
    k0m=bestC;
    // the score itself starts with a short bar (a pickup): the song's first sound is that pickup, and the first full bar
    // starts on the strongest bar accent 1..B-1 beats later; that tells how long the pickup really is
    if(sc.pickup&&act&&act[0]){let bp=1,bz=-1e9;for(let p=1;p<B;p++){const v=zz((((kS+p)%B)+B)%B);if(v>bz){bz=v;bp=p}}
      // the bar line is there; the pickup reaches back over the beats before it that have drum hits (a soft lead-in
      // the start search did not count as music still belongs to it)
      const kd=kS+bp,ds=[...D].sort((a,b)=>a-b),dm=ds[Math.floor(ds.length*0.6)]||1;let p=0;while(p<B-1&&kd-p-1>=0&&D[kd-p-1]>dm*0.15)p++;
      p=Math.max(p,bp);k0m=kd-p;pickupBeats=p}}
  // is the answer backed by enough music? (the drum entry and a few bars after it, or 8 bars of drums)
  let entryOK=false,after=0,before=0;
  if(hasRest){const ke=k0+firstOn;let na=0,nb=0;for(let kk=ke;kk<Math.min(K,ke+16);kk++){after+=Math.min(1,D[kk]);na++}
    for(let j=0;j<firstOn;j++){const kk=k0+j;if(kk<0||kk>=K)continue;before+=Math.min(1,D[kk]);nb++}
    after=na?after/na:0;before=nb?before/nb:0;entryOK=na>=16&&after>=0.5&&after-before>=0.18}
  else{const ks=Math.max(0,k0);let na=0;for(let kk=ks;kk<K;kk++){after+=Math.min(1,D[kk]);na++}after=na?after/na:0;entryOK=na>=32&&after>=0.45}
  // the music start decides; the rest matching only when no clear start was found
  const kFit=k0;if(k0m!=null)k0=k0m;
  if(global.__skDbg){let snd=0,cnt=0;for(let k=Math.max(0,kFit);k<(k0m==null?kFit:k0m);k++){cnt++;if(Mg[k]==null?Mu[k]>0.08:Mg[k]>=0.5)snd++}const fv=k=>{const e=fits.find(q=>q[0]===k);return e?e[1]:-1e9};global.__skDbg.push({kFit,k0m,B,hasRest:!!hasRest,entryOK,after:+after.toFixed(3),before:+before.toFixed(3),snd,cnt,gap:k0m==null?null:+(fv(kFit)-fv(k0m)).toFixed(2),fits:fits.map(q=>[q[0],+q[1].toFixed(2)]),ph,T,t0:S0.t0,HOP})}
  // a soft intro can be missed by the start search: when the score's rests line up clearly with the drums a whole number
  // of bars earlier, and there is sound (not silence) in between, the earlier bar 1 wins
  if(k0m!=null&&hasRest&&kFit<k0m&&((k0m-kFit)%B===0)&&entryOK&&after-before>=(global.__abT!=null?global.__abT:0.15)){
    let snd=0,cnt=0;for(let k=Math.max(0,kFit);k<k0m;k++){cnt++;if(Mg[k]==null?Mu[k]>0.08:Mg[k]>=0.5)snd++}
    if(cnt&&snd/cnt>0.7)k0=kFit
    // (a very soft intro - a piano alone - hardly makes onsets; when the score's rests fit far better there and the
    // intro is not silence, the earlier bar 1 still wins)
    else if(k0!==kFit){const fv=k=>{const e=fits.find(q=>q[0]===k);return e?e[1]:-1e9},gap=fv(kFit)-fv(k0m);
      let loudIn=0,c2=0;const R=S0.r,rs2=[...R].sort((a,b)=>a-b),p90=rs2[Math.floor(R.length*0.9)]||1;
      for(let k=Math.max(0,kFit);k<k0m;k++){const a=Math.round(ph+k*T),z=Math.round(ph+(k+1)*T);let e=0,c=0;for(let y=a;y<z&&y<n;y++){e+=R[y];c++}c2++;if(c&&e/c>p90*0.04)loudIn++}
      if(global.__softDbg)global.__softDbg.push({gap,loudIn,c2});if((gap>2.5&&c2&&loudIn/c2>0.8)||gap>8)k0=kFit}}
  // the score starts somewhere in the middle of the song (its first page is a later part): bar 1 is the bar line
  // nearest the given time, where the bar accents and the score's playing/resting pattern agree best
  let hinted=false;const hintCands=[];
  if(sc.startAt>0){const kc=((sc.startAt-S0.t0)/HOP-ph)/T;let bk=null,bv=-1e9;
    // kick drum per beat, scaled like D (the low drums are what a score's rests silence most reliably)
    // (low-band onsets above their local background, at each beat and 8th: the kick drum)
    const kN=new Float32Array(K);{const L=S0.lo,nn=L.length,cs=new Float64Array(nn+1);for(let i=0;i<nn;i++)cs[i+1]=cs[i]+L[i];
      const bg=i=>{const a=Math.max(0,i-15),b=Math.min(nn,i+16);return (cs[b]-cs[a])/(b-a)},pk=x=>{let m=0;for(let d=-3;d<=3;d++){const i=Math.round(x)+d;if(i<0||i>=nn)continue;const v=L[i]-bg(i);if(v>m)m=v}return m};
      for(let k=0;k<K;k++){const x=ph+k*T;kN[k]=pk(x)+pk(x+T/2)}}
    // (the given time is rough: a bar or so either way; the score's rest bars decide between neighbours)
    for(let k=Math.floor(kc-B*1.6);k<=Math.ceil(kc+B*1.6);k++){if(k<0||k>=K)continue;
      let v=(B>1?1.2*acc[(((k+bo)%B)+B)%B]:0)-Math.abs(k-kc)/Math.max(1,B)*0.5,fk=null;
      // harmony changes on the bar's first beat (a chord rarely changes in the middle of a slow bar): tells the bar line
      // from the middle of the bar, which the drum accents cannot (they repeat every 2 beats)
      if(B>=4&&act){let a=0,b=0,c=0;for(let j=0;j+B<=act.length;j+=B){const kk=k+j;if(kk+B>K)break;a+=Hc[kk];b+=Hc[kk+B/2];c++}
        if(c>=4){const sd=(()=>{let m=0,q=0,cnt=0;for(let x=0;x<K;x++){m+=Hc[x];q+=Hc[x]*Hc[x];cnt++}m/=cnt||1;return Math.sqrt(Math.max(1e-9,q/(cnt||1)-m*m))})();v+=1.5*(a-b)/c/sd;
          if(global.__hintDbg)global.__hintDbg.push(['h',k,+((a-b)/c/sd).toFixed(3)])}}
      // rests against playing: each bar the score rests in should be quieter in the low drums than the playing bars
      // right around it (local, so a song that grows louder or softer does not matter; a bar's strength is its two
      // strongest beats, the kick on 1 and 3)
      if(act&&B>=2){const nb=Math.floor(act.length/B),bar=[],rest=[];for(let m=0;m<nb;m++){const k1=k+m*B;if(k1+B>K)break;
          const vs=[];for(let j=0;j<B;j++)vs.push(kN[k1+j]);vs.sort((x,y)=>y-x);bar.push((vs[0]+vs[1])/2);let r=true;for(let j=0;j<B;j++)if(act[m*B+j])r=false;rest.push(r)}
        let cs=0,cn=0;for(let m=0;m<bar.length;m++){if(!rest[m])continue;let l=0,ln=0;for(let q=m-3;q<=m+3;q++)if(q>=0&&q<bar.length&&!rest[q]){l+=bar[q];ln++}
          if(ln>=2){l/=ln;cs+=Math.max(-1,Math.min(1,(l-bar[m])/Math.max(1e-9,l)));cn++}}
        if(cn){v+=7*cs/cn;fk=cs/cn;if(global.__hintDbg)global.__hintDbg.push(['f',k,+(cs/cn).toFixed(3)])}}
      if(global.__hintDbg)global.__hintDbg.push([k,+v.toFixed(2),B>1?+acc[((k%B)+B)%B].toFixed(2):0,+(S0.t0+(ph+k*T)*HOP).toFixed(2)]);
      hintCands.push([k,v,fk]);if(v>bv){bv=v;bk=k}}
    if(bk!=null){k0=bk;hinted=true}}
  const firstBeat=S0.t0+(ph+k0*T)*HOP;
  let m0=-1;for(let k=0;k+8<=K;k++){let m=0;for(let j=0;j<8;j++)m+=Mu[k+j]/8;if(m>=0.5){m0=k;break}}
  if(global.__alignDbg)global.__alignDbg={D:Array.from(D),Mu:Array.from(Mu),fits,k0,T,ph,acc:Array.from(acc),Mg};
  return {bpm,firstBeat,beat:60/bpm,conf:base?base.conf:0.5,barConf:pc,fitMargin,phase:S0.t0+ph*HOP,downbeat:p0,k0,entryOK,drumAfter:after,drumBefore:before,beats:K,musicStart:m0,firstOn,musicT:ts,kStart:kS,barPhase:pm,barPhaseConf:pmc,kFit,byStart:k0m!=null||hinted,hinted,pickupBeats,steadySd,rawBpm,hintCands:hinted?hintCands.filter(c=>c[1]>Math.max(...hintCands.map(q=>q[1]))-1.2).sort((a,b)=>b[1]-a[1]).slice(0,4):null,tempoFree};
}

/* raw sound recorded while the video played fast (no pitch correction), handed over in parts:
   parts = [{x: Int16Array, idx: [[offset, firstSampleIndex], ...]}], clock = [[audioTime, songTime, unsteady], ...].
   Every sample is placed at its song time: song time follows audio time in straight stretches (the actual speed is
   measured per stretch; a stall, seek or ad starts a new stretch). The result is the song sampled at sr/R. */
/* ---------- beat-by-beat timing for songs played without a click ----------
   Dynamic-programming beat tracker (onsets on the beat, spacing within 10% of the tempo, changes kept small): follows
   a band that speeds up and slows down. Returns the beat times (s). */
function trackSeries(S,bpm){
  const n=S.f.length;if(n<400||!(bpm>0))return null;
  const ol=onsetN(S.lo,n),oh=onsetN(S.hi,n),op=onsetN(S.perc,n),on=onsetN(S.noise,n),of=onsetN(S.f,n);
  const e=new Float32Array(n);for(let i=0;i<n;i++)e[i]=(ol?ol[i]:0)+(oh?oh[i]:0)+(on?on[i]*(oh?0.5:1):(op?op[i]*0.5:0))+0.3*(of?of[i]:0);
  let m=0,v=0;for(let i=0;i<n;i++)m+=e[i]/n;for(let i=0;i<n;i++)v+=(e[i]-m)*(e[i]-m)/n;v=Math.sqrt(v)||1;for(let i=0;i<n;i++)e[i]=(e[i]-m)/v;
  const T=60/(bpm*HOP),lo=Math.floor(T*0.9),hi=Math.ceil(T*1.1),C=new Float32Array(n),P=new Int32Array(n).fill(-1);
  for(let i=0;i<n;i++){let best=0,bp=-1;for(let d=lo;d<=hi;d++){const j=i-d;if(j<0)break;const w=Math.log(d/T),x=C[j]-600*w*w;if(bp<0||x>best){best=x;bp=j}}
    C[i]=e[i]+(bp>=0&&best>0?best:0);P[i]=bp>=0&&best>0?bp:-1}
  let end=n-1,bv=-1e9;for(let i=n-1;i>=Math.max(0,n-hi);i--)if(C[i]>bv){bv=C[i];end=i}
  const fr=[];for(let i=end;i>=0;i=P[i]){fr.push(i);if(P[i]<0)break}fr.reverse();
  const out=fr.map(i=>S.t0+i*HOP);out.env=e;out.t0=S.t0;return out}
/* the grid the score follows: beat k (the fixed grid's numbering, bar 1 at r.k0) at the tracked beat times, continued
   at the local tempo outside them. maxDev = how far the band strays from one steady tempo. */
function makeGrid(r,bt){
  const beat=60/r.bpm;if(!bt||bt.length<16)return null;
  let i0=0,bd=9;for(let i=0;i<bt.length;i++){const d=Math.abs(bt[i]-r.firstBeat);if(d<bd){bd=d;i0=i}}if(bd>beat*0.5)return null;
  const kA=r.k0-i0,N=bt.length,sm=Float64Array.from(bt);
  // light smoothing: a beat a few ms early or late is noise, a drift over bars is real
  for(let i=1;i<N-1;i++)sm[i]=(bt[i-1]+2*bt[i]+bt[i+1])/4;
  let maxDev=0;for(let i=0;i<N;i++){const dv=sm[i]-(r.phase+(kA+i)*beat);if(Math.abs(dv)>maxDev)maxDev=Math.abs(dv)}
  const w=Math.min(N-1,8),spbA=(sm[w]-sm[0])/w,spbB=(sm[N-1]-sm[N-1-w])/w;
  const T=k=>{const i=k-kA;if(i<=0)return sm[0]+i*spbA;if(i>=N-1)return sm[N-1]+(i-N+1)*spbB;const a=Math.floor(i),f=i-a;return sm[a]*(1-f)+sm[a+1]*f};
  const K=t=>{if(t<=sm[0])return kA+(t-sm[0])/spbA;if(t>=sm[N-1])return kA+N-1+(t-sm[N-1])/spbB;let a=0,b=N-1;while(b-a>1){const c=(a+b)>>1;if(sm[c]<=t)a=c;else b=c}return kA+a+(t-sm[a])/(sm[b]-sm[a])};
  return {T,K,kA,times:sm,maxDev}}
/* after the fast pass: a closer listen (getBuf(ta,tb) -> the song from ta to tb at 1/4 resolution, or null) where the
   drums come in (which bar is bar 1) or at a clear stretch of drums (exact timing), and the beat map for a band that
   drifts. sc.unit = beats of the analysis per score quarter (2 when a x/8 score is analysed in eighths). */
/* a band that speeds up and slows down: stretch time so the tracked beats fall on a steady grid (u = steady time),
   analyse in steady time, and bring every result back to song time. Returns null when the song keeps a steady tempo. */
function warpFor(S,bt,bpm){
  if(!bt||bt.length<24||!bt.env)return null;const N=bt.length,E=bt.env;
  // trust the tracked beats only where the beat is clear: strong onsets on the beat, weaker halfway between
  const ev=t=>{const x=Math.round((t-bt.t0)/HOP);let m=-9;for(let d=-2;d<=2;d++){const v=E[x+d];if(v!=null&&v>m)m=v}return m};
  const sp0=(bt[N-1]-bt[0])/(N-1),on=bt.map(t=>ev(t)),off=bt.map(t=>ev(t+sp0/2)),conf=new Array(N).fill(false);
  for(let i=0;i<N;i++){let a=0,b=0,c=0;for(let j=Math.max(0,i-4);j<=Math.min(N-1,i+4);j++){a+=on[j];b+=off[j];c++}conf[i]=a/c>0.5&&a/c-b/c>0.4}
  let sx=0,sy=0,sxx=0,sxy=0,nc=0;for(let i=0;i<N;i++)if(conf[i]){sx+=i;sy+=bt[i];sxx+=i*i;sxy+=i*bt[i];nc++}
  if(nc<16)return null;
  let sp=(nc*sxy-sx*sy)/(nc*sxx-sx*sx),c=(sy-sp*sx)/nc;
  // robust: refit without the beats far off the line (an opening in another tempo must not tilt it)
  for(let it=0;it<3;it++){const res=[];for(let i=0;i<N;i++)if(conf[i])res.push(Math.abs(bt[i]-(c+sp*i)));res.sort((a,b)=>a-b);const lim=Math.max(0.03,3*res[res.length>>1]);
    sx=sy=sxx=sxy=0;let m=0;for(let i=0;i<N;i++)if(conf[i]&&Math.abs(bt[i]-(c+sp*i))<=lim){sx+=i;sy+=bt[i];sxx+=i*i;sxy+=i*bt[i];m++}if(m<16)break;sp=(m*sxy-sx*sy)/(m*sxx-sx*sx);c=(sy-sp*sx)/m}
  // deviations from the steady line where the beat is clear, carried across unclear stretches
  const dv=new Float64Array(N);let last=-1;for(let i=0;i<N;i++)if(conf[i]){dv[i]=bt[i]-(c+sp*i);if(last<0)for(let j=0;j<i;j++)dv[j]=dv[i];else for(let j=last+1;j<i;j++)dv[j]=dv[last]+(dv[i]-dv[last])*(j-last)/(i-last);last=i}
  for(let j=last+1;j<N;j++)dv[j]=dv[last];
  const sm=new Float64Array(N);for(let i=0;i<N;i++){let a=0,k=0;for(let j=Math.max(0,i-1);j<=Math.min(N-1,i+1);j++){a+=dv[j];k++}sm[i]=c+sp*i+a/k}
  // a different opening (a video's intro, a free piano start) is not a drifting band: the drift must show in the song itself
  let dev=0,dev2=0;for(let i=0;i<N;i++){const d=Math.abs(sm[i]-(c+sp*i));dev=Math.max(dev,d);if(i>=N*0.2)dev2=Math.max(dev2,d)}
  if(dev2<0.045)return null;
  // and a steady grid really goes off: its timing against the clear beats wanders by more than ~45 ms over the song
  {const lags=[];for(let a=0;a+16<=N;a+=8){let bs=-1e9,bl=0,cnt=0;for(let i=a;i<a+16;i++)if(conf[i])cnt++;if(cnt<10)continue;
      for(let L=-0.12;L<=0.1201;L+=0.004){let v=0;for(let i=a;i<a+16;i++)if(conf[i])v+=ev(c+sp*i+L);if(v>bs){bs=v;bl=L}}lags.push(bl)}
    if(lags.length<4)return null;lags.sort((x,y)=>x-y);if(lags[Math.floor(lags.length*0.9)]-lags[Math.floor(lags.length*0.1)]<0.045)return null}
  const u=i=>c+sp*i,w=Math.min(N-1,8),spA=(sm[w]-sm[0])/w,spB=(sm[N-1]-sm[N-1-w])/w;
  const toU=t=>{if(t<=sm[0])return u(0)+(t-sm[0])/spA*sp;if(t>=sm[N-1])return u(N-1)+(t-sm[N-1])/spB*sp;let a=0,b=N-1;while(b-a>1){const h=(a+b)>>1;if(sm[h]<=t)a=h;else b=h}return u(a)+(t-sm[a])/(sm[b]-sm[a])*sp};
  const toT=x=>{const i=(x-c)/sp;if(i<=0)return sm[0]+i*spA;if(i>=N-1)return sm[N-1]+(i-N+1)*spB;const a=Math.floor(i),f=i-a;return sm[a]*(1-f)+sm[a+1]*f};
  const n=S.f.length,at=(arr,t)=>{if(!arr)return null;const x=(t-S.t0)/HOP,i=Math.floor(x),f=x-i;if(i<0)return arr[0];if(i>=n-1)return arr[n-1];return arr[i]*(1-f)+arr[i+1]*f};
  // the steady-time copy covers the whole recording
  const U0=toU(S.t0),n2=Math.max(1,Math.floor((toU(S.t0+(n-1)*HOP)-U0)/HOP)),keys=['f','r','lo','mi','hi','perc','noise'],W={t0:U0};
  for(const k of keys)W[k]=S[k]?new Float32Array(n2):null;W.ch=S.ch?new Float32Array(n2*12):null;
  for(let j=0;j<n2;j++){const t=toT(U0+j*HOP);for(const k of keys)if(W[k])W[k][j]=at(S[k],t);
    if(W.ch){const i=Math.min(n-1,Math.max(0,Math.round((t-S.t0)/HOP)));for(let q=0;q<12;q++)W.ch[j*12+q]=S.ch[i*12+q]}}
  return {S:W,toU,toT,dev}}
function alignSong(S,sc){
  let r=align(S,sc);if(!r)return r;const beat0=60/r.bpm;
  // a song whose beat stays put against one steady tempo all the way (recorded to a click) needs no beat-by-beat map
  const steady=r.steadySd!=null&&r.steadySd<2.5;
  const bt=steady?null:trackSeries(S,r.bpm),wp=steady?null:warpFor(S,bt,r.bpm);
  if(!wp){r.G={T:k=>r.phase+k*beat0,K:t=>(t-r.phase)/beat0};return r}
  const rw=align(wp.S,sc.startAt>0?{...sc,startAt:wp.toU(sc.startAt)}:sc);if(!rw)return r.G={T:k=>r.phase+k*beat0,K:t=>(t-r.phase)/beat0},r;
  const beat=60/rw.bpm,T=k=>wp.toT(rw.phase+k*beat),K=t=>(wp.toU(t)-rw.phase)/beat;
  return {...rw,firstBeat:wp.toT(rw.firstBeat),phase:wp.toT(rw.phase),musicT:rw.musicT>=0?wp.toT(rw.musicT):-1,G:T&&{T,K},warped:+wp.dev.toFixed(3),steadyBpm:r.bpm}}
/* follow the beat through a stretch where the band slows down (rit.) or speeds up: start on the grid, look for the drum hit
   near each next expected beat (more room on the late side), and let the beat length follow what is found.
   Returns the beat times (s) for n beats from t0, or null when the drums are too unclear to follow. */
function trackBeats(buf,t0,beat,n){
  const S=seriesFromBuffer(buf,(buf.length/buf.sampleRate)+2),N=S.f.length;if(N<100)return null;
  const ol=onsetN(S.lo,N),oh=onsetN(S.hi,N),op=onsetN(S.perc,N),of=onsetN(S.f,N);
  const od=new Float32Array(N);for(let i=0;i<N;i++)od[i]=(ol?ol[i]:0)+(oh?oh[i]*0.7:0)+(op?op[i]*0.5:0)+(of?of[i]*0.3:0);
  const fx=t=>(t-(buf.from||0)-S.t0)/HOP,pk=t=>{const x=Math.round(fx(t));let m=0;for(let d=-2;d<=2;d++){const v=od[x+d]||0;if(v>m)m=v}return m};
  // the slowing as one smooth curve: steady until beat s, then each beat a little longer than the one before
  // (t_k = t0 + k*beat + c*(k-s)^2 after s). Every (s, c) is tried against the drum hits; c = 0 is "no slowing".
  const T=(s0,c,e,k)=>t0+e+k*beat+(k>s0?c*(k-s0)*(k-s0):0);
  const score=(s0,c,e)=>{let v=0;for(let k=0;k<n;k++){const t=T(s0,c,e,k);v+=pk(t)+0.5*pk(t+beat/2+(k>=s0?c*((k+0.5-s0)*(k+0.5-s0)-(k-s0)*(k-s0)):0))}return v};
  let base=-1,be=0;for(let e=-0.03;e<=0.0301;e+=0.005){const v=score(n,0,e);if(v>base){base=v;be=e}}
  let best=base,bs=n,bc=0,bestE=be;
  for(let s0=0;s0<n-2;s0++)for(let c=0.004;c<=beat*0.09;c*=1.25){const v=score(s0,c,be);if(v>best){best=v;bs=s0;bc=c}}
  if(bc>0)for(let e=-0.03;e<=0.0301;e+=0.005){const v=score(bs,bc,e);if(v>best){best=v;bestE=e}}
  const out=[];for(let k=0;k<n;k++)out.push(T(bs,bc,bestE,k));
  return {times:out,slow:bc>0&&best>base*1.08,gain:base>0?best/base:1,start:bs,c:bc}}
/* how much later (s) recording A hears the same sound than recording B/* how much later (s) recording A hears the same sound than recording B, over B's stretch (onset envelopes at 200 Hz) */
function xLag(A,Bf){const env=(buf,t0,t1)=>{const sr=buf.sampleRate,x=buf.getChannelData(0),f=buf.from||0,h=sr/200,m=Math.floor((t1-t0)*200),o=new Float32Array(m);let pv=0;
    for(let i=0;i<m;i++){const a=Math.floor((t0-f)*sr+i*h),z=Math.floor((t0-f)*sr+(i+1)*h);let e=0,c=0;for(let j=Math.max(0,a);j<Math.min(x.length,z);j++){e+=x[j]*x[j];c++}const v=c?Math.sqrt(e/c):0;o[i]=Math.max(0,v-pv);pv=v}return o};
  const t0=(Bf.from||0)+0.4,t1=(Bf.from||0)+Bf.length/Bf.sampleRate-0.4;if(t1-t0<3)return null;
  const eb=env(Bf,t0,t1),ea=env(A,t0-0.25,t1+0.25),M=50;let best=-1,bl=0;const sc=[];
  for(let L=-M;L<=M;L++){let s=0;for(let i=0;i<eb.length;i++)s+=(ea[i+M+L]||0)*eb[i];sc.push(s);if(s>best){best=s;bl=L}}
  const srt=[...sc].sort((a,b)=>a-b),med=srt[srt.length>>1];return {lag:bl/200,q:best>0?(best-med)/best:0}}
async function refine(r,sc,getBuf,opt){
  if(global.__noRefine){const o={...r};delete o.G;return o}
  const firstOn=sc.act?sc.act.indexOf(1):-1,beat=60/r.bpm,G=r.G||{T:k=>r.phase+k*beat,K:t=>(t-r.phase)/beat},GT=G.T;
  const out={...r};delete out.G;let lag=0;
  if(firstOn>0&&!(sc.startAt>0)){const e1=r.k0+firstOn,e2=(r.musicStart>=0?r.musicStart:r.k0)+firstOn;let ka=Math.min(e1,e2)-8,kb=Math.max(e1,e2)+12;if(kb-ka>56){ka=e2-12;kb=e2+16}
    const ta=Math.max(0,GT(ka)-0.4),tb=GT(kb),b=tb-ta>4?await getBuf(ta,tb,'entry'):null;
    if(b){const B=Math.max(1,Math.round(sc.bar||4)),bo=(((sc.barOff||0)%B)+B)%B,db=r.byStart?(((r.k0+bo)%B)+B)%B:r.downbeat;
      // (the bar where the drums first play: a score whose first playing bar is only a fill in its last beats counts that bar)
      const fb=firstOn-(((firstOn-bo)%B)+B)%B;
      const rr=entryRefine(b,{expect:e2,phase:r.phase,beat,firstOn:fb,bar:sc.bar,downbeat:db,barConf:r.byStart?1:r.barConf,T:G.T,K:G.K});out.phase2=rr&&{kE:rr.kE,barStart:rr.barStart,k0:rr.k0,contrast:rr.contrast};
      // only which bar: the timing from the whole song is steadier than this short window's (checked on real songs)
      if(rr&&rr.kE!=null){let k0=rr.k0;
        // the entry seen in the recording can be the fill or the first full bar: the score's beat-by-beat rests decide
        if(rr.D){let bv=-1e9;const CS=[rr.k0-3*B,rr.k0-2*B,rr.k0-B,rr.k0,rr.k0+B,rr.k0+2*B],priorIn=CS.includes(r.k0);for(const c of CS){let s1=0,n1=0,s0=0,n0=0;for(let j=Math.max(0,fb-12);j<Math.min(sc.act.length,fb+12);j++){const d=rr.D[c+j];if(d==null)continue;if(sc.act[j]){s1+=Math.min(1,d);n1++}else{s0+=Math.min(1,d);n0++}}
          const v=n1>=4&&n0>=2?s1/n1-s0/n0:-9;if(global.__entDbg)global.__entDbg.push([c,+v.toFixed(3),rr.kE,rr.barStart]);if(global.__entAll)global.__entAll.push({c,v,prior:r.k0,rk:rr.k0});
          // the bar from the song's start (r.k0) is the steadier answer: this short window's rest/play contrast has to beat it clearly
          const vb=v+(c===r.k0?(global.__bp!=null?global.__bp:0.1):0)+(c===rr.k0?(global.__br!=null?global.__br:0):0)-(priorIn?(global.__dp!=null?global.__dp:0.03)*Math.abs(c-r.k0)/B:0);if(vb>bv){bv=vb;k0=c}}}
        out.k0=k0;out.entryChecked=true}out.__eb=b}}
  // a score starting mid-song with close candidates for bar 1: listen closer (1/4 speed resolution) around the score's
  // first rests and let the kick drum there decide (the fast pass hears the low drums only roughly)
  if(r.hinted&&r.hintCands&&r.hintCands.length>1&&sc.act&&getBuf){const B=Math.max(1,Math.round(sc.bar||4)),act=sc.act,nb=Math.floor(act.length/B);
    const restBar=m=>{for(let j=0;j<B;j++)if(act[m*B+j])return false;return true};let m0=-1,m1=-1;
    for(let m=0;m<nb;m++){if(restBar(m)){if(m0<0)m0=m;m1=m}else if(m0>=0)break}
    if(m0>=0){const ks=r.hintCands.map(c=>c[0]),lo=Math.min(...ks)+(m0-3)*B,hi=Math.max(...ks)+(m1+4)*B;
      const ta=Math.max(0,GT(lo)-3),tb=GT(hi)+1,b=tb-ta>3?await getBuf(ta,tb,'bar'):null;
      if(b){const S=seriesFromBuffer(b,tb-ta+2),L=S.lo,n=L.length,cs=new Float64Array(n+1);for(let i=0;i<n;i++)cs[i+1]=cs[i]+L[i];
        const bg=i=>{const a=Math.max(0,i-15),c=Math.min(n,i+16);return (cs[c]-cs[a])/(c-a)},fr=t=>(t-ta-S.t0)/0.01,
          pk=t=>{const x=fr(t);let m=0;for(let d=-3;d<=3;d++){const i=Math.round(x)+d;if(i<0||i>=n)continue;const v=L[i]-bg(i);if(v>m)m=v}return m};
        // this recording's own timing can sit a few tens of ms off the fast pass: find that first (all candidates share the beats)
        let dl=0;{const kA=Math.min(...ks)+(m0-3)*B,kZ=Math.max(...ks)+(m1+4)*B;let bv=-1;for(let L=-0.12;L<=0.1201;L+=0.01){let v=0;for(let k=kA;k<kZ;k++)v+=pk(GT(k)+L);if(v>bv){bv=v;dl=L}}}
        const kick=k=>pk(GT(k)+dl)+pk((GT(k)+GT(k+1))/2+dl);
        // (a stretch the recording missed - the first moments after it jumps there - is silent: those bars do not count)
        const X=b.getChannelData(0),bsr=b.sampleRate,bf=b.from||ta,heard=k=>{const a=Math.max(0,Math.round((GT(k)-bf)*bsr)),z=Math.min(X.length,Math.round((GT(k+B)-bf)*bsr));if(z-a<10)return false;let nz=0;for(let i=a;i<z;i+=7)if(X[i]!==0)nz++;return nz>(z-a)/7*0.9};
        const sc2=r.hintCands.map(([k,v,f])=>{const bar=[],rest=[];for(let m=Math.max(0,m0-3);m<=Math.min(nb-1,m1+3);m++){if(!heard(k+m*B)){bar.push(null);rest.push(restBar(m));continue}const vs=[];for(let j=0;j<B;j++)vs.push(kick(k+m*B+j));vs.sort((x,y)=>y-x);bar.push((vs[0]+vs[1])/2);rest.push(restBar(m))}
          let c=0,cn=0;for(let i=0;i<bar.length;i++){if(!rest[i]||bar[i]==null)continue;let l=0,ln=0;for(let q=i-3;q<=i+3;q++)if(q>=0&&q<bar.length&&!rest[q]&&bar[q]!=null){l+=bar[q];ln++}if(ln>=2){l/=ln;c+=Math.max(-1,Math.min(1,(l-bar[i])/Math.max(1e-9,l)));cn++}}
          const f2=cn?c/cn:0;return {k,v:v-7*(f||0)+10*f2,f2}});
        sc2.sort((a,b)=>b.v-a.v);out.barCheck=sc2.map(x=>[x.k,+x.v.toFixed(2),+x.f2.toFixed(3)]);out.k0=sc2[0].k}}}
  // a fast recording of a video is placed in song time from the player's clock, and that placement is off by a few
  // milliseconds of real time each session; at 16x speed that is tens of milliseconds of song (the beats came out late,
  // and the tempo a little off). Two short listens at normal speed - early and late in the score - are exact: line the
  // fast recording up against each and correct the grid (offset, and tempo from the two)
  let GT2=GT;
  if(opt&&opt.fast&&opt.slow){const nAct=sc.act?sc.act.length:64,songEnd=(r.songSecs||sc.dur||1e9)-0.5,W=6;
    const k1=out.k0+Math.max(0,firstOn)+2,k2=out.k0+Math.max(firstOn+8,nAct-16);
    const pts=[];
    for(const [ta,tb] of [[GT(k1),GT(k1)+W],[GT(k2)-W,GT(k2)]]){const a2=Math.max(0,ta),b2=Math.min(songEnd,tb);if(b2-a2<3)continue;if(pts.length&&Math.abs(a2-pts[0].t)<W*2)continue;
      const b=await opt.slow(a2,b2);if(!b)continue;const L=xLag(opt.fast,b);if(L&&L.q>0.3&&Math.abs(L.lag)<0.24)pts.push({t:(a2+b2)/2,lag:L.lag,q:L.q})}
    out.latCheck=pts;
    if(pts.length===1){const c=-pts[0].lag;GT2=k=>GT(k)+c;lag=c}
    else if(pts.length===2){const [p1,p2]=pts,sl=(p2.lag-p1.lag)/(p2.t-p1.t);
      if(Math.abs(sl)<0.004){const corr=t=>-(p1.lag+sl*(t-p1.t));GT2=k=>{const t=GT(k);return t+corr(t)};lag=corr(GT(out.k0));
        if(!r.warped){let nb=r.bpm/(1-sl);if(Math.abs(nb-Math.round(nb))<0.035)nb=Math.round(nb);out.bpm=Math.round(nb*100)/100}}
      else{const c=-(p1.lag+p2.lag)/2;GT2=k=>GT(k)+c;lag=c}}}
  delete out.__eb;out.lagFix=lag;
  // (drums from the start: the whole-song pass already has bar 1 and the timing)
  out.firstBeat=GT2(out.k0);out.phase=r.phase+lag;
  // the map covers the score and the whole recording (a score shorter than the song, repeats, an outro)
  if(r.warped){const u=sc.unit||1,pre=8,nQ=Math.ceil((sc.act?sc.act.length:0)/u)+16,end=(r.songSecs||sc.dur||0)+4,t=[];for(let q=-pre;(q<nQ||GT(out.k0+q*u)<end)&&q<6000;q++)t.push(GT2(out.k0+q*u));out.map={i0:pre,t}}
  return out}
function fromParts(parts,clock,sr,R,from){
  from=from||0;const sr2=sr/R,C=clock.filter(c=>!c[2]),segs=[];let a=0;
  while(a<C.length){let b=a+1,k=R;
    while(b<C.length){const dt=C[b][0]-C[b-1][0],dm=C[b][1]-C[b-1][1];
      if(dt>0.35||dm<-0.02||Math.abs(dm-dt*k)>0.1+dt*k*0.35)break;
      if(b-a>=5){const T=C[b][0]-C[a][0];if(T>0.15)k=(C[b][1]-C[a][1])/T}b++}
    if(b-a>=5){let sx=0,sy=0,sxx=0,sxy=0;const m=b-a;for(let i=a;i<b;i++){const X=C[i][0],Y=C[i][1];sx+=X;sy+=Y;sxx+=X*X;sxy+=X*Y}
      const d=m*sxx-sx*sx;let kk=d?(m*sxy-sx*sy)/d:k;
      // the player runs at an exact speed: snap the noisy estimate to it (R, or whatever standard speed it really used)
      for(const q of [R,16,8,4,2,1.5,1.25,1])if(Math.abs(kk/q-1)<0.02){kk=q;break}
      const c=(sy-kk*sx)/m;
      if(kk>0.5)segs.push({t0:C[a][0]-0.04,t1:C[b-1][0]+0.04,k:kk,c})}
    a=b}
  let end=0;for(const g of segs)end=Math.max(end,g.k*g.t1+g.c);
  const len=Math.max(1,Math.ceil((end+1-from)*sr2)),d=new Float32Array(len);let si=0;
  for(const pt of parts){const x=pt.x;
    for(let bi=0;bi<pt.idx.length;bi++){const [off,f0]=pt.idx[bi],nxt=bi+1<pt.idx.length?pt.idx[bi+1][0]:x.length;
      for(let i=off;i<nxt;i++){const ta=(f0+i-off)/sr;
        while(si>0&&ta<segs[si].t0)si--;while(si<segs.length-1&&ta>segs[si].t1)si++;const g=segs[si];if(!g||ta<g.t0||ta>g.t1)continue;
        const k=Math.round((g.k*ta+g.c-from)*sr2);if(k>=0&&k<len)d[k]=x[i]/32767}}}
  let rate=0,w=0;for(const g of segs){rate+=g.k*(g.t1-g.t0);w+=g.t1-g.t0}
  return {sampleRate:sr2,length:len,numberOfChannels:1,getChannelData:()=>d,songSecs:end,rate:w?rate/w:R,segs:segs.length,from};
}
function b64i16(b64){const bin=atob(b64),u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return new Int16Array(u8.buffer)}

/* second look, at a speed that keeps the cymbal band: where exactly do the drums come in, and which beat is the
   bar's first beat there. g = {phase, beat, firstOn, bar}: the beat grid from the fast pass (beat k at phase+k*beat). */
function entryRefine(buf,g){
  const S=seriesFromBuffer(buf,200),n=S.f.length;if(n<200)return null;
  const ol=onsetN(S.lo,n),oh=onsetN(S.hi,n),op=onsetN(S.perc,n),of=onsetN(S.f,n),on=onsetN(S.noise,n),om=onsetN(S.mi,n);if(!of)return null;
  const de=new Float32Array(n);for(let i=0;i<n;i++)de[i]=(ol?ol[i]*0.5:0)+(oh?oh[i]:0)+(on?on[i]*0.5:(op?op[i]*0.5:0));
  const T=g.beat/HOP,fx=t=>(t-buf.from-S.t0)/HOP;
  const peak=(arr,x)=>{if(!arr)return 0;let m=0;for(let d=-3;d<=3;d++){const v=arr[Math.round(x)+d]||0;if(v>m)m=v}return m};
  const locked=(env,x)=>{let b=0,c=0;for(let y=Math.round(x-T*0.1);y<Math.round(x+T*0.9);y++){if(y<0||y>=n)continue;b+=env[y];c++}b=c?b/c:0;return Math.max(0,0.6*peak(env,x)+0.4*peak(env,x+T/2)-1.2*b)};
  const GT=g.T||(k=>g.phase+k*g.beat),GK=g.K||(t=>(t-g.phase)/g.beat);
  const k1=Math.ceil(GK(buf.from+0.1)),k2=Math.floor(GK(buf.from+n*HOP-0.3));if(k2-k1<10)return null;
  const D={},Kk={},Sn={},Cr={};let mx=0;
  for(let k=k1;k<=k2;k++){const x=fx(GT(k));D[k]=locked(de,x);Kk[k]=peak(ol,x);Sn[k]=peak(om,x)+peak(oh,x);Cr[k]=peak(oh||of,x);if(D[k]>mx)mx=D[k]}
  if(!(mx>0))return null;for(let k=k1;k<=k2;k++)D[k]/=mx;
  // the entry: where the drum activity jumps and stays
  let kE=null,best=-1,bestP=-9;
  for(let k=k1+3;k<=k2-5;k++){let a=0,b=0,na=0,nb=0;for(let j=0;j<6&&k+j<=k2;j++){a+=D[k+j];na++}for(let j=1;j<=6&&k-j>=k1;j++){b+=D[k-j];nb++}
    a/=na;b/=nb;const c=a-b,cp=c-(g.expect!=null?0.005*Math.abs(k-g.expect):0);if(a>=0.35&&cp>bestP){bestP=cp;best=c;kE=k}}
  if(global.__erDbg)global.__erDbg.push({k1,k2,D:Object.fromEntries(Object.entries(D).map(([k,v])=>[k,+v.toFixed(2)])),kE,best:+best.toFixed(3),expect:g.expect});
  if(kE==null||best<0.2)return {kE:null,contrast:best};
  // drums may come in with a pickup before the bar: the bar starts at or before the entry; pick the one the accents agree with
  const B=Math.max(1,Math.round(g.bar||4));const acc=[];
  for(let p=0;p<B;p++){let s2=0,c=0;for(let k=kE+((p-kE)%B+B)%B;k+B<=k2+1;k+=B){c++;let v=Kk[k]+1.0*Cr[k]-0.6*Sn[k];
      if(B===4)v+=0.5*(Kk[k+2]||0)+(Sn[k+1]||0)+(Sn[k+3]||0)-0.4*((Kk[k+1]||0)+(Kk[k+3]||0))-0.5*(Sn[k+2]||0)-0.3*(Cr[k+2]||0);
      s2+=v}acc.push(c?s2/c:-9)}
  // candidates: the first playing bar starts at kE-j (j = 0..B-1); its start must line up with a bar accent
  let bj=0,bv=-1e9;
  // the fast pass already knows which beat is the bar's first (chord changes, kick/snare over the whole song): use it when it is clear
  if(g.downbeat!=null&&g.barConf>=0.3)bj=((kE-g.downbeat)%B+B)%B;
  else for(let j=0;j<B;j++){const p=((kE-j)%B+B)%B;const v=acc[p]-0.05*j;if(v>bv){bv=v;bj=j}}
  const srt=[...acc].sort((a,b)=>b-a);
  // fine timing of the beat grid from the clear drums after the entry (the fast pass is a little blurrier)
  let lag=0,bl=-1;for(let L=-0.06;L<=0.0601;L+=0.002){let v=0;for(let k=kE;k<=k2;k++)v+=peak(de,fx(GT(k)+L));if(v>bl){bl=v;lag=L}}
  // this envelope peaks a little before the attack the fast pass is calibrated to (measured on test songs: 26 ms)
  lag+=0.026;
  return {kE,barStart:kE-bj,k0:kE-bj-g.firstOn,contrast:best,accMargin:srt[0]-(srt[1]||0),lag,D,k1,k2};
}

/* fine timing of the beat grid from a short clear stretch with drums (recorded at 4x): seconds to add to the phase */
function fineLag(buf,g){
  const S=seriesFromBuffer(buf,60),n=S.f.length;if(n<100)return null;
  const ol=onsetN(S.lo,n),oh=onsetN(S.hi,n),on=onsetN(S.noise,n),op=onsetN(S.perc,n);
  const de=new Float32Array(n);for(let i=0;i<n;i++)de[i]=(ol?ol[i]*0.5:0)+(oh?oh[i]:0)+(on?on[i]*0.5:(op?op[i]*0.5:0));
  const fx=t=>(t-buf.from-S.t0)/HOP,peak=x=>{let m=0;for(let d=-2;d<=2;d++){const v=de[Math.round(x)+d]||0;if(v>m)m=v}return m};
  const GT=g.T||(k=>g.phase+k*g.beat),GK=g.K||(t=>(t-g.phase)/g.beat);
  const k1=Math.ceil(GK(buf.from+0.15)),k2=Math.floor(GK(buf.from+n*HOP-0.2));if(k2-k1<6)return null;
  const sc=[];let lag=0,bl=-1;for(let L=-0.06;L<=0.0601;L+=0.002){let v=0;for(let k=k1;k<=k2;k++)v+=peak(fx(GT(k)+L));sc.push(v);if(v>bl){bl=v;lag=L}}
  const srt=[...sc].sort((a,b)=>a-b),med=srt[srt.length>>1];
  return {lag:lag+0.015,sal:bl>0?(bl-med)/bl:0};   // +15 ms: same calibration as entryRefine (measured)
}

/* live check while the song plays: how far (seconds) the drums land from the expected beats in this stretch.
   buf starts at song time buf.from; beats = song times of beats where the score has drums */
function phaseError(buf,beats){
  const S=seriesFromBuffer(buf,60),n=S.f.length;if(n<100)return null;
  const ol=onsetN(S.lo,n),oh=onsetN(S.hi,n),op=onsetN(S.perc,n);
  const od=new Float32Array(n);for(let i=0;i<n;i++)od[i]=(ol?ol[i]:0)+(oh?oh[i]:0)+(op?op[i]*0.5:0);
  const at=t=>{const x=(t-buf.from-S.t0)/HOP;let m=0;for(let d=-1;d<=1;d++){const v=od[Math.round(x)+d]||0;if(v>m)m=v}return m};
  const use=beats.filter(t=>t-buf.from>0.15&&t-buf.from<buf.length/buf.sampleRate-0.15);if(use.length<4)return null;
  const sc=[];let best=-1,bl=0;
  for(let lag=-0.1;lag<=0.1001;lag+=0.002){let s=0;for(const t of use)s+=at(t+lag);s/=use.length;sc.push(s);if(s>best){best=s;bl=lag}}
  const srt=[...sc].sort((a,b)=>a-b),med=srt[srt.length>>1];
  return {lag:bl+0.010,sal:best>0?(best-med)/best:0,n:use.length,strength:best};   // +10 ms: measured bias of this envelope
}

const SR_A=24000,ENS_VARIANTS=[[3.3,0],[6.6,0]];
function resampleTo(x,sr,sr2){if(Math.abs(sr-sr2)<0.5)return x;
  let y=x;if(sr>sr2*1.05){const w=Math.max(2,Math.round(sr/sr2));y=new Float32Array(x.length);let acc=0;
    for(let i=0;i<x.length;i++){acc+=x[i];if(i>=w)acc-=x[i-w];y[i]=acc/Math.min(i+1,w)}}
  const sh=sr>sr2*1.05?(Math.max(2,Math.round(sr/sr2))-1)/2:0,m=Math.floor(x.length*sr2/sr),o=new Float32Array(m),k=sr/sr2;
  for(let i=0;i<m;i++){const t=i*k+sh,j=Math.floor(t),f=t-j;o[i]=(y[j]||0)*(1-f)+(y[j+1]||0)*f}return o}
function resampleBuf(b,sr2){const sr=b.sampleRate;if(Math.abs(sr-sr2)<0.5)return b;const o=resampleTo(b.getChannelData(0),sr,sr2);
  return {sampleRate:sr2,length:o.length,numberOfChannels:1,getChannelData:()=>o,from:b.from}}
global.Tempo={
  phaseError,entryRefine,fineLag,trackBeats,trackSeries,makeGrid,refine,alignSong,
  fromParts,b64i16,xLag,
  alignFast:(buf,sc)=>{const r=alignSong(seriesFromBuffer(buf,420),sc||{});if(r)r.songSecs=buf.length/buf.sampleRate;return r},
  alignParts:(parts,clock,sr,R,sc,track)=>{const b=fromParts(parts,clock,sr,R);if(b.songSecs<6)return null;const S=seriesFromBuffer(b,420);const r=track?alignSong(S,sc||{}):align(S,sc||{});if(r){r.songSecs=b.songSecs;r.rate=b.rate;r.segs=b.segs}return r},
  alignBuffer:(buf,sc,maxSec)=>align(seriesFromBuffer(buf,maxSec||120),sc||{}),
  // a whole audio file: exactly the YouTube pipeline (fast look at 1/16 resolution for tempo, grid and bar 1, then a closer
  // 1/4 look where the drums come in, or at a clear stretch of drums for the exact timing)
  // a whole audio file: the same steps as for YouTube (fast look at 1/16 resolution, closer look at 1/4)
  alignFile1:async(buf,sc,maxSec,opt)=>{sc=sc||{};const sr0=buf.sampleRate,L0=Math.min(buf.length,Math.round((maxSec||420)*sr0));
    const mono0=new Float32Array(L0);for(let c=0;c<buf.numberOfChannels;c++){const x=buf.getChannelData(c);for(let i=0;i<L0;i++)mono0[i]+=x[i]/buf.numberOfChannels}
    // the analysis frames are counted in samples: the same song at another sample rate (a 44.1 kHz file, a 48 kHz
    // computer, a recording at 2x or 4x) came out a bar off now and then. Everything is analysed at one rate.
    const sr=global.__noRes?sr0:SR_A,mono=global.__noRes?mono0:resampleTo(mono0,sr0,SR_A),L=mono.length;
    // the same song can come in louder or softer (the video's loudness normalisation, a different file): the analysis
    // works on log magnitudes with fixed floors, so bring the song to a fixed level first (95th percentile of 10 ms RMS)
    {const w=Math.max(1,Math.round(sr*0.01)),rs=[];for(let i=0;i+w<=L;i+=w){let e=0;for(let j=0;j<w;j++)e+=mono[i+j]*mono[i+j];rs.push(Math.sqrt(e/w))}
      rs.sort((a,b)=>a-b);const p=rs[Math.floor(rs.length*0.95)]||0;if(p>1e-5&&!global.__noNorm){const g=0.2/p;for(let i=0;i<L;i++)mono[i]*=g}}
    const dec=(R,a,b)=>{a=Math.max(0,Math.round(a*sr));b=Math.min(L,Math.round(b*sr));const m=Math.max(0,Math.floor((b-a)/R)),o=new Float32Array(m);
      for(let i=0;i<m;i++){let s=0;for(let j=0;j<R;j++)s+=mono[a+i*R+j];o[i]=s/R}return {sampleRate:sr/R,length:m,numberOfChannels:1,getChannelData:()=>o,from:a/sr}};
    const R1=sr>=32000?16:sr>=16000?8:4,R2=sr>=32000?4:sr>=16000?2:1;
    const S=seriesFromBuffer(dec(R1,0,L/sr),maxSec||420);const r=alignSong(S,{...sc,dur:sc.dur||L/sr});if(!r)return r;
    r.songSecs=L/sr;const gb=opt&&opt.getBuf;
    return refine(r,sc,async(a,b,why)=>{if(gb&&(why==='entry'||why==='bar')){const x=await gb(a,b,why);if(x)return global.__noRes?x:resampleBuf(x,sr/R2)}return b<=L/sr+1?dec(R2,a,b):null},opt)},
  // the bar choice rests on many small decisions; a few milliseconds of shift can tip a close one. Listen three times
  // (as is, and moved by 1/3 and 2/3 of an analysis frame) and keep the bar most of them agree on.
  alignFile:async(buf,sc,maxSec,opt)=>{const T=globalThis.Tempo||global.Tempo;const r0=await T.alignFile1(buf,sc,maxSec,opt);
    if(!r0||r0.map||global.__noEns)return r0;const sr=buf.sampleRate,beat=60/r0.bpm,votes=[0];
    const VAR=global.__ens||ENS_VARIANTS;
    for(const [ms,lp] of VAR){const d=Math.round(sr*ms/1000),n=buf.length+d;let y=new Float32Array(n);
      for(let c=0;c<buf.numberOfChannels;c++){const xc=buf.getChannelData(c);for(let i=0;i<buf.length;i++)y[i+d]+=xc[i]/buf.numberOfChannels}
      if(lp)y=resampleTo(resampleTo(y,sr,11025),11025,sr).subarray(0,n);
      const b2={sampleRate:sr,length:y.length,numberOfChannels:1,getChannelData:()=>y,from:buf.from};
      const r=await T.alignFile1(b2,sc,maxSec&&maxSec+1,opt);if(!r||r.map||Math.abs(r.bpm-r0.bpm)>0.01)continue;
      const q=(r.firstBeat-d/sr-r0.firstBeat)/beat;if(Math.abs(q-Math.round(q))<0.25)votes.push(Math.round(q))}
    const cnt={};for(const v of votes)cnt[v]=(cnt[v]||0)+1;let best=0;for(const v in cnt)if(cnt[v]>cnt[best])best=+v;
    if(best!==0&&cnt[best]>=2&&cnt[best]>(cnt[0]||0)){const o={...r0};o.firstBeat=r0.firstBeat+best*beat;o.k0=(r0.k0||0)+best;o.ensemble=votes;return o}
    r0.ensemble=votes;return r0},
  alignSeries:(s,sc,lag)=>{const r=align(seriesFromLive(s),sc||{});if(r){r.firstBeat=r.firstBeat-(lag==null?0.09:lag);r.phase-= (lag==null?0.09:lag)}return r},
  fromBuffer:(buf,maxSec)=>analyse(seriesFromBuffer(buf,maxSec||120)),
  fromSeries:s=>{const r=analyse(seriesFromLive(s));if(r)r.firstBeat=Math.max(0,r.firstBeat-0.09);return r}, // live analyser at 4x lags ~90 ms of music
  _fft:fft
};
})(typeof window!=='undefined'?window:globalThis);
