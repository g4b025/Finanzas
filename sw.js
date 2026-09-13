const CACHE='gabo-finanzas-v21';
const ASSETS=['./','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
async function liveIndex(){
  const r=await fetch('./index.html',{cache:'no-store'});
  let html=await r.text();
  try{
    const lr=await fetch('./finance-live.json?ts='+Date.now(),{cache:'no-store'});
    if(lr.ok){
      const live=await lr.json();
      if(Number.isFinite(Number(live.debitNow))) html=html.replace(/liquidity:\{debitNow:[\d.]+/,`liquidity:{debitNow:${Number(live.debitNow).toFixed(2)}`);
      if(live.version) html=html.replace(/version:(\d+)/,`version:${Number(live.version)}`);
      if(live.lastEmailId) html=html.replace(/lastEmailId:'[^']*'/,`lastEmailId:'${live.lastEmailId}'`);
      if(live.lastTransactionAt) html=html.replace(/lastTransactionAt:'[^']*'/,`lastTransactionAt:'${live.lastTransactionAt}'`);
    }
  }catch(e){}
  const out=new Response(html,{status:r.status,statusText:r.statusText,headers:r.headers});
  const c=await caches.open(CACHE);c.put('./index.html',out.clone());
  return out;
}
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){e.respondWith(liveIndex().catch(()=>caches.match('./index.html')));return}
  if(new URL(e.request.url).pathname.endsWith('/finance-live.json')){e.respondWith(fetch(e.request,{cache:'no-store'}));return}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
