const OWNER='g4b025';
const REPO='Finanzas';
const BRANCH='main';

function need(name){const v=process.env[name];if(!v) throw new Error(`Missing env ${name}`);return v}
async function googleAccessToken(){
  const body=new URLSearchParams({client_id:need('GOOGLE_CLIENT_ID'),client_secret:need('GOOGLE_CLIENT_SECRET'),refresh_token:need('GOOGLE_REFRESH_TOKEN'),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!r.ok) throw new Error(`Google token ${r.status}: ${await r.text()}`);return (await r.json()).access_token;
}
async function gmail(path,token){const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers:{authorization:`Bearer ${token}`}});if(!r.ok) throw new Error(`Gmail ${r.status}: ${await r.text()}`);return r.json()}
function b64url(s=''){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Buffer.from(s,'base64').toString('utf8')}
function collectText(part){if(!part)return'';let out='';if(part.body?.data&&(part.mimeType==='text/plain'||part.mimeType==='text/html'))out+=b64url(part.body.data)+'\n';for(const p of part.parts||[])out+=collectText(p);return out}
function stripHtml(s=''){return s.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim()}
function parseAmount(text){for(const p of[/(?:monto|importe|cantidad|por un monto)[^$\d]{0,40}\$?\s*([\d,]+\.\d{2})/i,/\$\s*([\d,]+\.\d{2})/i,/\b([\d,]+\.\d{2})\s*(?:mxn|mxp|pesos)\b/i]){const m=text.match(p);if(m)return Number(m[1].replace(/,/g,''))}return null}
function classify(text){const t=text.toLowerCase();const incoming=['depósito','deposito','abono','transferencia recibida','spei recibido','recibiste','ingreso'];const outgoing=['retiro de efectivo','compra','transferencia realizada','transferencia enviada','realizaste una transferencia','realizó una transferencia','realizo una transferencia','cargo','domiciliación','domiciliacion','pago realizado'];if(incoming.some(x=>t.includes(x)))return 1;if(outgoing.some(x=>t.includes(x)))return-1;return 0}
async function gh(path,opts={}){const token=need('GITHUB_FINANCE_TOKEN');const r=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,{method:opts.method||'GET',headers:{authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'gabo-finance-sync'},body:opts.body?JSON.stringify(opts.body):undefined});if(!r.ok)throw new Error(`GitHub ${path} ${r.status}: ${await r.text()}`);return r.json()}
async function getRepoFile(path){const j=await gh(`${path}?ref=${BRANCH}`);return{text:Buffer.from(j.content,'base64').toString('utf8'),sha:j.sha}}
async function putRepoFile(path,text,sha,message){return gh(path,{method:'PUT',body:{message,content:Buffer.from(text).toString('base64'),sha,branch:BRANCH}})}
function shouldIgnoreManual(state,amount,direction,emailDate){const date=new Date(Number(emailDate)).toISOString().slice(0,10);const item=(state.manualAdjustments||[]).find(x=>x.remainingMatches>0&&Number(x.amount)===Number(amount)&&x.direction===direction&&x.date===date);if(!item)return false;item.remainingMatches-=1;return true}

