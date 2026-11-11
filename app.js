/* Worldguess game logic. Sections: game core, Nostr accounts and leaderboard, then the site layer at the bottom (config, languages, tabs, settings, streaks, share, ads). */

const $ = s => document.querySelector(s);
const ROUNDS = 5;
// Rough land boxes [south, west, north, east] used to pick random places
const REGIONS = [[25,-124,49,-67],[49,-125,60,-95],[15,-117,32,-87],[-34,-74,5,-35],[-50,-73,-23,-60],
  [36,-10,58,30],[50,30,60,60],[36,26,42,44],[8,68,32,88],[1,98,21,109],[-8,95,6,120],
  [31,130,45,142],[-38,114,-16,153],[-34,17,-22,32]];

// =====================================================================
// GAME CORE: three imagery sources (google | commons | pmx) + two guess maps (Google | Leaflet)
// =====================================================================
let key = ''; try { key = localStorage.getItem('wg_key') || ''; } catch (e) {}
let R = Math.random, last = { mode: 'classic', room: '', src: 'commons' }, roundLog = [], timer = null, tLeft = 0, acct = null, NT = null;
let round = 0, total = 0, target = null, guess = null, done = false, svc, pano, G = null, cur = {};
const MODES = { classic: { t: 0 }, timed: { t: 60 }, blitz: { t: 20, still: true } };
let sv = null; try { sv = localStorage.getItem('wg_src'); } catch (e) {}
$('#src').value = sv || (key ? 'google' : 'commons');

function show(id) {
  document.querySelectorAll('.screen,#game').forEach(e => e.classList.remove('on'));
  $(id).classList.add('on');
  document.body.classList.toggle('playing', id === '#game');
  window.scrollTo(0, 0); fillAds(id);
}
function route() { show('#menu'); }

$('#saveKey').onclick = () => {
  const v = $('#keyIn').value.trim();
  if (v.length < 20) { $('#setupErr').textContent = 'That does not look like an API key. Copy it again from Google Cloud Console.'; return; }
  key = v; try { localStorage.setItem('wg_key', key); } catch (e) {}
  $('#src').value = 'google'; $('#setupErr').textContent = ''; route();
};
$('#changeKey').onclick = () => { $('#keyIn').value = ''; show('#setup'); };
$('#src').onchange = () => { try { localStorage.setItem('wg_src', $('#src').value); } catch (e) {} };
$('#play').onclick = () => start();
$('#daily').onclick = () => start('daily-' + today());
$('#again').onclick = () => play();
$('#lb').onclick = () => openBoard('mode:' + $('#mode').value + modeSfx($('#src').value));
$('#toBoard').onclick = () => openBoard(boardKey());
$('#backMenu').onclick = () => route();
$('#refresh').onclick = () => loadBoard();
$('#boardSel').onchange = () => loadBoard();
$('#expand').onclick = () => $('#guessbox').classList.toggle('big');
$('#photo').onclick = () => $('#photo').classList.toggle('zoom');
$('#room').oninput = e => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32); };
window.gm_authFailure = () => {
  $('#setupErr').textContent = 'Google rejected this key. Check that Maps JavaScript API is enabled, billing is on, and the referrer restriction matches this site.';
  show('#setup');
};

// ---- loaders ----
function loadScript(src, css) {
  return new Promise((res, rej) => {
    if (css) { const c = document.createElement('link'); c.rel = 'stylesheet'; c.href = css; document.head.appendChild(c); }
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load a map library. Check your connection.'));
    document.head.appendChild(s);
  });
}
function loadMaps() {
  if (window.google && google.maps) return Promise.resolve();
  return new Promise((res, rej) => {
    window.__gmReady = res;
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&callback=__gmReady&v=weekly';
    s.onerror = () => rej(new Error('Could not reach Google Maps. Check your connection.'));
    document.head.appendChild(s);
  });
}
const loadLeaflet = () => window.L && window.L.map ? Promise.resolve()
  : loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css');
const loadImg = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });

