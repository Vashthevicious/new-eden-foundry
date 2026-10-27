'use strict';
/* New Eden Foundry — application logic.
   Static site: all state lives in this browser (localStorage). Live data:
   - Jita buy/sell from Fuzzwork market aggregates (CORS-open)
   - universe average/adjusted from ESI /markets/prices/
   - character blueprints via EVE SSO (PKCE, no secret, token never leaves browser)
*/
let TYPES={}, RECIPES={}, BASE_RECIPES={}, ALTS={}, INVENT={}, GROUPS={}, NAME2ID={};
const LSKEY='nef-site-v1', SSOKEY='nef-sso-v1';
const SSO_BASE='https://login.eveonline.com/v2/oauth';
const ESI='https://esi.evetech.net/latest';
const SSO_SCOPES='esi-characters.read_blueprints.v1 esi-skills.read_skills.v1 esi-assets.read_assets.v1 esi-location.read_location.v1 esi-universe.read_structures.v1 esi-markets.structure_markets.v1';
let S={ targets:[], buy:{}, me:{}, te:{}, stock:{}, prices:{}, manual:{}, skills:{}, rchoice:{},
        set:{me:0,te:0,structM:0,structR:0,invent:false,clientId:'',basis:'pct'},
        tab:'plan', open:{}, theme:'', priceTs:0 };
let SSO=null; // {access, refresh, exp, charId, charName}

/* ---------- utilities ---------- */
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmt(n,dec){ if(n==null||isNaN(n))return '—';
  return n.toLocaleString('en-US',{minimumFractionDigits:dec??0,maximumFractionDigits:dec??(Math.abs(n)<100?2:0)}); }
function fmtISK(n){ if(n==null||isNaN(n))return '—';
  const a=Math.abs(n);
  if(a>=1e9) return fmt(n/1e9,2)+' B';
  if(a>=1e6) return fmt(n/1e6,2)+' M';
  return fmt(n,a<100?2:0); }
function fmtTime(sec){ if(!sec)return '—'; sec=Math.round(sec);
  const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);
  if(d)return d+'d '+h+'h'; if(h)return h+'h '+m+'m'; if(m)return m+'m'; return sec+'s'; }
function ago(ts){ if(!ts)return 'never'; const m=Math.round((Date.now()-ts)/60000);
  if(m<1)return 'just now'; if(m<60)return m+'m ago'; return Math.round(m/60)+'h ago'; }
function toast(t){ const m=$('msg'); m.textContent=t; m.style.display='block';
  clearTimeout(toast._t); toast._t=setTimeout(()=>m.style.display='none',3000); }
function save(){ try{ localStorage.setItem(LSKEY, JSON.stringify(S)); }catch(e){} }
function saveSSO(){ try{ SSO?localStorage.setItem(SSOKEY,JSON.stringify(SSO)):localStorage.removeItem(SSOKEY);}catch(e){} }
function tname(tid){ return TYPES[tid]?TYPES[tid].n:('#'+tid); }
function tcat(tid){ const t=TYPES[tid]; if(!t||t.g==null)return ''; const g=GROUPS[t.g]; return g?g.c:''; }
function tgroup(tid){ const t=TYPES[tid]; if(!t||t.g==null)return ''; const g=GROUPS[t.g]; return g?g.n:''; }
function icon(tid,lg){ return `<img class="ticon${lg?' lg':''}" loading="lazy" alt=""
  src="https://images.evetech.net/types/${tid}/icon?size=${lg?64:32}" onerror="this.style.visibility='hidden'">`; }

/* ---------- prices ---------- */
// a product with several recipes uses the largest-output one unless the user
// picked another in the tree (S.rchoice[tid] = blueprint type id)
function applyRecipeChoices(){
  RECIPES={...BASE_RECIPES};
  for(const [tid,bp] of Object.entries(S.rchoice||{})){
    const a=(ALTS[tid]||[]).find(x=>x.bp===+bp);
    if(a)RECIPES[tid]=a;
  }
}
function price(tid){
  const m=S.manual[tid]; if(m&&(m.b!=null||m.s!=null))
    return {b:m.b??m.s, s:m.s??m.b, src:'man'};
  const p=S.prices[tid];
  if(p){
    if(p.rich){ const k=S.set.basis||'pct';
      return {s:p.rich.s[k]??p.rich.s.pct??p.rich.s.ext,
              b:p.rich.b[k]??p.rich.b.pct??p.rich.b.ext, src:p.src}; }
    return p;
  }
  // deliberately no SDE base-price fallback: those numbers are decades stale
  // and poison totals; unpriced items stay visibly unpriced instead
  return {b:null,s:null,src:'none'};
}

/* ---------- character skills ---------- */
const SK={industry:3380,advIndustry:3388,reactions:45746,
          massProd:3387,advMassProd:24625,massReact:45748,advMassReact:45749,
          labOp:3406,advLabOp:24624};
const skL=id=>S.skills[id]||0;
function slots(){return {m:1+skL(SK.massProd)+skL(SK.advMassProd),
                         r:1+skL(SK.massReact)+skL(SK.advMassReact),
                         s:1+skL(SK.labOp)+skL(SK.advLabOp)};}
function timeFactor(act){
  if(act==='r') return 1-0.04*skL(SK.reactions);
  return (1-0.04*skL(SK.industry))*(1-0.03*skL(SK.advIndustry));
}
function effProb(iv){
  let enc=0,sci=0;
  for(const [sid] of (iv.sk||[])){
    const n=tname(sid);
    if(/Encryption Methods$/.test(n)) enc=skL(sid); else sci+=skL(sid);
  }
  return Math.min(1, iv.prob*(1+enc/40+sci/30));
}
function planTypeIds(){
  const ids=new Set();
  for(const t of S.targets){(function col(tid){
    ids.add(+tid);const r=RECIPES[tid];
    if(r&&!S.buy[tid]){for(const[m]of r.mats)col(m);
      if(INVENT[r.bp]){for(const[m]of INVENT[r.bp].mats)ids.add(+m);ids.add(+INVENT[r.bp].from);}}
  })(t.tid);}
  return [...ids];
}
let fetchingPrices=false;
async function refreshPrices(manual){
  if(fetchingPrices)return;
  const ids=planTypeIds();
  if(!ids.length){ if(manual)toast('Add a build target first'); return; }
  fetchingPrices=true; renderReadouts();
  let got=0, failed=false;
  try{
    for(let i=0;i<ids.length;i+=150){
      const chunk=ids.slice(i,i+150);
      const r=await fetch('https://market.fuzzwork.co.uk/aggregates/?region=10000002&types='+chunk.join(','));
      if(!r.ok)throw new Error('http '+r.status);
      const j=await r.json();
      for(const[tid,v]of Object.entries(j)){
        if(v&&v.sell&&v.buy){
          S.prices[tid]={src:'jita',rich:{
            s:{ext:+v.sell.min||null, pct:+v.sell.percentile||+v.sell.min||null, avg:+v.sell.weightedAverage||null},
            b:{ext:+v.buy.max||null,  pct:+v.buy.percentile||+v.buy.max||null,  avg:+v.buy.weightedAverage||null}}};
          got++;
        }
      }
    }
    S.priceTs=Date.now();
  }catch(e){
    failed=true;
    // fallback: ESI universe averages for anything still unpriced
    try{
      const r=await fetch(ESI+'/markets/prices/');
      if(r.ok){const j=await r.json();
        for(const e2 of j){ if(!S.prices[e2.type_id]&&(e2.average_price!=null)){
          S.prices[e2.type_id]={s:e2.average_price,b:e2.average_price,src:'esi'};got++;}}
        S.priceTs=Date.now(); failed=false;
      }
    }catch(e2){}
  }
  fetchingPrices=false;
  if(got)toast('Prices updated for '+got+' types'+(failed?' (partial)':''));
  else if(manual)toast('Price fetch failed — check your connection');
  save(); render(); renderReadouts();
}

