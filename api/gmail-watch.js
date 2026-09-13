function need(name){
  const v=process.env[name];
  if(!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function accessToken(){
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

module.exports=async function handler(req,res){
  if(req.method!=='GET' && req.method!=='POST') return res.status(405).json({ok:false,error:'GET/POST only'});
  const auth=req.headers.authorization||'';
  if(process.env.CRON_SECRET && auth!==`Bearer ${process.env.CRON_SECRET}` && req.query.key!==process.env.WEBHOOK_SECRET){
    return res.status(401).json({ok:false,error:'unauthorized'});
  }
  try{
    const token=await accessToken();
    const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch',{
      method:'POST',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({topicName:need('GMAIL_PUBSUB_TOPIC'),labelIds:['INBOX'],labelFilterBehavior:'INCLUDE'})
    });
    const text=await r.text();
    if(!r.ok) throw new Error(`Gmail watch ${r.status}: ${text}`);
    return res.status(200).json({ok:true,watch:JSON.parse(text)});
  }catch(e){
    console.error(e);
    return res.status(500).json({ok:false,error:e.message});
  }
};