// ---- guess maps: both expose init / world / put / reveal / clear / destroy ----
const GM = { map: null, pin: null, ans: null, line: null,
  init(el, cb) {
    this.map = new google.maps.Map(el, { center: { lat: 20, lng: 0 }, zoom: 1, disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy', draggableCursor: 'crosshair' });
    this.map.addListener('click', e => cb(e.latLng.lat(), e.latLng.lng()));
  },
  world() { this.map.setCenter({ lat: 20, lng: 0 }); this.map.setZoom(1); },
  put(a, b) { const p = { lat: a, lng: b }; this.pin ? this.pin.setPosition(p) : this.pin = new google.maps.Marker({ map: this.map, position: p }); },
  reveal(g, tg) {
    this.ans = new google.maps.Marker({ map: this.map, position: tg, icon: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png' });
    const b = new google.maps.LatLngBounds(); b.extend(tg);
    if (g) { this.line = new google.maps.Polyline({ map: this.map, path: [g, tg], strokeColor: '#ffd60a', strokeWeight: 3 }); b.extend(g); }
    this.map.fitBounds(b, 40);
  },
  clear() { [this.pin, this.ans, this.line].forEach(o => o && o.setMap(null)); this.pin = this.ans = this.line = null; },
  destroy() { this.clear(); $('#map').innerHTML = ''; } };
// Leaflet map for the no-key modes. Tiles come from config.json -> "tiles" (default: OpenStreetMap).
const LM = { map: null, pin: null, ans: null, line: null,
  init(el, cb) {
    const Lf = window.L, T = CFG.tiles || {};
    this.map = Lf.map(el, { worldCopyJump: true }).setView([20, 0], 1);
    Lf.tileLayer(T.url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: T.attribution || '© OpenStreetMap contributors', maxZoom: 18 }).addTo(this.map);
    this.map.on('click', e => cb(e.latlng.lat, e.latlng.lng));
    new ResizeObserver(() => this.map && this.map.invalidateSize()).observe(el);
  },
  world() { this.map.setView([20, 0], 1); },
  put(a, b) { this.pin ? this.pin.setLatLng([a, b]) : this.pin = window.L.circleMarker([a, b], { radius: 9, color: '#fff', weight: 2, fillColor: '#ffd60a', fillOpacity: 1 }).addTo(this.map); },
  reveal(g, tg) {
    const Lf = window.L, pts = [[tg.lat, tg.lng]];
    this.ans = Lf.circleMarker(pts[0], { radius: 9, color: '#fff', weight: 2, fillColor: '#2ee59d', fillOpacity: 1 }).addTo(this.map);
    if (g) { this.line = Lf.polyline([[g.lat, g.lng], pts[0]], { color: '#ffd60a', weight: 3 }).addTo(this.map); pts.push([g.lat, g.lng]); }
    this.map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
  },
  clear() { [this.pin, this.ans, this.line].forEach(o => o && o.remove()); this.pin = this.ans = this.line = null; },
  destroy() { this.clear(); this.map && this.map.remove(); this.map = null; $('#map').innerHTML = ''; } };
async function initGuessMap() {
  const want = last.src === 'google' ? GM : LM;
  if (G && G !== want) { G.destroy(); G = null; }
  if (!G) { if (want === LM) await loadLeaflet(); G = want; G.init($('#map'), placeGuess); }
}

// ---- imagery sources. Each returns {lat, lng, pano} (Google) or {lat, lng, img, credit, link, title} (photos) ----
const randPoint = rnd => { if (last.map) { const p = last.map.locs[rnd() * last.map.locs.length | 0]; return [p[0], p[1]]; } const r = REGIONS[rnd() * REGIONS.length | 0]; return [r[0] + rnd() * (r[2] - r[0]), r[1] + rnd() * (r[3] - r[1])]; };
async function gPick(rnd) {
  for (let i = 0; i < 30; i++) {
    const [lat, lng] = randPoint(rnd);
    try { // coverage lookups do not use a billable panorama
      const d = (await svc.getPanorama({ location: { lat, lng }, radius: last.map ? 800 : 100000, preference: google.maps.StreetViewPreference.NEAREST, sources: [google.maps.StreetViewSource.OUTDOOR] })).data;
      return { lat: d.location.latLng.lat(), lng: d.location.latLng.lng(), pano: d.location.pano };
    } catch (e) { /* no coverage, retry */ }
  }
  throw new Error('No Street View found. Check that Maps JavaScript API is enabled for your key.');
}
// Wikimedia Commons: public API, no key. Photos are credited after each guess (licence requirement).
const BAD = /\b(map|flag|logo|arms|plan|diagram|stamp|portrait|poster|cover|scan|screenshot|icon|seal|chart|coin)\b/i;
const strip = h => h ? new DOMParser().parseFromString(h, 'text/html').body.textContent.trim().slice(0, 60) : '';
async function cPick(rnd) {
  for (let i = 0; i < 14; i++) {
    const [lat, lng] = randPoint(rnd);
    const j = await getJSON('https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=' + lat + '|' + lng +
      '&ggsradius=' + (last.map ? 1500 : 10000) + '&ggslimit=40&ggsnamespace=6&prop=coordinates|imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600&iiextmetadatafilter=Artist|LicenseShortName', null);
    const ok = Object.values((j && j.query && j.query.pages) || {}).filter(p => p.imageinfo && p.coordinates && p.imageinfo[0].mime === 'image/jpeg' &&
      p.imageinfo[0].width >= 1000 && p.imageinfo[0].height >= 600 && !BAD.test(p.title)).sort((a, b) => a.pageid - b.pageid);
    if (ok.length) {
      const p = ok[rnd() * ok.length | 0], ii = p.imageinfo[0], em = ii.extmetadata || {};
      return { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon, img: ii.thumburl || ii.url, link: ii.descriptionurl,
        credit: (strip(em.Artist && em.Artist.value) || 'Wikimedia Commons') + (em.LicenseShortName ? ', ' + em.LicenseShortName.value : ''),
        title: p.title.replace(/^File:/, '').replace(/\.\w+$/, '') };
    }
  }
  throw new Error('No photos found right now. Try again.');
}
// Panoramax (beta): STAC search over the public API. API address is configurable in config.json -> "panoramaxApi".
async function pPick(rnd) {
  const base = CFG.panoramaxApi || 'https://api.panoramax.xyz/api';
  for (let i = 0; i < 14; i++) {
    const [lat, lng] = randPoint(rnd), d = last.map ? 0.015 : 0.05;
    const j = await getJSON(base + '/search?limit=20&bbox=' + [lng - d, lat - d, lng + d, lat + d].join(','), null);
    const f = ((j && j.features) || []).filter(x => x.assets && (x.assets.sd || x.assets.hd) && x.geometry).sort((a, b) => a.id < b.id ? -1 : 1);
    if (f.length) {
      const x = f[rnd() * f.length | 0], c = x.geometry.coordinates, p = x.properties || {};
      return { lat: c[1], lng: c[0], img: (x.assets.sd || x.assets.hd).href, link: '', title: '',
        credit: 'Panoramax' + (p['geovisio:producer'] ? ' / ' + p['geovisio:producer'] : '') + (p.license ? ', ' + p.license : '') };
    }
  }
  throw new Error('No street photos found right now. Try again.');
}
async function photoPick(fn) { // skip 360° panoramas (very wide images): they would look distorted when shown flat
  for (let i = 0; i < 5; i++) { const s = await fn(R); try { const im = await loadImg(s.img); if (im.naturalWidth / im.naturalHeight < 1.9) return s; } catch (e) {} }
  throw new Error('Could not load a photo. Try again.');
}
const pick = () => last.src === 'google' ? gPick(R) : photoPick(last.src === 'pmx' ? pPick : cPick);

// ---- game flow ----
function msg(m, on = true) { $('#msgText').textContent = m; $('#msg').classList.toggle('off', !on); }
async function play() {
  if (last.src === 'google' && !key) { show('#setup'); return; }
  show('#game'); msg(t('loading'));
  try {
    if (last.src === 'google') {
      await loadMaps();
      if (!pano) {
        svc = new google.maps.StreetViewService();
        // One panorama object is reused for every round, since Google bills per panorama created.
        pano = new google.maps.StreetViewPanorama($('#pano'), { addressControl: false, showRoadLabels: false, fullscreenControl: false, enableCloseButton: false, motionTracking: false, motionTrackingControl: false });
      }
      const nm = $('#noMove').checked || MODES[last.mode].still;
      pano.setOptions({ linksControl: !nm, clickToGo: !nm });
    }
    await initGuessMap();
    round = 0; total = 0; roundLog = [];
    await nextRound();
  } catch (e) { msg(e.message + ' Reload to try again.'); }
}
async function nextRound() {
  round++; done = false; guess = null; clearInterval(timer); if (DU) DU.round = round;
  R = last.room ? seeded(last.room + ':' + round) : Math.random;
  G.clear(); $('#result').classList.remove('on');
  $('#guessBtn').disabled = true; $('#guessBtn').textContent = t('btn.pin'); $('#guessbox').classList.remove('big');
  msg(t('loading.loc')); hud();
  cur = await pick(); target = { lat: cur.lat, lng: cur.lng };
  if (cur.pano) { $('#photo').style.display = 'none'; $('#pano').style.display = 'block'; pano.setPano(cur.pano); pano.setPov({ heading: R() * 360, pitch: 0 }); }
  else { $('#pano').style.display = 'none'; $('#photo').style.display = 'flex'; $('#photo').classList.remove('zoom'); $('#photoImg').src = cur.img; }
  G.world(); msg('', false); startTimer();
}
function hud() {
  $('#hud').textContent = (DU && DU.started ? t('duel.hud', { r: round, n: ROUNDS, me: Math.round(DU.hp[0]), op: Math.round(DU.hp[1]) }) : t('hud', { r: round, n: ROUNDS, s: total.toLocaleString() })) + (tLeft > 0 ? '   ' + tLeft + 's' : '');
  $('#hud').classList.toggle('low', tLeft > 0 && tLeft <= 10);
}
function placeGuess(a, b) {
  if (done) return;
  guess = { lat: a, lng: b }; G.put(a, b);
  $('#guessBtn').disabled = false; $('#guessBtn').textContent = t('btn.guess');
}
function km(a, b) {
  const R6 = 6371, rad = x => x * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R6 * Math.asin(Math.sqrt(h));
}
$('#guessBtn').onclick = () => {
  if (done) { return round >= ROUNDS ? finish() : nextRound().catch(e => msg(e.message)); }
  if (guess) submit();
};
function submit() {
  if (DU && DU.started) return duelSubmit();
  done = true; clearInterval(timer); tLeft = 0;
  const d = guess ? km(guess, target) : null;
  const pts = guess ? Math.round(5000 * Math.exp(-d / 1491.7)) : 0; // approximates GeoGuessr's world scoring
  total += pts; roundLog.push(guess ? Math.round(d) : -1); hud();
  G.reveal(guess, target);
  $('#guessbox').classList.add('big'); $('#guessBtn').disabled = false;
  // Photo credit is shown after every guess (required by Commons / Panoramax licences)
  const cr = cur.credit ? '<br><small>' + (cur.title ? esc(cur.title) + ' · ' : '') + (cur.link ? '<a href="' + esc(cur.link) + '" target="_blank" rel="noopener">' + esc(cur.credit) + '</a>' : esc(cur.credit)) + '</small>' : '';
  $('#result').innerHTML = (guess ? t('res.ok', { d: Math.round(d).toLocaleString(), p: pts.toLocaleString() }) : t('res.none')) + cr;
  $('#result').classList.add('on');
  $('#guessBtn').textContent = round >= ROUNDS ? t('btn.final') : t('btn.next');
}
function finish() {
  $('#finalScore').textContent = total.toLocaleString() + ' / ' + (ROUNDS * 5000).toLocaleString();
  $('#finalNote').textContent = total > 20000 ? 'Outstanding. You could be a pro.' : total > 12000 ? 'Solid. You read the clues well.' : 'Keep going: road lines, signs and plants give plenty away.';
  ['#share', '#again', '#toBoard'].forEach(s => $(s).hidden = false);
  show('#end'); postScore(); recordDaily();
}

// ---- Modes, rooms, timer ----
let CFG = {};
const today = () => new Date(Date.now() + (CFG.dailyResetOffsetMinutes || 0) * 60000).toISOString().slice(0, 10);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const modeSfx = s => s === 'google' ? '' : '-' + s, roomSfx = s => s === 'google' ? '' : '~' + s;
const boardKey = () => last.map ? 'cm:' + last.map.id + roomSfx(last.src) : last.room ? 'room:' + last.room + roomSfx(last.src) : 'mode:' + last.mode + modeSfx(last.src);
function start(room) {
  last = { mode: $('#mode').value, room: room || $('#room').value.trim(), src: $('#src').value, map: null };
  play();
}
// Same room code gives every player the same places and headings
function seeded(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function startTimer() {
  const t = DU && DU.started ? (MODES[last.mode].t || 60) : MODES[last.mode].t; if (!t) return;  // duels always have a timer
  tLeft = t; hud();
  timer = setInterval(() => { tLeft--; hud(); if (tLeft <= 0) { clearInterval(timer); if (!done) submit(); } }, 1000);
}

// ---- Nostr: accounts, scores, leaderboard ----
let RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const KIND = 9731;
const nostr = async () => NT || (NT = await import('https://esm.sh/nostr-tools@2.7.2'));
try { acct = JSON.parse(localStorage.getItem('wg_acct') || 'null'); } catch (e) {}
function saveAcct() { try { localStorage.setItem('wg_acct', JSON.stringify(acct)); } catch (e) {} renderAcct(); }
async function sign(t) {
  if (acct.ext) { t.pubkey = acct.pub; return window.nostr.signEvent(t); }
  const N = await nostr();
  return N.finalizeEvent(t, N.nip19.decode(acct.nsec).data);
}
function renderAcct() {
  const a = $('#acct');
  a.innerHTML = !acct
    ? '<b>Account (optional)</b><p>Sign in with Nostr to post scores and join rooms.</p><div class="row"><button class="ghost" data-a="new">Create account</button><button class="ghost" data-a="imp">Import key</button>' + (window.nostr ? '<button class="ghost" data-a="ext">Use extension</button>' : '') + '</div>'
    : '<b>' + esc(acct.name || 'Unnamed player') + '</b><div class="row"><button class="ghost" data-a="name">Set name</button>' + (acct.nsec ? '<button class="ghost" data-a="bak">Back up key</button>' : '') + '<button class="ghost" data-a="out">Sign out</button></div>';
}
$('#acct').onclick = async e => {
  const k = e.target.dataset.a; if (!k) return;
  try {
    if (k === 'new') {
      if (!confirm(t('acct.notice'))) return;
      const N = await nostr(), sk = N.generateSecretKey();
      acct = { nsec: N.nip19.nsecEncode(sk), pub: N.getPublicKey(sk), name: (prompt('Pick a display name') || '').slice(0, 24) };
      saveAcct(); prompt('Save this secret key somewhere safe. It is your login and cannot be recovered:', acct.nsec);
    } else if (k === 'imp') {
      const v = (prompt('Paste your nsec key') || '').trim(); if (!v) return;
      const N = await nostr(), sk = N.nip19.decode(v).data;
      acct = { nsec: v, pub: N.getPublicKey(sk), name: (prompt('Display name') || '').slice(0, 24) }; saveAcct();
    } else if (k === 'ext') {
      acct = { ext: 1, pub: await window.nostr.getPublicKey(), name: (prompt('Display name') || '').slice(0, 24) }; saveAcct();
    } else if (k === 'name') { acct.name = (prompt('Display name', acct.name || '') || '').slice(0, 24); saveAcct(); }
    else if (k === 'bak') prompt('Your secret key:', acct.nsec);
    else if (k === 'out' && confirm('Sign out? Without a backed-up key you cannot get this account back.')) { acct = null; saveAcct(); }
  } catch (err) { alert('That did not work: ' + err.message); }
};
function publish(ev) {
  RELAYS.forEach(u => { try { const w = new WebSocket(u); w.onopen = () => { w.send(JSON.stringify(['EVENT', ev])); setTimeout(() => w.close(), 4000); }; } catch (e) {} });
}
function query(filter, ms = 5000) {
  return new Promise(res => {
    const seen = new Map(); let n = 0;
    const fin = () => { if (++n >= RELAYS.length) res([...seen.values()]); };
    RELAYS.forEach(u => {
      try {
        const w = new WebSocket(u), id = 'wg' + Math.random().toString(36).slice(2);
        w.onopen = () => w.send(JSON.stringify(['REQ', id, filter]));
        w.onmessage = m => { const d = JSON.parse(m.data); if (d[0] === 'EVENT') seen.set(d[2].id, d[2]); if (d[0] === 'EOSE') { w.close(); fin(); } };
        w.onerror = fin;
      } catch (e) { fin(); }
    });
    setTimeout(() => res([...seen.values()]), ms);
  });
}
async function postScore() {
  const n = $('#postNote');
  if (!acct) { n.textContent = 'Sign in from the menu to post scores to the leaderboard.'; return; }
  n.textContent = 'Posting score…';
  try {
    const ev = await sign({ kind: KIND, created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ rounds: roundLog }),
      tags: [['t', 'worldguess'], ['b', boardKey()], ['score', String(total)], ['name', acct.name || 'anon']] });
    publish(ev); n.textContent = 'Score posted to Nostr relays. It can take a few seconds to appear.';
  } catch (e) { n.textContent = 'Could not post your score.'; }
}
function openBoard(key) {
  const sel = $('#boardSel'); sel.innerHTML = '';
  const room = $('#room').value.trim();
  const SN = { google: 'Street View', commons: 'Wikimedia photos', pmx: 'Street photos' }, MN = { classic: 'Classic', timed: 'Timed', blitz: 'Blitz' };
  const opts = [];
  Object.keys(SN).forEach(s => Object.keys(MN).forEach(m => opts.push(['mode:' + m + modeSfx(s), MN[m] + ' · ' + SN[s]])));
  Object.keys(SN).forEach(s => opts.push(['room:daily-' + today() + roomSfx(s), 'Daily · ' + SN[s]]));
  if (room) opts.push(['room:' + room + roomSfx($('#src').value), 'Room: ' + room]);
  if (!opts.some(o => o[0] === key)) opts.push([key, key.startsWith('cm:') ? 'Map: ' + ((last.map && last.map.name) || key.slice(3)) : 'Room: ' + key.slice(5)]);
  opts.forEach(o => sel.add(new Option(o[1], o[0])));
  sel.value = key; show('#board'); loadBoard();
}
async function loadBoard() {
  const key = $('#boardSel').value; $('#boardNote').textContent = 'Loading…';
  try {
    const N = await nostr();
    const evs = await query({ kinds: [KIND], '#b': [key], limit: 300 });
    const best = new Map(), tag = (e, k) => (e.tags.find(t => t[0] === k) || [])[1];
    for (const e of evs) {
      if (!N.verifyEvent(e)) continue;
      let r; try { r = JSON.parse(e.content).rounds; } catch (_) { continue; }
      const s = +tag(e, 'score');
      if (!Array.isArray(r) || r.length !== ROUNDS || !(s >= 0 && s <= 25000)) continue;
      const calc = r.reduce((a, d) => a + (d >= 0 ? Math.round(5000 * Math.exp(-d / 1491.7)) : 0), 0);
      if (Math.abs(calc - s) > 10) continue;
      const p = best.get(e.pubkey);
      if (!p || s > p.s) best.set(e.pubkey, { s, name: String(tag(e, 'name') || 'anon').slice(0, 24) });
    }
    const rows = [...best.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 20);
    $('#tbl').innerHTML = '<tr><th>#</th><th>Player</th><th>Score</th></tr>' + rows.map((r, i) =>
      '<tr' + (acct && r[0] === acct.pub ? ' class="me"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(r[1].name) + '</td><td>' + r[1].s.toLocaleString() + '</td></tr>').join('');
    $('#boardNote').textContent = rows.length ? 'Scores are self-reported by players and only checked for consistency.' : 'No scores yet. Be the first.';
  } catch (e) { $('#boardNote').textContent = 'Could not reach the relays.'; }
}
setInterval(() => { if ($('#board').classList.contains('on')) loadBoard(); }, 20000);
renderAcct();

// =====================================================================
// SITE LAYER: config, languages, tabs, settings, streaks, share links, ads
// =====================================================================
const DEF_RELAYS = RELAYS.slice();
let TR = {}, EN = {}, lang = 'en', LANGS = [], ADS_ON = false;

// ---- Translations: t('key', {name: value}) falls back to English, then to the key ----
const t = (k, v) => String(TR[k] ?? EN[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v && v[x] !== undefined ? v[x] : '');
function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(e => { const k = e.dataset.i18n; if (TR[k] ?? EN[k]) e.textContent = t(k); });
  document.querySelectorAll('[data-i18n-ph]').forEach(e => { const k = e.dataset.i18nPh; if (TR[k] ?? EN[k]) e.placeholder = t(k); });
}
async function getJSON(u, d) { try { const r = await fetch(u); if (!r.ok) throw 0; return await r.json(); } catch (e) { return d; } }
async function setLang(c) {
  lang = c; TR = c === 'en' ? {} : await getJSON('lang/' + c + '.json', {});
  try { localStorage.setItem('wg_lang', c); } catch (e) {}
  document.documentElement.lang = c;
  document.documentElement.dir = (CFG.rtl || ['ar', 'he', 'fa', 'ur']).includes(c) ? 'rtl' : 'ltr';
  applyLang(); buildNav(); renderStreak();
}

// ---- Tiny Markdown renderer for pages/*.md and the footer (headings, lists, **bold**, [links](https://...)) ----
function md(s) {
  const e = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inl = x => e(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.split(/\n{2,}/).map(b => {
    b = b.trim(); let m;
    if ((m = b.match(/^(#{1,3})\s+(.*)$/))) return '<h' + m[1].length + '>' + inl(m[2]) + '</h' + m[1].length + '>';
    if (/^[-*]\s/.test(b)) return '<ul>' + b.split('\n').map(l => '<li>' + inl(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>';
    return b ? '<p>' + inl(b).replace(/\n/g, '<br>') + '</p>' : '';
  }).join('');
}

// ---- Navigation tabs (Play, Leaderboard, tabs from config.json, Settings) ----
const lbl = l => typeof l === 'object' ? (l[lang] || l.en || '') : l;
function mark(id) { document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.id === id)); }
function buildNav() {
  const items = [['play', t('nav.play'), () => route()], ['board', t('nav.board'), () => openBoard('mode:classic')], ['maps', t('nav.maps'), openMaps]];
  (CFG.tabs || []).forEach(x => items.push([x.id, lbl(x.label), () => showPage(x)]));
  items.push(['settings', t('nav.settings'), openSettings]);
  const n = $('#nav'); n.innerHTML = '';
  items.forEach(i => { const b = document.createElement('button'); b.textContent = i[1]; b.dataset.id = i[0]; b.onclick = () => { closeNav(); i[2](); mark(i[0]); }; n.appendChild(b); });
  mark('play');
}
$('#brand').onclick = ev => { ev.preventDefault(); closeNav(); route(); mark('play'); };
$('#quit').onclick = () => { clearInterval(timer); duelStop(); route(); mark('play'); };
async function showPage(x) {
  show('#page'); $('#pageBody').textContent = '…';
  try { const r = await fetch(x.file); if (!r.ok) throw 0; $('#pageBody').innerHTML = md(await r.text()); }
  catch (e) { $('#pageBody').textContent = t('page.err'); }
}

// ---- Settings: language, relays, clear data ----
function openSettings() {
  const s = $('#langSel'); s.innerHTML = ''; LANGS.forEach(l => s.add(new Option(l.name, l.code))); s.value = lang;
  $('#langRow').hidden = LANGS.length < 2; $('#relays').value = RELAYS.join('\n'); $('#setNote').textContent = ''; $('#rtcOn').checked = localStorage.getItem('wg_rtc') !== '0'; show('#settings');
}
$('#langSel').onchange = e => setLang(e.target.value);
$('#saveRelays').onclick = () => {
  const v = $('#relays').value.split('\n').map(x => x.trim()).filter(x => /^wss:\/\/\S+$/.test(x)).slice(0, 8);
  if (!v.length) { $('#setNote').textContent = t('set.badrelay'); return; }
  RELAYS = v; try { localStorage.setItem('wg_relays', JSON.stringify(v)); } catch (e) {}
  $('#setNote').textContent = t('set.saved');
};
$('#resetRelays').onclick = () => {
  try { localStorage.removeItem('wg_relays'); } catch (e) {}
  RELAYS = (CFG.relays && CFG.relays.length) ? CFG.relays : DEF_RELAYS; $('#relays').value = RELAYS.join('\n');
};
$('#wipe').onclick = () => {
  if (!confirm(t('set.wipe.confirm'))) return;
  Object.keys(localStorage).filter(k => k.startsWith('wg_')).forEach(k => localStorage.removeItem(k)); location.reload();
};

// ---- Daily streak: consecutive daily-challenge days. Saved locally, and rebuilt from your signed scores on Nostr when signed in ----
const iso = d => d.toISOString().slice(0, 10);
function dailyDates() { try { return JSON.parse(localStorage.getItem('wg_daily') || '[]'); } catch (e) { return []; } }
function saveDates(a) { try { localStorage.setItem('wg_daily', JSON.stringify([...new Set(a)].sort().slice(-400))); } catch (e) {} }
function streakOf(a) {
  const s = new Set(a); let d = new Date(today() + 'T00:00:00Z'), n = 0;
  if (!s.has(iso(d))) d = new Date(d - 864e5);          // today not played yet: streak still alive through yesterday
  while (s.has(iso(d))) { n++; d = new Date(d - 864e5); }
  return n;
}
function renderStreak() { const n = streakOf(dailyDates()); $('#streak').textContent = n ? t('streak', { n }) : t('streak.none'); }
function recordDaily() { if (!last.room.startsWith('daily-')) return; saveDates([...dailyDates(), last.room.slice(6)]); renderStreak(); }
async function syncStreak() {
  if (!acct) return;
  const evs = await query({ kinds: [KIND], authors: [acct.pub], '#t': ['worldguess'], limit: 200 });
  const ds = evs.map(e => ((e.tags.find(x => x[0] === 'b') || [])[1] || '')).filter(b => /^room:daily-\d{4}-\d{2}-\d{2}(~\w+)?$/.test(b)).map(b => b.slice(11, 21));
  if (ds.length) { saveDates([...dailyDates(), ...ds]); renderStreak(); }
}

// ---- Share links: #room=code&mode=timed  or  #daily=1 ----
async function share(room, mode, src) {
  const u = location.origin + location.pathname + '#' + (room ? 'room=' + encodeURIComponent(room) + '&mode=' + mode : 'daily=1') + '&src=' + src;
  try { if (navigator.share) { await navigator.share({ title: CFG.title || 'Worldguess', text: t('share.text'), url: u }); return; }
        await navigator.clipboard.writeText(u); alert(t('share.copied')); }
  catch (e) { prompt('', u); }
}
$('#invite').onclick = () => share($('#room').value.trim(), $('#mode').value, $('#src').value);
$('#share').onclick = () => last.map ? shareMap(last.map) : share(last.room.startsWith('daily-') ? '' : last.room, last.mode, last.src);
function handleHash() {
  const p = new URLSearchParams(location.hash.slice(1)), m = p.get('mode');
  if (m && MODES[m]) $('#mode').value = m;
  const sc = p.get('src'); if (['google', 'commons', 'pmx'].includes(sc)) $('#src').value = sc;
  const mp = (p.get('map') || '').split(':');
  if (/^[0-9a-f]{64}$/.test(mp[0]) && mp[1]) { fetchOneMap(mp[0], mp[1]).then(m => m && playMap(m)); return; }
  const dc = (p.get('duel') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  if (dc) { openDuel(); duelJoin(dc); return; }
  const r = (p.get('room') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (r) $('#room').value = r;
  if (p.get('daily') && (key || $('#src').value !== 'google')) start('daily-' + today());
}

// ---- AdSense: set "ads" in config.json. Each slot is filled once, only when its screen is shown ----
function initAds() {
  const a = CFG.ads; if (!a || !a.enabled || !a.client) return;
  ADS_ON = true; document.body.classList.add('ads');
  const s = document.createElement('script'); s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(a.client);
  document.head.appendChild(s);
}
function fillAds(sel) {
  if (!ADS_ON) return;
  document.querySelectorAll(sel + ' .ad[data-slot]').forEach(el => {
    const slot = (CFG.ads.slots || {})[el.dataset.slot]; if (!slot || el.dataset.f) return;
    el.dataset.f = 1;
    el.innerHTML = '<ins class="adsbygoogle" style="display:block;width:100%" data-ad-client="' + esc(CFG.ads.client) + '" data-ad-slot="' + esc(slot) + '" data-ad-format="auto" data-full-width-responsive="true"></ins>';
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  });
}

// ---- Boot: load config, then apply it ----
(async function init() {
  CFG = await getJSON('config.json', {});
  Object.entries(CFG.theme || {}).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  if (CFG.title) { document.title = CFG.title; $('#brandText').textContent = CFG.title; document.querySelectorAll('.gt').forEach(e => e.textContent = CFG.title); }
  if (CFG.favicon) $('#fav').href = CFG.favicon;
  if (CFG.banner) { $('#logo').src = CFG.banner; $('#logo').hidden = false; }
  if (CFG.showTitle === false) $('#brandText').hidden = true;
  $('#foot').innerHTML = md(CFG.footer || '');
  let rl = null; try { rl = JSON.parse(localStorage.getItem('wg_relays') || 'null'); } catch (e) {}
  RELAYS = rl && rl.length ? rl : (CFG.relays && CFG.relays.length ? CFG.relays : DEF_RELAYS);
  LANGS = await getJSON('lang/index.json', [{ code: 'en', name: 'English' }]);
  EN = await getJSON('lang/en.json', {});
  let saved = null; try { saved = localStorage.getItem('wg_lang'); } catch (e) {}
  saved = saved || (navigator.language || 'en').slice(0, 2);
  await setLang(LANGS.some(l => l.code === saved) ? saved : (CFG.defaultLang || 'en'));
  initAds(); fillAds('.screen.on'); renderStreak(); syncStreak(); handleHash();
})();

// =====================================================================
// COMMUNITY MAPS: a map is a signed Nostr event (kind 30731) holding a list of places.
// Votes are Nostr reactions (kind 7, "+" or "-"). Maps with a net score at or below config "mapHideBelow" (default -3) are hidden.
// =====================================================================
const MAPK = 30731, tg = (e, k) => (e.tags.find(x => x[0] === k) || [])[1];
let MAPS = [], EM = null, EMK = [];
const okLocs = a => Array.isArray(a) && a.length >= 5 && a.length <= 300 && a.every(p => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
const parseLocs = s => s.split('\n').map(l => l.trim().split(/[\s,;]+/).map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180).slice(0, 300);
function evToMap(e) {
  let c; try { c = JSON.parse(e.content); } catch (_) { return null; }
  if (!c || !okLocs(c.locs) || !tg(e, 'd')) return null;
  const d = tg(e, 'd');
  return { k: e.pubkey + ':' + d, pub: e.pubkey, d, id: e.pubkey.slice(0, 8) + '-' + d, name: String(tg(e, 'name') || 'Untitled').slice(0, 40), locs: c.locs, at: e.created_at, score: 0, mine: 0 };
}
async function fetchMaps() {
  const N = await nostr(), latest = new Map();
  for (const e of await query({ kinds: [MAPK], '#t': ['worldguess-map'], limit: 150 })) {
    if (!N.verifyEvent(e)) continue;
    const k = e.pubkey + ':' + tg(e, 'd'), p = latest.get(k);
    if (!p || e.created_at > p.created_at) latest.set(k, e);
  }
  const maps = [...latest.values()].map(evToMap).filter(Boolean), by = {};
  maps.forEach(m => by[MAPK + ':' + m.k] = m);
  const best = new Map();                                   // one vote per key: the newest wins
  for (const v of await query({ kinds: [7], '#a': Object.keys(by), limit: 1000 })) {
    if (!N.verifyEvent(v)) continue;
    const a = tg(v, 'a'), kk = a + '|' + v.pubkey, p = best.get(kk);
    if (by[a] && (!p || v.created_at > p.created_at)) best.set(kk, v);
  }
  for (const v of best.values()) {
    const m = by[tg(v, 'a')], s = v.content === '+' ? 1 : v.content === '-' ? -1 : 0;
    m.score += s; if (acct && v.pubkey === acct.pub) m.mine = s;
  }
  const hide = CFG.mapHideBelow ?? -3;
  return maps.filter(m => m.score > hide).sort((a, b) => b.score - a.score || b.at - a.at);
}
async function fetchOneMap(pub, d) {
  const N = await nostr(), e = (await query({ kinds: [MAPK], authors: [pub], '#d': [d], limit: 5 })).filter(x => N.verifyEvent(x)).sort((a, b) => b.created_at - a.created_at)[0];
  return e ? evToMap(e) : null;
}
function playMap(m) { last = { mode: $('#mode').value, room: '', src: $('#src').value, map: m }; play(); }
async function sendLink(u) {
  try { if (navigator.share) { await navigator.share({ title: CFG.title || 'Worldguess', text: t('share.text'), url: u }); return; } await navigator.clipboard.writeText(u); alert(t('share.copied')); }
  catch (e) { prompt('', u); }
}
const shareMap = m => sendLink(location.origin + location.pathname + '#map=' + m.pub + ':' + m.d + '&src=' + last.src + '&mode=' + last.mode);
async function vote(m, s) {
  if (!acct) { alert(t('maps.signin')); return; }
  if (m.mine === s) return;
  try {
    publish(await sign({ kind: 7, created_at: Math.floor(Date.now() / 1000), content: s > 0 ? '+' : '-', tags: [['a', MAPK + ':' + m.k], ['p', m.pub], ['t', 'worldguess']] }));
    m.score += s - m.mine; m.mine = s; renderMaps();
  } catch (e) { $('#mapNote').textContent = 'Could not send your vote.'; }
}
function renderMaps() {
  const box = $('#mapList'); box.innerHTML = '';
  MAPS.forEach((m, i) => {
    const c = document.createElement('div'); c.className = 'mapcard';
    const info = document.createElement('div'); info.className = 'info';
    const b = document.createElement('b'); b.textContent = m.name;
    const s = document.createElement('small'); s.textContent = m.locs.length + ' · ' + m.pub.slice(0, 8);
    info.append(b, document.createElement('br'), s);
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = (m.score > 0 ? '+' : '') + m.score;
    const mk = (a, txt, lab, on) => { const x = document.createElement('button'); x.className = 'ghost sm' + (on ? ' on' : ''); x.dataset.a = a; x.dataset.i = i; x.textContent = txt; x.setAttribute('aria-label', lab); return x; };
    c.append(info, mk('up', '▲', 'Upvote', m.mine > 0), sc, mk('dn', '▼', 'Downvote', m.mine < 0), mk('play', t('maps.play'), 'Play'), mk('share', t('btn.share'), 'Share'));
    box.appendChild(c);
  });
  $('#mapNote').textContent = MAPS.length ? '' : t('maps.empty');
}
$('#mapList').onclick = e => {
  const a = e.target.dataset.a, m = MAPS[+e.target.dataset.i]; if (!a || !m) return;
  if (a === 'up') vote(m, 1); else if (a === 'dn') vote(m, -1); else if (a === 'play') playMap(m); else shareMap(m);
};
async function openMaps() {
  show('#maps'); $('#mapNote').textContent = '…';
  try { MAPS = await fetchMaps(); renderMaps(); } catch (e) { $('#mapNote').textContent = 'Could not reach the relays.'; }
}
$('#mapRefresh').onclick = openMaps;

// ---- create a map: click the map or paste "lat, lng" lines ----
function drawEdit() {
  EMK.forEach(m => m.remove());
  EMK = parseLocs($('#mapLocs').value).map(p => window.L.circleMarker(p, { radius: 6, color: '#fff', weight: 1, fillColor: '#ffd60a', fillOpacity: 1 }).addTo(EM));
  $('#mapCount').textContent = EMK.length + ' / 300';
}
$('#mapNew').onclick = async () => {
  if (!acct) { alert(t('maps.signin')); return; }
  show('#mapEdit'); $('#mapEditNote').textContent = '';
  try { await loadLeaflet(); } catch (e) { $('#mapEditNote').textContent = e.message; return; }
  if (!EM) {
    const T = CFG.tiles || {};
    EM = window.L.map('editMap', { worldCopyJump: true }).setView([20, 0], 2);
    window.L.tileLayer(T.url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: T.attribution || '© OpenStreetMap contributors', maxZoom: 18 }).addTo(EM);
    EM.on('click', e => { const v = $('#mapLocs'); v.value = (v.value.trim() ? v.value.trim() + '\n' : '') + e.latlng.lat.toFixed(5) + ', ' + ((e.latlng.lng + 540) % 360 - 180).toFixed(5); drawEdit(); });
  }
  setTimeout(() => { EM.invalidateSize(); drawEdit(); }, 60);
};
$('#mapLocs').oninput = () => EM && drawEdit();
$('#mapCancel').onclick = openMaps;
$('#mapPub').onclick = async () => {
  const name = $('#mapName').value.trim().slice(0, 40), locs = parseLocs($('#mapLocs').value), n = $('#mapEditNote');
  if (!name || locs.length < 5) { n.textContent = t('maps.need'); return; }
  try {
    const d = Math.random().toString(36).slice(2, 8);
    publish(await sign({ kind: MAPK, created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ v: 1, locs: locs.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]) }),
      tags: [['d', d], ['t', 'worldguess-map'], ['name', name], ['n', String(locs.length)]] }));
    n.textContent = t('maps.posted'); $('#mapName').value = ''; $('#mapLocs').value = '';
  } catch (e) { n.textContent = 'Could not publish.'; }
};

// ---- Mobile menu: tabs collapse into a hamburger ----
function closeNav() { $('#top').classList.remove('open'); $('#burger').setAttribute('aria-expanded', 'false'); }
$('#burger').onclick = () => { const o = $('#top').classList.toggle('open'); $('#burger').setAttribute('aria-expanded', String(o)); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });

// =====================================================================
// DUELS (unranked): two players, same seeded places, 6000 health each.
// Messages travel as ephemeral Nostr events (kind 21731) signed with a throwaway key, and switch to a direct
// WebRTC data channel when one can be opened. Guesses use commit-then-reveal so nobody can copy the other's pin.
// =====================================================================
const DK = 21731, MULT = [1, 1, 1.5, 2, 2.5], HP0 = 6000;
let DU = null;
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const dstat = (k, v) => { $('#duelStatus').textContent = t(k, v); };
const myName = () => (acct && acct.name) || t('duel.player');
const scoreOf = (g, tg) => g ? Math.round(5000 * Math.exp(-km(g, tg) / 1491.7)) : 0;
// run fn now and every ms until it returns false (or n tries); used to resend messages that relays may drop
function every(fn, ms, n = 15) { const D = DU; let k = 0; const id = setInterval(() => { if (DU !== D || ++k >= n || fn() === false) clearInterval(id); }, ms); D.tm.push(id); fn(); }

async function duelOpen(code, host) {
  duelStop(true);
  const N = await nostr(), sk = N.generateSecretKey();
  const D = DU = { code, host, N, sk, pub: N.getPublicKey(sk), opp: null, oppName: '', hp: [HP0, HP0], c: { me: {}, op: {} }, rv: { me: {}, op: {} }, done: {},
    started: false, socks: [], tm: [], round: 0, cfg: { src: $('#src').value, mode: $('#mode').value }, pc: null, dc: null, rtc: null, offered: false };
  const since = Math.floor(Date.now() / 1000) - 10;
  RELAYS.forEach(u => { try {
    const w = new WebSocket(u); D.socks.push(w);
    w.onopen = () => w.send(JSON.stringify(['REQ', 'd' + Math.random().toString(36).slice(2, 8), { kinds: [DK], '#r': [code], since }]));
    w.onmessage = e => { try { const d = JSON.parse(e.data); if (DU === D && d[0] === 'EVENT' && d[2].pubkey !== D.pub && N.verifyEvent(d[2])) duelRecv(d[2]); } catch (_) {} };
  } catch (_) {} });
  if (localStorage.getItem('wg_rtc') !== '0') rtcSetup();
}
function dsend(m) {
  const D = DU; if (!D) return; const s = JSON.stringify(m);
  if (D.dc && D.dc.readyState === 'open') { D.dc.send(s); return; }
  const ev = D.N.finalizeEvent({ kind: DK, created_at: Math.floor(Date.now() / 1000), tags: [['r', D.code]], content: s }, D.sk);
  D.socks.forEach(w => { if (w.readyState === 1) w.send(JSON.stringify(['EVENT', ev])); });
}
// ---- WebRTC: signalling goes through the relays; STUN only (no TURN), so some mobile networks will fall back to relays ----
function rtcSetup() {
  const D = DU; if (!window.RTCPeerConnection) return;
  const pc = D.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const wire = c => { D.dc = c; c.onopen = () => dstat('duel.direct'); c.onmessage = e => { try { duelMsg(JSON.parse(e.data)); } catch (_) {} }; };
  if (D.host) wire(pc.createDataChannel('d')); else pc.ondatachannel = e => wire(e.channel);
  const gathered = () => new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); const f = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', f); r(); } }; pc.addEventListener('icegatheringstatechange', f); setTimeout(r, 4000); });
  D.rtc = {
    async offer() { await pc.setLocalDescription(await pc.createOffer()); await gathered(); dsend({ t: 'offer', s: pc.localDescription.sdp }); },
    async onOffer(s) { try { await pc.setRemoteDescription({ type: 'offer', sdp: s }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(); dsend({ t: 'answer', s: pc.localDescription.sdp }); } catch (_) {} },
    async onAnswer(s) { try { await pc.setRemoteDescription({ type: 'answer', sdp: s }); } catch (_) {} } };
}
// ---- handshake and round protocol ----
function duelRecv(ev) {
  let m; try { m = JSON.parse(ev.content); } catch (_) { return; }
  const D = DU;
  if (!D.opp) { if ((m.t === 'hello' && D.host) || (m.t === 'cfg' && !D.host)) D.opp = ev.pubkey; else return; }   // the first player to answer is the opponent
  if (ev.pubkey === D.opp) duelMsg(m);
}
function duelMsg(m) {
  const D = DU; if (!D) return;
  if (m.n) D.oppName = String(m.n).slice(0, 24);
  switch (m.t) {
    case 'hello': if (D.host && !D.started) { dsend({ t: 'cfg', n: myName(), ...D.cfg }); dstat('duel.connecting'); if (D.rtc && !D.offered) { D.offered = true; D.rtc.offer(); } } break;
    case 'cfg': if (!D.host && !D.started) { D.cfg = { src: m.src, mode: m.mode }; dstat('duel.connecting'); every(() => { if (D.started) return false; dsend({ t: 'ready', n: myName() }); }, 2000, 10); } break;
    case 'ready': if (D.host && !D.started) { every(() => { dsend({ t: 'go' }); }, 1500, 3); duelBegin(); } break;
    case 'go': duelBegin(); break;
    case 'offer': D.rtc && D.rtc.onOffer(m.s); break;
    case 'answer': D.rtc && D.rtc.onAnswer(m.s); break;
    case 'commit': D.c.op[m.r] = m.h; duelStep(m.r); break;
    case 'reveal': D.rv.op[m.r] = { g: m.g, k: m.k }; duelStep(m.r); break;
    case 'bye': if (D.started) duelFinish('left'); break;
  }
}
function duelBegin() {
  const D = DU; if (!D || D.started) return;
  D.started = true; D.tm.forEach(i => { clearInterval(i); clearTimeout(i); });
  last = { mode: D.cfg.mode, room: 'duel-' + D.code, src: D.cfg.src, map: null };   // the shared room code seeds identical places
  play();
}
async function duelSubmit() {
  const D = DU, r = round; done = true; clearInterval(timer); tLeft = 0; $('#guessBtn').disabled = true;
  const g = guess ? { lat: +guess.lat.toFixed(5), lng: +guess.lng.toFixed(5) } : null, k = Math.random().toString(36).slice(2);
  D.rv.me[r] = { g, k }; D.revealed = false;
  const h = await sha(JSON.stringify(g) + k); D.c.me[r] = h;
  $('#result').innerHTML = t('duel.wait'); $('#result').classList.add('on');
  every(() => { if (DU !== D || D.round !== r) return false; dsend({ t: 'commit', r, h }); }, 2500, 6);
  clearTimeout(D.fto); D.fto = setTimeout(() => { if (DU === D && !D.c.op[r]) duelFinish('gone'); }, 45000);   // opponent vanished
  duelStep(r);
}
async function duelStep(r) {
  const D = DU; if (!D || r !== D.round) return;
  if (D.c.me[r] && D.c.op[r] && !D.revealed) {
    D.revealed = true; const my = D.rv.me[r];
    every(() => { if (DU !== D || D.round !== r) return false; dsend({ t: 'reveal', r, g: my.g, k: my.k }); }, 2500, 4);
  }
  if (D.rv.me[r] && D.rv.op[r] && D.revealed && !D.done[r]) { D.done[r] = 1; await duelResolve(r); }
}
async function duelResolve(r) {
  const D = DU, o = D.rv.op[r], me = D.rv.me[r]; clearTimeout(D.fto);
  if (await sha(JSON.stringify(o.g) + o.k) !== D.c.op[r]) return duelFinish('cheat');   // the reveal must match the earlier commitment
  if (DU !== D) return;
  const pm = scoreOf(me.g, target), po = scoreOf(o.g, target), dmg = Math.round(Math.abs(pm - po) * (MULT[r - 1] || 1));
  if (pm > po) D.hp[1] = Math.max(0, D.hp[1] - dmg); else if (po > pm) D.hp[0] = Math.max(0, D.hp[0] - dmg);
  G.reveal(me.g, target); $('#guessbox').classList.add('big'); hud();
  const dist = g => g ? Math.round(km(g, target)).toLocaleString() : '–';
  $('#result').innerHTML = t('duel.res', { a: pm.toLocaleString(), ad: dist(me.g), n: esc(D.oppName || t('duel.opp')), b: po.toLocaleString(), bd: dist(o.g) }) + '<br>' +
    (pm > po ? t('duel.won', { d: dmg }) : po > pm ? t('duel.lost', { d: dmg }) : t('duel.tie'));
  setTimeout(() => { if (DU !== D) return; if (D.hp[0] <= 0 || D.hp[1] <= 0 || r >= ROUNDS) duelFinish(); else nextRound().catch(e => msg(e.message)); }, 6500);
}
function duelFinish(why) {
  const D = DU; if (!D) return; const [a, b] = D.hp;
  const res = why === 'left' || why === 'gone' ? 'w' : why === 'cheat' ? 'x' : a > b ? 'w' : a < b ? 'l' : 'd';
  duelStop(); clearInterval(timer);
  $('#finalScore').textContent = t({ w: 'duel.win', l: 'duel.lose', d: 'duel.draw', x: 'duel.cheat' }[res]);
  $('#finalNote').textContent = t('duel.final', { a: Math.round(a), b: Math.round(b) }); $('#postNote').textContent = '';
  ['#share', '#again', '#toBoard'].forEach(s => $(s).hidden = true); show('#end');
}
function duelStop(silent) {
  const D = DU; if (!D) return;
  if (!silent && D.opp) dsend({ t: 'bye' });
  D.tm.forEach(i => { clearInterval(i); clearTimeout(i); }); clearTimeout(D.fto);
  setTimeout(() => { D.socks.forEach(w => { try { w.close(); } catch (_) {} }); if (D.pc) D.pc.close(); }, 500);   // let 'bye' flush first
  DU = null;
}
// ---- lobby ----
function openDuel() { show('#duel'); dstat('duel.idle'); $('#duelShare').hidden = true; }
async function duelJoin(code) {
  code = (code || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12); if (!code) return;
  $('#duelCode').value = code;
  try { await duelOpen(code, false); } catch (e) { $('#duelStatus').textContent = e.message; return; }
  dstat('duel.joining'); const D = DU;
  setTimeout(() => { if (DU === D) every(() => { if (D.opp) return false; dsend({ t: 'hello', n: myName() }); }, 2000, 15); }, 700);
}
$('#duelBtn').onclick = () => { openDuel(); mark('play'); };
$('#duelCreate').onclick = async () => {
  const code = Math.random().toString(36).slice(2, 8); $('#duelCode').value = code;
  try { await duelOpen(code, true); dstat('duel.wait2', { c: code }); $('#duelShare').hidden = false; } catch (e) { $('#duelStatus').textContent = e.message; }
};
$('#duelJoin').onclick = () => duelJoin($('#duelCode').value);
$('#duelShare').onclick = () => DU && sendLink(location.origin + location.pathname + '#duel=' + DU.code + '&src=' + DU.cfg.src + '&mode=' + DU.cfg.mode);
$('#duelCancel').onclick = () => { duelStop(); route(); };
$('#rtcOn').onchange = e => { try { localStorage.setItem('wg_rtc', e.target.checked ? '1' : '0'); } catch (_) {} };

route();
