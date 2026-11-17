/* VITICO Wholesale web app.
   Talks to Supabase directly. Every price, stock, credit and allocation change happens inside
   database functions (see supabase/schema.sql); this file only shows data and sends requests. */
(function(){
const CFG=window.VITICO_CONFIG||{};
const $=id=>document.getElementById(id);
const r2=n=>Math.round(n*100)/100;
const fj=n=>'$'+r2(+n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const day=t=>new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
const val=id=>($(id)?$(id).value.trim():'');
const num=v=>Math.max(0,parseFloat(v)||0);
const CATS={Staples:'#B67A12',Canned:'#B4432B',Drinks:'#2C7FB8',Snacks:'#7A5AA6',Household:'#3D8C6E',Other:'#6B7690'};
const STAT=['Submitted','Confirmed','Processing','Ready','Dispatched','Completed','On hold','Partially fulfilled','Reserved','Cancelled'];
const NAV={
 public:[['welcome','Welcome'],['apply','Apply for an account'],['login','Log in']],
 pending:[['waiting','Your application']],
 customer:[['home','Home'],['products','Products'],['orders','Orders'],['deals','Deal Drops'],['container','Container builder'],['rebates','Rebates'],['account','Account']],
 rep:[['my-customers','My customers'],['price-requests','Special prices'],['commission','Sales and commission']],
 admin:[['admin-orders','Orders'],['admin-products','Products'],['admin-pricing','Pricing rules'],['admin-deals','Deal Drops'],['admin-containers','Containers'],['admin-customers','Customers and users'],['admin-approvals','Price approvals']]
};

if(!CFG.SUPABASE_URL||!CFG.SUPABASE_KEY||/YOUR-/.test(CFG.SUPABASE_URL+CFG.SUPABASE_KEY)){
  $('view').innerHTML='<section class="panel"><h1>Connect your database</h1><p style="margin-top:10px">This copy of the site has no database details. Put your Supabase project URL and publishable key in <b>web/config.js</b>, or set <b>SUPABASE_URL</b> and <b>SUPABASE_KEY</b> in Vercel. The README has the steps.</p></section>';
  return;
}
const sb=window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_KEY);
const ctx={user:null,profile:null,customer:null,settings:{},tiers:[],zones:[],breaks:[],cat:[],cart:null,box:null};
let DATA={},D={},Q='',CAT='All',M=null,UI=null,RECOVER=false,NOTE='',RF={c:'',s:'',price:'',reason:''},PV={c:'',s:'',q:1},seq=0,CUR='';

async function q(p){const{data,error}=await p;if(error)throw new Error(error.message);return data;}
function toast(t){const e=$('toast');e.textContent=t;e.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>e.style.display='none',4200);}
const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify(v));}catch(e){}return null;};

/* ---------- session ---------- */
async function loadCustomer(){
  // keep the current customer in place while the fresh copy loads, so the screen never flips to "pending"
  if(!(ctx.profile&&ctx.profile.role==='customer'&&ctx.profile.customer_id)){ctx.customer=null;return;}
  ctx.customer=await q(sb.from('customers').select('*, zones(name), rep:profiles!rep_id(full_name,email)').eq('id',ctx.profile.customer_id).single());
}
async function loadRules(){
  [ctx.settings,ctx.tiers,ctx.zones,ctx.breaks]=await Promise.all([q(sb.from('settings').select('*').single()),q(sb.from('tiers').select('*').order('sort')),
    q(sb.from('zones').select('*').order('sort')),q(sb.from('qty_breaks').select('*').order('min_qty'))]);
}
async function loadCtx(){
  const{data:{session}}=await sb.auth.getSession();
  ctx.user=session?session.user:null;ctx.profile=ctx.customer=ctx.cart=ctx.box=null;ctx.cat=[];
  if(!ctx.user){ctx.zones=await q(sb.from('zones').select('*').order('sort'));return;}
  ctx.profile=await q(sb.from('profiles').select('*').eq('id',ctx.user.id).single());
  await Promise.all([loadRules(),loadCustomer()]);
  if(ctx.customer){ctx.cart=store('vitico-cart-'+ctx.customer.id)||{};ctx.box=store('vitico-box-'+ctx.customer.id)||{type:'',dest:'',items:{}};}
}
const role=()=>!ctx.user?'public':ctx.profile.role==='admin'?'admin':ctx.profile.role==='rep'?'rep':ctx.customer?'customer':'pending';
const credit=c=>r2(c.credit_limit-c.balance);
const saveCart=()=>store('vitico-cart-'+ctx.customer.id,ctx.cart);
const saveBox=()=>store('vitico-box-'+ctx.customer.id,ctx.box);
async function loadCat(){ctx.cat=await q(sb.rpc('catalogue',{p_customer:ctx.customer.id}));}
const cp=id=>ctx.cat.find(p=>p.id===id);

/* ---------- pricing on screen: read the ladder the database worked out ---------- */
function pAt(pricing,qty){
  const L=pricing.ladder;let e=L[0],i=0;L.forEach((x,j)=>{if(qty>=x.min){e=x;i=j;}});
  const nx=L.slice(i+1).find(x=>x.unit<e.unit),steps=pricing.steps.map(s=>[s.label,s.value]);
  if(e.off>0)steps.push([e.min+'+ cartons −'+e.off+'%',r2(pricing.pre*(1-e.off/100))]);
  if(e.promo>0)steps.push(['Promotion −'+e.promo+'%',e.unit]);
  return{unit:e.unit,steps,ladder:L,cur:e,next:nx?{need:nx.min-qty,unit:nx.unit}:null,ref:pricing.ref};
}
function calc(items){
  const lines=Object.entries(items).filter(([id,n])=>n>0&&cp(id)).map(([id,n])=>{const p=cp(id),pr=pAt(p.pricing,n);return{p,q:n,pr,sum:r2(n*pr.unit)};});
  return{lines,total:r2(lines.reduce((a,l)=>a+l.sum,0)),
    saved:r2(lines.reduce((a,l)=>a+(l.pr.ref&&l.pr.ref>l.pr.unit?(l.pr.ref-l.pr.unit)*l.q:0),0)),
    cbm:lines.reduce((a,l)=>a+l.q*l.p.cbm,0),kg:lines.reduce((a,l)=>a+l.q*l.p.kg,0),cartons:lines.reduce((a,l)=>a+l.q,0)};
}

/* ---------- small html helpers ---------- */
const stat=s=>`<span class="tag ${({Completed:'t-go',Dispatched:'t-go',Approved:'t-go',Applied:'t-go',Paid:'t-go','Bond paid':'t-go',Reserved:'t-deal',Pending:'t-deal','Awaiting payment':'t-deal','Awaiting bond payment':'t-deal','On hold':'t-bad',Declined:'t-bad',Cancelled:'t-bad',Overdue:'t-bad'})[s]||''}">${esc(s)}</span>`;
function left(ms){if(ms<=0)return'Ended';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d?`${d}d ${h}h left`:`${h}h ${String(m).padStart(2,'0')}m ${String(s%60).padStart(2,'0')}s left`;}
const ends=d=>`data-ends="${Date.parse(d.ends_at)}"`;
const stepper=(k,s,v,step)=>`<span class="stepper"><button data-a="step" data-k="${k}" data-s="${s}" data-d="-${step||1}" aria-label="Fewer">−</button><input type="number" min="0" value="${v}" data-k="${k}" data-s="${s}" aria-label="Quantity"><button data-a="step" data-k="${k}" data-s="${s}" data-d="${step||1}" aria-label="More">+</button></span>`;
const opts=(list,v)=>list.map(([a,b])=>`<option value="${esc(a)}" ${a===v?'selected':''}>${esc(b)}</option>`).join('');
// An input that saves straight to one column of one row.
const bind=(tbl,id,col,v,t,w,key)=>`<input ${t==='text'?'type="text"':t==='bool'?'type="checkbox"'+(v?' checked':''):'type="number" step="any" min="0"'} ${t==='bool'?'':`value="${esc(v)}"`} data-tbl="${tbl}" data-id="${esc(id)}" data-col="${col}" data-t="${t}" data-key="${key||'id'}"${w?` style="width:${w}px"`:''}>`;
const bsel=(tbl,id,col,v,list,nullable)=>`<select data-tbl="${tbl}" data-id="${esc(id)}" data-col="${col}" data-t="${nullable?'nullable':'text'}" data-key="id">${nullable?`<option value="">None</option>`:''}${opts(list.map(o=>Array.isArray(o)?o:[o,o]),v)}</select>`;
const stepsHTML=st=>`<ul class="steps">${st.map(s=>`<li><span>${esc(s[0])}</span><b>${fj(s[1])}</b></li>`).join('')}</ul>`;
const lineText=o=>(o.order_lines||[]).map(l=>`${l.qty} × ${esc(l.products?l.products.name:'')}`).join(', ')+(o.info?`<br><span class="muted">${esc(o.info)}</span>`:'');
const dealWho=d=>d.tiers&&d.tiers.length?d.tiers.join(' and ')+' only':'Everyone';
const empty=t=>`<p class="muted">${t}</p>`;

const L={},V={};
/* ================= PUBLIC ================= */
V.welcome=()=>`<section class="hero"><div><h1>Wholesale groceries for Fiji and the Pacific</h1>
   <p>Order by the carton or fill a container for the islands. Your own prices, credit and rebates are in one place.</p>
   <a class="btn" href="#apply">Apply for a trade account</a><a class="btn ghost" href="#login">Log in</a></div></section>
  <div class="grid g2" style="margin-top:14px">
   <section class="panel"><h2>Prices set for your business</h2><p>Your tier, island and order size all count. Every product shows the price at each quantity and how it compares with the FCCC reference price.</p></section>
   <section class="panel"><h2>Build your own container</h2><p>Mix products in a 20FT or 40FT container and watch the volume and weight fill as you add cartons.</p></section>
   <section class="panel"><h2>Rebates that add up</h2><p>Earn a rebate on every completed order, track your quarterly target and spend the balance on your next order.</p></section>
  </div>`;
