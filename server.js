/*  server.js — remote slide untuk presentasi (Termux, tanpa dependensi)
 *
 *  Jalankan:   node server.js
 *  Presentasi: http://IP-PERANGKAT:3001/         (Pad / laptop ke proyektor)
 *  Remote:     http://IP-PERANGKAT:3001/remote   (HP)
 *
 *  Taruh di folder yang sama dengan pinkke.html (atau index.html) dan aset mp3/jpg.
 *  Protokol sama dengan Sync di presentasi: /api/slide, /api/def, /events.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +process.env.PORT || 3001;
const TOTAL = +process.env.TOTAL || 6;          // jumlah slide
const ROOT = __dirname;
const MAIN = ['index.html', 'pinkke.html'].find(f => fs.existsSync(path.join(ROOT, f))) || 'pinkke.html';

const TITLES = ['قائل النص', 'النص (أ)', 'النص (ب، ج)', 'خصائص ١-٢', 'خصائص ٣-٤', 'شكر وتقدير'];

let state = { i: 0, def: null, music: null, terms: null };   // music: null = belum diketahui; terms: kata per slide dari display
const clients = new Set();                      // { res, cid }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function broadcast(msg, exceptCid) {
  const data = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const c of clients) {
    if (exceptCid && c.cid === exceptCid) continue;
    try { c.res.write(data); } catch (e) { clients.delete(c); }
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {               // dukung seek audio
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = parseInt(a, 10) || 0;
      const end = b ? Math.min(parseInt(b, 10), st.size - 1) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const c = { res, cid: url.searchParams.get('cid') || '' };
    clients.add(c);
    res.write('data: ' + JSON.stringify({ i: state.i }) + '\n\n');   // posisi sekarang untuk yang baru gabung
    if (state.terms !== null) res.write('data: ' + JSON.stringify({ terms: state.terms }) + '\n\n');
    if (state.music !== null) res.write('data: ' + JSON.stringify({ music: state.music }) + '\n\n');
    if (state.def !== null) res.write('data: ' + JSON.stringify({ def: state.def }) + '\n\n');
    req.on('close', () => clients.delete(c));
    return;
  }

  if (p === '/api/state') return sendJSON(res, { ...state, total: TOTAL, titles: TITLES });

  if (p === '/api/slide' && req.method === 'POST') {
    const b = await readBody(req);
    let i = typeof b.i === 'number' ? b.i : state.i + (+b.d || 0);
    i = Math.max(0, Math.min(TOTAL - 1, Math.round(i)));
    state.i = i;
    if (state.def !== null) { state.def = null; broadcast({ def: null }, b.cid); }
    broadcast({ i }, b.cid);
    return sendJSON(res, { ok: true, i });
  }

  if (p === '/api/def' && req.method === 'POST') {
    const b = await readBody(req);
    state.def = b.def === undefined ? null : b.def;
    broadcast({ def: state.def }, b.cid);
    return sendJSON(res, { ok: true });
  }

  if (p === '/api/music' && req.method === 'POST') {
    const b = await readBody(req);
    state.music = !!b.on;
    broadcast({ music: state.music }, b.cid);
    return sendJSON(res, { ok: true, music: state.music });
  }

  if (p === '/api/terms' && req.method === 'POST') {   // dikirim display saat mulai: daftar kata per slide
    const b = await readBody(req);
    if (Array.isArray(b.terms)) { state.terms = b.terms; broadcast({ terms: state.terms }, b.cid); }
    return sendJSON(res, { ok: true });
  }

  if (p === '/remote') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(REMOTE_HTML);
  }

  // file statis (aman dari ../)
  const rel = p === '/' ? MAIN : p.replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end('403'); }
  serveFile(req, res, file);
});

setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Slide server jalan (port ' + PORT + ', ' + TOTAL + ' slide, file: ' + MAIN + ')\n');
  let ips = [];
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  } catch (e) { /* Termux Android 13+ kadang menolak */ }
  if (ips.length) {
    ips.forEach(ip => {
      console.log('  Presentasi : http://' + ip + ':' + PORT + '/');
      console.log('  Remote HP  : http://' + ip + ':' + PORT + '/remote\n');
    });
  } else {
    console.log('  IP tidak terbaca. Cek IP Wi-Fi di pengaturan, lalu buka:');
    console.log('  Presentasi : http://IP:' + PORT + '/');
    console.log('  Remote HP  : http://IP:' + PORT + '/remote\n');
  }
  console.log('  Di perangkat presentasi: tekan "ابدأ العرض" dulu, baru remote bekerja.\n');
});

