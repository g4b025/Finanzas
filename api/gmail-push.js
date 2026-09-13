const OWNER='g4b025';
const REPO='Finanzas';
const BRANCH='main';

function need(name){
  const v=process.env[name];
  if(!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function googleAccessToken(){
  const body=new URLSearchParams({
    client_id:need('GOOGLE_CLIENT_ID'),
    client_secret:need('GOOGLE_CLIENT_SECRET'),
    refresh_token:need('GOOGLE_REFRESH_TOKEN'),
    grant_type:'refresh_token'
  });
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!r.ok) throw new Error(`Google token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function gmail(path,token){
  const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers:{authorization:`Bearer ${token}`}});
  if(!r.ok) throw new Error(`Gmail ${r.status}: ${await r.text()}`);
  return r.json();
}

function b64url(s=''){
  s=s.replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4) s+='=';
  return Buffer.from(s,'base64').toString('utf8');
}

function collectText(part){
  if(!part) return '';
  let out='';
  if(part.body?.data && (part.mimeType==='text/plain' || part.mimeType==='text/html')) out+=b64url(part.body.data)+'\n';
  for(const p of part.parts||[]) out+=collectText(p);
  return out;
}

function stripHtml(s=''){
  return s.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
}

function parseAmount(text){
  const patterns=[
    /(?:monto|importe|cantidad|por un monto)[^$\d]{0,40}\$?\s*([\d,]+\.\d{2})/i,
    /\$\s*([\d,]+\.\d{2})/i,
    /\b([\d,]+\.\d{2})\s*(?:mxn|pesos)\b/i
  ];
  for(const p of patterns){
    const m=text.match(p);
    if(m) return Number(m[1].replace(/,/g,''));
  }
  return null;
}

function classify(text){
  const t=text.toLowerCase();
  const incoming=['depósito','deposito','abono','transferencia recibida','spei recibido','recibiste','ingreso'];
  const outgoing=['retiro de efectivo','compra','transferencia realizada','transferencia enviada','cargo','domiciliación','domiciliacion','pago realizado'];
  if(incoming.some(x=>t.includes(x))) return 1;
  if(outgoing.some(x=>t.includes(x))) return -1;
  return 0;
}

async function gh(path,opts={}){
  const token=need('GITHUB_FINANCE_TOKEN');
  const r=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,{
    method:opts.method||'GET',
    headers:{authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'gabo-finance-sync'},
    body:opts.body?JSON.stringify(opts.body):undefined
  });
  if(!r.ok) throw new Error(`GitHub ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getRepoFile(path){
  const j=await gh(`${path}?ref=${BRANCH}`);
  return {text:Buffer.from(j.content,'base64').toString('utf8'),sha:j.sha};
}

async function putRepoFile(path,text,sha,message){
  return gh(path,{method:'PUT',body:{message,content:Buffer.from(text).toString('base64'),sha,branch:BRANCH}});
}

function shouldIgnoreManual(state,amount,direction,emailDate){
  const date=new Date(Number(emailDate)).toISOString().slice(0,10);
  const item=(state.manualAdjustments||[]).find(x=>x.remainingMatches>0 && Number(x.amount)===Number(amount) && x.direction===direction && x.date===date);
  if(!item) return false;
  item.remainingMatches-=1;
  return true;
}

async function updateFinance(netDelta,lastEmailId,lastDate){
  if(!netDelta) return;
  const {text,sha}=await getRepoFile('index.html');
  const currentMatch=text.match(/liquidity:\{debitNow:([\d.]+)/);
  if(!currentMatch) throw new Error('Could not find debitNow in index.html');
  const current=Number(currentMatch[1]);
  const next=Math.max(0,Math.round((current+netDelta)*100)/100);
  let out=text.replace(/liquidity:\{debitNow:[\d.]+/,`liquidity:{debitNow:${next.toFixed(2)}`);
  out=out.replace(/version:(\d+)/,(m,n)=>`version:${Number(n)+1}`);
  if(lastEmailId) out=out.replace(/lastEmailId:'[^']*'/,`lastEmailId:'${lastEmailId}'`);
  if(lastDate) out=out.replace(/lastTransactionAt:'[^']*'/,`lastTransactionAt:'${new Date(Number(lastDate)).toISOString()}'`);
  await putRepoFile('index.html',out,sha,`Realtime Santander sync: ${netDelta>0?'+':''}${netDelta.toFixed(2)} MXN`);
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'POST only'});
  if(process.env.WEBHOOK_SECRET && req.query.key!==process.env.WEBHOOK_SECRET) return res.status(401).json({ok:false,error:'unauthorized'});

  try{
    const data=req.body?.message?.data ? JSON.parse(Buffer.from(req.body.message.data,'base64').toString('utf8')) : {};
    const token=await googleAccessToken();
    const q=encodeURIComponent('{from:santander@envio.santander.com.mx from:notificaciones@notificaciones.santander.com.mx} newer_than:2d');
    const list=await gmail(`messages?q=${q}&maxResults=25`,token);

    const stateFile=await getRepoFile('finance-sync-state.json');
    const state=JSON.parse(stateFile.text);
    const processed=new Set(state.processedMessageIds||[]);
    const last4=process.env.SANTANDER_DEBIT_LAST4||'5439';
    const rows=[];

    for(const x of list.messages||[]){
      if(processed.has(x.id)) continue;
      const msg=await gmail(`messages/${x.id}?format=full`,token);
      const headers=Object.fromEntries((msg.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
      const raw=`${headers.subject||''} ${msg.snippet||''} ${stripHtml(collectText(msg.payload))}`;
      const amount=parseAmount(raw);
      const sign=classify(raw);
      const isDebit=raw.includes(last4);
      rows.push({id:x.id,internalDate:msg.internalDate||'0',raw,amount,sign,isDebit,subject:headers.subject||''});
    }

    rows.sort((a,b)=>Number(a.internalDate)-Number(b.internalDate));
    let net=0;
    let lastId=null,lastDate=null;
    const applied=[];

    for(const r of rows){
      processed.add(r.id);
      lastId=r.id; lastDate=r.internalDate;
      if(!r.amount || !r.sign || !r.isDebit) continue;
      const direction=r.sign<0?'out':'in';
      if(shouldIgnoreManual(state,r.amount,direction,r.internalDate)){
        applied.push({id:r.id,amount:r.amount,direction,ignored:'manual-dedupe'});
        continue;
      }
      net+=r.sign*r.amount;
      applied.push({id:r.id,amount:r.amount,direction,subject:r.subject});
    }

    await updateFinance(net,lastId,lastDate);
    state.processedMessageIds=Array.from(processed).slice(-250);
    state.lastPubSubHistoryId=data.historyId||state.lastPubSubHistoryId||null;
    state.updatedAt=new Date().toISOString();
    await putRepoFile('finance-sync-state.json',JSON.stringify(state,null,2)+'\n',stateFile.sha,'Update finance sync state');

    return res.status(200).json({ok:true,historyId:data.historyId||null,netDelta:Math.round(net*100)/100,applied});
  }catch(e){
    console.error(e);
    return res.status(500).json({ok:false,error:e.message});
  }
};
