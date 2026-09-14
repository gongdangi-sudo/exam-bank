
function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function readState(env) {
  const rows = await env.DB.prepare(
    "SELECT key, value, updated_at FROM app_state WHERE key IN ('problems','history')"
  ).all();

  const state = { problems: [], history: [], updatedAt: null };
  for (const row of rows.results || []) {
    try {
      if (row.key === "problems") state.problems = JSON.parse(row.value || "[]");
      if (row.key === "history") state.history = JSON.parse(row.value || "[]");
      if (!state.updatedAt || row.updated_at > state.updatedAt) state.updatedAt = row.updated_at;
    } catch {}
  }
  return state;
}

async function writeState(env, payload) {
  const problems = Array.isArray(payload?.problems) ? payload.problems : [];
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const now = new Date().toISOString();

  const p = env.DB.prepare(`
    INSERT INTO app_state(key,value,updated_at) VALUES('problems',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).bind(JSON.stringify(problems), now);

  const h = env.DB.prepare(`
    INSERT INTO app_state(key,value,updated_at) VALUES('history',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).bind(JSON.stringify(history), now);

  await env.DB.batch([p, h]);
  return { ok: true, problems: problems.length, history: history.length, updatedAt: now };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return json({ ok: true, service: "exam-bank", database: "D1" });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") {
        return json(await readState(env));
      }
      if (request.method === "PUT") {
        try {
          const payload = await request.json();
          return json(await writeState(env, payload));
        } catch (e) {
          return json({ ok: false, error: String(e?.message || e) }, 400);
        }
      }
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // 정적 사이트는 Cloudflare의 글로벌 자산 캐시에서 제공
    return env.ASSETS.fetch(request);
  }
};
