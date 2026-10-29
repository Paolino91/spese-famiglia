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

window.SFDelta = SFDelta;
