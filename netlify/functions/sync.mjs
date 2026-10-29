// Netlify Function: sincronizzazione differenziale delle spese di famiglia.
// Stato condiviso in Netlify Blobs (store "spese-famiglia", chiave "stato"):
//   { rev, entries: { chiave: { v, u, r } }, day }
// Il telefono invia solo le voci cambiate e riceve solo quelle con revisione > since.
// Risparmio crediti: nessuna scrittura se non cambia nulla, copia di sicurezza una sola volta al giorno,
// richieste "semplici" (niente preflight CORS), risposte minime.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual, createHash } from "node:crypto";

// Sincronizzazione differenziale (identica su app e server).
// Ogni dato condiviso e' una "voce" con chiave, valore v e timestamp u:
//   e:<id>        spesa                       d:<chiave>    lapide (cancellazione), v = istante
//   s:budget      budget mensile              l:<cat>       limite di una categoria
//   c:<id>        categoria personalizzata    r:<id>        spesa ricorrente
// Le lapidi vincono sempre: d:<id> elimina e:<id>, d:rec:<id> elimina r:<id>, d:cat:<id> elimina c:<id>.
var SFDelta = (function () {
  var num = function (x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; };
  var sameJSON = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

  // chiave della voce eliminata da una lapide
  function victim(dkey) {
    var k = dkey.slice(2);
    if (k.indexOf('rec:') === 0) return 'r:' + k.slice(4);
    if (k.indexOf('cat:') === 0) return 'c:' + k.slice(4);
    return 'e:' + k;
  }
  function killedBy(key) {
    var t = key.slice(0, 2), id = key.slice(2);
    if (t === 'e:') return 'd:' + id;
    if (t === 'r:') return 'd:rec:' + id;
    if (t === 'c:') return 'd:cat:' + id;
    return null;
  }
  // a vince su b? (timestamp piu' recente; a parita', confronto stabile del contenuto)
  function wins(a, b) {
    if (!b) return true;
    if (num(a.u) !== num(b.u)) return num(a.u) > num(b.u);
    var ja = JSON.stringify(a.v), jb = JSON.stringify(b.v);
    if (typeof a.v === 'number' && typeof b.v === 'number') return a.v > b.v;
    return ja > jb;
  }

  // dati dell'app -> voci
  function toEntries(d) {
    var out = {}, s = (d && d.settings) || {};
    ((d && d.expenses) || []).forEach(function (x) { if (x && x.id && x.amount != null) out['e:' + x.id] = { v: x, u: num(x.u) }; });
    var del = (d && d.deleted) || {};
    Object.keys(del).forEach(function (k) { out['d:' + k] = { v: num(del[k]) || 1, u: 0 }; });
    if (s.budget != null) out['s:budget'] = { v: s.budget, u: num(s.budgetU) };
    var lim = s.limits || {}, limU = s.limitsU || {};
    Object.keys(lim).forEach(function (k) { if (lim[k] != null) out['l:' + k] = { v: lim[k], u: num(limU[k]) }; });
    (s.customCats || []).forEach(function (c) { if (c && c.id) out['c:' + c.id] = { v: c, u: num(c.u) }; });
    (s.recurring || []).forEach(function (r) { if (r && r.id) out['r:' + r.id] = { v: r, u: num(r.u) }; });
    return out;
  }

  // applica voci ricevute ai dati dell'app (restituisce un nuovo oggetto)
  function applyEntries(d, entries) {
    var cur = toEntries(d);
    Object.keys(entries).forEach(function (k) {
      var e = entries[k];
      if (k.indexOf('d:') === 0) { if (!cur[k]) cur[k] = e; delete cur[victim(k)]; return; }
      var kb = killedBy(k); if (kb && cur[kb]) return;
      if (wins(e, cur[k])) cur[k] = e;
    });
    return fromEntries(cur, d);
  }

  // voci -> dati dell'app (conserva le impostazioni locali, es. il proprietario del telefono)
  function fromEntries(map, base) {
    base = base || {};
    var bs = base.settings || {};
    var expenses = [], deleted = {}, limits = {}, limitsU = {}, cats = [], recs = [];
    var budget = bs.budget != null ? bs.budget : 2900, budgetU = num(bs.budgetU);
    Object.keys(map).forEach(function (k) {
      var e = map[k], t = k.slice(0, 2), id = k.slice(2);
      if (t === 'e:') expenses.push(e.v);
      else if (t === 'd:') deleted[id] = e.v;
      else if (k === 's:budget') { budget = e.v; budgetU = num(e.u); }
      else if (t === 'l:') { limits[id] = e.v; if (num(e.u)) limitsU[id] = num(e.u); }
      else if (t === 'c:') cats.push(e.v);
      else if (t === 'r:') recs.push(e.v);
    });
    expenses.sort(function (a, b) { return num(b.ts) - num(a.ts) || (a.id < b.id ? -1 : 1); });
    var byId = function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); };
    var settings = Object.assign({}, bs, { budget: budget, budgetU: budgetU, limits: limits, limitsU: limitsU,
      customCats: cats.sort(byId), recurring: recs.sort(byId) });
    return Object.assign({}, base, { expenses: expenses, deleted: deleted, settings: settings });
  }

  // chiavi cambiate tra due versioni dei dati (per sapere cosa inviare)
  function changedKeys(prev, next) {
    var a = toEntries(prev), b = toEntries(next), out = [];
    Object.keys(b).forEach(function (k) { if (!a[k] || !sameJSON(a[k], b[k])) out.push(k); });
    return out;
  }

  // SERVER: unisce le voci inviate nello stato condiviso; assegna una revisione alle voci cambiate
  // stato = { rev, entries: { key: {v,u,r} } }
  function serverApply(state, ops) {
    var E = state.entries, changed = 0;
    ops.forEach(function (op) {
      var k = op[0], e = { v: op[1], u: num(op[2]) };
      if (typeof k !== 'string' || k.length < 3 || k.length > 200) return;
      if (k.indexOf('d:') === 0) {
        var vk = victim(k);
        if (!E[k]) { E[k] = { v: num(e.v) || 1, u: 0, r: ++state.rev }; changed++; }
        if (E[vk]) { delete E[vk]; changed++; }
        return;
      }
      var kb = killedBy(k); if (kb && E[kb]) return;
      if (wins(e, E[k])) {
        if (E[k] && sameJSON(E[k].v, e.v) && num(E[k].u) === e.u) return;
        E[k] = { v: e.v, u: e.u, r: ++state.rev }; changed++;
      }
    });
    return changed;
  }
  // SERVER: voci con revisione successiva a "since"
  function serverDelta(state, since) {
    var out = [], E = state.entries;
    Object.keys(E).forEach(function (k) { if (E[k].r > since) out.push([k, E[k].v, E[k].u]); });
    return out;
  }

  return { toEntries: toEntries, applyEntries: applyEntries, fromEntries: fromEntries, changedKeys: changedKeys,
    serverApply: serverApply, serverDelta: serverDelta, victim: victim, killedBy: killedBy, wins: wins };
})();


