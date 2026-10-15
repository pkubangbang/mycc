// ML autopilot: a tiny feed-forward neural net trained by evolution
// (population + mutation + selection) against the EXACT game physics.
// No external deps, CommonJS (.cjs because the repo package.json is ESM).
//
// Network: 6 inputs -> 8 hidden (tanh) -> 1 output (tanh).
//   outputs > 0  => flap.
//
// Inputs (all normalised to ~[-1,1] or [0,1]):
//   0: bird.vy / MAX_FALL_V                       (vertical velocity)
//   1: (bird.y - (H-GROUND_H)/2) / ((H-GROUND_H)/2)  (height, 0 = mid)
//   2: gapTop of nearest pipe / H                 (where the top of the gap is)
//   3: gapCenter of nearest pipe / H
//   4: horizontal distance to nearest pipe / PIPE_SPACING   (0..~1)
//   5: bird.y relative to gapCenter / H           (are we above/below the gap)
//
// Objective: maximise (score) with a huge penalty for crashing early.

const GRAVITY = 0.45, FLAP_VELOCITY = -7.6, MAX_FALL_V = 11;
const GROUND_H = 96, PIPE_W = 62, PIPE_GAP = 150, PIPE_SPACING = 210;
const BASE_SPEED = 2.4, SPEED_RAMP = 0.0009, W = 360, H = 640;

let seed = 1;
function srand(s){seed=s>>>0;}
function rand(){seed^=seed<<13;seed>>>=0;seed^=seed>>17;seed^=seed<<5;seed>>>=0;return seed/4294967296;}

// ---------- tiny MLP ----------
const NIN=6, NHID=8, NOUT=1;
function makeNet(){ // random init
  const w1=[],b1=[],w2=[],b2=[];
  for(let i=0;i<NHID*NIN;i++) w1.push((rand()*2-1)*1.5);
  for(let i=0;i<NHID;i++) b1.push((rand()*2-1)*0.5);
  for(let i=0;i<NOUT*NHID;i++) w2.push((rand()*2-1)*1.5);
  for(let i=0;i<NOUT;i++) b2.push((rand()*2-1)*0.5);
  return {w1,b1,w2,b2};
}
function cloneNet(n){return {w1:n.w1.slice(),b1:n.b1.slice(),w2:n.w2.slice(),b2:n.b2.slice()};}
function mutate(n,rate,scale){
  const c=cloneNet(n);
  const arrs=[c.w1,c.b1,c.w2,c.b2];
  for(const a of arrs) for(let i=0;i<a.length;i++) if(rand()<rate) a[i]+=(rand()*2-1)*scale;
  return c;
}
function forward(netin,x){
  const h=new Array(NHID);
  for(let j=0;j<NHID;j++){let s=netin.b1[j];for(let i=0;i<NIN;i++)s+=netin.w1[j*NIN+i]*x[i];h[j]=Math.tanh(s);}
  let o=netin.b2[0];for(let j=0;j<NHID;j++)o+=netin.w2[j]*h[j];
  return Math.tanh(o);
}

// ---------- game mirror ----------
let bird, pipes, score, frame, speed, autoFlapCool;
function addPipe(x){const margin=70;const minTop=margin;const maxTop=H-GROUND_H-PIPE_GAP-margin;const topH=minTop+rand()*(maxTop-minTop);pipes.push({x,topH,scored:false});}
function reset(){score=0;frame=0;speed=BASE_SPEED;pipes=[];autoFlapCool=0;bird={x:92,y:H/2-60,vy:0,r:16};let s=W+40;for(let i=0;i<4;i++)addPipe(s+i*PIPE_SPACING);}
function doFlap(){bird.vy=FLAP_VELOCITY;autoFlapCool=2;}
function nearestPipe(){ for(const p of pipes){ if(p.x+PIPE_W >= bird.x-bird.r) return p; } return null; }
function circleRect(cx,cy,r,rx,ry,rw,rh){const nx=Math.max(rx,Math.min(cx,rx+rw));const ny=Math.max(ry,Math.min(cy,ry+rh));const dx=cx-nx,dy=cy-ny;return dx*dx+dy*dy<r*r;}
function collides(){for(const p of pipes){if(p.x>bird.x+bird.r||p.x+PIPE_W<bird.x-bird.r)continue;if(circleRect(bird.x,bird.y,bird.r-2,p.x,0,PIPE_W,p.topH))return"pipe";const by=p.topH+PIPE_GAP;if(circleRect(bird.x,bird.y,bird.r-2,p.x,by,PIPE_W,H-GROUND_H-by))return"pipe";}return null;}

function inputs(){
  const t=nearestPipe();
  const play=H-GROUND_H;
  const gapTop=t?t.topH:play*0.5, gapC=t?t.topH+PIPE_GAP*0.5:play*0.5;
  const dist=t?Math.min(PIPE_SPACING,(t.x-bird.x)):PIPE_SPACING;
  return [
    bird.vy/MAX_FALL_V,
    (bird.y-play*0.5)/(play*0.5),
    gapTop/H,
    gapC/H,
    dist/PIPE_SPACING,
    (bird.y-gapC)/H,
  ];
}