/* ---------- EVE SSO (PKCE) ---------- */
function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function ssoLogin(){
  const cid=(S.set.clientId||'').trim();
  if(!cid){toast('Enter your ESI application Client ID first (Prices · Stock · ESI tab)');return;}
  const verifier=b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge=b64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const state=b64url(crypto.getRandomValues(new Uint8Array(12)));
  try{sessionStorage.setItem('nef-pkce',JSON.stringify({verifier,state}));}catch(e){toast('Session storage unavailable');return;}
  const redirect=location.origin+location.pathname;
  location.href=SSO_BASE+'/authorize/?response_type=code'
    +'&redirect_uri='+encodeURIComponent(redirect)
    +'&client_id='+encodeURIComponent(cid)
    +'&scope='+encodeURIComponent(SSO_SCOPES)
    +'&code_challenge='+challenge+'&code_challenge_method=S256&state='+state;
}
async function ssoToken(body){
  const r=await fetch(SSO_BASE+'/token',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(body).toString()});
  if(!r.ok)throw new Error('SSO token: http '+r.status);
  return r.json();
}
function applyToken(j){
  const payload=JSON.parse(atob(j.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
  SSO={access:j.access_token, refresh:j.refresh_token,
       exp:Date.now()+(j.expires_in-60)*1000,
       charId:+String(payload.sub).split(':').pop(), charName:payload.name};
  saveSSO();
}
async function ssoCallback(){
  const q=new URLSearchParams(location.search);
  if(!q.get('code'))return false;
  let st=null;
  try{st=JSON.parse(sessionStorage.getItem('nef-pkce'));}catch(e){}
  history.replaceState(null,'',location.pathname);
  if(!st||st.state!==q.get('state')){toast('SSO state mismatch — try logging in again');return false;}
  try{
    const j=await ssoToken({grant_type:'authorization_code',code:q.get('code'),
      client_id:S.set.clientId.trim(),code_verifier:st.verifier});
    applyToken(j);
    toast('Logged in as '+SSO.charName);
    await pullBlueprints();
    await pullSkills();
    pullLocation();
  }catch(e){toast('SSO login failed: '+e.message);}
  return true;
}
async function ssoAccess(){
  if(!SSO)return null;
  if(Date.now()<SSO.exp)return SSO.access;
  try{
    const j=await ssoToken({grant_type:'refresh_token',refresh_token:SSO.refresh,
      client_id:S.set.clientId.trim()});
    applyToken(j);
    return SSO.access;
  }catch(e){SSO=null;saveSSO();renderReadouts();toast('EVE login expired — log in again');return null;}
}
async function pullBlueprints(){
  const tok=await ssoAccess();
  if(!tok){toast('Log in with EVE first');return;}
  let page=1,pages=1,n=0;
  const bp2prod={};
  for(const[pid,r]of Object.entries(RECIPES))bp2prod[r.bp]=+pid;
  try{
    while(page<=pages){
      const r=await fetch(ESI+'/characters/'+SSO.charId+'/blueprints/?page='+page,
        {headers:{Authorization:'Bearer '+tok}});
      if(!r.ok)throw new Error('http '+r.status);
      pages=+(r.headers.get('x-pages')||1);
      for(const b of await r.json()){
        const pid=bp2prod[b.type_id];
        if(pid==null||b.material_efficiency==null)continue;
        if(S.me[pid]==null||b.material_efficiency>S.me[pid]){S.me[pid]=b.material_efficiency;n++;}
        if(b.time_efficiency!=null&&(S.te[pid]==null||b.time_efficiency>S.te[pid]))S.te[pid]=b.time_efficiency;
      }
      page++;
    }
    toast('Applied ME from '+n+' of your blueprints');
    save();render();
  }catch(e){toast('Blueprint fetch failed: '+e.message);}
}
async function pullSkills(){
  const tok=await ssoAccess();
  if(!tok){toast('Log in with EVE first');return;}
  try{
    const r=await fetch(ESI+'/characters/'+SSO.charId+'/skills/',
      {headers:{Authorization:'Bearer '+tok}});
    if(!r.ok)throw new Error('http '+r.status+(r.status===403?' — add the esi-skills.read_skills.v1 scope to your ESI app and log in again':''));
    const j=await r.json();
    S.skills={};
    for(const s of j.skills)S.skills[s.skill_id]=s.active_skill_level;
    const sl=slots();
    toast('Skills synced — '+sl.m+' mfg / '+sl.r+' reaction slots, times and invention odds updated');
    save();render();
  }catch(e){toast('Skill fetch failed: '+e.message);}
}
async function pullLocation(){
  const tok=await ssoAccess(); if(!tok)return;
  try{
    const r=await fetch(ESI+'/characters/'+SSO.charId+'/location/',{headers:{Authorization:'Bearer '+tok}});
    if(!r.ok)return;
    const j=await r.json();
    const s=await fetch(ESI+'/universe/systems/'+j.solar_system_id+'/');
    if(s.ok){SSO.sys=(await s.json()).name;saveSSO();renderReadouts();}
  }catch(e){}
}
async function pullAssets(){
  const tok=await ssoAccess();
  if(!tok){toast('Log in with EVE first');return;}
  const plan=computePlan();
  const wanted=new Set([...plan.shop.keys(),...plan.gross.keys()].map(Number));
  if(!wanted.size){toast('Add a build target first — assets are matched against the plan');return;}
  try{
    let page=1,pages=1;
    const agg={};
    while(page<=pages){
      const r=await fetch(ESI+'/characters/'+SSO.charId+'/assets/?page='+page,
        {headers:{Authorization:'Bearer '+tok}});
      if(!r.ok)throw new Error('http '+r.status);
      pages=+(r.headers.get('x-pages')||1);
      for(const a of await r.json()){
        if(!wanted.has(a.type_id))continue;
        const f=a.location_flag||'';
        if(f.includes('Hangar')||f==='Deliveries'||f==='Unlocked')
          agg[a.type_id]=(agg[a.type_id]||0)+(a.quantity||1);
      }
      page++;
    }
    let n=0;
    for(const[tid,q]of Object.entries(agg)){S.stock[tid]=q;n++;}
    toast(n?('Stock set from assets: '+n+' material types'):'No plan materials found in your hangars');
    save();render();
  }catch(e){toast('Asset fetch failed: '+e.message);}
}
async function fetchStructMarket(){
  const sid=String(S.set.structId||'').trim();
  if(!/^\d{10,}$/.test(sid)){toast('Enter a structure ID first (the long number from the in-game market or a killboard link)');return;}
  const tok=await ssoAccess();
  if(!tok){toast('Log in with EVE first — structure markets need auth');return;}
  if(fetchingPrices)return;
  fetchingPrices=true;renderReadouts();
  try{
    let sname='structure '+sid;
    try{const sr=await fetch(ESI+'/universe/structures/'+sid+'/',{headers:{Authorization:'Bearer '+tok}});
      if(sr.ok)sname=(await sr.json()).name;
      else if(sr.status===403)throw new Error('no docking access to that structure');
    }catch(e){if(/docking/.test(e.message))throw e;}
    let page=1,pages=1;
    const orders={};
    while(page<=pages&&page<=200){
      const r=await fetch(ESI+'/markets/structures/'+sid+'/?page='+page,
        {headers:{Authorization:'Bearer '+tok}});
      if(!r.ok)throw new Error('http '+r.status);
      pages=+(r.headers.get('x-pages')||1);
      for(const o of await r.json()){
        const e=orders[o.type_id]??={s:null,b:null};
        if(o.is_buy_order){ if(e.b==null||o.price>e.b)e.b=o.price; }
        else if(e.s==null||o.price<e.s)e.s=o.price;
      }
      page++;
    }
    const ids=new Set(planTypeIds());
    let n=0;
    for(const[tid,v]of Object.entries(orders))
      if(ids.has(+tid)){S.prices[tid]={s:v.s,b:v.b,src:'struct'};n++;}
    S.priceTs=Date.now();S.set.structName=sname;
    toast('Priced '+n+' plan types from '+sname+(pages>200?' (first 200 pages)':''));
    save();render();
  }catch(e){toast('Structure market fetch failed: '+e.message);}
  fetchingPrices=false;renderReadouts();
}
function ssoLogout(){SSO=null;saveSSO();renderReadouts();render();toast('Logged out');}

/* ---------- core calculation (ported, headless-tested) ---------- */
function meFor(tid){
  if(S.me[tid]!=null) return S.me[tid];
  const r=RECIPES[tid];
  if(r&&r.act==='r') return 0;
  if(r&&S.set.invent&&INVENT[r.bp]) return 2;   // invented BPC base ME2
  return S.set.me;
}
function teFor(tid){
  if(S.te[tid]!=null) return S.te[tid];
  const r=RECIPES[tid];
  if(r&&r.act==='r') return 0;
  if(r&&S.set.invent&&INVENT[r.bp]) return 4;   // invented BPC base TE4
  return S.set.te;
}
function isBuild(tid){ return RECIPES[tid] && !S.buy[tid]; }
function matMod(tid){
  const r=RECIPES[tid];
  if(r.act==='r') return 1-(S.set.structR||0)/100;
  return (1-meFor(tid)/100)*(1-(S.set.structM||0)/100);
}
function jobMats(tid,runs){
  const r=RECIPES[tid], mod=matMod(tid);
  return r.mats.map(([mid,q])=>[mid, Math.max(runs, Math.ceil(Math.round(q*runs*mod*100)/100))]);
}
function computePlan(){
  const res={steps:[],shop:new Map(),invRows:[],gross:new Map(),stockUsed:new Map()};
  if(!S.targets.length) return res;
  const depth=new Map(), seen=new Set();
  function walk2(tid,d,path){
    if(path.has(tid))return;
    const cur=depth.get(tid)??-1;
    if(d<=cur && seen.has(tid)) return;
    if(d>cur) depth.set(tid,d);
    seen.add(tid);
    if(!isBuild(tid))return;
    path.add(tid);
    const nd=(depth.get(tid)??d)+1;
    for(const [mid] of RECIPES[tid].mats) walk2(mid,nd,path);
    if(S.set.invent && INVENT[RECIPES[tid].bp]){
      const iv=INVENT[RECIPES[tid].bp];
      for(const [mid] of iv.mats) walk2(mid,nd,path);
      walk2(iv.from,nd,path);
    }
    path.delete(tid);
  }
  for(const t of S.targets) walk2(t.tid,0,new Set());
  const demand=new Map();
  for(const t of S.targets) demand.set(t.tid,(demand.get(t.tid)||0)+t.qty);
  const order=[...depth.keys()].sort((a,b)=>depth.get(a)-depth.get(b));
  const stockLeft={...S.stock};
  for(const tid of order){
    let gross=demand.get(tid)||0;
    if(!gross)continue;
    res.gross.set(tid,gross);
    let net=gross;
    if(stockLeft[tid]>0){
      const used=Math.min(stockLeft[tid],net);
      net-=used; stockLeft[tid]-=used;
      res.stockUsed.set(tid,used);
    }
    if(net<=0)continue;
    if(isBuild(tid)){
      const r=RECIPES[tid];
      const runs=Math.ceil(net/r.q);
      res.steps.push({tid,runs,net,depth:depth.get(tid),act:r.act,
        time:r.t*runs*(1-teFor(tid)/100)*timeFactor(r.act)});
      for(const [mid,q] of jobMats(tid,runs))
        demand.set(mid,(demand.get(mid)||0)+q);
      if(S.set.invent && INVENT[r.bp]){
        const iv=INVENT[r.bp];
        const p=effProb(iv);
        const attempts=Math.ceil(runs/(iv.q*p));
        res.invRows.push({tid,bp:r.bp,iv,runs,attempts,p});
        for(const [mid,q] of iv.mats)
          demand.set(mid,(demand.get(mid)||0)+q*attempts);
        if(tcat(iv.from)==='Ancient Relics')
          demand.set(iv.from,(demand.get(iv.from)||0)+attempts);
      }
    } else {
      res.shop.set(tid,(res.shop.get(tid)||0)+net);
    }
  }
  res.steps.sort((a,b)=>b.depth-a.depth || a.act.localeCompare(b.act) || tname(a.tid).localeCompare(tname(b.tid)));
  return res;
}
function grossTree(tid,qty,path){
  const node={tid,qty,kids:null};
  if(!isBuild(tid)||path.has(tid))return node;
  const r=RECIPES[tid], runs=Math.ceil(qty/r.q);
  node.runs=runs;
  path.add(tid);
  node.kids=jobMats(tid,runs).map(([mid,q])=>grossTree(mid,q,path));
  path.delete(tid);
  return node;
}
function treeCost(node,basis){
  if(node.kids==null||S.buy[node.tid]){
    const p=price(node.tid)[basis];
    return p==null?null:p*node.qty;
  }
  let sum=0;
  for(const k of node.kids){ const c=treeCost(k,basis); if(c!=null)sum+=c; }
  return sum;
}

/* ---------- rendering ---------- */
function renderReadouts(){
  const r=$('readouts');
  const age=S.priceTs?Date.now()-S.priceTs:null;
  const pdot=fetchingPrices?'<span class="dot shimmer">●</span>':
    age==null?'<span class="dot off">●</span>':
    age<40*60000?'<span class="dot">●</span>':'<span class="dot stale">●</span>';
  r.innerHTML=
    `<span>${Object.keys(RECIPES).length||'…'} recipes</span>`+
    `<span>${pdot} jita ${fetchingPrices?'updating…':ago(S.priceTs)} <button id="priceBtn">refresh</button></span>`+
    `<span>${SSO?`<span class="dot">●</span> ${esc(SSO.charName)}${SSO.sys?' @ '+esc(SSO.sys):''} <button id="bpBtn">sync</button> <button id="outBtn">logout</button>`
               :`<span class="dot off">●</span> not logged in <button id="inBtn">EVE login</button>`}</span>`+
    (Object.keys(S.skills).length?`<span title="from your Mass Production / Reactions / Laboratory skills">⚒ <b>${slots().m}</b> mfg · <b>${slots().r}</b> react · <b>${slots().s}</b> sci slots</span>`:'')+
    `<button id="themeBtn" title="theme">${S.theme==='dark'?'◐ dark':S.theme==='light'?'◑ light':'◓ auto'}</button>`;
  const on=(id,f)=>{const b=$(id);if(b)b.onclick=f;};
  on('priceBtn',()=>refreshPrices(true));
  on('inBtn',ssoLogin); on('outBtn',ssoLogout);
  on('bpBtn',async()=>{await pullBlueprints();await pullSkills();pullLocation();});
  on('themeBtn',()=>{S.theme=S.theme===''?'dark':S.theme==='dark'?'light':'';
    applyTheme();save();renderReadouts();});
}
function applyTheme(){
  if(S.theme)document.documentElement.setAttribute('data-theme',S.theme);
  else document.documentElement.removeAttribute('data-theme');
}
function pillFor(tid){
  const r=RECIPES[tid];
  if(!r)return '';
  if(r.act==='r')return '<span class="pill react">reaction</span>';
  const meta=TYPES[tid]&&TYPES[tid].meta;
  if(meta===2)return '<span class="pill t2">T2</span>';
  if(meta===14)return '<span class="pill t2">T3</span>';
  return '';
}
function render(){
  for(const t of ['plan','steps','shop','data'])
    $('tab-'+t).setAttribute('aria-selected',String(S.tab===t));
  const P=$('panel');
  if(S.tab==='plan')P.innerHTML=renderPlan();
  else if(S.tab==='steps')P.innerHTML=renderSteps();
  else if(S.tab==='shop')P.innerHTML=renderShop();
  else P.innerHTML=renderData();
  wirePanel();
  if(S.tab==='plan')drawFlows();
}
function renderPlan(){
  if(!S.targets.length)
    return `<div class="empty">No build targets yet. Search for anything buildable above — a capital hull,
      a T2 module, a reaction output — and add it to the plan.<br><br>
      Every tier of the bill of materials can be flipped between <b>build</b> and <b>buy</b>,
      stock you own is deducted, and the shopping list, steps and flow map update live.</div>`;
  let h='';
  S.targets.forEach((t,i)=>{
    const tree=grossTree(t.tid,t.qty,new Set());
    const cost=treeCost(tree,'s'), sellV=(price(t.tid).s??0)*t.qty;
    const isShip=tcat(t.tid)==='Ship';
    h+=`<div class="sec">
      <div class="target-card">
        ${isShip?`<img class="render" alt="" loading="lazy" src="https://images.evetech.net/types/${t.tid}/render?size=512" onerror="this.remove()">`:''}
        ${icon(t.tid,true)}
        <b>${esc(tname(t.tid))}</b> ${pillFor(t.tid)}
        <span class="meta" style="color:var(--fg2);font-size:12px">${esc(tgroup(t.tid))}</span>
        <span class="sp" style="flex:1"></span>
        <label class="f" style="flex-direction:row;align-items:center;gap:5px;color:var(--fg2)">qty
          <input type="number" class="me-in" style="width:80px !important" data-tqty="${i}" value="${t.qty}" min="1"></label>
        <span class="meta" style="font-family:var(--mono);font-size:12px;color:var(--fg2)">
          mats ${fmtISK(cost)} · sell ${fmtISK(sellV)}
          ${cost!=null&&sellV?` · margin <b style="color:${sellV-cost>=0?'var(--good)':'var(--bad)'}">${fmtISK(sellV-cost)}</b>`:''}</span>
        <button class="tiny quiet" data-del="${i}">remove</button>
      </div>
      <div class="flow-wrap"><div class="flow" data-flow="${i}"></div></div>
      ${renderNode(tree,'t'+i,0)}
    </div>`;
  });
  h+=`<div class="note">Quantities are gross (before stock). Toggle any buildable line to <b>buy</b> to stop the chain there — it then appears on the shopping list instead. ME boxes set per-blueprint material efficiency; log in with EVE to use your researched values automatically.</div>`;
  return h;
}
function renderNode(node,key,d){
  const tid=node.tid, r=RECIPES[tid], buildable=!!r, buying=!buildable||!!S.buy[tid];
  const openKey=key, isOpen=S.open[openKey]??(d<2);
  const p=price(tid);
  let row=`<div class="trow" style="padding-left:${6+d*4}px">`;
  row+= buildable&&!buying
    ? `<button class="twist" data-tw="${esc(openKey)}" aria-label="toggle">${isOpen?'−':'+'}</button>`
    : `<span style="width:22px;display:inline-block"></span>`;
  row+=icon(tid);
  row+=`<span class="qty">${fmt(node.qty)}</span><span class="nm">${esc(tname(tid))}</span> ${pillFor(tid)}`;
  if(buildable){
    row+=`<button class="tiny ${buying?'quiet':'ghost'}" data-bb="${tid}">${buying?'buying':'building'}</button>`;
    if(!buying&&r.act==='m')
      row+=`<span class="meta">ME</span><input type="number" class="me-in" data-me="${tid}" value="${meFor(tid)}" min="0" max="10">`;
    if(!buying)row+=`<span class="meta">${node.runs} run${node.runs>1?'s':''} · out ×${r.q}</span>`;
    if(!buying&&ALTS[tid]&&ALTS[tid].length>1){
      row+=`<select class="alt-sel" data-alt="${tid}" title="this product has more than one recipe">`+
        ALTS[tid].map(a=>`<option value="${a.bp}"${RECIPES[tid].bp===a.bp?' selected':''}>${esc(tname(a.bp))} (×${a.q})</option>`).join('')+
        `</select>`;
    }
  }
  row+=`<span class="sp"></span>`;
  if(buying) row+=`<span class="meta">${p.s!=null?fmtISK(p.s*node.qty)+' @ sell':'no price'}${p.src==='base'?' <span class="src">(base)</span>':''}</span>`;
  else { const c=treeCost(node,'s'); row+=`<span class="meta">mats ${fmtISK(c)}</span>`; }
  row+='</div>';
  let kids='';
  if(!buying&&node.kids&&isOpen)
    kids=`<div class="tnode">${node.kids.map((k,i)=>renderNode(k,key+'.'+i,d+1)).join('')}</div>`;
  return row+kids;
}

/* flow map: per-target tier columns with SVG links */
function drawFlows(){
  document.querySelectorAll('[data-flow]').forEach(el=>{
    const t=S.targets[+el.dataset.flow];
    if(!t)return;
    // gather nodes per depth + edges, single-target walk
    const nodes=new Map(), edges=[];
    (function walk(tid,qty,d,path){
      const k=tid;
      const n=nodes.get(k)||{tid,qty:0,depth:0,buy:!isBuild(tid)};
      n.qty+=qty; n.depth=Math.max(n.depth,d);
      nodes.set(k,n);
      if(!isBuild(tid)||path.has(tid))return;
      const r=RECIPES[tid], runs=Math.ceil(qty/r.q);
      path.add(tid);
      for(const [mid,q] of jobMats(tid,runs)){
        edges.push([tid,mid]);
        walk(mid,q,d+1,path);
      }
      path.delete(tid);
    })(t.tid,t.qty,0,new Set());
    const maxd=Math.max(...[...nodes.values()].map(n=>n.depth));
    const byTier=[];
    for(let d=0;d<=maxd;d++)byTier.push([...nodes.values()].filter(n=>n.depth===d));
    const LIMIT=9;
    let html='<div class="cols">';
    const tierLabel=d=>d===0?'product':d===maxd?'raw inputs':'tier '+(maxd-d+1);
    for(let d=maxd;d>=0;d--){
      const col=byTier[d], show=col.slice(0,LIMIT);
      html+=`<div class="col"><div class="colhead">${tierLabel(d)} · ${col.length}</div>`;
      for(const n of show){
        const cls=n.buy?'buyn':(RECIPES[n.tid]&&RECIPES[n.tid].act==='r'?'reactn':'');
        html+=`<div class="fnode ${cls}" data-fid="${n.tid}">${icon(n.tid)}<span class="fn">${esc(tname(n.tid))}</span><span class="fq">${fmt(n.qty)}</span></div>`;
      }
      if(col.length>LIMIT)html+=`<div class="fmore">+${col.length-LIMIT} more</div>`;
      html+='</div>';
    }
    html+='</div>';
    el.innerHTML='<svg aria-hidden="true"></svg>'+html;
    // draw links after layout
    requestAnimationFrame(()=>{
      const svg=el.querySelector('svg');
      const er=el.getBoundingClientRect();
      svg.setAttribute('viewBox',`0 0 ${el.scrollWidth} ${el.scrollHeight}`);
      svg.style.width=el.scrollWidth+'px';svg.style.height=el.scrollHeight+'px';
      const pos={};
      el.querySelectorAll('.fnode').forEach(n=>{
        const b=n.getBoundingClientRect();
        pos[n.dataset.fid]={l:b.left-er.left+el.scrollLeft,r:b.right-er.left+el.scrollLeft,
                            y:b.top-er.top+b.height/2};
      });
      let paths='';
      const seen=new Set();
      for(const[prod,mat]of edges){
        const key=prod+'-'+mat;
        if(seen.has(key))continue;seen.add(key);
        const a=pos[mat],b=pos[prod]; // material (left) -> product (right)
        if(!a||!b)continue;
        const x1=a.r,y1=a.y,x2=b.l,y2=b.y,mx=(x1+x2)/2;
        paths+=`<path class="link" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
      }
      svg.innerHTML=paths;
    });
  });
}
function renderSteps(){
  const plan=computePlan();
  if(!plan.steps.length)return '<div class="empty">Nothing to build yet — add a target, or everything is covered by stock.</div>';
  const maxd=Math.max(...plan.steps.map(s=>s.depth));
  const sl=slots(), haveSkills=Object.keys(S.skills).length>0;
  // wall-clock: longest-processing-time packing of each tier's jobs into your slots
  const makespan=(times,n)=>{ if(!times.length)return 0;
    const heap=Array(Math.max(1,n)).fill(0);
    times.sort((a,b)=>b-a);
    for(const t of times){heap.sort((a,b)=>a-b);heap[0]+=t;}
    return Math.max(...heap); };
  const tiers={};
  for(const s of plan.steps)(tiers[s.depth]??=[]).push(s);
  let wall=0;
  for(const d of Object.keys(tiers))
    wall+=Math.max(makespan(tiers[d].filter(x=>x.act!=='r').map(x=>x.time),sl.m),
                   makespan(tiers[d].filter(x=>x.act==='r').map(x=>x.time),sl.r));
  let h=`<div class="note">Jobs run bottom-up: deepest tier first. ${haveSkills
    ?`Times, slots and invention odds use your synced skills: <b>${sl.m}</b> manufacturing / <b>${sl.r}</b> reaction slots.`
    :'Log in with EVE (Prices · Stock · ESI tab) and your skills set job times, slot counts and invention odds.'}
    Click any row to see the materials that go into that job.</div>`;
  // Tier 0 — procurement: raw-input totals, moon goo and PI as flat totals
  if(plan.shop.size){
    const groupsOf={};
    for(const [tid,q] of plan.shop){
      const lab=tcat(tid)==='Planetary Commodities'?'Planetary commodities (PI)':(tgroup(tid)||'Other');
      (groupsOf[lab]??=[]).push({tid:+tid,q});
    }
    const pref=['Mineral','Moon Materials','Ice Product','Planetary commodities (PI)','Fuel Block','Salvaged Materials','Datacores'];
    const labs=Object.keys(groupsOf).sort((a,b)=>{
      const ia=pref.indexOf(a),ib=pref.indexOf(b);
      return (ia<0?99:ia)-(ib<0?99:ib)||a.localeCompare(b);});
    h+=`<div class="sec"><h2>Tier 0 — procurement</h2><div class="scroller"><table>
      <tr><th colspan="2">Raw input</th><th class="num">Quantity</th><th class="num">Volume m³</th><th class="num">Total @ sell</th></tr>`;
    for(const lab of labs){
      const rows=groupsOf[lab].sort((a,b)=>tname(a.tid).localeCompare(tname(b.tid)));
      let gq=0,gv=0,gt=0,priced=true;
      for(const r of rows){const p=price(r.tid).s;gv+=(TYPES[r.tid]&&TYPES[r.tid].v||0)*r.q;
        if(p!=null)gt+=p*r.q;else priced=false;}
      h+=`<tr class="stepdepth"><td colspan="2">${esc(lab)} · ${rows.length} type${rows.length>1?'s':''}</td>
        <td></td><td class="num">${fmt(gv,0)}</td><td class="num">${fmtISK(gt)}${priced?'':' +?'}</td></tr>`;
      for(const r of rows){
        const p=price(r.tid).s;
        h+=`<tr><td style="width:28px">${icon(r.tid)}</td><td>${esc(tname(r.tid))}</td>
          <td class="num">${fmt(r.q)}</td><td class="num">${fmt((TYPES[r.tid]&&TYPES[r.tid].v||0)*r.q,1)}</td>
          <td class="num">${p!=null?fmtISK(p*r.q):'—'}</td></tr>`;
      }
    }
    h+=`</table></div><div class="note">Everything the plan consumes but does not build — gather or buy this before tier 1 starts. PI commodities are totals only; their planet-side chains are deliberately not expanded.</div></div>`;
  }
  h+=`<div class="scroller"><table>
  <tr><th></th><th colspan="2">Product</th><th></th><th class="num">Units</th><th class="num">Runs</th><th class="num">ME / TE</th><th class="num">Job time</th><th>Blueprint</th></tr>`;
  let lastTier=null,totalTime=0;
  for(const s of plan.steps){
    const tier=maxd-s.depth;
    if(tier!==lastTier){
      const g=tiers[s.depth];
      const mJ=g.filter(x=>x.act!=='r').length, rJ=g.filter(x=>x.act==='r').length;
      const tw=Math.max(makespan(g.filter(x=>x.act!=='r').map(x=>x.time),sl.m),
                        makespan(g.filter(x=>x.act==='r').map(x=>x.time),sl.r));
      const slotTxt=[mJ?`${mJ} mfg job${mJ>1?'s':''} on ${sl.m} slot${sl.m>1?'s':''}`:'',
                     rJ?`${rJ} reaction job${rJ>1?'s':''} on ${sl.r} slot${sl.r>1?'s':''}`:''].filter(Boolean).join(' · ');
      h+=`<tr class="stepdepth"><td colspan="9">Tier ${tier+1} — ${s.depth===0?'final products':(s.act==='r'?'reactions / intermediates':'intermediates')} · ${slotTxt} · wall-clock ≈ ${fmtTime(tw)}</td></tr>`;
      lastTier=tier;
    }
    totalTime+=s.time;
    const open=!!S.open['st'+s.tid];
    const r=RECIPES[s.tid];
    const meTxt=r.act==='r'?'—':('ME'+meFor(s.tid)+' / TE'+teFor(s.tid));
    const meSrc=S.me[s.tid]!=null?' title="from your blueprints"':'';
    h+=`<tr class="steprow" data-st="${s.tid}"><td class="num" style="width:22px;color:var(--fg2)">${open?'−':'+'}</td>
      <td style="width:28px">${icon(s.tid)}</td><td>${esc(tname(s.tid))}</td><td>${pillFor(s.tid)}</td>
      <td class="num">${fmt(s.net)}</td><td class="num">${fmt(s.runs)}</td>
      <td class="num"${meSrc}>${meTxt}${S.me[s.tid]!=null?' <span class="src">yours</span>':''}</td>
      <td class="num">${fmtTime(s.time)}</td>
      <td class="meta" style="color:var(--fg2);font-size:12px">${esc(tname(r.bp))}</td></tr>`;
    if(open){
      for(const [mid,q] of jobMats(s.tid,s.runs)){
        const built=isBuild(mid), ps=price(mid).s;
        h+=`<tr class="submat"><td></td><td style="width:28px">${icon(mid)}</td>
          <td style="padding-left:16px">${esc(tname(mid))}</td>
          <td><span class="pill">${built?'built below':'buy'}</span></td>
          <td class="num">${fmt(q)}</td><td></td><td></td>
          <td class="num">${ps!=null?fmtISK(ps*q):''}</td><td></td></tr>`;
      }
    }
  }
  h+=`<tr class="total"><td colspan="7">Job time: sequential total / wall-clock with your slots</td><td class="num">${fmtTime(totalTime)} / ≈${fmtTime(wall)}</td><td></td></tr></table></div>`;
  if(plan.invRows.length){
    h+=`<div class="sec"><h2>Invention</h2><div class="scroller"><table>
    <tr><th>For</th><th class="num">Runs needed</th><th class="num">Prob.</th><th class="num">Runs/BPC</th><th class="num">Expected attempts</th><th>Per attempt</th><th>Source</th></tr>`;
    for(const r of plan.invRows){
      h+=`<tr><td>${icon(r.tid)} ${esc(tname(r.tid))}</td><td class="num">${fmt(r.runs)}</td>
      <td class="num" title="base ${(r.iv.prob*100).toFixed(0)}%">${((r.p??r.iv.prob)*100).toFixed(0)}%</td><td class="num">${r.iv.q}</td>
      <td class="num">${fmt(r.attempts)}</td>
      <td class="meta" style="color:var(--fg2);font-size:12px">${r.iv.mats.map(([m,q])=>q+'× '+esc(tname(m))).join(', ')}</td>
      <td class="meta" style="color:var(--fg2);font-size:12px">${esc(tname(r.iv.from))}${tcat(r.iv.from)==='Ancient Relics'?' (consumed)':''}</td></tr>`;
    }
    h+=`</table></div><div class="note">${Object.keys(S.skills).length?'Probabilities include your encryption and science skills; decryptors not applied.':'Base probability — log in with EVE to apply your skills; decryptors not applied.'} Datacores (and relics) for the expected attempts are already in the shopping list.</div></div>`;
  }
  if(plan.stockUsed.size){
    h+=`<div class="sec"><h2>Covered from stock</h2><table><tr><th>Item</th><th class="num">Used</th></tr>`;
    for(const [tid,q] of plan.stockUsed) h+=`<tr><td>${icon(tid)} ${esc(tname(tid))}</td><td class="num">${fmt(q)}</td></tr>`;
    h+='</table></div>';
  }
  return h;
}
function renderShop(){
  const plan=computePlan();
  if(!plan.shop.size)return '<div class="empty">Shopping list is empty.</div>';
  const rows=[...plan.shop.entries()].map(([tid,q])=>({tid:+tid,q}));
  rows.sort((a,b)=>tcat(a.tid).localeCompare(tcat(b.tid))||tname(a.tid).localeCompare(tname(b.tid)));
  let tb=0,ts=0,tv=0,missing=0;
  const drivers=rows.map(r=>{const p=price(r.tid);return {tid:r.tid,q:r.q,tot:p.s!=null?p.s*r.q:0,unit:p.s,src:p.src};})
    .sort((a,b)=>b.tot-a.tot).slice(0,6);
  let h=`<div class="scroller"><table>
  <tr><th colspan="2">Material</th><th>Category</th><th class="num">Quantity</th><th class="num">Volume m³</th>
  <th class="num">Unit sell</th><th class="num">Total @ sell</th><th class="num">Total @ buy</th><th></th></tr>`;
  let lastCat=null;
  for(const r of rows){
    const cat=tcat(r.tid), p=price(r.tid), v=(TYPES[r.tid]&&TYPES[r.tid].v||0)*r.q;
    tv+=v;
    const cs=p.s!=null?p.s*r.q:null, cb=p.b!=null?p.b*r.q:null;
    if(cs!=null)ts+=cs; else missing++;
    if(cb!=null)tb+=cb;
    if(cat!==lastCat){h+=`<tr class="stepdepth"><td colspan="9">${esc(cat)||'Other'}</td></tr>`;lastCat=cat;}
    const buildable=!!RECIPES[r.tid];
    h+=`<tr><td style="width:28px">${icon(r.tid)}</td><td>${esc(tname(r.tid))}${buildable?' <span class="pill" title="on this list because it is set to buy">bought</span> <button class="tiny ghost" data-buildit="'+r.tid+'">build instead</button>':''}</td><td class="meta" style="color:var(--fg2);font-size:12px">${esc(tgroup(r.tid))}</td>
      <td class="num">${fmt(r.q)}</td><td class="num">${fmt(v,1)}</td>
      <td class="num"><input type="text" class="price-in" data-pman="${r.tid}" value="${p.s!=null?p.s:''}" placeholder="—">
        <span class="src">${p.src==='base'?'base':p.src==='man'?'manual':p.src}</span></td>
      <td class="num">${fmtISK(cs)}</td><td class="num">${fmtISK(cb)}</td>
      <td><button class="tiny quiet" data-stockadd="${r.tid}" title="move this quantity into stock">to stock</button></td></tr>`;
  }
  h+=`<tr class="total"><td colspan="4">Totals</td><td class="num">${fmt(tv,1)}</td><td></td>
      <td class="num">${fmtISK(ts)}</td><td class="num">${fmtISK(tb)}</td><td></td></tr></table></div>`;
  let sellV=0,ok=true;
  for(const t of S.targets){const p=price(t.tid).s; if(p==null){ok=false;break;} sellV+=p*t.qty;}
  h=`<div class="kpis">
    <div class="kpi"><div class="l">Material cost @ sell</div><div class="v">${fmtISK(ts)}</div></div>
    <div class="kpi"><div class="l">Material cost @ buy</div><div class="v">${fmtISK(tb)}</div></div>
    <div class="kpi"><div class="l">Haul volume</div><div class="v">${fmt(tv,0)} m³</div></div>
    <div class="kpi"><div class="l">Product sell value</div><div class="v">${ok?fmtISK(sellV):'—'}</div></div>
    <div class="kpi"><div class="l">Margin (sell − mat@sell)</div><div class="v ${ok&&sellV-ts>=0?'good':'bad'}">${ok?fmtISK(sellV-ts):'—'}</div></div>
  </div>`+
  `<div class="sec"><h2>Top cost drivers</h2><div class="scroller"><table>
    <tr><th colspan="2">Material</th><th class="num">Qty</th><th class="num">Unit (src)</th><th class="num">Total</th><th class="num">% of mat cost</th></tr>
    ${drivers.map(d=>`<tr><td style="width:28px">${icon(d.tid)}</td><td>${esc(tname(d.tid))}</td>
      <td class="num">${fmt(d.q)}</td><td class="num">${fmtISK(d.unit)} <span class="src">${d.src}</span></td>
      <td class="num">${fmtISK(d.tot)}</td><td class="num">${ts?(d.tot/ts*100).toFixed(1)+'%':'—'}</td></tr>`).join('')}
  </table></div>
  <div class="note">If one of these looks absurd, check its src tag: <code>struct</code> prices come from a player market and a thin order book can carry troll prices — edit the unit price inline, or clear prices and refresh for Jita numbers.</div></div>`+
  (missing?`<div class="note">⚠ ${missing} item(s) have no price yet and are excluded from the totals — hit <b>refresh</b> next to “jita” in the header.</div>`:'')+h+
  `<div class="note">Edit any unit price inline (stored as manual override). “to stock” marks the full quantity as already owned. Job install costs / taxes are not included.</div>`;
  return h;
}
function renderData(){
  const plan=computePlan();
  const stockRows=Object.entries(S.stock).filter(([,q])=>q>0);
  return `
  <div class="grid2">
    <div class="sec">
      <h2>Live prices</h2>
      <div class="note">Jita 4-4 buy/sell comes from Fuzzwork market aggregates for exactly the types in your plan, with ESI universe averages as fallback. Prices auto-refresh when you change the plan and can be refreshed from the header readout. Last update: <b>${ago(S.priceTs)}</b>.</div>
      <label class="f" style="color:var(--fg2);max-width:320px">Price basis
        <select id="basisSel">
          <option value="pct"${(S.set.basis||'pct')==='pct'?' selected':''}>Realistic fill (5% percentile) — recommended</option>
          <option value="ext"${S.set.basis==='ext'?' selected':''}>Best order (min sell / max buy)</option>
          <option value="avg"${S.set.basis==='avg'?' selected':''}>Weighted average of whole book</option>
        </select></label>
      ${SSO?`<div class="note"><b>Structure market</b> — price the plan against a player structure you can dock in (overrides Jita for types it stocks):</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="structId" class="price-in" style="width:170px !important;text-align:left" placeholder="structure ID" value="${esc(S.set.structId||'')}">
        <button class="ghost" id="structFetch">Fetch structure prices</button>
        ${S.set.structName?`<span class="note">${esc(S.set.structName)}</span>`:''}
      </div>`:''}
      <div class="note">You can still paste prices manually (Fuzzwork JSON, ESI <code>/markets/prices/</code> JSON, or <code>name&lt;tab&gt;sell&lt;tab&gt;buy</code> lines):</div>
      <textarea id="pricePaste" placeholder='Optional manual paste'></textarea>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <button class="ghost" id="priceImport">Import paste</button>
        <button class="quiet" id="priceClear">Clear all prices</button>
        <span class="note">${Object.keys(S.prices).length} priced · ${Object.keys(S.manual).length} manual overrides</span>
      </div>
    </div>
    <div class="sec">
      <h2>EVE SSO — your blueprints</h2>
      <div class="note">One-time setup: create an application at
      <a href="https://developers.eveonline.com/applications" target="_blank" rel="noopener">developers.eveonline.com</a>
      — type <b>Authentication &amp; API access</b>, callback URL exactly <code id="cbUrl"></code>, with these scopes:
      <code>esi-characters.read_blueprints.v1</code>, <code>esi-skills.read_skills.v1</code>,
      <code>esi-assets.read_assets.v1</code>, <code>esi-location.read_location.v1</code>,
      <code>esi-universe.read_structures.v1</code>, <code>esi-markets.structure_markets.v1</code>
      — then paste its Client ID here. Tokens live only in this browser.
      If the EVE login page shows a scope error, your app is missing one of the scopes above — add it and retry.</div>
      <label class="f" style="color:var(--fg2)">ESI application client ID
        <input type="text" id="clientId" style="max-width:420px" value="${esc(S.set.clientId||'')}" placeholder="e.g. 0a1b2c3d4e5f…"></label>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${SSO?`<button id="bpImport2">Sync blueprints (${esc(SSO.charName)})</button><button class="quiet" id="outBtn2">Log out</button>`
             :`<button id="loginBtn">Log in with EVE Online</button>`}
        <button class="quiet" id="meClear">Reset ME overrides</button>
        <span class="note">${Object.keys(S.me).length} ME overrides · ${Object.keys(S.skills).length?Object.keys(S.skills).length+' skills synced ('+slots().m+' mfg / '+slots().r+' reaction / '+slots().s+' science slots)':'skills not synced'}</span>
      </div>
    </div>
  </div>
  <div class="sec">
    <h2>Stockpile — materials you already have</h2>
    <div class="note">Anything here is deducted at whatever tier it sits — minerals, moon-goo reaction outputs, finished components, datacores. Remaining demand flows down the chain.</div>
    <div class="toolbar" style="padding:6px 0">
      <div class="searchbox" style="max-width:380px">
        <input type="text" id="stockSearch" placeholder="Add material… (any item)" autocomplete="off">
        <div class="sugs" id="stockSugs" hidden></div>
      </div>
      <label class="f" style="color:var(--fg2)">Qty<input type="number" id="stockQty" value="1" min="1"></label>
      <button class="ghost" id="stockAdd">Add to stock</button>
      ${SSO?'<button class="ghost" id="assetPull">Import from assets</button>':''}
      <button class="quiet" id="stockClear">Clear stock</button>
    </div>
    ${stockRows.length?`<div class="scroller"><table><tr><th colspan="2">Item</th><th class="num">On hand</th><th class="num">Used by plan</th><th></th></tr>${
      stockRows.map(([tid,q])=>`<tr><td style="width:28px">${icon(tid)}</td><td>${esc(tname(tid))}</td>
        <td class="num"><input type="text" class="price-in" data-stockq="${tid}" value="${q}"></td>
        <td class="num">${fmt(plan.stockUsed.get(+tid)||0)}</td>
        <td><button class="tiny quiet" data-stockdel="${tid}">remove</button></td></tr>`).join('')}</table></div>`:'<div class="note">Stock is empty.</div>'}
  </div>
  <details class="helpbox"><summary>About this tool</summary>
    <div class="note">Static data: EVE SDE (Tranquility) — ${Object.keys(RECIPES).length} manufacturing/reaction recipes, ${Object.keys(INVENT).length} invention paths, ${Object.keys(TYPES).length} types.
    Material formula per job: <code>max(runs, ceil(base × runs × (1−ME/100) × (1−structure/100)))</code>; reactions use the reaction structure bonus only.
    Not modeled: job cost indices/taxes, decryptors, invention skill bonuses, PI schematic chains (PI commodities are purchasable inputs).
    All data stays in your browser. Item imagery © CCP via images.evetech.net. EVE Online and all related trademarks are the property of CCP hf.</div>
  </details>`;
}

/* ---------- search ---------- */
let PRODUCTS=[];
function buildSearch(){
  PRODUCTS=Object.keys(RECIPES).map(tid=>({tid:+tid,n:tname(tid),nl:tname(tid).toLowerCase(),c:tgroup(tid)}));
  PRODUCTS.sort((a,b)=>a.n.localeCompare(b.n));
  NAME2ID={}; for(const[tid,t]of Object.entries(TYPES))NAME2ID[t.n.toLowerCase()]=+tid;
}
function attachSearch(inputId,sugsId,universe,onPick){
  const inp=$(inputId),box=$(sugsId);
  if(!inp)return;
  let sel=0,cur=[];
  function show(q){
    q=q.trim().toLowerCase();
    if(q.length<1){box.hidden=true;return;}
    const starts=[],incl=[];
    for(const p of universe){
      const i=p.nl.indexOf(q);
      if(i===0)starts.push(p);else if(i>0)incl.push(p);
      if(starts.length>=15)break;
    }
    cur=starts.concat(incl).slice(0,15);
    if(!cur.length){box.hidden=true;return;}
    sel=0;
    box.innerHTML=cur.map((p,i)=>`<div data-i="${i}"${i===0?' class="sel"':''}>${icon(p.tid)}<span>${esc(p.n)}</span><span class="cat">${esc(p.c)}</span></div>`).join('');
    box.hidden=false;
  }
  inp.addEventListener('input',()=>show(inp.value));
  inp.addEventListener('focus',()=>show(inp.value));
  inp.addEventListener('keydown',e=>{
    if(box.hidden)return;
    if(e.key==='ArrowDown'){sel=Math.min(sel+1,cur.length-1);}
    else if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);}
    else if(e.key==='Enter'){if(cur.length){onPick(cur[Math.max(sel,0)]);box.hidden=true;}return;}
    else if(e.key==='Escape'){box.hidden=true;return;}
    else return;
    e.preventDefault();
    [...box.children].forEach((c,i)=>c.classList.toggle('sel',i===sel));
  });
  box.addEventListener('mousedown',e=>{
    const d=e.target.closest('[data-i]');
    if(d){onPick(cur[+d.dataset.i]);box.hidden=true;}
  });
  document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==inp)box.hidden=true;});
}

/* ---------- manual imports ---------- */
function importPrices(text){
  text=text.trim(); if(!text)return 0;
  let n=0;
  try{
    const j=JSON.parse(text);
    if(Array.isArray(j)&&j.length&&j[0].type_id!=null){
      for(const e of j){ if(e.average_price!=null||e.adjusted_price!=null){
        const v=e.average_price??e.adjusted_price;
        S.prices[e.type_id]={b:v,s:v,src:'esi'};n++; }}
      return n;
    }
    if(j&&typeof j==='object'){
      for(const[tid,v]of Object.entries(j)){
        if(v&&v.sell&&v.buy){ S.prices[tid]={s:+v.sell.min||null,b:+v.buy.max||null,src:'jita'};n++; }
      }
      return n;
    }
  }catch(e){}
  for(const line of text.split(/\n/)){
    const m=line.split(/\t|\s{2,}/).map(s=>s.trim()).filter(Boolean);
    if(m.length<2)continue;
    const tid=NAME2ID[m[0].toLowerCase()];
    if(!tid)continue;
    const s=parseFloat(m[1].replace(/,/g,'')),b=m[2]?parseFloat(m[2].replace(/,/g,'')):null;
    if(isNaN(s))continue;
    S.prices[tid]={s,b:isNaN(b)?s:(b??s),src:'paste'};n++;
  }
  return n;
}

/* ---------- event wiring ---------- */
function wirePanel(){
  const P=$('panel');
  P.onclick=e=>{
    const tw=e.target.closest('[data-tw]');
    if(tw){const k=tw.dataset.tw;
      S.open[k]=!(S.open[k]??(k.split('.').length<=2));render();save();return;}
    const bb=e.target.closest('[data-bb]');
    if(bb){const tid=bb.dataset.bb;if(S.buy[tid])delete S.buy[tid];else S.buy[tid]=1;render();save();refreshPrices();return;}
    const del=e.target.closest('[data-del]');
    if(del){S.targets.splice(+del.dataset.del,1);render();save();return;}
    const bi=e.target.closest('[data-buildit]');
    if(bi){delete S.buy[bi.dataset.buildit];render();save();refreshPrices();return;}
    const sa=e.target.closest('[data-stockadd]');
    if(sa){const tid=sa.dataset.stockadd;const plan=computePlan();const q=plan.shop.get(+tid)||0;
      S.stock[tid]=(S.stock[tid]||0)+q;toast('Moved '+fmt(q)+' × '+tname(tid)+' to stock');render();save();return;}
    const st=e.target.closest('[data-st]');
    if(st){const k='st'+st.dataset.st;S.open[k]=!S.open[k];render();save();return;}
    const sd=e.target.closest('[data-stockdel]');
    if(sd){delete S.stock[sd.dataset.stockdel];render();save();return;}
    if(e.target.id==='priceImport'){const n=importPrices($('pricePaste').value);toast(n?('Imported prices for '+n+' types'):'Nothing recognized — check the format');render();save();return;}
    if(e.target.id==='priceClear'){S.prices={};S.manual={};S.priceTs=0;toast('Prices cleared');render();save();renderReadouts();return;}
    if(e.target.id==='loginBtn'){ssoLogin();return;}
    if(e.target.id==='bpImport2'){pullBlueprints();return;}
    if(e.target.id==='outBtn2'){ssoLogout();return;}
    if(e.target.id==='meClear'){S.me={};toast('ME overrides reset');render();save();return;}
    if(e.target.id==='stockAdd'){const tid=P.dataset.stockPick;const q=parseFloat($('stockQty').value)||1;
      if(!tid){toast('Pick an item from the search first');return;}
      S.stock[tid]=(S.stock[tid]||0)+q;delete P.dataset.stockPick;$('stockSearch').value='';render();save();return;}
    if(e.target.id==='stockClear'){S.stock={};render();save();return;}
    if(e.target.id==='assetPull'){pullAssets();return;}
    if(e.target.id==='structFetch'){fetchStructMarket();return;}
  };
  P.onchange=e=>{
    const t=e.target;
    if(t.dataset.tqty!=null){S.targets[+t.dataset.tqty].qty=Math.max(1,parseInt(t.value)||1);render();save();}
    else if(t.dataset.me!=null){S.me[t.dataset.me]=Math.min(10,Math.max(0,parseInt(t.value)||0));render();save();}
    else if(t.dataset.pman!=null){const v=parseFloat(t.value.replace(/,/g,''));
      if(isNaN(v))delete S.manual[t.dataset.pman];else S.manual[t.dataset.pman]={s:v,b:v};render();save();}
    else if(t.dataset.stockq!=null){const v=parseFloat(t.value.replace(/,/g,''));
      if(!v||v<=0)delete S.stock[t.dataset.stockq];else S.stock[t.dataset.stockq]=v;render();save();}
    else if(t.id==='clientId'){S.set.clientId=t.value.trim();save();}
    else if(t.id==='structId'){S.set.structId=t.value.trim();S.set.structName='';save();}
    else if(t.id==='basisSel'){S.set.basis=t.value;save();render();}
    else if(t.dataset.alt!=null){
      const tid=t.dataset.alt, bp=+t.value;
      if(BASE_RECIPES[tid]&&BASE_RECIPES[tid].bp===bp)delete S.rchoice[tid];
      else S.rchoice[tid]=bp;
      applyRecipeChoices();save();render();refreshPrices();}
  };
  const cb=$('cbUrl'); if(cb)cb.textContent=location.origin+location.pathname;
  if($('stockSearch')){
    const all=Object.entries(TYPES).map(([tid,t])=>({tid:+tid,n:t.n,nl:t.n.toLowerCase(),c:tgroup(tid)}));
    attachSearch('stockSearch','stockSugs',all,p=>{P.dataset.stockPick=p.tid;$('stockSearch').value=p.n;});
  }
}
function wireTop(){
  attachSearch('search','sugs',PRODUCTS,p=>{wireTop._pick=p;$('search').value=p.n;});
  $('addBtn').onclick=()=>{
    let p=wireTop._pick;
    if(!p||p.n!==$('search').value){
      const q=$('search').value.trim().toLowerCase();
      p=PRODUCTS.find(x=>x.nl===q)||PRODUCTS.find(x=>x.nl.startsWith(q));
    }
    if(!p){toast('Pick a buildable item from the suggestions');return;}
    S.targets.push({tid:p.tid,qty:Math.max(1,parseInt($('qty').value)||1)});
    wireTop._pick=null;$('search').value='';S.tab='plan';render();save();
    refreshPrices();
  };
  for(const t of ['plan','steps','shop','data'])
    $('tab-'+t).onclick=()=>{S.tab=t;render();save();};
  const bind=(id,key,isBool)=>{const el=$(id);
    if(isBool)el.checked=!!S.set[key]; else el.value=S.set[key];
    el.onchange=()=>{S.set[key]=isBool?el.checked:(parseFloat(el.value)||0);render();save();};};
  bind('defME','me');bind('defTE','te');bind('structM','structM');bind('structR','structR');bind('invToggle','invent',true);
}

/* ---------- boot ---------- */
(async function(){
  try{const raw=localStorage.getItem(LSKEY);if(raw)S=Object.assign(S,JSON.parse(raw));}catch(e){}
  try{const raw=localStorage.getItem(SSOKEY);if(raw)SSO=JSON.parse(raw);}catch(e){}
  applyTheme();
  renderReadouts();
  try{
    const [t,r]=await Promise.all([
      fetch('data/types.json').then(x=>x.json()),
      fetch('data/recipes.json').then(x=>x.json())
    ]);
    TYPES=t;BASE_RECIPES=r.recipes;ALTS=r.alts||{};INVENT=r.invention;GROUPS=r.groups;
    applyRecipeChoices();
  }catch(e){
    $('panel').innerHTML='<div class="empty">Could not load the static data files (data/types.json, data/recipes.json). If you are opening this from disk, serve it over http instead.</div>';
    return;
  }
  buildSearch();
  wireTop();
  renderReadouts();
  await ssoCallback();          // handle ?code= return from EVE SSO
  render();
  // live prices: refresh on load if plan exists and prices are stale (>30 min)
  if(S.targets.length&&(Date.now()-S.priceTs>30*60000)) refreshPrices();
})();
