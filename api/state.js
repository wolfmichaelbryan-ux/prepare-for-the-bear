// Vercel serverless function: cloud save for multi-device sync.
// GET  -> { meta, logs: [json strings] }   (meta = parsed State row or null)
// POST -> { meta, logs: [{id, date, sess, json}] } upserts the State row and adds any Logs not already stored.
const BASE = process.env.AIRTABLE_BASE || "appY9ChYklyYAXA7I";
const TOKEN = process.env.AIRTABLE_TOKEN;
const KEY = "mike";
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://wolfmichaelbryan-ux.github.io,https://prepare-for-the-bear.vercel.app").split(",").map(s => s.trim());
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const T = t => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function listAll(table, params) {
  const out = []; let offset;
  do {
    const u = new URL(T(table));
    Object.entries(params || {}).forEach(([k, v]) => Array.isArray(v) ? v.forEach(x => u.searchParams.append(k, x)) : u.searchParams.set(k, v));
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: H }); const j = await r.json();
    if (!r.ok) throw new Error(`Airtable ${r.status} on ${table}: ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j.records); offset = j.offset;
  } while (offset);
  return out;
}
async function write(method, url, body) {
  const r = await fetch(url, { method, headers: H, body: JSON.stringify(body) }); const j = await r.json();
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!TOKEN) return res.status(500).json({ error: "AIRTABLE_TOKEN is not set" });
  if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "origin not allowed" });

  try {
    if (req.method === "GET") {
      const [st, logs] = await Promise.all([
        listAll("State", { maxRecords: 1, filterByFormula: `{Key}="${KEY}"` }),
        listAll("Logs", { "fields[]": ["JSON"] }),
      ]);
      let meta = null;
      if (st.length) { try { meta = JSON.parse(st[0].fields.State || "null"); } catch (e) { meta = null; } }
      return res.status(200).json({ meta, logs: logs.map(r => r.fields.JSON).filter(Boolean) });
    }
    if (req.method === "POST") {
      const p = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!p.meta) return res.status(400).json({ error: "bad payload" });
      const st = await listAll("State", { maxRecords: 1, filterByFormula: `{Key}="${KEY}"` });
      const fields = { Key: KEY, State: JSON.stringify(p.meta), Updated: p.meta.updated || new Date().toISOString(), Device: p.meta.device || "" };
      if (st.length) await write("PATCH", `${T("State")}/${st[0].id}`, { fields, typecast: true });
      else await write("POST", T("State"), { records: [{ fields }], typecast: true });

      let saved = 0;
      const incoming = Array.isArray(p.logs) ? p.logs.filter(l => l && l.id && l.json) : [];
      if (incoming.length) {
        const existing = new Set((await listAll("Logs", { "fields[]": ["Log ID"] })).map(r => Number(r.fields["Log ID"])));
        const fresh = incoming.filter(l => !existing.has(Number(l.id)));
        for (let i = 0; i < fresh.length; i += 10) {
          await write("POST", T("Logs"), { records: fresh.slice(i, i + 10).map(l => ({ fields: { "Log ID": Number(l.id), JSON: l.json, Date: l.date || "", Session: l.sess || "" } })), typecast: true });
          saved += Math.min(10, fresh.length - i);
        }
      }
      return res.status(200).json({ ok: true, savedLogs: saved });
    }
    return res.status(405).json({ error: "GET or POST" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