function stepWithNet(net){
  frame++; speed=BASE_SPEED+score*SPEED_RAMP;
  if(autoFlapCool>0) autoFlapCool--;
  else { const out=forward(net,inputs()); if(out>0) doFlap(); }
  bird.vy+=GRAVITY; if(bird.vy>MAX_FALL_V)bird.vy=MAX_FALL_V; bird.y+=bird.vy;
  if(bird.y<bird.r){bird.y=bird.r;bird.vy=0;}
  for(const p of pipes){p.x-=speed;if(!p.scored&&p.x+PIPE_W<bird.x){p.scored=true;score++;}}
  if(pipes.length&&pipes[0].x+PIPE_W<-10){pipes.shift();addPipe(pipes[pipes.length-1].x+PIPE_SPACING);}
  if(collides())return{score,reason:"pipe"};
  if(bird.y+bird.r>=H-GROUND_H){bird.y=H-GROUND_H-bird.r;return{score,reason:"ground"};}
  return{score,reason:"alive"};
}

function runOne(net,seedVal,maxScore){
  srand(seedVal); reset();
  let s=0;
  while(s<maxScore){ const r=stepWithNet(net); if(r.reason!=="alive") return {score:r.score,frames:frame}; s=r.score; }
  return {score:maxScore,frames:frame};
}

// fitness over a set of seeds. We reward SURVIVAL FRAMES (dense signal — the
// agent gets credit for getting closer to the first pipe even before scoring),
// plus a bonus for pipes cleared. Clamped so a few long runs don't dominate.
function fitness(net,seeds,maxScore,clamp){
  let total=0;
  for(const sd of seeds){
    const r=runOne(net,sd,maxScore);
    const sc=Math.min(r.score,clamp);
    const fr=Math.min(r.frames, 3000);            // ~ up to a few hundred seconds
    total += sc*10 + fr*0.5;                      // pipes dominate, survival guides
  }
  return total/seeds.length;
}

// ---------- evolution ----------
function train(opts){
  const POP=opts.pop||80, GENS=opts.gens||60, MAX=opts.max||120;
  const CLAMP=opts.clamp||60;
  const SEEDS=opts.seeds||(function(){const a=[];for(let i=1;i<=10;i++)a.push(i);return a;})();
  const ELITE=Math.max(2,Math.round(POP*0.15));
  let pop=[];
  for(let i=0;i<POP;i++) pop.push(makeNet());
  let best=null,bestFit=-1;
  for(let g=0;g<GENS;g++){
    const scored=pop.map(n=>({n,f:fitness(n,SEEDS,MAX,CLAMP)}));
    scored.sort((a,b)=>b.f-a.f);
    if(scored[0].f>bestFit){bestFit=scored[0].f;best=cloneNet(scored[0].n);
      if(opts.checkpoint){ try{ require("fs").writeFileSync(opts.checkpoint, JSON.stringify({gen:g,f:fitness(best,SEEDS,MAX,CLAMP),net:best})); }catch(e){} }
    }
    if(opts.log) console.log("gen"+g,"best="+scored[0].f.toFixed(2),"avg="+(scored.reduce((s,x)=>s+x.f,0)/POP).toFixed(2));
    const next=scored.slice(0,ELITE).map(x=>cloneNet(x.n));
    while(next.length<POP){
      const parent=scored[Math.floor(rand()*ELITE)].n;
      const rate=0.25, scale=0.35*(1-g/GENS)+0.05;
      next.push(mutate(parent,rate,scale));
    }
    pop=next;
  }
  return best;
}

// ---------- evaluate ----------
function evaluateNet(net,N,target){
  let crashes=0,sum=0,minScore=Infinity;const ex=[];
  for(let i=0;i<N;i++){const r=runOne(net,i+1,target);const sc=r.score;sum+=sc;if(sc<minScore)minScore=sc;if(sc<target){crashes++;if(ex.length<8)ex.push("seed"+(i+1)+":s="+sc);}}
  return{N,target,crashes,minScore,avg:sum/N,ex};
}

if(require.main===module){
  const gens=parseInt(process.argv[2]||"60",10);
  const pop=parseInt(process.argv[3]||"80",10);
  const N=parseInt(process.argv[4]||"300",10);
  // train on a broad seed set; clamp high so long runs are rewarded
  const seeds=[]; for(let i=1;i<=10;i++) seeds.push(i*13+5);
  console.log("training: pop="+pop+" gens="+gens+" seeds="+seeds.length);
  const net=train({pop,gens,max:900,clamp:700,seeds,checkpoint:"train-net.json",log:true});
  const r=evaluateNet(net,N,500);
  console.log("EVAL(train seeds) N="+r.N,"crashes="+r.crashes+" ("+(100*r.crashes/r.N).toFixed(1)+"%)","minScore="+r.minScore,"avg="+r.avg.toFixed(1));
  console.log(r.ex.join("  "));
  // hold-out: unseen seeds 1000..1099
  let hc=0,hsum=0,hmin=Infinity;const hex=[];
  for(let i=0;i<100;i++){const sc=runOne(net,1000+i,500).score;hsum+=sc;if(sc<hmin)hmin=sc;if(sc<500){hc++;if(hex.length<8)hex.push("seed"+(1000+i)+":s="+sc);}}
  console.log("HOLDOUT N=100 crashes="+hc+" ("+hc+"%) minScore="+hmin+" avg="+(hsum/100).toFixed(1));
  console.log(hex.join("  "));
  require("fs").writeFileSync("autopilot-net.json",JSON.stringify(net));
  console.log("saved autopilot-net.json");
}
module.exports={makeNet,forward,train,evaluateNet,runOne,cloneNet};
