function J(x,s=200){return new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
async function ensure(env){
 await env.DB.exec(`CREATE TABLE IF NOT EXISTS problems(
 id TEXT PRIMARY KEY,subject TEXT,exam TEXT,year TEXT,no TEXT,unit TEXT,subunit TEXT,type TEXT,
 question TEXT,choices TEXT,answer TEXT,explanation TEXT,original_explanation TEXT,edited_explanation TEXT,
 status TEXT,data TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_ps ON problems(subject);
 CREATE INDEX IF NOT EXISTS idx_pse ON problems(subject,exam);
 CREATE INDEX IF NOT EXISTS idx_psy ON problems(subject,year);
 CREATE INDEX IF NOT EXISTS idx_pu ON problems(unit);
 CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);`)
}
const parse=r=>{try{return JSON.parse(r.data)}catch{return null}};
function N(p){return {id:String(p.id||crypto.randomUUID()),subject:String(p.subject||''),exam:String(p.exam||''),year:String(p.year||''),no:String(p.no||''),unit:String(p.unit||''),subunit:String(p.subunit||''),type:String(p.type||''),question:String(p.question||''),choices:String(p.choices||''),answer:String(p.answer||''),explanation:String(p.explanation||''),oe:String(p.originalExplanation||''),ee:String(p.editedExplanation||''),status:String(p.status||''),data:JSON.stringify(p),updated:new Date().toISOString()}}
export default{async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname.startsWith('/api/')){try{await ensure(env)}catch(e){return J({ok:false,error:String(e)},500)}}
 if(u.pathname==='/api/meta'){
  const total=(await env.DB.prepare('SELECT COUNT(*) n FROM problems').first())?.n||0;
  const r=await env.DB.prepare('SELECT subject,COUNT(*) count FROM problems GROUP BY subject ORDER BY subject').all();
  return J({ok:true,total,subjects:r.results||[]})
 }
 if(u.pathname==='/api/problems'&&req.method==='GET'){
  const subject=u.searchParams.get('subject')||'',q=u.searchParams.get('q')||'',page=Math.max(1,+u.searchParams.get('page')||1),size=Math.min(100,Math.max(10,+u.searchParams.get('pageSize')||50));
  const w=[],b=[];if(subject){w.push('subject=?');b.push(subject)}if(q){w.push('(question LIKE ? OR unit LIKE ? OR no LIKE ?)');b.push('%'+q+'%','%'+q+'%','%'+q+'%')}
  const W=w.length?' WHERE '+w.join(' AND '):'';
  const total=(await env.DB.prepare('SELECT COUNT(*) n FROM problems'+W).bind(...b).first())?.n||0;
  const r=await env.DB.prepare('SELECT data FROM problems'+W+' ORDER BY subject,year,no LIMIT ? OFFSET ?').bind(...b,size,(page-1)*size).all();
  return J({ok:true,total,page,pageSize:size,problems:(r.results||[]).map(parse).filter(Boolean)})
 }
 if(u.pathname==='/api/candidates'){
  const w=[],b=[];for(const k of ['subject','exam','year','unit']){const v=u.searchParams.get(k)||'';if(v&&v!=='전체'){w.push(k+'=?');b.push(v)}}
  const limit=Math.min(250,Math.max(20,+u.searchParams.get('limit')||100)),W=w.length?' WHERE '+w.join(' AND '):'';
  const r=await env.DB.prepare('SELECT data FROM problems'+W+' ORDER BY RANDOM() LIMIT ?').bind(...b,limit).all();
  return J({ok:true,problems:(r.results||[]).map(parse).filter(Boolean)})
 }
 if(u.pathname==='/api/problems/bulk'&&req.method==='PUT'){
  const a=(await req.json()).problems||[];let written=0;
  for(let i=0;i<a.length;i+=40){const st=a.slice(i,i+40).map(p=>{const x=N(p);return env.DB.prepare(`INSERT INTO problems(id,subject,exam,year,no,unit,subunit,type,question,choices,answer,explanation,original_explanation,edited_explanation,status,data,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,exam=excluded.exam,year=excluded.year,no=excluded.no,unit=excluded.unit,subunit=excluded.subunit,type=excluded.type,question=excluded.question,choices=excluded.choices,answer=excluded.answer,explanation=excluded.explanation,original_explanation=excluded.original_explanation,edited_explanation=excluded.edited_explanation,status=excluded.status,data=excluded.data,updated_at=excluded.updated_at`).bind(x.id,x.subject,x.exam,x.year,x.no,x.unit,x.subunit,x.type,x.question,x.choices,x.answer,x.explanation,x.oe,x.ee,x.status,x.data,x.updated)});if(st.length){await env.DB.batch(st);written+=st.length}}
  return J({ok:true,written})
 }
 if(u.pathname==='/api/history'&&req.method==='GET'){const r=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();let h=[];try{h=JSON.parse(r?.value||'[]')}catch{}return J({ok:true,history:h})}
 if(u.pathname==='/api/history'&&req.method==='PUT'){const h=(await req.json()).history||[],now=new Date().toISOString();await env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(h),now).run();return J({ok:true})}
 return env.ASSETS.fetch(req)
}}