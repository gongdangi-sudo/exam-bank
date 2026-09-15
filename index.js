function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}
async function ensure(env){
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS app_state(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS problems(
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS view_assets(
      id TEXT PRIMARY KEY,
      image BLOB NOT NULL,
      mime_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
async function readProblems(env){
  const rows=await env.DB.prepare("SELECT data FROM problems ORDER BY id").all();
  if((rows.results||[]).length){
    return (rows.results||[]).map(r=>{try{return JSON.parse(r.data)}catch{return null}}).filter(Boolean);
  }
  const legacy=await env.DB.prepare("SELECT value FROM app_state WHERE key='problems'").first();
  try{return JSON.parse(legacy?.value||'[]')}catch{return []}
}
export default{
  async fetch(request,env){
    const u=new URL(request.url);
    if(u.pathname.startsWith('/api/')){
      try{await ensure(env)}catch(e){return json({ok:false,error:String(e?.message||e)},500)}
    }

    if(u.pathname==='/api/health')return json({ok:true,service:'exam-bank'});

    if(u.pathname.startsWith('/api/view-asset/')){
      const id=decodeURIComponent(u.pathname.slice('/api/view-asset/'.length));
      if(request.method==='POST'){
        const ab=await request.arrayBuffer();
        if(!ab.byteLength)return json({ok:false,error:'empty image'},400);
        const mime=request.headers.get('content-type')||'image/webp';
        const now=new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO view_assets(id,image,mime_type,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET image=excluded.image,mime_type=excluded.mime_type,updated_at=excluded.updated_at
        `).bind(id,ab,mime,now).run();
        return json({ok:true,id,url:'/api/view-asset/'+encodeURIComponent(id)});
      }
      if(request.method==='GET'){
        const r=await env.DB.prepare("SELECT image,mime_type FROM view_assets WHERE id=?").bind(id).first();
        if(!r)return new Response('Not found',{status:404});
        return new Response(r.image,{headers:{
          "content-type":r.mime_type||'image/webp',
          "cache-control":"public,max-age=31536000,immutable"
        }});
      }
      return json({ok:false,error:'Method not allowed'},405);
    }

    if(u.pathname==='/api/problems/bulk'&&request.method==='PUT'){
      const b=await request.json();
      const items=Array.isArray(b?.problems)?b.problems:[];
      const now=new Date().toISOString();
      for(let i=0;i<items.length;i+=50){
        const st=items.slice(i,i+50).map(p=>env.DB.prepare(`
          INSERT INTO problems(id,data,updated_at) VALUES(?,?,?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at
        `).bind(String(p.id),JSON.stringify(p),now));
        if(st.length)await env.DB.batch(st);
      }
      return json({ok:true,written:items.length});
    }

    if(u.pathname==='/api/problems'&&request.method==='GET'){
      return json({ok:true,problems:await readProblems(env)});
    }

    if(u.pathname==='/api/history'&&request.method==='GET'){
      const r=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();
      let h=[];try{h=JSON.parse(r?.value||'[]')}catch{}
      return json({ok:true,history:h});
    }
    if(u.pathname==='/api/history'&&request.method==='PUT'){
      const b=await request.json(),h=Array.isArray(b?.history)?b.history:[];
      const now=new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      `).bind(JSON.stringify(h),now).run();
      return json({ok:true});
    }

    if(u.pathname==='/api/state'){
      if(request.method==='GET'){
        const problems=await readProblems(env);
        const hr=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();
        let history=[];try{history=JSON.parse(hr?.value||'[]')}catch{}
        return json({problems,history});
      }
      if(request.method==='PUT'){
        const b=await request.json();
        const problems=Array.isArray(b?.problems)?b.problems:[];
        const history=Array.isArray(b?.history)?b.history:[];
        const now=new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO app_state(key,value,updated_at) VALUES('problems',?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
          `).bind(JSON.stringify(problems),now),
          env.DB.prepare(`
            INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
          `).bind(JSON.stringify(history),now)
        ]);
        return json({ok:true,problems:problems.length,history:history.length});
      }
    }

    return env.ASSETS.fetch(request);
  }
};