V.apply=()=>NOTE?`<section class="panel"><h1>Application sent</h1><p style="margin:10px 0">${esc(NOTE)}</p></section>`
 :`<div class="head"><h1>Apply for a trade account</h1><p class="muted">For shops, resorts, caterers and island traders. We review each application and set your tier and credit limit.</p></div>
  <section class="panel"><div class="form">
   <label class="field">Business name<input type="text" id="ap-n" autocomplete="organization"></label>
   <label class="field">Your name<input type="text" id="ap-c" autocomplete="name"></label>
   <label class="field">Email<input type="email" id="ap-e" autocomplete="email"></label>
   <label class="field">Choose a password<input type="password" id="ap-w" autocomplete="new-password"></label>
   <label class="field">Phone<input type="text" id="ap-p" autocomplete="tel"></label>
   <label class="field">Where you take delivery<select id="ap-z">${opts(ctx.zones.map(z=>[z.id,z.name]))}</select></label>
   <label class="field wide">What you usually buy<textarea id="ap-t" rows="3"></textarea></label>
   <div class="wide"><p class="err small" id="ap-err"></p><button class="btn" data-a="apply">Send application</button></div></div></section>`;
V.login=()=>RECOVER?`<div class="head"><h1>Choose a new password</h1></div><section class="panel" style="max-width:460px">
   <label class="field">New password<input type="password" id="lg-n" autocomplete="new-password"></label>
   <p class="err small" id="lg-err" style="margin:10px 0"></p><button class="btn" data-a="newpass">Save password</button></section>`
 :`<div class="head"><h1>Log in</h1></div><section class="panel" style="max-width:460px">
   <label class="field">Email<input type="email" id="lg-e" autocomplete="email"></label>
   <label class="field" style="margin-top:12px">Password<input type="password" id="lg-p" autocomplete="current-password"></label>
   <p class="err small" id="lg-err" style="margin:10px 0"></p>
   <button class="btn" data-a="login">Log in</button> <button class="btn ghost" data-a="forgot">Email me a reset link</button>
   <p class="small" style="margin-top:14px">No account yet? <a href="#apply">Apply for a trade account</a></p></section>`;
L.waiting=async()=>({apps:await q(sb.from('applications').select('*').order('created_at',{ascending:false}))});
V.waiting=d=>{const a=d.apps[0];
  return `<section class="panel"><h1>${a&&a.status==='Declined'?'Application not approved':'Your application is being reviewed'}</h1>
   <p style="margin:10px 0">${a?(a.status==='Declined'?'Contact VITICO if you think this is a mistake.':`We received the application for ${esc(a.business_name)} on ${day(a.created_at)}. You can order as soon as it is approved.`):'This login is not linked to a customer account yet. Ask VITICO to link it.'}</p>
   <button class="btn ghost" data-a="retry">Check again</button></section>`;};

/* ================= CUSTOMER ================= */
L.home=async()=>{await loadCustomer();const[orders,deals]=await Promise.all([
  q(sb.from('orders').select('id,number,type,status,total,created_at,order_lines(id)').not('status','in','("Completed","Cancelled")').order('created_at',{ascending:false}).limit(4)),
  q(sb.from('deals').select('*').gt('ends_at',new Date().toISOString()).order('ends_at'))]);return{orders,deals};};
