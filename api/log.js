// Vercel serverless function: receives a finished session from the app and writes it to Airtable.
// Env (set in the Vercel dashboard): AIRTABLE_TOKEN (required), AIRTABLE_BASE (optional override),
// ALLOWED_ORIGINS (optional, comma-separated). The token never ships to the client.
const BASE = process.env.AIRTABLE_BASE || "appY9ChYklyYAXA7I";
const TOKEN = process.env.AIRTABLE_TOKEN;
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://wolfmichaelbryan-ux.github.io,https://prepare-for-the-bear.vercel.app").split(",").map(s => s.trim());

async function at(table, body) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!TOKEN) return res.status(500).json({ error: "AIRTABLE_TOKEN is not set" });
  if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "origin not allowed" });

  const p = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  if (!p || !p.id || !p.sessName || !Array.isArray(p.sets)) return res.status(400).json({ error: "bad payload" });

  try {
    // idempotent: the app retries until it gets a 200, so never write the same session twice
    const dup = await fetch(`https://api.airtable.com/v0/${BASE}/Sessions?maxRecords=1&filterByFormula=${encodeURIComponent(`{Log ID}=${Number(p.id)}`)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }).then(r => r.json());
    if (dup.records && dup.records.length) return res.status(200).json({ ok: true, session: dup.records[0].id, duplicate: true });

    const sessionId = `${String(p.date).slice(0, 10)} ${p.sessName}`;
    const sess = await at("Sessions", { records: [{ fields: {
      "Session ID": sessionId,
      "Date": p.date,
      "Session": p.sessName,
      "Minutes": p.minutes || null,
      "Notes": p.note || "",
      "TM changes": (p.tmChanges || []).join("\n"),
      "PRs": (p.prs || []).join("\n"),
      "Deload": !!p.deload,
      "Log ID": p.id,
      "Summary": p.summary || "",
    }}], typecast: true });
    const sid = sess.records[0].id;

    let n = 0;
    for (let i = 0; i < p.sets.length; i += 10) {
      const chunk = p.sets.slice(i, i + 10).map(s => ({ fields: {
        "Set": `${sessionId} · ${s.exercise} · ${s.setNo}`,
        "Session": [sid],
        "Date": p.date,
        "Exercise": s.exercise,
        "Set #": s.setNo,
        "Weight": s.w ?? null,
        "Unit": s.unit || "",
        "Reps": s.r ?? null,
        "AMRAP": !!s.amrap,
        "Skipped": !!s.skipped,
        "Est 1RM": s.e1rm ?? null,
      }}));
      await at("Sets", { records: chunk, typecast: true });
      n += chunk.length;
    }
    return res.status(200).json({ ok: true, session: sid, sets: n });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