const ALLOWED_ORIGINS = ["https://paolino91.github.io"];
const corsFor = (req) => {
  const o = req.headers.get("origin") || "";
  return ALLOWED_ORIGINS.includes(o)
    ? { "access-control-allow-origin": o, "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-family-key", "access-control-max-age": "86400", vary: "Origin" }
    : {};
};
const reply = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
  });
const sameKey = (a, b) =>
  timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());

const KEY = "stato";
const OLD_KEY = "famiglia"; // formato della prima versione (lettura una tantum per la migrazione)

async function loadState(store) {
  const cur = await store.getWithMetadata(KEY, { type: "json" });
  if (cur && cur.data && cur.data.entries) return { state: cur.data, etag: cur.etag };
  // migrazione dal vecchio formato
  const state = { rev: 0, entries: {}, day: "" };
  const old = await store.get(OLD_KEY, { type: "json" });
  if (old && Array.isArray(old.expenses)) {
    const ent = SFDelta.toEntries(old);
    SFDelta.serverApply(state, Object.keys(ent).map((k) => [k, ent[k].v, ent[k].u]));
  }
  return { state, etag: cur ? cur.etag : null, fresh: !cur };
}

export default async (req) => {
  const cors = corsFor(req);
  const json = (obj, status = 200) => reply(obj, status, cors);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const expected = (process.env.FAMILY_KEY || "").trim();
  if (!expected) return json({ error: "FAMILY_KEY non configurata sul server" }, 500);

  let body;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const given = String((body && body.k) || req.headers.get("x-family-key") || "").trim();
  if (!given || !sameKey(given, expected)) return json({ error: "Codice famiglia errato" }, 401);

  // compatibilita' con la prima versione dell'app (invia tutto, riceve tutto)
  const legacy = body && body.data && Array.isArray(body.data.expenses);
  let ops, since;
  if (legacy) {
    const ent = SFDelta.toEntries(body.data);
    ops = Object.keys(ent).map((k) => [k, ent[k].v, ent[k].u]);
    since = 0;
  } else {
    ops = Array.isArray(body.ops) ? body.ops.slice(0, 20000) : [];
    since = Number.isFinite(body.since) ? body.since : 0;
  }

  const store = getStore({ name: "spese-famiglia", consistency: "strong" });
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, etag, fresh } = await loadState(store);
    const reset = since > state.rev; // il server e' stato azzerato: il telefono deve reinviare tutto
    const changed = ops.length ? SFDelta.serverApply(state, ops) : 0;
    const today = new Date().toISOString().slice(0, 10);
    const needBackup = changed > 0 && state.day !== today;

    if (changed > 0 || fresh) {
      if (needBackup) state.day = today;
      const res = etag
        ? await store.setJSON(KEY, state, { onlyIfMatch: etag })
        : await store.setJSON(KEY, state, { onlyIfNew: true });
      if (!res || !res.modified) continue; // l'altro telefono ha scritto nello stesso istante: si riprova
      if (needBackup) { try { await store.setJSON("backup-" + today, state, { onlyIfNew: true }); } catch {} }
    }

    if (legacy) {
      const map = {};
      Object.keys(state.entries).forEach((k) => { map[k] = state.entries[k]; });
      const full = SFDelta.fromEntries(map, {});
      return json({ data: { expenses: full.expenses, deleted: full.deleted, settings: full.settings }, at: Date.now() });
    }
    const out = { rev: state.rev };
    const ch = SFDelta.serverDelta(state, reset ? 0 : since);
    if (ch.length) out.ch = ch;
    if (reset) out.reset = true;
    return json(out);
  }
  return json({ error: "Scrittura concorrente, riprova" }, 409);
};

export const config = { path: "/api/sync" };