V.home=d=>{
  const c=ctx.customer,R=ctx.settings,used=c.credit_limit?c.balance/c.credit_limit*100:0,tp=c.quarter_target?Math.min(100,c.spend/c.quarter_target*100):0;
  return `<div class="head"><h1>${esc(c.name)}</h1><span class="tag">${esc(c.tier)} tier</span><span class="tag">${esc(c.zones?c.zones.name:'')}</span></div>
  <div class="grid g2">
   <section class="panel"><h2>Credit</h2><div class="fig">${fj(credit(c))}</div><p class="muted small">available of ${fj(c.credit_limit)} limit, ${esc(c.terms)}</p>
     <div class="meter ${used>90?'over':used>75?'warn':''}"><i style="width:${Math.min(100,used)}%"></i></div><p class="small">${fj(c.balance)} outstanding. <a href="#account">See invoices</a></p></section>
   <section class="panel"><h2>Rebate target this quarter</h2><div class="fig">${fj(c.spend)}</div><p class="muted small">${c.quarter_target?`spent of ${fj(c.quarter_target)} target`:'spent so far'}</p>
     <div class="meter sky"><i style="width:${tp}%"></i></div><p class="small">${!+c.quarter_target?'No target set yet.':c.spend>=c.quarter_target?'<span class="ok">Target reached.</span>':`${fj(c.quarter_target-c.spend)} to go for a ${R.target_rate_pct}% rebate, about ${fj(c.quarter_target*R.target_rate_pct/100)}.`}</p></section>
   <section class="panel"><h2>Rebate wallet</h2><div class="fig">${fj(c.wallet_available)}</div><p class="muted small">ready to spend, plus ${fj(c.wallet_pending)} pending</p>
     <p class="small" style="margin-top:8px">${fj(c.saved)} saved against FCCC reference prices.</p></section>
  </div>
  <div class="grid g2">
   <section class="panel"><h2>Open orders</h2>${d.orders.length?d.orders.map(o=>`<div class="line"><div><b>${esc(o.number)}</b> <span class="muted small">${day(o.created_at)}, ${esc(o.type)}</span></div><div>${stat(o.status)}</div><div class="muted small">${o.order_lines.length} products</div><div>${fj(o.total)}</div></div>`).join(''):empty('No open orders. Start one from Products.')}
     <p style="margin-top:10px"><a href="#orders">All orders</a></p></section>
   <section class="panel"><h2>Deal Drops live now</h2>${d.deals.map(x=>`<div class="line"><div><b>${esc(x.name)}</b></div><div class="count" ${ends(x)}></div><div class="muted small">${x.remaining} of ${x.allocation} left</div><div>${fj(x.unit_price)} per ${esc(x.per)}</div></div>`).join('')||empty('No deals running right now.')}
     <p style="margin-top:10px"><a href="#deals">See Deal Drops</a></p></section>
  </div>`;
};
L.products=async()=>{await loadCat();return{};};
function prodList(){
  const s=Q.trim().toLowerCase();
  const list=ctx.cat.filter(p=>(CAT==='All'||p.category===CAT)&&(!s||(p.name+' '+p.sku+' '+p.pack).toLowerCase().includes(s)));
  if(!ctx.cat.length)return empty('No products have been added yet.');
  if(!list.length)return empty('No products match. Clear the search or pick another category.');
  return list.map(p=>{const qty=D[p.id]||1,pr=pAt(p.pricing,qty);
   return `<article class="prod"><div class="tile" style="background:${CATS[p.category]||CATS.Other}">${esc(p.sku.slice(0,4))}</div>
    <div><h3>${esc(p.name)}</h3><p class="muted small">${esc(p.pack)}. ${p.stock.toLocaleString()} cartons available. ${p.cbm} CBM and ${p.kg} kg per carton.</p>
     ${pr.ladder.length>1?`<ol class="ladder">${pr.ladder.map(l=>`<li class="${l===pr.cur?'on':''}">${l.min}+ cartons<b>${fj(l.unit)}</b></li>`).join('')}</ol>`:''}
     <details><summary>How this price is worked out</summary>${stepsHTML(pr.steps)}</details></div>
    <div class="pbuy"><div class="unit">${fj(pr.unit)} <small>per carton</small></div>
     ${pr.ref&&pr.ref>pr.unit?`<p class="small">FCCC reference ${fj(pr.ref)}. <span class="ok">You save ${fj(pr.ref-pr.unit)}</span></p>`:''}
     ${pr.next?`<p class="small muted">${pr.next.need} more for ${fj(pr.next.unit)} each</p>`:''}
     <div>${stepper('p',p.id,qty)}</div><button class="btn" data-a="add" data-s="${p.id}" ${p.stock?'':'disabled'}>${p.stock?'Add to cart':'Out of stock'}</button></div></article>`;}).join('');
}
V.products=()=>`<div class="head"><h1>Products</h1><p class="muted">Carton prices in FJD for ${esc(ctx.customer.name)}.</p></div>
  <div class="filters"><input type="search" id="q" placeholder="Search by name or code" value="${esc(Q)}" aria-label="Search products">
  ${['All',...new Set(ctx.cat.map(p=>p.category))].map(c=>`<button class="chip ${c===CAT?'on':''}" data-a="cat" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div id="plist">${prodList()}</div>`;
L.orders=async()=>({orders:await q(sb.from('orders').select('*, order_lines(product_id, qty, products(name))').order('created_at',{ascending:false}))});
V.orders=d=>`<div class="head"><h1>Orders</h1></div><div class="panel scroll">${d.orders.length?`<table><thead><tr><th>Order</th><th>Placed</th><th>Type</th><th>PO number</th><th>Contents</th><th class="num">Total</th><th>Status</th><th>Payment</th><th></th></tr></thead><tbody>
  ${d.orders.map(o=>`<tr><td><b>${esc(o.number)}</b></td><td>${day(o.created_at)}</td><td>${esc(o.type)}</td><td>${esc(o.po_number)}</td><td class="small">${lineText(o)}</td>
   <td class="num">${fj(o.total)}</td><td>${stat(o.status)}</td><td>${stat(o.payment_status||'')}</td><td>${o.type==='Order'?`<button class="btn ghost sm" data-a="reorder" data-id="${o.id}">Reorder</button>`:''}</td></tr>`).join('')}</tbody></table>`:empty('No orders yet. Add products to the cart to place the first one.')}</div>`;
L.deals=async()=>{await loadCustomer();const[deals,res]=await Promise.all([q(sb.from('deals').select('*, deal_lines(qty, products(name, pack, base_price))').order('ends_at',{ascending:false})),
  q(sb.from('deal_reservations').select('deal_id, qty'))]);return{deals,res};};
const taken=(d,id)=>d.res.filter(r=>r.deal_id===id).reduce((a,r)=>a+r.qty,0);
V.deals=d=>{
  const c=ctx.customer;
  return `<div class="head"><h1>Deal Drops</h1><p class="muted">Limited stock at a fixed price. A ${ctx.settings.bond_pct}% security bond holds your allocation and comes off the final invoice.</p></div>
  <div class="grid g2">${d.deals.map(x=>{const mine=taken(d,x.id),ended=Date.parse(x.ends_at)<=Date.now(),locked=x.tiers&&x.tiers.length&&!x.tiers.includes(c.tier),normal=x.deal_lines.reduce((a,l)=>a+(l.products?l.products.base_price:0)*l.qty,0);
    const btn=ended?'<button class="btn" disabled>Ended</button>':!x.remaining?'<button class="btn" disabled>Sold out</button>':locked?`<p class="err small">For ${esc(x.tiers.join(' and '))} customers only.</p>`:mine>=x.max_per_customer?'<p class="ok small">You have secured your maximum.</p>':`<button class="btn deal" data-a="deal" data-id="${x.id}">Secure deal</button>`;
    return `<article class="panel deal"><header><h3>${esc(x.name)}</h3><span class="count" ${ends(x)}></span></header>
     <p class="small">${x.deal_lines.map(l=>`${x.per==='combo'?l.qty+' × ':''}${esc(l.products.name)} (${esc(l.products.pack)})`).join(', ')}</p>
     <p style="margin:8px 0"><span class="unit">${fj(x.unit_price)}</span> <span class="muted small">per ${esc(x.per)}, normally ${fj(normal)}</span></p>
     <div class="meter sky"><i style="width:${Math.min(100,x.remaining/x.allocation*100)}%"></i></div>
     <p class="small">${x.remaining} of ${x.allocation} left. Up to ${x.max_per_customer} per customer${mine?`, you have secured ${mine}`:''}.</p>
     <p class="muted small" style="margin:6px 0 10px">${esc(x.note)}</p>${btn}</article>`;}).join('')||empty('No deals yet. New Deal Drops appear here.')}</div>`;
};
L.container=async()=>{await Promise.all([loadCat(),loadCustomer()]);const[types,dests]=await Promise.all([q(sb.from('container_types').select('*').order('sort')),q(sb.from('destinations').select('*').order('name'))]);
  if(!types.find(t=>t.id===ctx.box.type))ctx.box.type=types[0]?types[0].id:'';if(!dests.find(x=>x.name===ctx.box.dest))ctx.box.dest=dests[0]?dests[0].name:'';return{types,dests};};
V.container=d=>{
  const c=ctx.customer,b=ctx.box,cap=d.types.find(t=>t.id===b.type);
  if(!cap)return `<div class="head"><h1>Container builder</h1></div>${empty('No container types have been set up yet.')}`;
  const k=calc(b.items),pv=k.cbm/cap.max_cbm*100,pw=k.kg/cap.max_kg*100,over=pv>100||pw>100,near=!over&&(pv>=90||pw>=90);
  const cats={};k.lines.forEach(l=>{cats[l.p.category]=(cats[l.p.category]||0)+l.q*l.p.cbm;});
  const msg=over?`<p class="err">Over capacity by ${pv>100?(k.cbm-cap.max_cbm).toFixed(2)+' CBM':Math.round(k.kg-cap.max_kg).toLocaleString()+' kg'}. Remove cartons or switch to a larger container before placing the order.</p>`
    :near?'<p class="small" style="font-weight:500">Nearly full. Check the remaining space before adding more.</p>':!k.cartons?'<p class="muted small">Add cartons below to start loading.</p>':'';
  const can=!over&&k.cartons>0,short=can&&k.total>credit(c);
  return `<div class="head"><h1>Container builder</h1><p class="muted">Plan a mixed container for the islands. Volume, weight and price update as you load.</p></div>
  <section class="panel">
   <div class="row" style="margin-bottom:12px">
    <span class="seg">${d.types.map(x=>`<button class="${x.id===cap.id?'on':''}" data-a="box" data-t="${x.id}">${esc(x.name)}</button>`).join('')}</span>
    <label class="small muted">Destination <select id="dest">${opts(d.dests.map(x=>[x.name,x.name]),b.dest)}</select></label></div>
   <div class="box ${over?'over':''}" role="img" aria-label="Container ${Math.round(pv)} percent full by volume">${Object.entries(cats).map(([n,v])=>`<span style="width:${v/cap.max_cbm*100}%;background:${CATS[n]||CATS.Other}"></span>`).join('')}</div>
   <div class="legend">${Object.keys(cats).map(n=>`<span><i style="background:${CATS[n]||CATS.Other}"></i>${esc(n)}</span>`).join('')}</div>
   <div class="grid g2" style="margin-top:10px">
    <div><div class="boxcap"><b>Volume ${pv.toFixed(0)}%</b><span class="small">${k.cbm.toFixed(2)} of ${cap.max_cbm} CBM, ${Math.max(0,cap.max_cbm-k.cbm).toFixed(2)} left</span></div><div class="meter ${pv>100?'over':pv>=90?'warn':''}"><i style="width:${Math.min(100,pv)}%"></i></div></div>
    <div><div class="boxcap"><b>Weight ${pw.toFixed(0)}%</b><span class="small">${Math.round(k.kg).toLocaleString()} of ${(+cap.max_kg).toLocaleString()} kg, ${Math.max(0,Math.round(cap.max_kg-k.kg)).toLocaleString()} left</span></div><div class="meter ${pw>100?'over':pw>=90?'warn':''}"><i style="width:${Math.min(100,pw)}%"></i></div></div>
   </div>${msg}
   <div class="row" style="justify-content:space-between;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
    <div><span class="fig">${fj(k.total)}</span> <span class="muted small">${k.cartons.toLocaleString()} cartons, on account</span>${short?`<p class="err small">This is more than your available credit of ${fj(credit(c))}.</p>`:''}</div>
    <div><button class="btn ghost" data-a="boxclear" ${k.cartons?'':'disabled'}>Empty container</button> <button class="btn" data-a="boxorder" ${can&&!short?'':'disabled'}>Place container order</button></div></div>
  </section>
  <section class="panel scroll"><table><thead><tr><th>Product</th><th class="num">CBM</th><th class="num">kg</th><th class="num">Price at this quantity</th><th>Cartons</th><th class="num">Line total</th></tr></thead><tbody>
  ${ctx.cat.map(p=>{const n=b.items[p.id]||0,pr=pAt(p.pricing,Math.max(n,1));return `<tr><td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.pack)}</span></td><td class="num">${p.cbm}</td><td class="num">${p.kg}</td><td class="num">${fj(pr.unit)}</td><td>${stepper('b',p.id,n,10)}</td><td class="num">${n?fj(n*pr.unit):''}</td></tr>`;}).join('')}</tbody></table></section>`;
};
L.rebates=async()=>{await loadCustomer();return{led:await q(sb.from('wallet_ledger').select('*').order('created_at',{ascending:false}).limit(200))};};
V.rebates=d=>{
  const c=ctx.customer,R=ctx.settings,t=+c.quarter_target;
  return `<div class="head"><h1>Rebates</h1></div><div class="grid g2">
   <section class="panel"><h2>Wallet</h2><div class="fig">${fj(c.wallet_available)}</div><p class="muted small">ready to spend on orders or Deal Drop bonds</p>
    <p style="margin-top:8px">${fj(c.wallet_pending)} pending. Rebates of ${R.rebate_pct}% are released when an order is completed.</p></section>
   <section class="panel"><h2>Quarter target</h2><div class="fig">${t?Math.round(Math.min(1,c.spend/t)*100)+'%':fj(c.spend)}</div><div class="meter sky"><i style="width:${t?Math.min(100,c.spend/t*100):0}%"></i></div>
    <p>${!t?'No target set yet.':`${fj(c.spend)} of ${fj(t)}. ${c.spend>=t?'Target reached.':`Spend ${fj(t-c.spend)} more to earn about ${fj(t*R.target_rate_pct/100)}.`}`}</p></section></div>
   <section class="panel scroll"><h2>Wallet history</h2>${d.led.length?`<table><thead><tr><th>Date</th><th>What happened</th><th class="num">Amount</th></tr></thead><tbody>
   ${d.led.map(l=>`<tr><td>${day(l.created_at)}</td><td>${esc(l.description)}</td><td class="num ${l.amount<0?'':'ok'}">${l.amount<0?'−':'+'}${fj(Math.abs(l.amount))}</td></tr>`).join('')}</tbody></table>`:empty('Nothing yet. Rebates appear here when orders are completed.')}</section>`;
};
L.account=async()=>{await loadCustomer();const id=ctx.customer.id;const[people,inv,con]=await Promise.all([
  q(sb.from('profiles').select('full_name,email,company_role,can_approve').eq('customer_id',id)),
  q(sb.from('invoices').select('*').order('issued_on',{ascending:false})),
  q(sb.from('contract_prices').select('price, products(name)').eq('customer_id',id))]);return{people,inv,con};};
V.account=d=>{
  const c=ctx.customer;
  return `<div class="head"><h1>Account</h1></div><div class="grid g2">
   <section class="panel"><h2>${esc(c.name)}</h2><table class="kv"><tbody>
    <tr><th>Tier</th><td>${esc(c.tier)}</td></tr><tr><th>Pricing zone</th><td>${esc(c.zones?c.zones.name:'')}</td></tr><tr><th>Payment terms</th><td>${esc(c.terms)}</td></tr>
    <tr><th>Credit limit</th><td>${fj(c.credit_limit)}</td></tr><tr><th>Outstanding</th><td>${fj(c.balance)}</td></tr><tr><th>Available credit</th><td><b>${fj(credit(c))}</b></td></tr>
    <tr><th>Your sales rep</th><td>${c.rep?esc(c.rep.full_name||c.rep.email):'Not assigned yet'}</td></tr>
    ${d.con.length?`<tr><th>Contract prices</th><td>${d.con.map(x=>`${esc(x.products.name)} ${fj(x.price)}`).join(', ')}</td></tr>`:''}</tbody></table></section>
   <section class="panel"><h2>People on this account</h2><table class="kv"><thead><tr><th>Name</th><th>Role</th><th>Can approve orders</th></tr></thead><tbody>
    ${d.people.map(u=>`<tr><td>${esc(u.full_name||u.email)}</td><td>${esc(u.company_role)}</td><td>${u.can_approve?'Yes':'No'}</td></tr>`).join('')}</tbody></table></section></div>
   <section class="panel scroll"><h2>Invoices</h2>${d.inv.length?`<table><thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
    ${d.inv.map(i=>`<tr><td><b>${esc(i.number)}</b></td><td>${day(i.issued_on)}</td><td>${i.due_on?day(i.due_on):''}</td><td>${stat(i.status)}</td><td class="num">${fj(i.amount)}</td><td>${i.pdf_url&&/^https:/.test(i.pdf_url)?`<a class="btn ghost sm" href="${esc(i.pdf_url)}" target="_blank" rel="noopener">Download PDF</a>`:''}</td></tr>`).join('')}</tbody></table>`:empty('No invoices yet. They appear here once the accounting system is connected.')}</section>`;
};

/* ================= SALES REP ================= */
L['my-customers']=async()=>{const[cs,os]=await Promise.all([q(sb.from('customers').select('*, zones(name), contract_prices(price, products(name))').order('name')),
  q(sb.from('orders').select('customer_id, number, status, created_at').order('created_at',{ascending:false}))]);return{cs,os};};
V['my-customers']=d=>`<div class="head"><h1>My customers</h1><p class="muted">${esc(ctx.profile.full_name||ctx.profile.email)}, ${d.cs.length} accounts.</p></div>
  ${d.cs.length?`<div class="grid g2">${d.cs.map(c=>{const o=d.os.find(x=>x.customer_id===c.id),tp=c.quarter_target?Math.min(100,c.spend/c.quarter_target*100):0,used=c.credit_limit?c.balance/c.credit_limit*100:0;
   return `<section class="panel"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(c.name)}</h2><span class="tag">${esc(c.tier)}</span></div>
    <p class="muted small">${esc(c.zones?c.zones.name:'')}, ${esc(c.terms)}</p>
    <p class="small" style="margin-top:10px">Quarter spend ${fj(c.spend)} of ${fj(c.quarter_target)}</p><div class="meter sky"><i style="width:${tp}%"></i></div>
    <p class="small">Credit used ${fj(c.balance)} of ${fj(c.credit_limit)}</p><div class="meter ${used>90?'over':used>75?'warn':''}"><i style="width:${Math.min(100,used)}%"></i></div>
    <table class="kv"><tbody><tr><th>Last order</th><td>${o?`${esc(o.number)}, ${day(o.created_at)}, ${stat(o.status)}`:'None yet'}</td></tr>
     <tr><th>Rebate wallet</th><td>${fj(c.wallet_available)}</td></tr><tr><th>Contract prices</th><td>${c.contract_prices.map(x=>`${esc(x.products.name)} ${fj(x.price)}`).join(', ')||'None'}</td></tr></tbody></table></section>`;}).join('')}</div>`
   :empty('No customers are assigned to you yet. An admin assigns them under Customers and users.')}`;
L['price-requests']=async()=>{const[cs,ps,rq]=await Promise.all([q(sb.from('customers').select('id,name').order('name')),q(sb.from('products').select('id,name').eq('active',true).order('name')),
  q(sb.from('price_requests').select('*, customers(name), products(name)').eq('rep_id',ctx.user.id).order('created_at',{ascending:false}))]);
  if(!cs.find(c=>c.id===RF.c))RF.c=cs[0]?cs[0].id:'';if(!ps.find(p=>p.id===RF.s))RF.s=ps[0]?ps[0].id:'';return{cs,ps,rq};};
V['price-requests']=d=>`<div class="head"><h1>Special prices</h1><p class="muted">Offer a customer their own price on a product. Prices more than ${ctx.settings.rep_floor_pct}% below normal go to an admin for approval.</p></div>
  <section class="panel"><h2>Request a price</h2>${d.cs.length&&d.ps.length?`<div class="form">
   <label class="field">Customer<select id="rf-c">${opts(d.cs.map(c=>[c.id,c.name]),RF.c)}</select></label>
   <label class="field">Product<select id="rf-s">${opts(d.ps.map(p=>[p.id,p.name]),RF.s)}</select></label>
   <label class="field">Price per carton<input type="number" step="any" min="0" id="rf-p" value="${esc(RF.price)}"></label>
   <label class="field wide">Reason<input type="text" id="rf-r" value="${esc(RF.reason)}" placeholder="Why this customer should get this price" style="width:100%"></label>
   <div class="wide"><p class="small" id="rf-hint" style="margin-bottom:10px"></p><button class="btn" data-a="request">Send price request</button></div></div>`:empty('You need at least one customer and one product before you can request a price.')}</section>
  <section class="panel scroll"><h2>My requests</h2>${d.rq.length?`<table><thead><tr><th>Date</th><th>Customer</th><th>Product</th><th class="num">Normal</th><th class="num">Requested</th><th>Reason</th><th>Status</th></tr></thead><tbody>
   ${d.rq.map(r=>`<tr><td>${day(r.created_at)}</td><td>${esc(r.customers&&r.customers.name)}</td><td>${esc(r.products&&r.products.name)}</td><td class="num">${fj(r.normal_price)}</td><td class="num">${fj(r.price)}</td><td class="small">${esc(r.reason)}</td><td>${stat(r.status)}</td></tr>`).join('')}</tbody></table>`:empty('No requests yet.')}</section>`;
const quotes={};
async function rfHint(){
  const el=$('rf-hint');if(!el||!RF.c||!RF.s)return;
  const key=RF.c+'|'+RF.s;
  try{if(quotes[key]==null)quotes[key]=(await q(sb.rpc('quote',{p_customer:RF.c,p_product:RF.s,p_qty:1,p_ignore_contract:true}))).unit;}catch(e){el.textContent=e.message;return;}
  if(key!==RF.c+'|'+RF.s||!$('rf-hint'))return;
  const n=quotes[key],fl=r2(n*(1-ctx.settings.rep_floor_pct/100)),p=parseFloat(RF.price);
  let t=`Normal price for this customer is ${fj(n)}. You can go down to ${fj(fl)} without approval.`;
  if(p>0)t+=p>=fl?` <span class="ok">${fj(p)} is within your limit and applies straight away.</span>`:` <span class="err">${fj(p)} is ${Math.round((1-p/n)*100)}% below normal and needs approval.</span>`;
  $('rf-hint').innerHTML=t;
}
L.commission=async()=>({os:await q(sb.from('orders').select('*, customers(name)').neq('status','Cancelled').order('created_at',{ascending:false}))});
V.commission=d=>{
  const tot=d.os.reduce((a,o)=>a+ +o.total,0),rate=ctx.settings.commission_pct;
  return `<div class="head"><h1>Sales and commission</h1></div><div class="grid g2">
   <section class="panel"><h2>Sales from my customers</h2><div class="fig">${fj(tot)}</div><p class="muted small">${d.os.length} orders</p></section>
   <section class="panel"><h2>Commission</h2><div class="fig">${fj(tot*rate/100)}</div><p class="muted small">at ${rate}% of order value</p></section></div>
   <section class="panel scroll"><h2>Orders</h2>${d.os.length?`<table><thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th>Type</th><th>Status</th><th class="num">Total</th><th class="num">Commission</th></tr></thead><tbody>
   ${d.os.map(o=>`<tr><td><b>${esc(o.number)}</b></td><td>${esc(o.customers&&o.customers.name)}</td><td>${day(o.created_at)}</td><td>${esc(o.type)}</td><td>${stat(o.status)}</td><td class="num">${fj(o.total)}</td><td class="num">${fj(o.total*rate/100)}</td></tr>`).join('')}</tbody></table>`:empty('No orders from your customers yet.')}</section>`;
};

/* ================= ADMIN ================= */
L['admin-orders']=async()=>({os:await q(sb.from('orders').select('*, customers(name), order_lines(qty, products(name))').order('created_at',{ascending:false}).limit(300))});
V['admin-orders']=d=>`<div class="head"><h1>Orders</h1><p class="muted">Marking an order Completed releases its rebate to the customer’s wallet. Cancelling returns the stock, credit and any Deal Drop allocation.</p></div>
  <section class="panel scroll">${d.os.length?`<table><thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th>Type</th><th>Contents</th><th class="num">Total</th><th>Payment</th><th>Status</th></tr></thead><tbody>
  ${d.os.map(o=>`<tr><td><b>${esc(o.number)}</b>${o.po_number?`<br><span class="muted small">${esc(o.po_number)}</span>`:''}</td><td>${esc(o.customers&&o.customers.name)}</td><td>${day(o.created_at)}</td><td>${esc(o.type)}</td><td class="small">${lineText(o)}</td><td class="num">${fj(o.total)}</td>
   <td>${stat(o.payment_status||'')}<br><span class="muted small">${esc(({account:'On account',mpaisa:'M-PAiSA',bank:'Bank deposit',wallet:'Rebate wallet'})[o.pay_method]||'')}</span>${/^Awaiting/.test(o.payment_status||'')&&o.status!=='Cancelled'?`<br><button class="btn ghost sm" data-a="paid" data-id="${o.id}">Mark as paid</button>`:''}</td>
   <td>${o.status==='Cancelled'?stat('Cancelled'):`<select data-ost="${o.id}" aria-label="Status">${STAT.map(s=>`<option ${s===o.status?'selected':''}>${s}</option>`).join('')}</select>`}</td></tr>`).join('')}</tbody></table>`:empty('No orders yet.')}</section>`;
L['admin-products']=async()=>({ps:await q(sb.from('products').select('*').order('sku'))});
V['admin-products']=d=>`<div class="head"><h1>Products</h1><p class="muted">Changes save as you leave each box and apply to every customer’s prices straight away. Untick Active to hide a product.</p></div>
  <section class="panel scroll">${d.ps.length?`<table><thead><tr><th>Code</th><th>Name</th><th>Pack</th><th>Category</th><th>Standard price</th><th>FCCC ref</th><th>Promo %</th><th>CBM</th><th>kg</th><th>Stock</th><th>Active</th><th></th></tr></thead><tbody>
  ${d.ps.map(p=>`<tr><td><b>${esc(p.sku)}</b></td><td>${bind('products',p.id,'name',p.name,'text')}</td><td>${bind('products',p.id,'pack',p.pack,'text')}</td><td>${bind('products',p.id,'category',p.category,'text',100)}</td>
   <td>${bind('products',p.id,'base_price',p.base_price,'num')}</td><td>${bind('products',p.id,'fccc_ref',p.fccc_ref,'numnull')}</td><td>${bind('products',p.id,'promo_pct',p.promo_pct,'num',64)}</td><td>${bind('products',p.id,'cbm',p.cbm,'num',70)}</td><td>${bind('products',p.id,'kg',p.kg,'num',70)}</td><td>${bind('products',p.id,'stock',p.stock,'int')}</td><td>${bind('products',p.id,'active',p.active,'bool')}</td><td><button class="btn ghost sm" data-a="delprod" data-id="${p.id}" data-n="${esc(p.name)}">Delete</button></td></tr>`).join('')}</tbody></table>`:empty('No products yet. Add one below or import your list.')}</section>
  <section class="panel"><h2>Add a product</h2><div class="row"><label class="field">Code<input type="text" id="np-s" style="width:90px"></label><label class="field">Name<input type="text" id="np-n"></label>
   <label class="field">Standard price<input type="number" step="any" min="0" id="np-b" style="width:110px"></label><button class="btn" data-a="addprod">Add product</button></div></section>
  <section class="panel"><h2>Import your product list</h2><p class="muted small">Paste one product per line from a spreadsheet, in this order: code, name, pack, category, standard price, FCCC reference, CBM, kg, stock. Existing codes are updated and new codes are added.</p>
   <textarea id="imp" rows="5" style="width:100%;margin:10px 0" placeholder="RIC, Long grain rice, Bale of 4 × 10 kg, Staples, 98, 104, 0.055, 41, 1200"></textarea><button class="btn" data-a="import">Import products</button></section>`;
L['admin-pricing']=async()=>{await loadRules();const[con,cs,ps]=await Promise.all([q(sb.from('contract_prices').select('customer_id, product_id, price, customers(name), products(name, base_price)')),
  q(sb.from('customers').select('id,name').order('name')),q(sb.from('products').select('id,name').order('name'))]);
  if(!cs.find(c=>c.id===PV.c))PV.c=cs[0]?cs[0].id:'';if(!ps.find(p=>p.id===PV.s))PV.s=ps[0]?ps[0].id:'';return{con,cs,ps};};
V['admin-pricing']=d=>{
  const R=ctx.settings;
  return `<div class="head"><h1>Pricing rules</h1><p class="muted">One set of rules prices the catalogue, cart and container builder. Changes save as you leave each box.</p></div>
  <div class="grid g2">
   <section class="panel"><h2>Tier discounts</h2><table class="kv"><tbody>${ctx.tiers.map(t=>`<tr><th>${esc(t.name)}</th><td>${bind('tiers',t.name,'discount_pct',t.discount_pct,'num',70,'name')} % off</td></tr>`).join('')}</tbody></table></section>
   <section class="panel"><h2>Island zones</h2><table class="kv"><tbody>${ctx.zones.map(z=>`<tr><td>${bind('zones',z.id,'name',z.name,'text')}</td><td>${bind('zones',z.id,'adj_pct',z.adj_pct,'num',70)} % added</td></tr>`).join('')}</tbody></table>
     <div class="row" style="margin-top:10px"><input type="text" id="nz" placeholder="New zone name"><button class="btn ghost" data-a="addzone">Add zone</button></div></section>
   <section class="panel"><h2>Quantity breaks</h2><table class="kv"><tbody>${ctx.breaks.map(b=>`<tr><td>From ${bind('qty_breaks',b.id,'min_qty',b.min_qty,'int',70)} cartons</td><td>${bind('qty_breaks',b.id,'off_pct',b.off_pct,'num',70)} % off</td><td><button class="btn ghost sm" data-a="delrow" data-tbl="qty_breaks" data-id="${b.id}">Remove</button></td></tr>`).join('')}</tbody></table>
     <button class="btn ghost" style="margin-top:10px" data-a="addbreak">Add a break</button></section>
   <section class="panel"><h2>Which rule wins</h2>
     <p class="small muted" style="margin-bottom:8px">A contract price always replaces the standard, tier and zone price. Choose what can still apply on top.</p>
     <label style="display:block;padding:3px 0">${bind('settings',1,'contract_breaks',R.contract_breaks,'bool')} Quantity breaks also apply to contract prices</label>
     <label style="display:block;padding:3px 0">${bind('settings',1,'contract_promo',R.contract_promo,'bool')} Promotions also apply to contract prices</label>
     <label class="field" style="margin-top:8px">When a product has both a promotion and a quantity break${bsel('settings',1,'promo_mode',R.promo_mode,[['stack','Apply both'],['best','Apply only the bigger discount']])}</label></section>
   <section class="panel"><h2>Other rates</h2><table class="kv"><tbody>
     <tr><th>Deal Drop security bond</th><td>${bind('settings',1,'bond_pct',R.bond_pct,'num',70)} %</td></tr>
     <tr><th>Rebate on completed orders</th><td>${bind('settings',1,'rebate_pct',R.rebate_pct,'num',70)} %</td></tr>
     <tr><th>Rebate for reaching the quarter target</th><td>${bind('settings',1,'target_rate_pct',R.target_rate_pct,'num',70)} %</td></tr>
     <tr><th>Sales rep can discount without approval</th><td>${bind('settings',1,'rep_floor_pct',R.rep_floor_pct,'num',70)} %</td></tr>
     <tr><th>Sales commission</th><td>${bind('settings',1,'commission_pct',R.commission_pct,'num',70)} %</td></tr></tbody></table></section>
   <section class="panel"><h2>Check a price</h2>${d.cs.length&&d.ps.length?`<div class="row"><select id="pv-c" aria-label="Customer">${opts(d.cs.map(c=>[c.id,c.name]),PV.c)}</select><select id="pv-s" aria-label="Product">${opts(d.ps.map(p=>[p.id,p.name]),PV.s)}</select>
     <label class="small muted">Cartons <input type="number" min="1" id="pv-q" value="${PV.q}" style="width:80px"></label></div><div id="preview" style="margin-top:10px"></div>`:empty('Add a customer and a product to check prices.')}</section>
  </div>
  <section class="panel scroll"><h2>Contract prices</h2>${d.con.length?`<table><thead><tr><th>Customer</th><th>Product</th><th>Standard price</th><th>Contract price</th><th></th></tr></thead><tbody>
   ${d.con.map(x=>`<tr><td>${esc(x.customers.name)}</td><td>${esc(x.products.name)}</td><td>${fj(x.products.base_price)}</td><td><input type="number" step="any" min="0" value="${esc(x.price)}" data-con="${x.customer_id}|${x.product_id}"></td><td><button class="btn ghost sm" data-a="delcon" data-con="${x.customer_id}|${x.product_id}">Remove</button></td></tr>`).join('')}</tbody></table>`:empty('No contract prices yet.')}
   ${d.cs.length&&d.ps.length?`<div class="row" style="margin-top:12px"><select id="nc-c" aria-label="Customer">${opts(d.cs.map(c=>[c.id,c.name]))}</select><select id="nc-s" aria-label="Product">${opts(d.ps.map(p=>[p.id,p.name]))}</select>
    <input type="number" step="any" min="0" id="nc-p" placeholder="Price" style="width:110px"><button class="btn" data-a="addcon">Add contract price</button></div>`:''}</section>`;
};
async function preview(){
  if(!$('preview')||!PV.c||!PV.s)return;
  try{const pr=pAt(await q(sb.rpc('quote',{p_customer:PV.c,p_product:PV.s,p_qty:PV.q})),PV.q);
    if($('preview'))$('preview').innerHTML=stepsHTML(pr.steps)+`<p style="margin-top:8px">Price per carton <b class="unit">${fj(pr.unit)}</b></p>`;}
  catch(e){if($('preview'))$('preview').innerHTML=`<p class="err">${esc(e.message)}</p>`;}
}
L['admin-deals']=async()=>{const[deals,ps]=await Promise.all([q(sb.from('deals').select('*, deal_lines(qty, products(name))').order('created_at',{ascending:false})),q(sb.from('products').select('id,name,base_price').eq('active',true).order('name'))]);return{deals,ps};};
V['admin-deals']=d=>{
  const po=opts(d.ps.map(p=>[p.id,p.name+' ('+fj(p.base_price)+')']));
  return `<div class="head"><h1>Deal Drops</h1></div>
  <section class="panel scroll">${d.deals.length?`<table><thead><tr><th>Deal</th><th>Who can buy</th><th>Price</th><th>Left</th><th>Allocation</th><th>Max per customer</th><th>Time</th><th></th></tr></thead><tbody>
  ${d.deals.map(x=>`<tr><td><b>${esc(x.name)}</b><br><span class="muted small">${x.deal_lines.map(l=>`${l.qty} × ${esc(l.products.name)}`).join(', ')}</span></td><td>${esc(dealWho(x))}</td>
   <td>${bind('deals',x.id,'unit_price',x.unit_price,'num')}</td><td>${bind('deals',x.id,'remaining',x.remaining,'int',70)}</td><td>${bind('deals',x.id,'allocation',x.allocation,'int',70)}</td><td>${bind('deals',x.id,'max_per_customer',x.max_per_customer,'int',70)}</td>
   <td class="count" ${ends(x)}></td><td style="white-space:nowrap"><button class="btn ghost sm" data-a="dealplus" data-id="${x.id}" data-e="${esc(x.ends_at)}">Add 24 hours</button> <button class="btn ghost sm" data-a="dealend" data-id="${x.id}">End now</button></td></tr>`).join('')}</tbody></table>`:empty('No deals yet. Create the first one below.')}</section>
  <section class="panel"><h2>Create a Deal Drop</h2>${d.ps.length?`<div class="form">
   <label class="field">Deal name<input type="text" id="nd-n"></label>
   <label class="field">Deal price (per carton, or per combo)<input type="number" step="any" min="0" id="nd-p"></label>
   <label class="field">Product<span class="row"><select id="nd-s1">${po}</select><input type="number" min="1" id="nd-q1" value="1" style="width:70px" aria-label="Cartons of this product"></span></label>
   <label class="field">Second product, for a combo<span class="row"><select id="nd-s2"><option value="">None</option>${po}</select><input type="number" min="1" id="nd-q2" value="1" style="width:70px" aria-label="Cartons of this product"></span></label>
   <label class="field">Third product, for a combo<span class="row"><select id="nd-s3"><option value="">None</option>${po}</select><input type="number" min="1" id="nd-q3" value="1" style="width:70px" aria-label="Cartons of this product"></span></label>
   <label class="field">Number available<input type="number" min="1" id="nd-a" value="100"></label>
   <label class="field">Maximum per customer<input type="number" min="1" id="nd-m" value="10"></label>
   <label class="field">Runs for (hours)<input type="number" min="1" id="nd-h" value="24"></label>
   <label class="field">Who can buy<select id="nd-t"><option value="">Everyone</option>${ctx.tiers.map((t,i)=>i?`<option value="${esc(ctx.tiers.slice(i).map(x=>x.name).join(','))}">${esc(ctx.tiers.slice(i).map(x=>x.name).join(' and '))} only</option>`:'').join('')}</select></label>
   <label class="field wide">Note for customers<input type="text" id="nd-w" style="width:100%" placeholder="For example: short-dated stock"></label>
   <div class="wide"><button class="btn deal" data-a="adddeal">Launch Deal Drop</button></div></div>`:empty('Add products before creating a deal.')}</section>`;
};
L['admin-containers']=async()=>{const[types,dests]=await Promise.all([q(sb.from('container_types').select('*').order('sort')),q(sb.from('destinations').select('*').order('name'))]);return{types,dests};};
V['admin-containers']=d=>`<div class="head"><h1>Containers</h1><p class="muted">Capacities the container builder uses to warn and to block an order.</p></div><div class="grid g2">
  <section class="panel"><h2>Container types</h2><table class="kv"><thead><tr><th>Name</th><th>Max CBM</th><th>Max kg</th><th></th></tr></thead><tbody>
   ${d.types.map(b=>`<tr><td>${bind('container_types',b.id,'name',b.name,'text',90)}</td><td>${bind('container_types',b.id,'max_cbm',b.max_cbm,'num',80)}</td><td>${bind('container_types',b.id,'max_kg',b.max_kg,'num',90)}</td><td>${d.types.length>1?`<button class="btn ghost sm" data-a="delrow" data-tbl="container_types" data-id="${b.id}">Remove</button>`:''}</td></tr>`).join('')}</tbody></table>
   <button class="btn ghost" style="margin-top:10px" data-a="addbox">Add a container type</button></section>
  <section class="panel"><h2>Destinations</h2>${d.dests.map(x=>`<div class="line"><div>${esc(x.name)}</div><div><button class="btn ghost sm" data-a="delrow" data-tbl="destinations" data-id="${x.id}">Remove</button></div></div>`).join('')}
   <div class="row" style="margin-top:10px"><input type="text" id="ndest" placeholder="Port, country"><button class="btn ghost" data-a="adddest">Add destination</button></div></section></div>`;
L['admin-customers']=async()=>{await loadRules();const[apps,cs,us]=await Promise.all([q(sb.from('applications').select('*, zones(name)').eq('status','Pending').order('created_at')),
  q(sb.from('customers').select('*').order('name')),q(sb.from('profiles').select('*').order('created_at'))]);return{apps,cs,us};};
V['admin-customers']=d=>{
  const reps=d.us.filter(u=>u.role==='rep').map(u=>[u.id,u.full_name||u.email]),tiers=ctx.tiers.map(t=>t.name),zones=ctx.zones.map(z=>[z.id,z.name]),cl=d.cs.map(c=>[c.id,c.name]);
  return `<div class="head"><h1>Customers and users</h1></div>
  <section class="panel"><h2>New account applications</h2>${d.apps.length?d.apps.map(a=>`<div class="line"><div><b>${esc(a.business_name)}</b> <span class="muted small">${day(a.created_at)}, ${esc(a.zones?a.zones.name:'')}</span><br><span class="small">${esc(a.contact)} ${esc(a.email)} ${esc(a.phone)}</span><br><span class="muted small">${esc(a.note)}</span></div>
    <div style="white-space:nowrap"><button class="btn sm" data-a="appok" data-id="${a.id}">Approve</button> <button class="btn ghost sm" data-a="appno" data-id="${a.id}">Decline</button></div></div>`).join('')
    +'<p class="muted small" style="margin-top:8px">An approved account starts on the lowest tier with no credit. Set its tier, credit limit and sales rep in the table below.</p>':empty('No applications waiting.')}</section>
  <section class="panel scroll"><h2>Customer accounts</h2>${d.cs.length?`<table><thead><tr><th>Customer</th><th>Tier</th><th>Zone</th><th>Credit limit</th><th>Outstanding</th><th>Terms</th><th>Sales rep</th><th>Quarter target</th><th class="num">Wallet</th></tr></thead><tbody>
   ${d.cs.map(c=>`<tr><td>${bind('customers',c.id,'name',c.name,'text',190)}</td><td>${bsel('customers',c.id,'tier',c.tier,tiers)}</td><td>${bsel('customers',c.id,'zone_id',c.zone_id,zones,true)}</td>
    <td>${bind('customers',c.id,'credit_limit',c.credit_limit,'num',100)}</td><td>${bind('customers',c.id,'balance',c.balance,'num',100)}</td><td>${bind('customers',c.id,'terms',c.terms,'text',80)}</td><td>${bsel('customers',c.id,'rep_id',c.rep_id,reps,true)}</td><td>${bind('customers',c.id,'quarter_target',c.quarter_target,'num',100)}</td><td class="num">${fj(c.wallet_available)}</td></tr>`).join('')}</tbody></table>
   <div class="row" style="margin-top:14px"><label class="field">Add or remove wallet credit<select id="aw-c">${opts(cl)}</select></label><label class="field">Amount<input type="number" step="any" id="aw-a" style="width:110px"></label>
    <label class="field">Reason shown to the customer<input type="text" id="aw-d" placeholder="Quarter target rebate"></label><button class="btn" data-a="wallet">Apply</button></div>`:empty('No customers yet. Approve an application to create the first one.')}</section>
  <section class="panel scroll"><h2>Logins</h2><p class="muted small" style="margin-bottom:8px">Make a login a sales rep or admin, or link another person to a customer’s account.</p>
   <table><thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Customer account</th><th>Role in company</th><th>Can approve orders</th></tr></thead><tbody>
   ${d.us.map(u=>`<tr><td>${bind('profiles',u.id,'full_name',u.full_name,'text')}</td><td>${esc(u.email)}</td><td>${u.id===ctx.user.id?'Admin (you)':bsel('profiles',u.id,'role',u.role,[['customer','Customer'],['rep','Sales rep'],['admin','Admin']])}</td>
    <td>${bsel('profiles',u.id,'customer_id',u.customer_id,cl,true)}</td><td>${bsel('profiles',u.id,'company_role',u.company_role,['Owner','Purchasing','Accounts'])}</td><td>${bind('profiles',u.id,'can_approve',u.can_approve,'bool')}</td></tr>`).join('')}</tbody></table></section>`;
};
L['admin-approvals']=async()=>({rq:await q(sb.from('price_requests').select('*, customers(name), products(name), profiles(full_name,email)').order('created_at',{ascending:false}))});
V['admin-approvals']=d=>{
  const row=(r,act)=>`<tr><td>${day(r.created_at)}</td><td>${esc(r.profiles&&(r.profiles.full_name||r.profiles.email))}</td><td>${esc(r.customers&&r.customers.name)}</td><td>${esc(r.products&&r.products.name)}</td><td class="num">${fj(r.normal_price)}</td><td class="num"><b>${fj(r.price)}</b><br><span class="small muted">${Math.round((1-r.price/r.normal_price)*100)}% below</span></td><td class="small">${esc(r.reason)}</td>
    <td style="white-space:nowrap">${act?`<button class="btn sm" data-a="reqok" data-id="${r.id}">Approve</button> <button class="btn ghost sm" data-a="reqno" data-id="${r.id}">Decline</button>`:stat(r.status)}</td></tr>`;
  const hd='<thead><tr><th>Date</th><th>Sales rep</th><th>Customer</th><th>Product</th><th class="num">Normal</th><th class="num">Requested</th><th>Reason</th><th></th></tr></thead>';
  const p=d.rq.filter(r=>r.status==='Pending'),h=d.rq.filter(r=>r.status!=='Pending');
  return `<div class="head"><h1>Price approvals</h1><p class="muted">Requests more than ${ctx.settings.rep_floor_pct}% below a customer’s normal price. Approving one sets it as that customer’s contract price.</p></div>
  <section class="panel scroll"><h2>Waiting for a decision</h2>${p.length?`<table>${hd}<tbody>${p.map(r=>row(r,true)).join('')}</tbody></table>`:empty('Nothing waiting.')}</section>
  <section class="panel scroll"><h2>History</h2>${h.length?`<table>${hd}<tbody>${h.map(r=>row(r,false)).join('')}</tbody></table>`:empty('No decisions yet.')}</section>`;
};

/* ---------- layers: cart drawer and deal dialog ---------- */
function cartHTML(){
  const c=ctx.customer,k=calc(ctx.cart),co=ctx.co||(ctx.co={po:'',ful:'Delivery',notes:'',pay:'account',wallet:false}),use=co.wallet?Math.min(c.wallet_available,k.total):0,due=r2(k.total-use),short=co.pay==='account'&&due>credit(c);
  if(!k.lines.length)return `<div class="drawer"><h2>Cart</h2><p class="muted" style="margin:12px 0">The cart is empty. Add cartons from Products.</p><button class="btn ghost" data-a="close">Close</button></div>`;
  return `<div class="drawer"><div class="row" style="justify-content:space-between"><h2>Cart</h2><button class="btn ghost" data-a="close">Close</button></div>
   ${k.lines.map(l=>`<div class="line"><div><b>${esc(l.p.name)}</b><br><span class="muted small">${fj(l.pr.unit)} per carton</span></div><div style="text-align:right"><b>${fj(l.sum)}</b></div>
     <div>${stepper('c',l.p.id,l.q)}</div><div></div>${l.pr.next?`<div class="small ok" style="grid-column:1/-1">Add ${l.pr.next.need} more to drop to ${fj(l.pr.next.unit)} each.</div>`:''}</div>`).join('')}
   <label class="field">PO number<input type="text" id="po" value="${esc(co.po)}" placeholder="Your purchase order reference"></label>
   <label class="field">Fulfilment<select id="ful">${opts([['Delivery','Delivery'],['Pickup from Suva warehouse','Pickup from Suva warehouse']],co.ful)}</select></label>
   <label class="field">Order notes<textarea id="notes" rows="2">${esc(co.notes)}</textarea></label>
   <label class="field">Pay with<select id="pay">${opts([['account','On account, '+c.terms],['mpaisa','M-PAiSA'],['bank','Bank deposit']],co.pay)}</select></label>
   ${co.pay!=='account'?'<p class="muted small" style="margin-top:6px">VITICO confirms the order once your payment is received.</p>':''}
   <label style="display:flex;gap:8px;margin:12px 0"><input type="checkbox" id="usew" ${co.wallet?'checked':''} ${+c.wallet_available?'':'disabled'}> Use rebate wallet (${fj(c.wallet_available)} available)</label>
   <div class="tot"><span>Goods</span><span>${fj(k.total)}</span></div>
   ${use?`<div class="tot"><span>Rebate wallet</span><span>−${fj(use)}</span></div>`:''}
   ${k.saved?`<div class="tot ok"><span>Saved against FCCC reference</span><span>${fj(k.saved)}</span></div>`:''}
   <div class="tot big"><span>To pay</span><span>${fj(due)}</span></div>
   ${short?`<p class="err small">This order is ${fj(due-credit(c))} over your available credit of ${fj(credit(c))}. Reduce the order, use your rebate wallet, or pay by M-PAiSA or bank deposit.</p>`:''}
   <p class="err small" id="cart-err"></p>
   <button class="btn" style="width:100%;margin-top:12px" data-a="place" ${short?'disabled':''}>Place order</button></div>`;
}
function dealHTML(){
  const d=DATA.deals.find(x=>x.id===M.id),w=+ctx.customer.wallet_available,tot=r2(d.unit_price*M.qty),bond=r2(tot*ctx.settings.bond_pct/100);
  if(M.pay==='wallet'&&w<bond)M.pay='bank';
  return `<div class="dialog" role="dialog" aria-label="Secure deal"><h2>Secure ${esc(d.name)}</h2>
   <p class="muted small" style="margin:4px 0 10px">${d.remaining} left. You can take up to ${M.cap} more.</p>
   <div>${stepper('m',d.id,M.qty)} <span class="muted small">${esc(d.per)}${M.qty>1?'s':''}</span></div>
   <div class="tot"><span>Deal total</span><span>${fj(tot)}</span></div>
   <div class="tot"><span>Security bond, ${ctx.settings.bond_pct}%</span><b>${fj(bond)}</b></div>
   <div class="tot"><span>Balance on final invoice</span><span>${fj(tot-bond)}</span></div>
   <fieldset style="border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:10px"><legend class="small muted">Pay the bond with</legend>
    ${[['bank','Bank deposit'],['mpaisa','M-PAiSA'],['wallet',`Rebate wallet, ${fj(w)} available`]].map(([v,l])=>`<label style="display:block;padding:3px 0"><input type="radio" name="bp" value="${v}" ${M.pay===v?'checked':''} ${v==='wallet'&&w<bond?'disabled':''}> ${l}</label>`).join('')}</fieldset>
   <p class="muted small">Your allocation is held now. A bond paid by bank deposit or M-PAiSA is confirmed by VITICO when the payment arrives.</p>
   <p class="err small" id="deal-err" style="margin-top:8px"></p>
   <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-a="close">Cancel</button><button class="btn deal" data-a="secure">Secure deal</button></div></div>`;
}
function layer(){$('layer').innerHTML=role()!=='customer'?'':UI==='cart'?`<div class="shade" data-a="shade">${cartHTML()}</div>`:UI==='deal'&&M?`<div class="shade center" data-a="shade">${dealHTML()}</div>`:'';}

/* ---------- render ---------- */
function route(){const h=location.hash.slice(1).split('&')[0],n=NAV[role()];if(RECOVER)return'login';return n.some(x=>x[0]===h)?h:n[0][0];}
function tick(){document.querySelectorAll('[data-ends]').forEach(e=>{e.textContent=left(e.dataset.ends-Date.now());});}
function chrome(r){
  const ro=role();
  $('nav').innerHTML=NAV[ro].map(([k,n])=>`<a href="#${k}" class="${k===r?'on':''}">${n}</a>`).join('');
  $('who').innerHTML=ctx.user?`<span class="who">${esc(ctx.customer?ctx.customer.name:ctx.profile.full_name||ctx.user.email)}</span>
    ${ro==='customer'?`<button class="btn cartbtn" data-a="cart">Cart <b>${Object.values(ctx.cart).reduce((a,b)=>a+b,0)}</b></button>`:''}<button class="btn ghost sm" data-a="logout">Log out</button>`:'';
}
function paint(){const r=CUR||route();chrome(r);$('view').innerHTML=V[r](DATA);layer();tick();after(r);}
function after(r){if(r==='price-requests')rfHint();if(r==='admin-pricing')preview();}
async function show(){
  const r=route(),my=++seq;chrome(r);
  if($('view').dataset.r!==r)$('view').innerHTML='<p class="muted">Loading…</p>';
  try{const d=L[r]?await L[r]():{};if(my!==seq)return;DATA=d;CUR=r;$('view').dataset.r=r;paint();}
  catch(e){if(my!==seq)return;CUR='';$('view').dataset.r='';$('view').innerHTML=`<section class="panel"><h2>Something went wrong</h2><p class="err" style="margin:8px 0">${esc(e.message)}</p><button class="btn ghost" data-a="retry">Try again</button></section>`;}
}
async function boot(){try{await loadCtx();}catch(e){$('view').innerHTML=`<section class="panel"><h2>Could not reach the database</h2><p class="err" style="margin:8px 0">${esc(e.message)}</p><p class="muted small">Check the URL and key in config.js and that schema.sql has been run.</p></section>`;return;}await show();}
function setQty(k,s,v){
  v=Math.max(0,Math.floor(v)||0);
  if(k==='m'){M.qty=Math.min(M.cap,Math.max(1,v));layer();return;}
  const p=cp(s);if(p)v=Math.min(v,p.stock);
  if(k==='p'){D[s]=Math.max(1,v);$('plist').innerHTML=prodList();return;}
  const bag=k==='c'?ctx.cart:ctx.box.items;
  if(v)bag[s]=v;else delete bag[s];
  if(k==='c'){saveCart();chrome(route());layer();}else{saveBox();paint();}
}
// Run a database action, show any error it raises, then reload the screen.
async function act(fn,okMsg,errEl){try{await fn();if(okMsg)toast(okMsg);await show();return true;}catch(e){if(errEl&&$(errEl))$(errEl).textContent=e.message;else toast(e.message);return false;}}

/* ---------- actions ---------- */
const A={
  retry(){boot();},
  async login(){const{error}=await sb.auth.signInWithPassword({email:val('lg-e'),password:$('lg-p').value});if(error){$('lg-err').textContent=error.message==='Invalid login credentials'?'That email and password do not match.':/not confirmed/i.test(error.message)?'Your account has not been approved yet. You can log in once VITICO approves your application.':error.message;}},
  async forgot(){const e=val('lg-e');if(!e){$('lg-err').textContent='Enter your email first.';return;}
    const{error}=await sb.auth.resetPasswordForEmail(e,{redirectTo:location.origin+location.pathname});$('lg-err').textContent=error?error.message:'If that email has an account, a reset link is on its way.';},
  async newpass(){const p=$('lg-n').value;if(p.length<8){$('lg-err').textContent='Use at least 8 characters.';return;}
    const{error}=await sb.auth.updateUser({password:p});if(error){$('lg-err').textContent=error.message;return;}RECOVER=false;toast('Password saved');boot();},
  async logout(){await sb.auth.signOut();},
  async apply(){
    const err=$('ap-err');
    if(!val('ap-n')||!val('ap-c')||!/.+@.+\..+/.test(val('ap-e'))){err.textContent='Enter the business name, your name and a valid email address.';return;}
    if($('ap-w').value.length<8){err.textContent='Choose a password of at least 8 characters.';return;}
    const{data,error}=await sb.auth.signUp({email:val('ap-e'),password:$('ap-w').value,options:{emailRedirectTo:location.origin+location.pathname,
      data:{full_name:val('ap-c'),business_name:val('ap-n'),phone:val('ap-p'),zone_id:val('ap-z'),note:val('ap-t')}}});
    if(error){err.textContent=error.message;return;}
    if(!data.session){NOTE='Thank you. VITICO will review your application. Once it is approved you can log in with this email and password.';paint();}
  },
  cart(){act(async()=>{if(!ctx.cat.length)await loadCat();await loadCustomer();UI='cart';});},
  close(){UI=null;M=null;layer();},
  shade(e,ev){if(ev.target===e)A.close();},
  cat(e){CAT=e.dataset.c;paint();},
  step(e){const i=e.parentNode.querySelector('input');setQty(e.dataset.k,e.dataset.s,(+i.value||0)+ +e.dataset.d);},
  add(e){const p=cp(e.dataset.s),n=D[p.id]||1;ctx.cart[p.id]=Math.min(p.stock,(ctx.cart[p.id]||0)+n);D[p.id]=1;saveCart();paint();toast(`Added ${n} × ${p.name} to cart`);},
  reorder(e){act(async()=>{await loadCat();const o=DATA.orders.find(x=>x.id===e.dataset.id);
    o.order_lines.forEach(l=>{const p=cp(l.product_id);if(p)ctx.cart[p.id]=Math.min(p.stock,(ctx.cart[p.id]||0)+l.qty);});saveCart();UI='cart';},'Added to cart at today’s prices');},
  async place(e){
    const co=ctx.co,items=Object.entries(ctx.cart).filter(([,n])=>n>0).map(([product_id,qty])=>({product_id,qty}));
    e.disabled=true;
    try{const o=await q(sb.rpc('place_order',{p_items:items,p_opts:{po:co.po,fulfilment:co.ful,notes:co.notes,pay:co.pay,use_wallet:co.wallet}}));
      ctx.cart={};saveCart();ctx.co=null;UI=null;toast(`Order ${o.number} placed`);if(route()==='orders')show();else location.hash='orders';}
    catch(x){e.disabled=false;$('cart-err').textContent=x.message;}
  },
  deal(e){const d=DATA.deals.find(x=>x.id===e.dataset.id),cap=Math.min(d.remaining,d.max_per_customer-taken(DATA,d.id));M={id:d.id,qty:1,pay:'bank',cap};UI='deal';layer();},
  async secure(e){
    e.disabled=true;
    try{const o=await q(sb.rpc('secure_deal',{p_deal:M.id,p_qty:M.qty,p_pay:M.pay}));UI=null;M=null;toast(`Deal secured as ${o.number}. Bond ${fj(o.bond)}.`);show();}
    catch(x){e.disabled=false;$('deal-err').textContent=x.message;}
  },
  box(e){ctx.box.type=e.dataset.t;saveBox();paint();},
  boxclear(){ctx.box.items={};saveBox();paint();},
  async boxorder(e){
    const items=Object.entries(ctx.box.items).filter(([,n])=>n>0).map(([product_id,qty])=>({product_id,qty}));e.disabled=true;
    try{const o=await q(sb.rpc('place_order',{p_items:items,p_opts:{container_type:ctx.box.type,destination:ctx.box.dest}}));ctx.box.items={};saveBox();toast(`Container order ${o.number} placed`);location.hash='orders';}
    catch(x){e.disabled=false;toast(x.message);}
  },
  /* sales rep */
  request(){const p=parseFloat(RF.price);if(!(p>0)||!RF.reason.trim())return toast('Enter a price and a reason');
    act(async()=>{const st=await q(sb.rpc('request_price',{p_customer:RF.c,p_product:RF.s,p_price:p,p_reason:RF.reason}));RF.price='';RF.reason='';toast(st==='Applied'?'Price applied to the customer’s account':'Sent to an admin for approval');});},
  /* admin */
  paid(e){act(()=>q(sb.rpc('set_order_paid',{p_order:e.dataset.id})),'Payment confirmed');},
  addprod(){const sku=val('np-s').toUpperCase().replace(/[^A-Z0-9-]/g,'');if(!sku||!val('np-n'))return toast('Enter a code and a name');
    act(()=>q(sb.from('products').insert({sku,name:val('np-n'),base_price:num(val('np-b')),pack:'Carton'})),'Product added. Fill in the rest in the table.');},
  import(){
    const rows=[];
    $('imp').value.split(/\n/).forEach(row=>{const f=row.split(/\t|,/).map(x=>x.trim()),sku=(f[0]||'').toUpperCase().replace(/[^A-Z0-9-]/g,'');
      if(!sku||!f[1]||isNaN(parseFloat(f[4])))return;
      rows.push({sku,name:f[1],pack:f[2]||'Carton',category:f[3]||'Other',base_price:num(f[4]),fccc_ref:f[5]&&!isNaN(parseFloat(f[5]))?num(f[5]):null,cbm:num(f[6]),kg:num(f[7]),stock:Math.round(num(f[8]))});});
    if(!rows.length)return toast('No valid rows found. Check the column order.');
    act(()=>q(sb.from('products').upsert(rows,{onConflict:'sku'})),`${rows.length} products imported`);
  },
  async delprod(e){
    const name=e.dataset.n;
    if(!window.confirm(`Delete ${name}? This cannot be undone.`))return;
    const{error}=await sb.from('products').delete().eq('id',e.dataset.id);
    if(!error){toast(`${name} deleted`);return show();}
    if(error.code!=='23503')return toast('Not deleted: '+error.message);
    // Still referenced by past orders or a Deal Drop, so keep the record and hide it instead.
    const r=await sb.from('products').update({active:false}).eq('id',e.dataset.id);
    toast(r.error?'Not deleted: '+r.error.message:`${name} is in past orders or a Deal Drop, so it was hidden instead of deleted. Customers no longer see it.`);
    show();
  },
  addzone(){const n=val('nz');if(!n)return toast('Enter a zone name');act(()=>q(sb.from('zones').insert({name:n,sort:ctx.zones.length+1})));},
  addbreak(){const m=Math.max(0,...ctx.breaks.map(b=>b.min_qty));act(()=>q(sb.from('qty_breaks').insert({min_qty:m?m*2:1,off_pct:0})));},
  delrow(e){act(()=>q(sb.from(e.dataset.tbl).delete().eq('id',e.dataset.id)));},
  addcon(){const p=num(val('nc-p'));if(!p)return toast('Enter a price');act(()=>q(sb.from('contract_prices').upsert({customer_id:val('nc-c'),product_id:val('nc-s'),price:p})),'Contract price saved');},
  delcon(e){const[c,p]=e.dataset.con.split('|');act(()=>q(sb.from('contract_prices').delete().eq('customer_id',c).eq('product_id',p)));},
  adddeal(){
    const lines=[1,2,3].filter(i=>val('nd-s'+i)).map(i=>({product_id:val('nd-s'+i),qty:Math.max(1,parseInt(val('nd-q'+i))||1)}));
    const n=val('nd-n'),p=num(val('nd-p')),a=Math.round(num(val('nd-a'))),m=Math.round(num(val('nd-m'))),h=num(val('nd-h'));
    if(!n||!p||!a||!m||!h)return toast('Fill in the name, price, number available, maximum and running time');
    act(()=>q(sb.rpc('create_deal',{p_name:n,p_lines:lines,p_price:p,p_allocation:a,p_max:m,p_hours:h,p_tiers:val('nd-t')?val('nd-t').split(','):null,p_note:val('nd-w')||null})),'Deal Drop launched');
  },
  dealplus(e){act(()=>q(sb.from('deals').update({ends_at:new Date(Math.max(Date.parse(e.dataset.e),Date.now())+864e5).toISOString()}).eq('id',e.dataset.id)));},
  dealend(e){act(()=>q(sb.from('deals').update({ends_at:new Date().toISOString()}).eq('id',e.dataset.id)));},
  addbox(){act(()=>q(sb.from('container_types').insert({name:'New type',max_cbm:30,max_kg:20000,sort:99})));},
  adddest(){const d=val('ndest');if(!d)return toast('Enter a destination');act(()=>q(sb.from('destinations').insert({name:d})));},
  appok(e){act(()=>q(sb.rpc('decide_application',{p_id:e.dataset.id,p_approve:true})),'Approved. They can now log in and order.');},
  appno(e){act(()=>q(sb.rpc('decide_application',{p_id:e.dataset.id,p_approve:false})),'Application declined');},
  reqok(e){act(()=>q(sb.rpc('decide_price_request',{p_id:e.dataset.id,p_approve:true})),'Approved. The contract price is live.');},
  reqno(e){act(()=>q(sb.rpc('decide_price_request',{p_id:e.dataset.id,p_approve:false})),'Request declined');},
  wallet(){const a=parseFloat(val('aw-a'));if(!a||!val('aw-d'))return toast('Enter an amount and a reason');act(()=>q(sb.rpc('adjust_wallet',{p_customer:val('aw-c'),p_amount:a,p_description:val('aw-d')})),'Wallet updated');}
};
document.addEventListener('click',ev=>{const e=ev.target.closest('[data-a]');if(e&&A[e.dataset.a]&&!e.disabled)A[e.dataset.a](e,ev);});
document.addEventListener('change',async ev=>{
  const t=ev.target;
  if(t.matches('input[type=number][data-k]'))return setQty(t.dataset.k,t.dataset.s,+t.value);
  if(t.dataset.tbl&&t.dataset.col){               // save one column of one row
    const ty=t.dataset.t;let v=ty==='bool'?t.checked:t.value;
    if(ty==='num')v=num(v);else if(ty==='int')v=Math.round(num(v));else if(ty==='numnull')v=v.trim()===''?null:num(v);else if(ty==='nullable')v=v||null;
    const{error}=await sb.from(t.dataset.tbl).update({[t.dataset.col]:v}).eq(t.dataset.key,t.dataset.id);
    toast(error?'Not saved: '+error.message:'Saved');if(!error&&t.dataset.tbl==='settings')ctx.settings[t.dataset.col]=v;if($('preview'))preview();return;
  }
  if(t.dataset.con){const[c,p]=t.dataset.con.split('|'),v=num(t.value);if(!v)return toast('Enter a price above zero');
    const{error}=await sb.from('contract_prices').update({price:v}).eq('customer_id',c).eq('product_id',p);toast(error?'Not saved: '+error.message:'Saved');if($('preview'))preview();return;}
  if(t.dataset.ost)return act(()=>q(sb.rpc('set_order_status',{p_order:t.dataset.ost,p_status:t.value})),'Order updated');
  if(t.id==='dest'){ctx.box.dest=t.value;saveBox();}
  else if(t.id==='ful'){ctx.co.ful=t.value;}
  else if(t.id==='pay'){ctx.co.pay=t.value;layer();}
  else if(t.id==='usew'){ctx.co.wallet=t.checked;layer();}
  else if(t.name==='bp'){M.pay=t.value;}
  else if(t.id==='rf-c'||t.id==='rf-s'){RF[t.id==='rf-c'?'c':'s']=t.value;rfHint();}
  else if(t.id==='pv-c'||t.id==='pv-s'||t.id==='pv-q'){PV.c=val('pv-c');PV.s=val('pv-s');PV.q=Math.max(1,parseInt(val('pv-q'))||1);preview();}
});
document.addEventListener('input',ev=>{
  const t=ev.target;
  if(t.id==='q'){Q=t.value;$('plist').innerHTML=prodList();}
  else if(t.id==='po'){ctx.co.po=t.value;}
  else if(t.id==='notes'){ctx.co.notes=t.value;}
  else if(t.id==='rf-p'){RF.price=t.value;rfHint();}
  else if(t.id==='rf-r'){RF.reason=t.value;}
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&UI)A.close();if(ev.key==='Enter'&&ev.target.id==='lg-p')A.login();});
window.addEventListener('hashchange',()=>{UI=null;M=null;if(location.hash!=='#apply')NOTE='';show();window.scrollTo(0,0);});
setInterval(tick,1000);

// Reload everything when someone logs in or out. Deferred, because Supabase must not be called from inside this callback.
let lastUser;
sb.auth.onAuthStateChange((event,session)=>{
  const id=session&&session.user?session.user.id:null;
  if(event==='PASSWORD_RECOVERY')RECOVER=true;
  if(event==='INITIAL_SESSION'){lastUser=id;return;}
  if(id===lastUser&&event!=='PASSWORD_RECOVERY')return;
  lastUser=id;setTimeout(boot,0);
});
window.viticoReady=boot();
})();
