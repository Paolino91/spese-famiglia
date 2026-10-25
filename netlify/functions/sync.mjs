// Netlify Function: sincronizzazione delle spese di famiglia.
// Il dato vive in Netlify Blobs (store "spese-famiglia", chiave "famiglia").
// Accesso protetto dal codice famiglia impostato nella variabile d'ambiente FAMILY_KEY.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual, createHash } from "node:crypto";

// Unione deterministica dei dati di famiglia (usata identica da app e server).
// Regole: spese unite per id; le "lapidi" (deleted) vincono sempre e viaggiano;
// impostazioni condivise con "vince l'ultima modifica" (timestamp u).
function sfMerge(a, b) {
  a = a || {}; b = b || {};
  const sa = a.settings || {}, sb = b.settings || {};
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  // vince u piu' alto; a parita', confronto stabile del contenuto (indipendente dall'ordine)
  const newer = (x, prev) => num(x.u) > num(prev.u) || (num(x.u) === num(prev.u) && JSON.stringify(x) > JSON.stringify(prev));

  // lapidi: unione (si conserva il timestamp piu' vecchio)
  const deleted = {};
  [a.deleted, b.deleted].forEach((d) => {
    if (d && typeof d === 'object') Object.keys(d).forEach((k) => {
      const t = num(d[k]) || 1;
      if (!deleted[k] || t < deleted[k]) deleted[k] = t;
    });
  });

  // spese: unione per id, scarto se cancellate
  const byId = {};
  [a.expenses, b.expenses].forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((x) => {
      if (!x || !x.id || x.amount == null) return;
      const prev = byId[x.id];
      if (!prev || newer(x, prev)) byId[x.id] = x;
    });
  });
  Object.keys(deleted).forEach((id) => { delete byId[id]; });
  const expenses = Object.values(byId).sort((x, y) => num(y.ts) - num(x.ts) || (x.id < y.id ? -1 : 1));

  // elenco con id e timestamp u: vince il piu' recente; lapidi con prefisso
  const mergeList = (la, lb, prefix) => {
    const m = {}, order = [];
    [la, lb].forEach((list) => (Array.isArray(list) ? list : []).forEach((x) => {
      if (!x || !x.id) return;
      if (!m[x.id]) order.push(x.id);
      if (!m[x.id] || newer(x, m[x.id])) m[x.id] = x;
    }));
    return order.filter((id) => !deleted[prefix + id]).sort().map((id) => m[id]);
  };

  // valore singolo con timestamp
  // a parita' di timestamp vince il valore maggiore: risultato identico in qualunque ordine
  const lww = (va, ua, vb, ub) => {
    if (num(ub) > num(ua)) return [vb, num(ub)];
    if (num(ua) > num(ub)) return [va, num(ua)];
    if (va == null) return [vb, num(ub)];
    if (vb == null) return [va, num(ua)];
    const bWins = (typeof va === 'number' && typeof vb === 'number') ? vb > va : JSON.stringify(vb) > JSON.stringify(va);
    return [bWins ? vb : va, num(ua)];
  };
  const [budget, budgetU] = lww(sa.budget, sa.budgetU, sb.budget, sb.budgetU);

  const limits = {}, limitsU = {};
  const la = sa.limits || {}, lb = sb.limits || {}, lua = sa.limitsU || {}, lub = sb.limitsU || {};
  Object.keys(Object.assign({}, la, lb)).forEach((k) => {
    const [v, u] = lww(la[k], lua[k], lb[k], lub[k]);
    if (v != null) { limits[k] = v; if (u) limitsU[k] = u; }
  });

  const settings = {
    budget: budget != null ? budget : 2900, budgetU,
    limits, limitsU,
    customCats: mergeList(sa.customCats, sb.customCats, 'cat:'),
    recurring: mergeList(sa.recurring, sb.recurring, 'rec:'),
  };
  return { expenses, deleted, settings };
}


const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const sameKey = (a, b) => {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
};

export default async (req) => {
  const expected = process.env.FAMILY_KEY || "";
  if (!expected) return json({ error: "FAMILY_KEY non configurata sul server" }, 500);
  const given = req.headers.get("x-family-key") || "";
  if (!given || !sameKey(given.trim(), expected.trim())) return json({ error: "Codice famiglia errato" }, 401);

  const store = getStore({ name: "spese-famiglia", consistency: "strong" });
  const KEY = "famiglia";

  if (req.method === "GET") {
    const cur = await store.get(KEY, { type: "json" });
    return json({ data: cur || sfMerge({}, {}), at: Date.now() });
  }
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  let incoming;
  try { incoming = await req.json(); } catch { return json({ error: "JSON non valido" }, 400); }
  const data = incoming && incoming.data;
  if (!data || !Array.isArray(data.expenses)) return json({ error: "Dati mancanti" }, 400);

  // lettura-unione-scrittura con controllo di concorrenza (ETag): se l'altro
  // telefono ha scritto nel frattempo, si rilegge e si riunisce.
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    const merged = sfMerge(cur ? cur.data : {}, data);
    merged.updatedAt = Date.now();
    const res = cur
      ? await store.setJSON(KEY, merged, { onlyIfMatch: cur.etag })
      : await store.setJSON(KEY, merged, { onlyIfNew: true });
    if (res && res.modified) {
      // copia di sicurezza giornaliera (una per giorno, mai sovrascritta)
      try {
        const day = new Date().toISOString().slice(0, 10);
        await store.setJSON("backup-" + day, merged, { onlyIfNew: true });
      } catch {}
      return json({ data: merged, at: merged.updatedAt });
    }
  }
  return json({ error: "Scrittura concorrente, riprova" }, 409);
};

export const config = { path: "/api/sync" };
