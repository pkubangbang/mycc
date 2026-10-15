// SECOND ML autopilot: a hill-climbing LINEAR PERCEPTRON pilot.
//
// This is a genuinely DIFFERENT machine-learning method from autopilot-ml.cjs
// (which evolves an 8-neuron hidden layer). Here the policy is a single linear
// function of the same 6 features plus a bias:
//
//     flap  <=>  w0*x0 + w1*x1 + ... + w5*x5 + b  >  0
//
// The weights are learned by (1+1) hill-climbing / stochastic search: keep the
// best weight vector, propose a Gaussian-perturbed candidate, keep it if its
// survival-fitness improves. No hidden layer, no population, no backprop.
// Shares the exact game physics mirror with autopilot-ml.cjs.

const GRAVITY = 0.45, FLAP_VELOCITY = -7.6, MAX_FALL_V = 11;
const GROUND_H = 96, PIPE_W = 62, PIPE_GAP = 150, PIPE_SPACING = 210;
const BASE_SPEED = 2.4, SPEED_RAMP = 0.0009, W = 360, H = 640;

let seed = 1;
function srand(s){seed=s>>>0;}
function rand(){seed^=seed<<13;seed>>>=0;seed^=seed>>17;seed^=seed<<5;seed>>>=0;return seed/4294967296;}
// gaussian via Box-Muller
function gauss(){ let u=0,v=0; while(u===0)u=rand(); while(v===0)v=rand(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

// ---------- linear policy ----------
const NIN = 6;
function makeW(){ const w=[]; for(let i=0;i<NIN;i++) w.push((rand()*2-1)*0.5); w.push((rand()*2-1)*0.5); return w; } // 6 weights + bias
function policyFlap(w, x){ let s=w[NIN]; for(let i=0;i<NIN;i++) s+=w[i]*x[i]; return s>0; }
function mutateW(w, sigma){
  const c=w.slice();
  for(let i=0;i<c.length;i++) if(rand()<0.35) c[i]+=gauss()*sigma;
  return c;
}

// ---------- game mirror ----------
let bird, pipes, score, frame, speed, autoFlapCool;
function addPipe(x){const margin=70;const minTop=margin;const maxTop=H-GROUND_H-PIPE_GAP-margin;const topH=minTop+rand()*(maxTop-minTop);pipes.push({x,topH,scored:false});}
function reset(){score=0;frame=0;speed=BASE_SPEED;pipes=[];autoFlapCool=0;bird={x:92,y:H/2-60,vy:0,r:16};let s=W+40;for(let i=0;i<4;i++)addPipe(s+i*PIPE_SPACING);}
function doFlap(){bird.vy=FLAP_VELOCITY;autoFlapCool=2;}
function nearestPipe(){ for(const p of pipes){ if(p.x+PIPE_W >= bird.x-bird.r) return p; } return null; }
function circleRect(cx,cy,r,rx,ry,rw,rh){const nx=Math.max(rx,Math.min(cx,rx+rw));const ny=Math.max(ry,Math.min(cy,ry+rh));const dx=cx-nx,dy=cy-ny;return dx*dx+dy*dy<r*r;}
function collides(){for(const p of pipes){if(p.x>bird.x+bird.r||p.x+PIPE_W<bird.x-bird.r)continue;if(circleRect(bird.x,bird.y,bird.r-2,p.x,0,PIPE_W,p.topH))return true;const by=p.topH+PIPE_GAP;if(circleRect(bird.x,bird.y,bird.r-2,p.x,by,PIPE_W,H-GROUND_H-by))return true;}return false;}
function inputs(){
  const t=nearestPipe(); const play=H-GROUND_H;
  const gapTop=t?t.topH:play*0.5, gapC=t?t.topH+PIPE_GAP*0.5:play*0.5;
  const dist=t?Math.min(PIPE_SPACING,(t.x-bird.x)):PIPE_SPACING;
  return [ bird.vy/MAX_FALL_V, (bird.y-play*0.5)/(play*0.5), gapTop/H, gapC/H, dist/PIPE_SPACING, (bird.y-gapC)/H ];
}
function stepWith(w){
  frame++; speed=BASE_SPEED+score*SPEED_RAMP;
  if(autoFlapCool>0) autoFlapCool--;
  else if(policyFlap(w, inputs())) doFlap();
  bird.vy+=GRAVITY; if(bird.vy>MAX_FALL_V)bird.vy=MAX_FALL_V; bird.y+=bird.vy;
  if(bird.y<bird.r){bird.y=bird.r;bird.vy=0;}
  for(const p of pipes){p.x-=speed;if(!p.scored&&p.x+PIPE_W<bird.x){p.scored=true;score++;}}
  if(pipes.length&&pipes[0].x+PIPE_W<-10){pipes.shift();addPipe(pipes[pipes.length-1].x+PIPE_SPACING);}
  if(collides())return{score,reason:"pipe"};
  if(bird.y+bird.r>=H-GROUND_H){bird.y=H-GROUND_H-bird.r;return{score,reason:"ground"};}
  return{score,reason:"alive"};
}
function runOne(w,sd,maxScore){ srand(sd); reset(); let s=0; while(s<maxScore){const r=stepWith(w); if(r.reason!=="alive")return{score:r.score,frames:frame}; s=r.score;} return{score:maxScore,frames:frame}; }
function fitness(w,seeds,maxScore,clamp){ let total=0; for(const sd of seeds){const r=runOne(w,sd,maxScore); total+=Math.min(r.score,clamp)*10+Math.min(r.frames,3000)*0.5;} return total/seeds.length; }

if(require.main===module){
  const iters=parseInt(process.argv[2]||"4000",10);
  const N=parseInt(process.argv[3]||"300",10);
  const seeds=[]; for(let i=1;i<=10;i++) seeds.push(i*13+5);
  const MAX=900, CLAMP=700;
  // Population-based hill-climbing ("(mu+lambda)"): keep a pool of survivors,
  // breed perturbed children from the best few. Unlike a single (1+1) climber
  // this can cross the sparse-reward valley before the first pipe.
  const POP=40, ELITE=8;
  let pop=[]; for(let i=0;i<POP;i++) pop.push(makeW());
  let best=null,bestFit=-1;
  const fitOf=w=>fitness(w,seeds,MAX,CLAMP);
  for(let it=0; it<iters; it++){
    const scored=pop.map(w=>({w,f:fitOf(w)})).sort((a,b)=>b.f-a.f);
    if(scored[0].f>bestFit){bestFit=scored[0].f;best=scored[0].w.slice();}
    if(it%20===0){
      console.log("it"+it,"best="+bestFit.toFixed(1));
      require("fs").writeFileSync("lin-net.json",JSON.stringify({w:best,it,bestFit}));
    }
    const sigma=0.5*(1-it/(iters*1.3))+0.03;
    const next=scored.slice(0,ELITE).map(s=>s.w.slice());
    while(next.length<POP){ const p=scored[Math.floor(rand()*ELITE)].w; next.push(mutateW(p,sigma)); }
    pop=next;
  }
  require("fs").writeFileSync("lin-net.json",JSON.stringify({w:best,it:iters,bestFit}));
  const w=best;
  let crashes=0,sum=0,minScore=Infinity;const ex=[];
  for(let i=0;i<N;i++){const sc=runOne(w,i+1,500).score;sum+=sc;if(sc<minScore)minScore=sc;if(sc<500){crashes++;if(ex.length<8)ex.push("seed"+(i+1)+":s="+sc);}}
  console.log("LIN EVAL N="+N,"crashes="+crashes+" ("+(100*crashes/N).toFixed(1)+"%)","minScore="+minScore,"avg="+(sum/N).toFixed(1));
  console.log(ex.join("  "));
  console.log("w="+JSON.stringify(w));
}
module.exports={makeW,fitness,runOne,policyFlap};
