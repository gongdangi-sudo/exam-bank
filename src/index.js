function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}
async function ensure(env){
  // D1 exec()는 줄 단위로 SQL을 나눠 처리할 수 있어
  // 여러 줄 CREATE TABLE을 넣으면 'incomplete input' 오류가 날 수 있습니다.
  // 각 DDL을 완전한 한 문장으로 prepare().run() 처리합니다.
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS problems (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS view_assets (id TEXT PRIMARY KEY, image BLOB NOT NULL, mime_type TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}
// 삭제(초기화) API는 Cloudflare 환경변수(Secret) ADMIN_RESET_TOKEN과 일치하는 토큰이 있어야만 동작한다.
// 이전에는 화면 소스에 보이는 고정 문구만으로 누구나 전체 데이터를 지울 수 있었다.
function adminTokenError(request,env){
  const expected=String(env.ADMIN_RESET_TOKEN||'');
  if(!expected)return json({ok:false,error:'서버에 ADMIN_RESET_TOKEN이 설정되지 않아 초기화가 비활성화되어 있습니다.'},403);
  if(request.headers.get('x-admin-token')!==expected)return json({ok:false,error:'관리자 토큰이 올바르지 않습니다.'},403);
  return null;
}
// 테이블 생성 확인은 Worker 인스턴스당 한 번만 수행한다.
// (매 API 요청마다 DDL 3회 → 요청마다 약 3초 지연이 있었음)
let ensurePromise=null;
function ensureOnce(env){
  if(!ensurePromise)ensurePromise=ensure(env).catch(e=>{ensurePromise=null;throw e});
  return ensurePromise;
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
      try{await ensureOnce(env)}catch(e){return json({ok:false,error:String(e?.message||e)},500)}
    }

    if(u.pathname==='/api/health')return json({ok:true,service:'exam-bank'});
    if(u.pathname==='/api/asset-count'&&request.method==='GET'){
      const n=(await env.DB.prepare("SELECT COUNT(*) AS n FROM view_assets").first())?.n||0;
      return json({ok:true,count:n});
    }


    if(u.pathname==='/api/admin/full-reset'&&request.method==='POST'){
      // destructive: same-origin UI requires explicit phrase + header
      {const denied=adminTokenError(request,env);if(denied)return denied;}
      if(request.headers.get('x-exam-bank-reset')!=='R249-RESET-ALL'){
        return json({ok:false,error:'reset header mismatch'},403);
      }
      let b={};try{b=await request.json()}catch{}
      if(b?.confirm!=='전체삭제'||b?.scope!=='all'){
        return json({ok:false,error:'reset confirmation mismatch'},400);
      }

      const beforeProblems=(await env.DB.prepare("SELECT COUNT(*) AS n FROM problems").first())?.n||0;
      const beforeAssets=(await env.DB.prepare("SELECT COUNT(*) AS n FROM view_assets").first())?.n||0;
      const hr=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();
      let beforeHistory=0;try{beforeHistory=JSON.parse(hr?.value||'[]').length||0}catch{}

      await env.DB.batch([
        env.DB.prepare("DELETE FROM problems"),
        env.DB.prepare("DELETE FROM view_assets"),
        env.DB.prepare("DELETE FROM app_state")
      ]);

      const afterProblems=(await env.DB.prepare("SELECT COUNT(*) AS n FROM problems").first())?.n||0;
      const afterAssets=(await env.DB.prepare("SELECT COUNT(*) AS n FROM view_assets").first())?.n||0;
      const afterState=(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_state").first())?.n||0;
      if(afterProblems||afterAssets||afterState){
        return json({ok:false,error:`reset verification failed: problems=${afterProblems}, assets=${afterAssets}, state=${afterState}`},500);
      }
      return json({ok:true,before:{problems:beforeProblems,history:beforeHistory,assets:beforeAssets},after:{problems:0,history:0,assets:0,state:0}});
    }


    if(u.pathname==='/api/admin/reset-language'&&request.method==='POST'){
      {const denied=adminTokenError(request,env);if(denied)return denied;}
      if(request.headers.get('x-exam-bank-reset')!=='K262-RESET-LANGUAGE'){
        return json({ok:false,error:'language reset header mismatch'},403);
      }

      let b={};try{b=await request.json()}catch{}
      if(b?.confirm!=='국어영어삭제'){
        return json({ok:false,error:'language reset confirmation mismatch'},400);
      }

      const requested=Array.isArray(b?.subjects)?b.subjects:[];
      const subjects=[...new Set(requested.filter(x=>x==='국어'||x==='영어'))];
      if(!subjects.length){
        return json({ok:false,error:'삭제할 과목을 선택해주세요.'},400);
      }
      const subjectSet=new Set(subjects);

      const allProblems=await readProblems(env);
      const shouldDelete=(p)=>{
        const subject=String(p?.subject||'').normalize('NFC').trim();
        const id=String(p?.id||'');
        if(subjectSet.has(subject))return true;
        if(subjectSet.has('국어') && (/^LANG2?-국어-/u.test(id)||/^LANGPAGE-국어-/u.test(id)))return true;
        if(subjectSet.has('영어') && (/^LANG2?-영어-/u.test(id)||/^LANGPAGE-영어-/u.test(id)))return true;
        return false;
      };

      const removed=allProblems.filter(shouldDelete);
      const remaining=allProblems.filter(p=>!shouldDelete(p));
      const removedIds=new Set(removed.map(p=>String(p.id)));

      // 문제 JSON에 연결되어 있는 view-asset ID를 수집한다.
      const assetIds=new Set();
      const collectAssets=(v)=>{
        if(v==null)return;
        if(typeof v==='string'){
          const m=v.match(/\/api\/view-asset\/([^?#\s]+)/);
          if(m){
            try{assetIds.add(decodeURIComponent(m[1]))}
            catch{assetIds.add(m[1])}
          }
          return;
        }
        if(Array.isArray(v)){for(const x of v)collectAssets(x);return}
        if(typeof v==='object'){for(const x of Object.values(v))collectAssets(x)}
      };
      for(const p of removed)collectAssets(p);

      // 구형/신형 국어·영어 페이지 자산도 함께 정리한다.
      const allAssetRows=await env.DB.prepare("SELECT id FROM view_assets").all();
      for(const r of (allAssetRows.results||[])){
        const id=String(r.id||'');
        if(subjectSet.has('국어') && (
          id.startsWith('LANGPAGE-국어-') ||
          id.startsWith('LANG-국어-') ||
          id.startsWith('LANG2-국어-')
        ))assetIds.add(id);
        if(subjectSet.has('영어') && (
          id.startsWith('LANGPAGE-영어-') ||
          id.startsWith('LANG-영어-') ||
          id.startsWith('LANG2-영어-')
        ))assetIds.add(id);
      }

      // 출제이력: 국어/영어 이력은 삭제하고, 혹시 혼합 이력이 있으면 해당 ID만 제거한다.
      const hr=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();
      let history=[];try{history=JSON.parse(hr?.value||'[]')}catch{}
      const beforeHistory=history.length;
      const newHistory=[];
      for(const h of history){
        const hs=String(h?.subject||'').normalize('NFC').trim();
        if(subjectSet.has(hs))continue;
        const ids=Array.isArray(h?.problemIds)?h.problemIds:[];
        const filtered=ids.filter(id=>!removedIds.has(String(id)));
        if(ids.length && !filtered.length)continue;
        newHistory.push({...h,problemIds:filtered});
      }

      // D1 problems 테이블에서 선택 과목만 삭제.
      const removedIdList=[...removedIds];
      for(let i=0;i<removedIdList.length;i+=50){
        const batch=removedIdList.slice(i,i+50).map(
          id=>env.DB.prepare("DELETE FROM problems WHERE id=?").bind(id)
        );
        if(batch.length)await env.DB.batch(batch);
      }

      // 연결 이미지 자산 삭제.
      const assetList=[...assetIds];
      for(let i=0;i<assetList.length;i+=50){
        const batch=assetList.slice(i,i+50).map(
          id=>env.DB.prepare("DELETE FROM view_assets WHERE id=?").bind(id)
        );
        if(batch.length)await env.DB.batch(batch);
      }

      // 구형 problems 캐시는 삭제해 나중에 되살아나지 않게 하고,
      // history는 선택 과목 이력을 제거한 버전으로 저장한다.
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM app_state WHERE key='problems'"),
        env.DB.prepare(`
          INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
        `).bind(JSON.stringify(newHistory),now)
      ]);

      // 재확인
      const verified=await readProblems(env);
      const remainSelected=verified.filter(p=>subjectSet.has(String(p?.subject||'').normalize('NFC').trim())).length;
      if(remainSelected){
        return json({ok:false,error:`선택 과목 ${remainSelected}문항이 아직 남아 있습니다.`},500);
      }

      const counts={};
      for(const s of subjects){
        counts[s]=removed.filter(p=>String(p?.subject||'').normalize('NFC').trim()===s).length;
      }

      return json({
        ok:true,
        subjects,
        deletedProblems:removed.length,
        deletedBySubject:counts,
        deletedAssets:assetList.length,
        deletedHistory:beforeHistory-newHistory.length,
        remainingProblems:verified.length
      });
    }

    if(u.pathname.startsWith('/api/view-asset/')){
      const id=decodeURIComponent(u.pathname.slice('/api/view-asset/'.length));
      if(request.method==='POST'){
        const ab=await request.arrayBuffer();
        if(!ab.byteLength)return json({ok:false,error:'empty image'},400);
        const bytes=new Uint8Array(ab);
        const mime=request.headers.get('content-type')||'image/webp';
        const now=new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO view_assets(id,image,mime_type,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET image=excluded.image,mime_type=excluded.mime_type,updated_at=excluded.updated_at
        `).bind(id,bytes,mime,now).run();
        return json({ok:true,id,url:'/api/view-asset/'+encodeURIComponent(id),bytes:bytes.byteLength});
      }
      if(request.method==='GET'){
        const r=await env.DB.prepare("SELECT image,mime_type FROM view_assets WHERE id=?").bind(id).first();
        if(!r)return new Response('Not found',{status:404,headers:{"cache-control":"no-store"}});

        let bytes=null;
        if(r.image instanceof ArrayBuffer){
          bytes=new Uint8Array(r.image);
        }else if(Array.isArray(r.image)){
          bytes=new Uint8Array(r.image);
        }else if(ArrayBuffer.isView(r.image)){
          bytes=new Uint8Array(r.image.buffer,r.image.byteOffset,r.image.byteLength);
        }

        if(!bytes || !bytes.byteLength){
          return new Response('Invalid image blob',{status:500,headers:{"cache-control":"no-store"}});
        }

        return new Response(bytes,{headers:{
          "content-type":r.mime_type||'image/webp',
          "content-length":String(bytes.byteLength),
          "cache-control":"no-store"
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

    // 클라이언트(flushCloudChangesP271)가 문제 삭제 시 호출하는 엔드포인트.
    // 없으면 405가 나서 동기화가 1.2초마다 무한 재시도되고 삭제한 문제가 새로고침 후 되살아난다.
    if(u.pathname==='/api/problems/delete-bulk'&&request.method==='POST'){
      let b={};try{b=await request.json()}catch{}
      const ids=[...new Set((Array.isArray(b?.ids)?b.ids:[]).map(String).filter(Boolean))];
      for(let i=0;i<ids.length;i+=50){
        const st=ids.slice(i,i+50).map(id=>env.DB.prepare("DELETE FROM problems WHERE id=?").bind(id));
        if(st.length)await env.DB.batch(st);
      }
      // 구형 app_state 'problems' 캐시가 남아 있으면 problems 테이블이 비었을 때 옛 데이터가 되살아나므로 함께 제거.
      if(ids.length)await env.DB.prepare("DELETE FROM app_state WHERE key='problems'").run();
      return json({ok:true,deleted:ids.length});
    }

    // 필요한 문항만 읽는다. (전체 /api/problems는 약 29MB라 25초 제한에 걸림)
    if(u.pathname==='/api/problems/by-ids'&&request.method==='POST'){
      let b={};try{b=await request.json()}catch{}
      const ids=[...new Set((Array.isArray(b?.ids)?b.ids:[]).map(String).filter(Boolean))];
      const out=[];
      for(let i=0;i<ids.length;i+=50){
        const part=ids.slice(i,i+50);
        const rows=await env.DB.prepare(`SELECT data FROM problems WHERE id IN (${part.map(()=>'?').join(',')})`).bind(...part).all();
        for(const r of (rows.results||[])){try{out.push(JSON.parse(r.data))}catch{}}
      }
      return json({ok:true,problems:out});
    }

    // 클라이언트(verifySingleProblemP275)가 부르는 단건 조회. 없으면 29MB 전체 조회로 대체되고 있었음.
    if(u.pathname==='/api/problem'&&request.method==='GET'){
      const id=u.searchParams.get('id')||'';
      const r=await env.DB.prepare("SELECT data FROM problems WHERE id=?").bind(id).first();
      if(!r)return json({ok:false,error:'not found'},404);
      let problem=null;try{problem=JSON.parse(r.data)}catch{}
      return json({ok:!!problem,problem});
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
      const b=await request.json();
      let h=Array.isArray(b?.history)?b.history:[];
      // 신형 클라이언트는 knownIds(마지막 동기화 때 본 이력 ID)를 함께 보낸다.
      // 서버에만 있고 클라이언트가 본 적 없는 이력(다른 탭/PC에서 추가)은 지우지 않고 병합한다.
      if(Array.isArray(b?.knownIds)){
        const known=new Set(b.knownIds.map(String));
        const clientIds=new Set(h.map(x=>String(x?.id||'')));
        const cur=await env.DB.prepare("SELECT value FROM app_state WHERE key='history'").first();
        let server=[];try{server=JSON.parse(cur?.value||'[]')}catch{}
        const extra=(Array.isArray(server)?server:[]).filter(x=>{const id=String(x?.id||'');return id&&!clientIds.has(id)&&!known.has(id);});
        if(extra.length){
          h=[...h,...extra].sort((a,b2)=>String(b2?.createdAt||'').localeCompare(String(a?.createdAt||''))).slice(0,1000);
        }
      }
      const now=new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      `).bind(JSON.stringify(h),now).run();
      return json({ok:true,history:h});
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