module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
  if(process.env.WEBHOOK_SECRET&&req.query.key!==process.env.WEBHOOK_SECRET)return res.status(401).json({ok:false,error:'unauthorized'});
  try{
    const data=req.body?.message?.data?JSON.parse(Buffer.from(req.body.message.data,'base64').toString('utf8')):{};
    const token=await googleAccessToken();
    const q=encodeURIComponent('{from:santander@envio.santander.com.mx from:notificaciones@notificaciones.santander.com.mx from:service@paypal.com.mx} newer_than:7d');
    const list=await gmail(`messages?q=${q}&maxResults=25`,token);
    const stateFile=await getRepoFile('finance-sync-state.json');
    const liveFile=await getRepoFile('finance-live.json');
    const state=JSON.parse(stateFile.text);const live=JSON.parse(liveFile.text);
    const processed=new Set(state.processedMessageIds||[]);
    const cutoff=live.lastTransactionAt?Date.parse(live.lastTransactionAt):0;
    const debitIds=(process.env.SANTANDER_DEBIT_IDS||`${process.env.SANTANDER_DEBIT_LAST4||'5439'},1515`).split(',').map(x=>x.trim()).filter(Boolean);
    const rows=[];
    for(const x of list.messages||[]){
      if(processed.has(x.id))continue;
      const msg=await gmail(`messages/${x.id}?format=full`,token);
      const when=Number(msg.internalDate||0);
      if(when<=cutoff){processed.add(x.id);continue}
      const headers=Object.fromEntries((msg.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
      const raw=`${headers.subject||''} ${msg.snippet||''} ${stripHtml(collectText(msg.payload))}`;
      const from=(headers.from||'').toLowerCase();
      const isPayPal=from.includes('paypal.com.mx');
      let paypalCardId=null,paypalConcept=null,paypalAmount=null;
      if(isPayPal){
        const am=raw.match(/Ha pagado\s*\$\s*([\d,]+\.\d{2})\s*MXN/i)||raw.match(/Pago\s*\$\s*([\d,]+\.\d{2})\s*MXN/i);
        paypalAmount=am?Number(am[1].replace(/,/g,'')):parseAmount(raw);
        if(/Mastercard[-\s]*8500/i.test(raw))paypalCardId='santander-gold';
        if(/AMEX\s*X?-?1007/i.test(raw)||/American Express.*1007/i.test(raw))paypalCardId='amex-gold';
        const cm=raw.match(/Ha pagado\s*\$[\d,.]+\s*MXN\s+a\s+(.+?)(?:Ver o administrar pago|Id\. de transacción|Fecha de la transacción|$)/i);
        paypalConcept=cm?cm[1].trim().replace(/\s+/g,' '):'Compra vía PayPal';
      }
      rows.push({id:x.id,internalDate:String(when),raw,amount:isPayPal?paypalAmount:parseAmount(raw),sign:isPayPal?-1:classify(raw),isDebit:debitIds.some(id=>raw.includes(id)),subject:headers.subject||'',source:isPayPal?'PayPal':'Santander',paypalCardId,paypalConcept});
    }
    rows.sort((a,b)=>Number(a.internalDate)-Number(b.internalDate));
    let net=Number(state.pendingManualDelta||0),lastId=live.lastEmailId||null,lastDate=cutoff||null;const applied=[];
    const cards=Array.isArray(live.cards)?JSON.parse(JSON.stringify(live.cards)):[];
    const transactions=Array.isArray(live.transactions)?[...live.transactions]:[];
    const paypalStart=live.paypalSyncStartAt?Date.parse(live.paypalSyncStartAt):Date.now();
    if(net)applied.push({amount:Math.abs(net),direction:net<0?'out':'in',source:'pending-manual-adjustment'});
    for(const r of rows){
      processed.add(r.id);lastId=r.id;lastDate=Number(r.internalDate);
      if(r.source==='PayPal'){
        if(!r.amount||!r.paypalCardId)continue;
        const tdate=new Date(Number(r.internalDate)).toISOString();
        if(Number(r.internalDate)>=paypalStart){
          const card=cards.find(x=>x.id===r.paypalCardId);
          if(card){
            card.balance=Math.round((Number(card.balance||0)+Number(r.amount))*100)/100;
            card.used=Math.round((Number(card.used||0)+Number(r.amount))*100)/100;
            if(Number.isFinite(Number(card.creditLine)))card.available=Math.max(0,Math.round((Number(card.creditLine)-Number(card.used))*100)/100);
          }
          if(!transactions.some(t=>t.sourceId===r.id))transactions.push({id:r.id,sourceId:r.id,cardId:r.paypalCardId,date:tdate,amount:r.amount,direction:'out',concept:r.paypalConcept||'Compra vía PayPal',source:'PayPal'});
          applied.push({id:r.id,amount:r.amount,direction:'out',cardId:r.paypalCardId,source:'PayPal'});
        }
        continue;
      }
      if(!r.amount||!r.sign||!r.isDebit)continue;
      const direction=r.sign<0?'out':'in';
      if(shouldIgnoreManual(state,r.amount,direction,r.internalDate)){applied.push({id:r.id,amount:r.amount,direction,ignored:'manual-dedupe'});continue}
      net+=r.sign*r.amount;applied.push({id:r.id,amount:r.amount,direction,subject:r.subject});
    }
    const next=Math.round((Number(live.debitNow||0)+net)*100)/100;
    const nextLive={...live,version:Number(live.version||21)+((net||applied.some(x=>x.source==='PayPal'))?1:0),debitNow:next,cards,transactions:transactions.slice(-500),lastEmailId:lastId,lastTransactionAt:lastDate?new Date(lastDate).toISOString():live.lastTransactionAt,updatedAt:new Date().toISOString()};
    if(net||lastId!==live.lastEmailId||applied.some(x=>x.source==='PayPal'))await putRepoFile('finance-live.json',JSON.stringify(nextLive,null,2)+'\n',liveFile.sha,applied.some(x=>x.source==='PayPal')?'Realtime PayPal/card sync':`Realtime Santander sync ${net>=0?'+':''}${net.toFixed(2)} MXN`);
    state.pendingManualDelta=0;state.processedMessageIds=Array.from(processed).slice(-250);state.lastPubSubHistoryId=data.historyId||state.lastPubSubHistoryId||null;state.updatedAt=new Date().toISOString();
    await putRepoFile('finance-sync-state.json',JSON.stringify(state,null,2)+'\n',stateFile.sha,'Update finance sync state');
    return res.status(200).json({ok:true,historyId:data.historyId||null,netDelta:Math.round(net*100)/100,debitNow:next,applied});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message})}
};