/* ================= halaman remote ================= */
const REMOTE_HTML = `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#fdf8f4">
<title>Remote Slide</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
:root{--cream:#fdf8f4;--rose:#f0c6cd;--rose-d:#d99aa5;--sage:#cfdac6;--sage-d:#5c7455;--deep:#7a4452;--txt:#4b3d40;}
html,body{height:100%;background:var(--cream);color:var(--txt);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;touch-action:manipulation;user-select:none;-webkit-user-select:none;}
body{display:flex;flex-direction:column;gap:14px;padding:max(14px,env(safe-area-inset-top)) 14px max(14px,env(safe-area-inset-bottom));}
.top{display:flex;align-items:center;justify-content:space-between;font-size:.85rem;color:var(--sage-d);font-weight:600;}
.dot{display:inline-block;width:.6em;height:.6em;border-radius:50%;background:#c9a0a8;margin-inline-end:.45em;}
.dot.on{background:#7fa174;}
.info{text-align:center;padding:10px 0 2px;}
.num{font-size:3.4rem;font-weight:800;color:var(--deep);line-height:1;}
.num small{font-size:1.5rem;color:var(--sage-d);font-weight:600;}
.name{margin-top:6px;font-size:1.25rem;color:var(--txt);min-height:1.6em;direction:rtl;}
.bar{height:6px;border-radius:9px;background:rgba(143,163,133,.25);overflow:hidden;}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--rose-d),#9fb394);transition:width .3s;}
.nav{flex:none;height:clamp(110px,19vh,170px);display:grid;grid-template-columns:1fr 1.6fr;gap:12px;}
.nav button{min-width:0;min-height:0;overflow:hidden;}
button{font:inherit;border:0;cursor:pointer;border-radius:22px;transition:transform .08s,filter .15s;}
button:active{transform:scale(.97);filter:brightness(.95);}
.prev{background:var(--sage);color:var(--sage-d);font-size:1.15rem;font-weight:700;}
.next{background:var(--rose);color:var(--deep);font-size:1.4rem;font-weight:800;box-shadow:0 6px 20px rgba(217,154,165,.35);}
.nav b{display:block;font-size:2.6rem;line-height:1;margin-bottom:6px;}
.jump{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;}
.jump button{padding:12px 0;font-size:1.05rem;font-weight:700;background:rgba(230,237,224,.9);color:var(--sage-d);border-radius:14px;}
.jump button.cur{background:var(--rose-d);color:#fff;}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.tlabel{font-size:.78rem;font-weight:700;color:var(--sage-d);margin-bottom:6px;}
.terms{display:flex;flex-wrap:wrap;align-content:flex-start;gap:8px;direction:rtl;height:19vh;min-height:84px;overflow-y:auto;-webkit-overflow-scrolling:touch;}
.defbox{flex:1;min-height:90px;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(255,255,255,.75);border:1px solid var(--rose);border-radius:16px;padding:12px 14px;direction:rtl;text-align:right;}
.defbox .dy{font-size:.75rem;font-weight:700;color:var(--sage-d);}
.defbox .dt{font-size:1.35rem;font-weight:800;color:var(--deep);margin:2px 0 6px;line-height:1.5;}
.defbox .dd{font-size:1.1rem;line-height:1.9;color:var(--txt);}
.defbox .dn{direction:ltr;text-align:center;font-size:.85rem;color:var(--sage-d);padding-top:1.2em;}
.terms button{padding:10px 14px;font-size:1.1rem;font-weight:700;background:rgba(248,223,226,.8);color:var(--deep);border-radius:14px;}
.terms button.on{background:var(--deep);color:#fff;}
.terms em{font-style:normal;font-size:.85rem;color:var(--sage-d);direction:ltr;}
.row button.off{background:rgba(207,218,198,.9);color:var(--sage-d);}
.row button{padding:13px 0;font-size:.95rem;font-weight:700;background:rgba(248,223,226,.8);color:var(--deep);border-radius:14px;}
/* urutan: info > nomor > tombol bantu > kata > definisi > Mundur/Lanjut paling bawah */
.top{order:1}.info{order:2}.bar{order:3}.jump{order:4}.row{order:5}.tw{order:6}.defbox{order:7}.nav{order:8}
</style></head><body>
<div class="top"><span><i class="dot" id="dot"></i><span id="st">menyambung…</span></span><span id="wake"></span></div>
<div class="info">
  <div class="num"><span id="cur">1</span> <small>/ <span id="tot">6</span></small></div>
  <div class="name" id="name">&nbsp;</div>
</div>
<div class="bar"><i id="bar"></i></div>
<div class="nav">
  <button class="prev" id="prev"><b>‹</b>Mundur</button>
  <button class="next" id="next"><b>›</b>Lanjut</button>
</div>
<div class="jump" id="jump"></div>
<div class="tw">
  <div class="tlabel">Kata di slide ini (ketuk untuk buka definisi di layar)</div>
  <div class="terms" id="terms"></div>
</div>
<div class="defbox" id="defbox"></div>
<div class="row">
  <button id="first">⏮ Awal</button>
  <button id="closedef">✕ Definisi</button>
  <button id="music">🔊 Musik</button>
</div>
<script>
const cid='remote-'+Math.random().toString(36).slice(2);
let S={i:0,total:6,titles:[],def:null,music:null,terms:null};
function findTerm(k){
  if(!S.terms)return null;
  const cur=S.terms[S.i]||[];
  for(const t of cur)if(t.k===k)return t;
  for(const l of S.terms)for(const t of l||[])if(t.k===k)return t;
  return null;
}
const $=id=>document.getElementById(id);

function render(){
  $('cur').textContent=S.i+1; $('tot').textContent=S.total;
  $('name').textContent=S.titles[S.i]||'';
  $('bar').style.width=((S.i+1)/S.total*100)+'%';
  document.querySelectorAll('#jump button').forEach((b,k)=>b.classList.toggle('cur',k===S.i));
  renderTerms(); renderMusic(); renderDef();
}
function renderDef(){
  const box=$('defbox'); box.innerHTML='';
  const t=S.def?findTerm(S.def):null;
  if(!t){const n=document.createElement('div');n.className='dn';n.textContent=S.def?'(definisi tidak ditemukan)':'Definisi kata akan tampil di sini';box.appendChild(n);return;}
  const y=document.createElement('div');y.className='dy';y.textContent=t.y||'';
  const h=document.createElement('div');h.className='dt';h.textContent=t.t||'';
  const d=document.createElement('div');d.className='dd';d.textContent=t.d||'';
  box.appendChild(y);box.appendChild(h);box.appendChild(d);box.scrollTop=0;
}
function renderTerms(){
  const box=$('terms'); box.innerHTML='';
  const list=(S.terms&&S.terms[S.i])||[];
  if(!list.length){const m=document.createElement('em');m.textContent=S.terms?'Tidak ada kata di slide ini':'Menunggu display dimulai…';box.appendChild(m);return;}
  list.forEach(t=>{const b=document.createElement('button');b.textContent=t.w||t.t;b.classList.toggle('on',S.def===t.k);b.onclick=()=>openDef(t.k);box.appendChild(b);});
}
function renderMusic(){
  const b=$('music'); const off=S.music===false;
  b.textContent=off?'🔇 Musik mati':'🔊 Musik nyala'; b.classList.toggle('off',off);
}
function openDef(k){
  buzz();
  if(S.def===k){S.def=null;post('/api/def',{def:null});}
  else{S.def=k;post('/api/def',{def:k});}
  renderTerms(); renderDef();
}
function buildJump(){
  const j=$('jump'); j.innerHTML='';
  j.style.gridTemplateColumns='repeat('+Math.min(S.total,6)+',1fr)';
  for(let k=0;k<S.total;k++){const b=document.createElement('button');b.textContent=k+1;b.onclick=()=>go(k);j.appendChild(b);}
}
function post(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({cid:cid},body))}).then(r=>r.json()).catch(()=>null);}
function buzz(){try{navigator.vibrate&&navigator.vibrate(18);}catch(e){}}
function go(i){
  i=Math.max(0,Math.min(S.total-1,i)); buzz();
  S.i=i; S.def=null; render();
  post('/api/slide',{i:i});
}
$('next').onclick=()=>go(S.i+1);
$('prev').onclick=()=>go(S.i-1);
$('first').onclick=()=>go(0);
$('closedef').onclick=()=>{buzz();S.def=null;renderTerms();renderDef();post('/api/def',{def:null});};
$('music').onclick=()=>{buzz();S.music=(S.music===false);renderMusic();post('/api/music',{on:S.music});};

function conn(on){$('dot').classList.toggle('on',on);$('st').textContent=on?'tersambung':'terputus, mencoba lagi…';}
function connect(){
  const es=new EventSource('/events?cid='+cid);
  es.onopen=()=>conn(true);
  es.onerror=()=>conn(false);
  es.onmessage=e=>{try{const d=JSON.parse(e.data);
    if(typeof d.i==='number'){S.i=d.i;render();}
    else if('def' in d){S.def=d.def;renderTerms();renderDef();}
    else if('music' in d){S.music=d.music;renderMusic();}
    else if('terms' in d){S.terms=d.terms;renderTerms();renderDef();}
  }catch(x){}};
}
fetch('/api/state').then(r=>r.json()).then(d=>{S=d;buildJump();render();connect();}).catch(()=>{buildJump();render();connect();});

/* layar HP tetap menyala */
let lock=null;
async function keep(){try{if('wakeLock' in navigator){lock=await navigator.wakeLock.request('screen');$('wake').textContent='layar aktif';}}catch(e){}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')keep();});
keep();
/* tombol volume tidak bisa dibaca browser; panah keyboard bluetooth tetap jalan */
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown')go(S.i+1);
  else if(e.key==='ArrowLeft'||e.key==='PageUp')go(S.i-1);
});
</script></body></html>`;
