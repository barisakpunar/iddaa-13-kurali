// ==UserScript==
// @name         iddaa 13 Kuralı - Canlı Basketbol Barem Uyarısı
// @namespace    iddaa-13-kurali
// @version      3.4
// @description  Canlı basketbol "Toplam Sayı Alt/Üst": canlı uç barem, referans uç baremden (maç öncesi / 5. dk / 1. çeyrek sonu) FARK kadar sapınca sanal kupon (Ters) + maç öncesi için Telegram uyarısı.
// @match        https://www.iddaa.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/barisakpunar/iddaa-13-kurali/main/iddaa-13-kurali.user.js
// @downloadURL  https://raw.githubusercontent.com/barisakpunar/iddaa-13-kurali/main/iddaa-13-kurali.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ================== AYARLAR ==================
  const AYAR = {
    // Telegram bot token ve chat ID kodda DEĞİL, paneldeki "Telegram" düğmesinden girilir ve bu tarayıcıda saklanır
    // (kod herkese açık depoda duruyor ve her güncellemede üzerine yazılıyor).
    FARK: 15,                  // canlı uç barem, maç öncesi uç baremden bu kadar saparsa uyarı + sanal bahis
                               // (paneldeki "Fark eşiği" kutusundan girilen değer bunun yerine geçer)
    SANAL_TUTAR: 1000,         // her sanal bahis (TL)
    // ---- referanslar: fark bu noktalardaki uç baremlere göre AYRI AYRI ölçülür, her biri kendi sanal kuponunu açar ----
    //   pre = maç öncesi son görüntü · dk5 = 5:00 oynandığında canlı · c1 = 1. çeyrek bittiğinde canlı
    REFERANSLAR: ['pre', 'dk5', 'c1'],
    UYARI_REFERANSLAR: ['pre'],  // Telegram'a sadece bunlar gider; diğerleri sessizce sanal kupona yazılır
    REF_TOLERANS_SN: 180,        // dk5 / c1 anı bu kadar oyun saniyesi geçtikten sonra görülürse (script geç açıldı vb.) o maçta atlanır
    CANLI_KONTROL_SN: 15,      // canlı liste kontrolü (WebSocket'e ek, yedek)
    MAC_ONCESI_KONTROL_SN: 60, // maç öncesi baremlerin kaydı
    PRE_DETAY_DK: 30,          // başlamaya bu kadar dk kala bütün maç öncesi baremleri (en alt / en üst) her taramada çek
    OTOMATIK_YENILE_SAAT: 6,   // sayfa bu kadar saatte bir yenilenir (canlı maç yokken); 0 = kapalı
    // ---- uzaktan kontrol (yönetici) ----
    // Bu adresteki JSON dosyasını düzenleyerek script'i uzaktan durdurabilir, eşiği/tutarı değiştirebilir, not gönderebilirsiniz.
    // Yönetici dosyasının adresi (GitHub deposu). Boş bırakılırsa uzaktan kontrol kapalıdır.
    KONTROL_URL: 'https://raw.githubusercontent.com/barisakpunar/iddaa-13-kurali/main/kontrol.json',
    KONTROL_SN: 120,           // yönetici dosyası kaç saniyede bir okunur
    TELEGRAM_TOKEN: '',        // (isteğe bağlı) buraya yazılırsa paneldeki değerin yerine geçer
    TELEGRAM_CHAT_ID: '',
  };
  // =============================================

  if (window.top !== window || window.__iddaa13) return;
  window.__iddaa13 = true;

  const VERSIYON = '3.4';
  const API = 'https://sportsbookv2.iddaa.com/sportsbook';
  const SR = 'https://stats.fn.sportradar.com/sansgirisimnew/tr/Europe:Istanbul/gismo'; // iddaa'nın kullandığı Sportradar verisi
  const WS_ORAN = 'wss://sportsbooksocket.iddaa.com/sportsBookHubLite';  // currentOdds / currentEvents
  const WS_SKOR = 'wss://sportsbooksocket.iddaa.com/sportsBookHub';      // currentScore
  const RS = '\x1e';                 // SignalR kayıt ayırıcı
  const SPOR = 2;                    // basketbol
  const PRE = { t: 2, st: 114 };     // Toplam Sayı Alt/Üst (Uzt.Dahil) - maç öncesi
  const LIVE = { t: 4, st: 140 };    // Toplam Sayı Alt/Üst (Uzt.Dahil) - canlı
  const KEY = 'iddaa13_v1';
  const FARK_KEY = 'iddaa13_fark';
  const REF_AD = { pre: 'Maç öncesi', dk5: '5. dk', c1: '1. çeyrek' };
  const log = (...a) => console.log('%c[13 Kuralı]', 'color:#e67e22;font-weight:bold', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const VARSAYILAN_FARK = AYAR.FARK;
  try { const f = parseFloat(localStorage.getItem(FARK_KEY)); if (f > 0) AYAR.FARK = f; } catch (e) { /* */ }
  const TG_TOKEN_KEY = 'iddaa13_tg_token', TG_CHAT_KEY = 'iddaa13_tg_chat';
  const lsOku = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const tgToken = () => AYAR.TELEGRAM_TOKEN || lsOku(TG_TOKEN_KEY);
  const tgChat = () => AYAR.TELEGRAM_CHAT_ID || lsOku(TG_CHAT_KEY);

  // ---------- kayıt ----------
  let db = yukle();
  let skorlar = {};                  // son canlı listedeki skorlar (data.sc)
  const durum = { ws: 'kapalı', wsSkor: 'kapalı', sonVeri: 0, detayIstek: 0, srIstek: 0, basladi: Date.now() };

  function yukle() {
    try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.mac) return d; } catch (e) { /* */ }
    return { mac: {}, uyarilar: [] };
  }
  let kirli = false;
  const kaydetIste = () => { kirli = true; };              // sık değişiklikler: 3 sn'de bir toplu kayıt
  function kaydet() {                                      // önemli anlar (uyarı, bahis, sonuç): hemen kayıt
    kirli = false;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { log('Kayıt hatası (depolama dolu olabilir):', e.message); }
  }
  // Eski kayıtları temizle: bahis olmayan bitmiş/eski maçlar silinir; bahisli maçların sadece özeti kalır
  function bakim() {
    const simdi = Date.now() / 1000;
    for (const [id, k] of Object.entries(db.mac)) {
      const bahisli = k.sanal && Object.keys(k.sanal).length > 0;
      const eski = (k.d || 0) < simdi - 2 * 86400;
      const canliyaGecmedi = !k.canliBasladi && k.d && k.d < simdi - 3 * 3600;     // iddaa canlı bahis açmadı
      const bitenEski = k.bitti && k.bitisZaman < Date.now() - 86400e3;
      if (!bahisli && (eski || canliyaGecmedi || bitenEski)) { delete db.mac[id]; continue; }
      if (bahisli && k.bitti && k.sanalZaman && k.bitisZaman < Date.now() - 86400e3) {
        for (const alan of ['canliGecmis', 'preGecmis', 'canliBaremler', 'saat', 'sr', 'uyariE']) delete k[alan];
      }
    }
    if (db.uyarilar && db.uyarilar.length > 200) db.uyarilar.length = 200;
  }

  // ---------- yardımcılar ----------
  // Zaman aşımlı istek: cevap gelmeyen istek script'i kilitlemesin
  async function getir(url, ms = 8000) {
    const ctrl = new AbortController();
    const zaman = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } finally { clearTimeout(zaman); }
  }
  const getJSON = async (url) => (await getir(url)).data;

  // Açık baremler küçükten büyüğe: [{ sov, alt, ust, mbc }]  (o[].no: 1=Alt, 2=Üst)
  function baremler(markets, tip) {
    return (markets || [])
      .filter(m => m.t === tip.t && m.st === tip.st && m.s === 1 && m.sov != null && !isNaN(parseFloat(m.sov)))
      .map(m => {
        const o = m.o || [];
        const oran = (no, i) => { const x = o.find(y => y.no === no) || o[i]; return x ? x.odd : null; };
        return { sov: parseFloat(m.sov), alt: oran(1, 0), ust: oran(2, 1), mbc: m.mbc };
      })
      .sort((a, b) => a.sov - b.sov);
  }
  // Ana barem: Alt/Üst oranları birbirine en yakın olan
  function anaBarem(list) {
    if (!list.length) return null;
    let best = list[0], bestFark = Infinity;
    for (const b of list) {
      const f = b.alt != null && b.ust != null ? Math.abs(b.alt - b.ust) : 50;
      if (f < bestFark) { bestFark = f; best = b; }
    }
    return best.sov;
  }
  const macLinki = (id) => `https://www.iddaa.com/program/canli/basketbol?d=${id}`;
  const oranYazi = (x) => (x == null ? '-' : Number(x).toFixed(2));
  const isaretli = (x) => (x == null ? '-' : (x > 0 ? '+' : '') + x);
  const canliMi = (e) => e.s === 1 || (e.m || []).some(m => m.t === 4);
  function gecmisEkle(k, alan, deger, max = 200) {
    const g = k[alan] || (k[alan] = []);
    const son = g[g.length - 1];
    if (!son || son[1] !== deger) { g.push([Date.now(), deger]); if (g.length > max) g.shift(); }
  }

  const tokenVar = () => /^\d+:[\w-]{20,}$/.test(tgToken()) && /^-?\d+$/.test(String(tgChat()));

  async function telegram(text, link) {
    if (!tokenVar()) { log('Telegram ayarlı değil, mesaj sadece konsolda:\n' + text); return false; }
    const ctrl = new AbortController();
    const zaman = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgToken()}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify(Object.assign(
          { chat_id: tgChat(), text, disable_web_page_preview: true },
          link ? { reply_markup: { inline_keyboard: [[{ text: "iddaa'da aç", url: link }]] } } : {}
        )),
      });
      const j = await r.json();
      if (!j.ok) log('Telegram hatası:', j.description);
      return j.ok;
    } catch (e) { log('Telegram gönderilemedi:', e.message); return false; }
    finally { clearTimeout(zaman); }
  }

  // Arka plan sekmesinde ana thread zamanlayıcıları kısılıyor; worker zamanlayıcıları kısılmıyor
  function zamanlayici(ms, fn) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)}, ${ms});`], { type: 'text/javascript' })));
      w.onmessage = fn;
      return;
    } catch (e) { /* */ }
    setInterval(fn, ms);
  }

  // ---------- uzaktan kontrol (yönetici) ----------
  // KONTROL_URL'deki JSON: { "aktif": true, "fark": 15, "tutar": 1000, "mesaj": "" }
  //   aktif:false → uyarı ve sanal bahis durur (yönetici tekrar true yapınca devam eder)
  //   fark / tutar → verilirse paneldeki değerin yerine geçer; boş/null bırakılırsa yerel ayar geçerli
  //   mesaj → değiştiğinde bir kez Telegram'a "Yönetici notu" olarak gönderilir
  // Bu dosya sadece OKUNUR; script yöneticiye hiçbir veri göndermez.
  let durduruldu = false, uzakFark = null;
  const KONTROL_ACIK = /^https:\/\//.test(AYAR.KONTROL_URL || '') && !AYAR.KONTROL_URL.includes('KULLANICI' + '/'); // yer tutucu duruyorsa kapalı
  async function kontrolCek() {
    if (!KONTROL_ACIK) { durum.kontrol = 'kapalı'; return; }
    try {
      const c = await getir(`${AYAR.KONTROL_URL}?c=${Date.now()}`, 8000);
      const onceki = durduruldu;
      durduruldu = c.aktif === false;
      uzakFark = c.fark > 0 ? +c.fark : null;
      if (uzakFark) AYAR.FARK = uzakFark;
      else { const f = parseFloat(lsOku(FARK_KEY)); AYAR.FARK = f > 0 ? f : VARSAYILAN_FARK; }
      if (c.tutar > 0) AYAR.SANAL_TUTAR = +c.tutar;
      if (c.mesaj && c.mesaj !== lsOku('iddaa13_admin_mesaj')) {
        try { localStorage.setItem('iddaa13_admin_mesaj', c.mesaj); } catch (e) { /* */ }
        telegram(`Yönetici notu: ${c.mesaj}`);
      }
      if (onceki !== durduruldu) log(durduruldu ? 'Yönetici script\'i durdurdu.' : 'Yönetici script\'i yeniden başlattı.');
      durum.kontrol = durduruldu ? 'DURDURULDU' : 'aktif';
      durum.kontrolZaman = Date.now();
    } catch (e) { durum.kontrol = 'ulaşılamadı (son ayarla devam)'; }
    cizIste();
  }

  // ---------- lig adları ----------
  let ligler = {};
  async function ligleriYukle() {
    try {
      for (const c of (await getJSON(`${API}/competitions`)) || []) if (String(c.si) === String(SPOR)) ligler[c.i] = c.n || c.sn;
    } catch (e) { /* lig adı olmadan da çalışır */ }
  }

  // ---------- skor ve oyun saati ----------
  // iddaa sc: { s, ht:{ r, qs:[...] }, at:{ r }, min, sec }  r = uzatmalar dahil sayı, min:sec = çeyrekte KALAN süre.
  // WebSocket skor mesajları sadece değişen alanları taşır → eksik taraf kayıttan tamamlanır.
  function skorGuncelle(k, sc, parcali) {
    if (!sc) return;
    if (sc.ht && Array.isArray(sc.ht.qs) && sc.ht.qs.length) k.ceyrekNo = sc.ht.qs.length;
    if (typeof sc.min === 'number' && typeof sc.sec === 'number') {
      const kalan = sc.min * 60 + sc.sec;
      k.maxKalan = Math.max(k.maxKalan || 0, kalan);
      k.saat = { ceyrek: k.ceyrekNo, kalan, t: Date.now() };
    } else if (k.saat && k.ceyrekNo) k.saat.ceyrek = k.ceyrekNo;
    const h = sc.ht && typeof sc.ht.r === 'number' ? sc.ht.r : (parcali ? k.skorH : undefined);
    const a = sc.at && typeof sc.at.r === 'number' ? sc.at.r : (parcali ? k.skorA : undefined);
    if (typeof h !== 'number' || typeof a !== 'number') return;
    k.skorH = h; k.skorA = a; k.toplam = h + a; k.skor = `${h}-${a}`; k.skorZaman = Date.now();
  }

  // Sportradar maç bilgisi: skoru iddaa'da olmayan liglerde canlı skor/saat, bitince kesin sonuç
  async function srCek(k) {
    if (!k.bri) return null;
    durum.srIstek++;
    const j = await getir(`${SR}/match_info/${k.bri}`, 6000);
    const m = j && j.doc && j.doc[0] && j.doc[0].data && j.doc[0].data.match;
    if (!m) return null;
    const ti = m.timeinfo || {};
    k.sr = {
      t: Date.now(),
      home: m.result ? m.result.home : null, away: m.result ? m.result.away : null,
      bitti: m.matchstatus === 'result' || !!m.ended_uts || (m.status && m.status._id === 100),
      iptal: !!(m.cancelled || m.postponed || m.walkover),
      durum: m.status ? m.status.name : '',
      oynanan: ti.played != null ? +ti.played : null, kalan: ti.remaining != null ? +ti.remaining : null,
      perDk: m.periodlength || null, perSayi: m.numberofperiods || null, uzDk: m.overtimelength || null,
    };
    // iddaa skoru yoksa / eskiyse Sportradar skorunu kullan
    if (typeof k.sr.home === 'number' && typeof k.sr.away === 'number' && (!k.skorZaman || Date.now() - k.skorZaman > 60000)) {
      k.skorH = k.sr.home; k.skorA = k.sr.away; k.toplam = k.sr.home + k.sr.away; k.skor = `${k.sr.home}-${k.sr.away}`;
    }
    return k.sr;
  }

  // Maç numarası (bri) bilinmiyorsa Sportradar günlük listesinden takım adı + saatle bul
  const srGunCache = {};
  const kelimeler = (s) => String(s || '').replace(/İ/g, 'i').replace(/ı/g, 'i').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !['basket', 'basketball', 'club', 'the'].includes(w));
  const ortak = (a, b) => { const B = new Set(kelimeler(b)); return kelimeler(a).filter(w => B.has(w)).length; };
  async function srBul(k) {
    if (!k.d) return false;
    const gunler = [0, -1].map(g => new Date((k.d + g * 86400) * 1000 + 3 * 3600e3).toISOString().slice(0, 10)); // İstanbul tarihi
    for (const gun of gunler) {
      let ms = srGunCache[gun] && Date.now() - srGunCache[gun].t < 600e3 ? srGunCache[gun].ms : null;
      if (!ms) {
        const j = await getir(`${SR}/sport_matches/${SPOR}/${gun}/1`, 15000);
        ms = [];
        const gez = (x) => { if (!x || typeof x !== 'object') return; if (x._doc === 'match' && x.teams) { ms.push(x); return; } for (const v of Object.values(x)) gez(v); };
        gez(j && j.doc && j.doc[0] && j.doc[0].data);
        srGunCache[gun] = { t: Date.now(), ms };
      }
      const aday = ms.find(m => m.teams.home && m.teams.away && ortak(k.hn, m.teams.home.name) > 0 && ortak(k.an, m.teams.away.name) > 0
        && (!m._dt || Math.abs(m._dt.uts - k.d) < 3 * 3600));
      if (aday) { k.bri = aday._id; return true; }
    }
    return false;
  }

  function periyotSn(k) {
    if (k.sr && k.sr.perDk) return k.sr.perDk * 60;
    const lig = k.lig || '';
    let p = /NCAA/i.test(lig) ? 1200 : (/(^|[^W])NBA\b/i.test(lig) && !/NEXTGEN/i.test(lig) ? 720 : 600);
    if (k.maxKalan > p) p = k.maxKalan > 720 ? 1200 : 720;
    return p;
  }
  // Oyunun kaçıncı dakikası: iddaa saati (çeyrekte kalan) varsa o, yoksa Sportradar "oynanan süre"
  function oyunZamani(k) {
    const per = periyotSn(k);
    const n = (k.sr && k.sr.perSayi) || (per === 1200 ? 2 : 4);
    const uz = ((k.sr && k.sr.uzDk) || 5) * 60;
    let ceyrek, kalan, t;
    if (k.saat && k.saat.ceyrek && k.saat.kalan != null && (!k.sr || k.saat.t >= k.sr.t - 60000)) {
      ceyrek = k.saat.ceyrek; kalan = Math.min(k.saat.kalan, ceyrek > n ? uz : per); t = k.saat.t;
    } else if (k.sr && k.sr.oynanan != null) {
      const p = k.sr.oynanan;
      ceyrek = p < n * per ? Math.floor(p / per) + 1 : n + 1 + Math.floor((p - n * per) / uz);
      kalan = k.sr.kalan != null ? k.sr.kalan : (ceyrek <= n ? ceyrek * per - p : uz - ((p - n * per) % uz));
      t = k.sr.t;
    } else return null;
    const gecen = ceyrek <= n ? (ceyrek - 1) * per + (per - kalan) : n * per + (ceyrek - n - 1) * uz + (uz - kalan);
    const dk = Math.floor(gecen / 60) + 1;                       // 15:00–15:59 = 16. dakika
    const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const ad = ceyrek > n ? `${ceyrek - n}. uzatma` : `${ceyrek}. ${n === 2 ? 'devre' : 'çeyrek'}`;
    const yas = Math.round((Date.now() - t) / 1000);
    return { dk, ceyrek, kalan: mmss(kalan), gecen: mmss(gecen), gecenSn: gecen, perSn: per, n, yazi: `${dk}' (${ad}, ${mmss(kalan)} kala${yas > 20 ? `, ${yas} sn önceki saat` : ''})` };
  }

  // ---------- referanslar ----------
  // Referansın en alt / en üst baremi → { alt, ust } ya da null (henüz yok / kaçırıldı)
  function refDeger(k, r) {
    if (r === 'pre') return k.pre == null ? null : { alt: k.preAlt ?? k.pre, ust: k.preUst ?? k.pre };
    const x = k.ref && k.ref[r];
    return x && !x.kacti ? x : null;
  }
  // Canlı referanslar: oyun süresi hedefe ilk ulaştığında o anki canlı en alt / en üst barem sabitlenir.
  //   dk5 = 5:00 oynandı · c1 = 1. çeyrek bitti (devre usulü liglerde 1. devrenin yarısı)
  // Sadece detay objesinden (bütün baremler) yakalanır; liste objesiyle hedefe gelinmişse detay istenir.
  // Saat bilinmiyorsa yakalanmaz. Hedef REF_TOLERANS_SN'den geç görülürse "kacti" işaretlenir ve o maçta o referans atlanır.
  function refYakala(id, k, enAlt, enUst, detay, kaynak) {
    const oz = oyunZamani(k);
    if (!oz) return;
    const ref = k.ref || (k.ref = {});
    const hedef = { dk5: 300, c1: oz.n === 2 ? oz.perSn / 2 : oz.perSn };
    for (const r of AYAR.REFERANSLAR) {
      if (!(r in hedef) || ref[r] || oz.gecenSn < hedef[r]) continue;
      const gec = oz.gecenSn - hedef[r] > AYAR.REF_TOLERANS_SN;
      if (!gec && !detay) { detayCek(id, kaynak); continue; }
      ref[r] = gec ? { kacti: true, t: Date.now(), dk: oz.dk, gecen: oz.gecen }
        : { alt: enAlt.sov, ust: enUst.sov, t: Date.now(), dk: oz.dk, gecen: oz.gecen };
      kaydet();
    }
  }

  // ---------- çekirdek: maç objesini (liste veya detay) değerlendir ----------
  function isle(e, kaynak, detay) {
    if (durduruldu || !e || e.i == null) return;
    const k = db.mac[e.i] || (db.mac[e.i] = {});
    if (e.hn) k.hn = e.hn;
    if (e.an) k.an = e.an;
    if (e.d) k.d = e.d;
    if (e.bri) k.bri = e.bri;
    if (e.ci) { k.ci = e.ci; if (ligler[e.ci]) k.lig = ligler[e.ci]; }

    if (!canliMi(e)) {                                           // ----- maç öncesi
      if (k.canliBasladi) return;
      const list = baremler(e.m, PRE);
      const ana = anaBarem(list);
      if (ana == null) return;
      k.pre = ana; k.preZaman = Date.now();
      gecmisEkle(k, 'preGecmis', ana, 50);
      if (detay) { k.preAlt = list[0].sov; k.preUst = list[list.length - 1].sov; k.preAralikZaman = Date.now(); }
      else if (k.preAlt == null || ana < k.preAlt || ana > k.preUst) k.preAlt = k.preUst = ana; // liste sadece ana baremi verir
      kaydetIste();
      return;
    }

    k.canliBasladi = true;                                       // ----- canlı
    if (skorlar[e.i]) skorGuncelle(k, skorlar[e.i]);
    const list = baremler(e.m, LIVE);
    if (!list.length) { k.canli = null; k.canliBaremler = []; kaydetIste(); return; }   // barem kapalı/askıda
    const enAlt = list[0], enUst = list[list.length - 1];
    k.canli = anaBarem(list); k.canliZaman = Date.now();
    k.canliBaremler = list;
    k.aralik = [enAlt.sov, enUst.sov];
    gecmisEkle(k, 'canliGecmis', `${enAlt.sov}–${enUst.sov}`);
    durum.sonVeri = Date.now();
    refYakala(e.i, k, enAlt, enUst, detay, kaynak);

    // Her referans için: canlı EN ÜST − referans EN ÜST (yukarı) / canlı EN ALT − referans EN ALT (aşağı)
    const ue = k.uyariE || (k.uyariE = {});
    const sk = k.sanal || (k.sanal = {});
    const rf = k.refFark || (k.refFark = {});
    for (const r of AYAR.REFERANSLAR) {
      const ref = refDeger(k, r);
      if (!ref) continue;                                        // referans henüz yok
      const eski = rf[r] || (r === 'pre' ? { maxUst: k.maxUst, minAlt: k.minAlt } : {});
      const f = { ust: +(enUst.sov - ref.ust).toFixed(1), alt: +(enAlt.sov - ref.alt).toFixed(1) };
      f.maxUst = Math.max(eski.maxUst ?? -Infinity, f.ust);
      f.minAlt = Math.min(eski.minAlt ?? Infinity, f.alt);
      rf[r] = f;
      if (r === 'pre') { k.farkUst = f.ust; k.farkAlt = f.alt; k.maxUst = f.maxUst; k.minAlt = f.minAlt; } // panel bunları okur
      const uyariAcik = AYAR.UYARI_REFERANSLAR.includes(r);

      for (const yon of ['ust', 'alt']) {
        const sapma = yon === 'ust' ? f.ust : -f.alt;           // ilgili yöndeki sapma (pozitif)
        if (!(sapma >= AYAR.FARK)) continue;
        const anahtar = r === 'pre' ? `${AYAR.FARK}_${yon}` : `${r}_${AYAR.FARK}_${yon}`; // pre: eski anahtar biçimi korunur
        if (sk[anahtar] && (ue[anahtar] || !uyariAcik)) continue;
        const b = yon === 'ust' ? enUst : enAlt;
        const karsi = yon === 'ust' ? ref.ust : ref.alt;         // karşılaştırılan referans barem
        const oz = oyunZamani(k);
        // Ters bahis: barem yukarı kaçtı → en üst baremde ALT; aşağı kaçtı → en alt baremde ÜST
        const bahis = yon === 'ust'
          ? { taraf: 'alt', sov: enUst.sov, oran: enUst.alt, mbc: enUst.mbc }
          : { taraf: 'ust', sov: enAlt.sov, oran: enAlt.ust, mbc: enAlt.mbc };

        if (!sk[anahtar]) {
          sk[anahtar] = {
            t: Date.now(), referans: r, refAlt: ref.alt, refUst: ref.ust, refGecen: r === 'pre' ? '' : ref.gecen,
            esik: AYAR.FARK, yon, pre: k.pre, preAlt: k.preAlt ?? k.pre, preUst: k.preUst ?? k.pre, preRef: karsi, fark: sapma,
            skor: k.skor || '', lig: k.lig || '', kaynak, baremler: list,
            dk: oz ? oz.dk : null, dkYazi: oz ? oz.yazi : '', gecen: oz ? oz.gecen : '', ceyrek: oz ? oz.ceyrek : null, ceyrekKalan: oz ? oz.kalan : '',
            ters: bahis,
          };
        }
        if (uyariAcik && !ue[anahtar]) {
          ue[anahtar] = { t: Date.now() };
          const link = macLinki(e.i);
          const enAd = yon === 'ust' ? 'üst' : 'alt';
          const refAd = r === 'pre' ? 'maç öncesi' : `${REF_AD[r]} (${ref.gecen})`;
          const msg =
            `13 KURALI · ±${AYAR.FARK} (${yon === 'ust' ? 'barem YUKARI' : 'barem AŞAĞI'})${r === 'pre' ? '' : ` · referans ${REF_AD[r]}`}\n` +
            `${k.hn} - ${k.an}${k.lig ? `\n${k.lig}` : ''}\n` +
            `Maç dakikası: ${oz ? oz.yazi : 'bilinmiyor'}\n` +
            (r === 'pre' ? `Maç öncesi baremler: ${ref.alt}–${ref.ust} (ana ${k.pre})\n` : `${REF_AD[r]} baremleri (${ref.gecen} oynandığında): ${ref.alt}–${ref.ust}\n`) +
            `Canlı en ${enAd} barem: ${b.sov} → ${refAd} en ${enAd} ${karsi}'e göre ${isaretli(+(b.sov - karsi).toFixed(1))}\n` +
            `>> TERS BAHİS: ${bahis.taraf === 'ust' ? 'ÜST' : 'ALT'} ${bahis.sov} @${oranYazi(bahis.oran)}${bahis.mbc > 1 ? ` (MBS ${bahis.mbc}, tek oynanmaz!)` : ''}\n` +
            `Açık canlı baremler:\n${list.map(x => `  ${x.sov}  Alt ${oranYazi(x.alt)} / Üst ${oranYazi(x.ust)}`).join('\n')}\n` +
            (k.skor ? `Skor: ${k.skor}\n` : '') +
            `Kaynak: ${kaynak}\n` + link;
          log(msg);
          telegram(msg, link);
          (db.uyarilar || (db.uyarilar = [])).unshift({
            t: Date.now(), id: e.i, mac: `${k.hn} - ${k.an}`, referans: r, esik: AYAR.FARK, yon, preRef: karsi, canli: b.sov,
            fark: +(b.sov - karsi).toFixed(1), skor: k.skor || '', dk: oz ? oz.dk : null, kaynak,
          });
        }
        kaydet();
      }
    }
    kaydetIste();
  }

  // ---------- sanal kupon sonuçlandırma ----------
  function sonuclandir(k, toplam, kaynak) {
    for (const b of Object.values(k.sanal || {})) {
      const x = b.ters;
      if (!x || x.oran == null) continue;
      const kazandi = x.taraf === 'ust' ? toplam > x.sov : toplam < x.sov;
      x.sonuc = kazandi ? 'K' : 'Y';
      x.net = kazandi ? +(AYAR.SANAL_TUTAR * (x.oran - 1)).toFixed(2) : -AYAR.SANAL_TUTAR;
      x.yakin = kaynak !== 'Sportradar' && kaynak !== 'elle' && Math.abs(toplam - x.sov) <= 3;  // kontrol edilmeli
    }
    k.sanalToplam = toplam; k.sonucKaynak = kaynak; k.sanalZaman = Date.now();
    log(`Sonuç: ${k.hn} - ${k.an} toplam ${toplam} (${kaynak})`);
    kaydet();
  }
  // Bitmiş, bahisli ve sonuçlanmamış maç: önce Sportradar kesin sonucu, 45 dk içinde gelmezse son görülen skor
  const sonucDeneme = {};
  async function sonucAra(id, k) {
    if (sonucDeneme[id] && Date.now() - sonucDeneme[id] < 30000) return;
    sonucDeneme[id] = Date.now();
    try {
      if (!k.bri) await srBul(k);
      const sr = await srCek(k);
      if (sr && sr.iptal) { k.sonucKaynak = 'iptal/ertelendi'; k.sanalZaman = Date.now(); kaydet(); return; }
      if (sr && sr.bitti && typeof sr.home === 'number') return sonuclandir(k, sr.home + sr.away, 'Sportradar');
    } catch (e) { /* bir sonraki turda tekrar */ }
    if (Date.now() - (k.bitisZaman || 0) > 45 * 60e3 && k.toplam != null) sonuclandir(k, k.toplam, 'son görülen skor');
  }

  // ---------- detay çekme: maç başına tek istek, arada gelen tetikler birleştirilir ----------
  const ucusta = new Map();
  async function detayCek(id, kaynak) {
    const u = ucusta.get(id);
    if (u) { u.tekrar = true; return; }
    const s = { tekrar: false };
    ucusta.set(id, s);
    try {
      do {
        s.tekrar = false;
        const t0 = Date.now();
        durum.detayIstek++;
        const det = await getJSON(`${API}/event/${id}`);
        if (det && det.sid === SPOR) isle(det, kaynak, true);
        if (s.tekrar) await sleep(Math.max(0, 700 - (Date.now() - t0)));
      } while (s.tekrar);
    } catch (e) { /* zaman aşımı/ağ hatası: bir sonraki tetikte tekrar */ }
    finally { ucusta.delete(id); cizIste(); }
  }

  // ---------- düzenli taramalar (üst üste binmez) ----------
  let preMesgul = false, canliMesgul = false;
  async function macOncesiTara() {
    if (durduruldu || preMesgul) return;
    preMesgul = true;
    try {
      const data = await getJSON(`${API}/events?st=${SPOR}&type=0&version=0`);
      const simdi = Date.now() / 1000;
      let ilkKez = 0;
      for (const e of data.events || []) {
        isle(e, 'polling');
        const k = db.mac[e.i];
        if (!k || k.canliBasladi) continue;
        k.preGorulme = Date.now();
        // liste sadece ana baremi verir; en alt/en üst için detay: yaklaşan maçlarda her taramada, diğerlerinde bir kez (taramada en fazla 10)
        if ((e.d && e.d - simdi < AYAR.PRE_DETAY_DK * 60) || (!k.preAralikZaman && ilkKez++ < 10)) detayCek(e.i, 'polling');
      }
      bakim();
      cizIste();
    } catch (e) { log('Maç öncesi tarama hatası:', e.message); }
    finally { preMesgul = false; }
  }

  async function canliTara() {
    if (durduruldu) return;
    hubOran.baglan(); hubSkor.baglan();
    if (canliMesgul) return;
    canliMesgul = true;
    try {
      const data = await getJSON(`${API}/events?st=${SPOR}&type=1&version=0`);
      skorlar = data.sc || {};
      const canliIdler = new Set();
      for (const e of data.events || []) {
        if (!canliMi(e)) continue;
        canliIdler.add(String(e.i));
        isle(e, 'polling');
        if (!(e.m || []).some(m => m.t === LIVE.t && m.st === LIVE.st)) detayCek(e.i, 'polling'); // listede toplam sayı marketi yoksa detaydan
      }
      for (const [id, k] of Object.entries(db.mac)) {
        if (!k.canliBasladi) continue;
        if (skorlar[id]) skorGuncelle(k, skorlar[id]);
        if (canliIdler.has(id)) {
          k.kayip = 0;
          if (k.bitti) { k.bitti = false; delete k.bitisZaman; }
          // iddaa skor/saat vermiyorsa (bazı ligler) Sportradar'dan
          if ((!k.skorZaman || Date.now() - k.skorZaman > 60000) && (!k.sr || Date.now() - k.sr.t > 14000)) {
            (k.bri ? srCek(k) : srBul(k).then(ok => ok && srCek(k))).catch(() => {});
          }
          continue;
        }
        if (!k.bitti) {                                         // canlı listeden art arda 2 kez düşerse bitti
          k.kayip = (k.kayip || 0) + 1;
          if (k.kayip >= 2) { k.bitti = true; k.bitisZaman = Date.now(); kaydet(); }
        }
        const bahisli = k.sanal && Object.keys(k.sanal).length > 0;
        if (k.bitti && bahisli && !k.sanalZaman && Date.now() - k.bitisZaman < 12 * 3600e3) sonucAra(id, k);
      }
      kaydetIste();
      cizIste();
    } catch (e) { log('Canlı tarama hatası:', e.message); }
    finally { canliMesgul = false; }
  }

  // ---------- WebSocket (SignalR JSON protokolü) ----------
  // Sunucu 15 sn'de bir ping atar; 45 sn hiç mesaj gelmezse bağlantı ölü sayılır ve yeniden kurulur.
  function hubOlustur(ad, url, onHedef) {
    const h = { ws: null, deneme: 0, sonMesaj: 0, sonGonderim: 0 };
    const yaz = (x) => { durum[ad] = x; cizIste(); };
    h.baglan = () => {
      if (h.ws && h.ws.readyState === WebSocket.OPEN && Date.now() - h.sonMesaj > 45000) {
        log(`WS (${ad}) 45 sn sessiz, yeniden bağlanılıyor`);
        const eski = h.ws; h.ws = null;
        try { eski.close(); } catch (e) { /* */ }
      }
      if (h.ws && (h.ws.readyState === WebSocket.CONNECTING || h.ws.readyState === WebSocket.OPEN)) return;
      let ws;
      try { ws = h.ws = new WebSocket(url); } catch (e) { yaz('hata'); return; }
      h.sonMesaj = Date.now();
      yaz('bağlanıyor');
      ws.onopen = () => { ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS); h.sonGonderim = Date.now(); };
      ws.onmessage = (ev) => {
        h.sonMesaj = Date.now();
        for (const f of String(ev.data).split(RS)) {
          if (!f) continue;
          let m; try { m = JSON.parse(f); } catch (e) { continue; }
          if (m.type === undefined) { if (m.error) ws.close(); else { h.deneme = 0; yaz('bağlı'); } }
          else if (m.type === 1) onHedef(m.target, m.arguments);
        }
        if (Date.now() - h.sonGonderim > 10000 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 6 }) + RS);              // ping
          h.sonGonderim = Date.now();
        }
      };
      ws.onclose = () => {
        if (h.ws !== ws) return;
        yaz('koptu');
        setTimeout(h.baglan, Math.min(30000, 1000 * 2 ** h.deneme++));
      };
    };
    return h;
  }
  // payload yapısından bağımsız: sid===2 olan objeleri topla
  function basketObjeleri(x, out, d = 0) {
    if (!x || typeof x !== 'object' || d > 4) return out;
    if (Array.isArray(x)) { for (const y of x) basketObjeleri(y, out, d + 1); return out; }
    if (x.sid !== undefined) { if (x.sid === SPOR) out.push(x); return out; }
    for (const v of Object.values(x)) if (v && typeof v === 'object') basketObjeleri(v, out, d + 1);
    return out;
  }
  const hubOran = hubOlustur('ws', WS_ORAN, (target, args) => {
    if (target !== 'currentOdds' && target !== 'currentEvents') return;
    for (const o of basketObjeleri(args, [])) {
      const id = o.eid != null ? o.eid : o.i;
      const k = db.mac[id];
      if (!durduruldu && k && k.canliBasladi && !k.bitti) detayCek(id, 'WebSocket');
    }
  });
  const hubSkor = hubOlustur('wsSkor', WS_SKOR, (target, args) => {
    if (target !== 'currentScore') return;
    for (const sc of basketObjeleri(args, [])) {
      const k = db.mac[sc.id != null ? sc.id : sc.eid];
      if (k && k.canliBasladi) { skorGuncelle(k, sc, true); kaydetIste(); }
    }
  });

  // ---------- liste fonksiyonları (panel + CSV) ----------
  function sanalListe() {
    const out = [];
    for (const [id, k] of Object.entries(db.mac)) {
      for (const b of Object.values(k.sanal || {})) {
        // v3.3 ve öncesindeki bahislerde referans alanı yok → hepsi maç öncesi
        if (b.ters) out.push(Object.assign({ id, mac: `${k.hn} - ${k.an}`, bitti: !!k.bitti, toplam: k.sanalZaman ? k.sanalToplam : null, sonucKaynak: k.sonucKaynak || '', referans: 'pre' }, b));
      }
    }
    return out.sort((a, b) => b.t - a.t);
  }
  // Özet satırları: referans × eşik (her referans için güncel eşik satırı boş da olsa görünür)
  function sanalOzet(liste) {
    const satirlar = [];
    for (const r of [...new Set([...AYAR.REFERANSLAR, ...liste.map(b => b.referans)])]) {
      const lr = liste.filter(b => b.referans === r);
      for (const esik of [...new Set([AYAR.FARK, ...lr.map(b => b.esik)])]) {
        const xs = lr.filter(b => b.esik === esik).map(b => b.ters).filter(x => x.oran != null);
        const biten = xs.filter(x => x.sonuc);
        const kaz = biten.filter(x => x.sonuc === 'K').length;
        const net = biten.reduce((a, x) => a + x.net, 0);
        const ortOran = xs.length ? xs.reduce((a, x) => a + x.oran, 0) / xs.length : null;
        satirlar.push({
          referans: r, esik, toplam: xs.length, biten: biten.length, kaz, kay: biten.length - kaz,
          yuzde: biten.length ? 100 * kaz / biten.length : null, ortOran, basabas: ortOran ? 100 / ortOran : null,
          net, roi: biten.length ? 100 * net / (biten.length * AYAR.SANAL_TUTAR) : null,
        });
      }
    }
    return satirlar;
  }
  function sanalCSV() {
    const bas = ['zaman', 'mac_id', 'mac', 'lig', 'esik', 'mac_dakikasi', 'gecen_sure', 'ceyrek', 'ceyrek_kalan', 'barem_yonu',
      'mac_oncesi_ana', 'mac_oncesi_en_alt', 'mac_oncesi_en_ust', 'karsilastirilan', 'fark', 'skor_aninda',
      'taraf', 'barem', 'oran', 'mbs', 'toplam_sayi', 'sonuc', 'net_tl', 'kontrol_et', 'sonuc_kaynagi', 'veri_kaynagi',
      'referans', 'referans_gecen_sure', 'referans_en_alt', 'referans_en_ust'];   // v3.4: yeni sütunlar sonda (eski dosyalarla uyumlu)
    const sat = [bas.join(';')];
    for (const b of sanalListe()) {
      const x = b.ters;
      sat.push([new Date(b.t).toLocaleString('tr-TR'), b.id, b.mac, b.lig || '', b.esik, b.dk ?? '', b.gecen || '', b.ceyrek ?? '', b.ceyrekKalan || b.kalan || '',
        b.yon === 'ust' ? 'yukari' : 'asagi', b.pre ?? '', b.preAlt ?? '', b.preUst ?? '', b.preRef ?? '', b.fark, b.skor,
        x.taraf === 'ust' ? 'UST' : 'ALT', x.sov, x.oran, x.mbc ?? '', b.toplam ?? '', x.sonuc ?? '', x.net ?? '', x.yakin ? 'evet' : '', b.sonucKaynak, b.kaynak,
        b.referans, b.refGecen || '', b.refAlt ?? b.preAlt ?? '', b.refUst ?? b.preUst ?? '']
        .map(v => String(v).replace(/;/g, ',')).join(';'));
    }
    return '\uFEFF' + sat.join('\n');
  }

  // ---------- panel ----------
  const SEKMELER = [['canli', 'Canlı'], ['yaklasan', 'Yaklaşan'], ['biten', 'Biten'], ['uyari', 'Uyarılar'], ['sanal', 'Sanal kupon']];
  let govde, ust, baslik, farkGirdi, sekme = 'canli';
  const acik = {};
  try { sekme = localStorage.getItem('iddaa13_sekme') || 'canli'; } catch (e) { /* */ }

  const el = (tag, css, txt) => { const d = document.createElement(tag); if (css) d.style.cssText = css; if (txt != null) d.textContent = txt; return d; };
  const saat = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const saatSn = (ms) => new Date(ms).toLocaleTimeString('tr-TR');
  const gun = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
  const kalanYazi = (d) => { const dk = Math.round((d * 1000 - Date.now()) / 60000); return dk <= 0 ? 'başlıyor' : dk < 60 ? `${dk} dk` : `${Math.floor(dk / 60)} sa ${dk % 60} dk`; };
  const gecmisYazi = (g, n) => (g || []).slice(-n).map(([t, v]) => `${saatSn(t)}  ${v}`).join('\n') || '-';
  const KIRMIZI = 'color:#f87171;font-weight:700;', YESIL = 'color:#34d399;font-weight:700;';

  const yerelTarih = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; };
  function indir(icerik, tur, ad) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([icerik], { type: tur }));
    a.download = ad; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function panelKur() {
    const panel = el('div', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:640px;max-width:calc(100vw - 24px);' +
      'background:#111827;color:#f9fafb;font:12px/1.4 system-ui,sans-serif;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);');
    const bas = el('div', 'display:flex;align-items:center;gap:6px;padding:8px 10px;background:#e67e22;border-radius:10px 10px 0 0;cursor:pointer;font-weight:600;');
    const btn = (txt, fn) => {
      const b = el('button', 'font:11px system-ui;padding:2px 6px;border:0;border-radius:6px;cursor:pointer;', txt);
      b.onclick = (ev) => { ev.stopPropagation(); fn(b); };
      return b;
    };
    baslik = el('span', 'flex:1', '');
    bas.append(baslik,
      btn('CSV', () => indir(sanalCSV(), 'text/csv;charset=utf-8', `iddaa13-sanal-kupon-${yerelTarih()}.csv`)),
      btn('Geçmişi temizle', () => {
        const biten = Object.values(db.mac).filter(k => k.bitti);
        const bahis = biten.reduce((a, k) => a + Object.keys(k.sanal || {}).length, 0);
        if (!window.confirm('Geçmiş silinsin mi? Emin misiniz?\n\n' +
          `Silinecek: ${biten.length} biten maç, bu maçlardaki ${bahis} sanal bahis ve ${(db.uyarilar || []).length} uyarı kaydı.\n` +
          'Canlı ve yaklaşan maçlar, maç öncesi baremler ve ayarlar korunur.\n\n' +
          'Silmeden önce bütün sanal bahisler otomatik olarak CSV dosyasına yedeklenir.')) return;
        if (bahis) indir(sanalCSV(), 'text/csv;charset=utf-8', `iddaa13-yedek-${yerelTarih()}.csv`);
        for (const id in db.mac) if (db.mac[id].bitti) delete db.mac[id];
        db.uyarilar = [];
        kaydet(); cizIste();
      }),
      btn('Telegram', () => {
        const t = window.prompt('Telegram bot token (BotFather\'ın verdiği, ör. 123456:ABC...):', tgToken());
        if (t == null) return;
        const c = window.prompt('Telegram chat ID (sadece rakam):', tgChat());
        if (c == null) return;
        try { localStorage.setItem(TG_TOKEN_KEY, t.trim()); localStorage.setItem(TG_CHAT_KEY, c.trim()); } catch (e) { /* */ }
        if (!tokenVar()) window.alert('Token veya chat ID biçimi hatalı görünüyor. Tekrar deneyin.');
        else telegram(`13 Kuralı takip (v${VERSIYON}) bu cihazda bağlandı. Fark eşiği: ±${AYAR.FARK}.`);
        cizIste();
      }),
      btn('Test mesajı', async (b) => {
        const ok = await telegram(`13 Kuralı takip (v${VERSIYON}) çalışıyor. Fark eşiği: ±${AYAR.FARK}.`, 'https://www.iddaa.com/program/canli/basketbol');
        b.textContent = ok ? 'Gönderildi ✓' : 'Ayar eksik/hata';
        setTimeout(() => (b.textContent = 'Test mesajı'), 3000);
      }));
    const icerik = el('div');
    // ayar satırı bir kez çizilir (yazarken odak kaybolmaz)
    const ayarSatir = el('div', 'display:flex;align-items:center;gap:6px;padding:6px 10px 0;color:#d1d5db;');
    const girdi = el('input', 'width:56px;font:12px system-ui;padding:2px 4px;border:1px solid #374151;border-radius:4px;background:#1f2937;color:#f9fafb;');
    girdi.type = 'number'; girdi.min = '1'; girdi.step = '1'; girdi.value = String(AYAR.FARK);
    const onay = el('span', 'color:#6b7280;', '');
    const uygula = () => {
      if (uzakFark) { girdi.value = String(AYAR.FARK); onay.textContent = 'yönetici belirledi'; return; }
      const v = parseFloat(girdi.value);
      if (!(v > 0)) { girdi.value = String(AYAR.FARK); return; }
      AYAR.FARK = v;
      try { localStorage.setItem(FARK_KEY, String(v)); } catch (e) { /* */ }
      onay.textContent = '✓ kaydedildi';
      setTimeout(() => (onay.textContent = ''), 2000);
      cizIste();
    };
    girdi.onchange = uygula;
    girdi.onkeydown = (ev) => { if (ev.key === 'Enter') uygula(); };
    ayarSatir.append(el('span', '', 'Fark eşiği:'), girdi, el('span', 'color:#9ca3af;', 'sayı (maç öncesi, 5. dk ve 1. çeyrek uç baremlerine göre)'), onay);
    ust = el('div', 'padding:6px 10px 0;');
    govde = el('div', 'padding:6px 10px 10px;max-height:45vh;overflow:auto;');
    farkGirdi = girdi;
    icerik.append(ayarSatir, ust, govde);
    bas.onclick = () => { icerik.style.display = icerik.style.display === 'none' ? '' : 'none'; };
    panel.append(bas, icerik);
    document.body.appendChild(panel);
  }

  // h: hücreler (metin veya {t, css, wrap, tik}), tik: satır tıklama, ek: açılır detay metni
  function tablo(basliklar, satirlar) {
    const t = el('table', 'width:100%;border-collapse:collapse;color:#e5e7eb;font:12px/1.4 system-ui,sans-serif;background:transparent;');
    const hr = el('tr');
    for (const b of basliklar) hr.append(el('th', 'text-align:left;color:#9ca3af;font:500 12px/1.4 system-ui,sans-serif;background:transparent;padding:3px 4px;border-bottom:1px solid #374151;white-space:nowrap;', b));
    t.append(hr);
    for (const s of satirlar) {
      const tr = el('tr', 'border-bottom:1px solid #1f2937;' + (s.tik ? 'cursor:pointer;' : ''));
      for (const h of s.h) {
        const v = h !== null && typeof h === 'object' ? h : { t: h };
        const td = el('td', 'padding:3px 4px;vertical-align:top;color:#e5e7eb;font:12px/1.4 system-ui,sans-serif;background:transparent;' +
          (v.wrap ? '' : 'white-space:nowrap;') + (v.tik ? 'cursor:pointer;text-decoration:underline;' : '') + (v.css || ''), v.t == null ? '-' : String(v.t));
        if (v.tik) td.onclick = (ev) => { ev.stopPropagation(); v.tik(); };
        tr.append(td);
      }
      if (s.tik) tr.onclick = s.tik;
      t.append(tr);
      if (s.ek) {
        const tr2 = el('tr'), td = el('td', 'padding:2px 4px 8px;');
        td.colSpan = basliklar.length;
        td.append(el('pre', 'margin:0;color:#9ca3af;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;', s.ek));
        tr2.append(td); t.append(tr2);
      }
    }
    govde.append(t);
  }
  const bos = (txt) => govde.append(el('div', 'color:#9ca3af;padding:6px 0;', txt));
  const ipucu = (txt) => govde.append(el('div', 'color:#6b7280;margin-top:6px;', txt));
  const ac = (id) => () => { acik[id] = !acik[id]; cizIste(); };
  const preYazi = (k) => (k.pre == null ? 'yok' : k.preAlt != null && k.preAlt !== k.preUst ? `${k.preAlt}–${k.preUst}` : String(k.pre));
  // Canlı sekmesi detayı: her referansın uç baremleri ve şu anki farklar
  const refOzet = (k) => AYAR.REFERANSLAR.map(r => {
    const x = refDeger(k, r), f = (k.refFark || {})[r], ham = r === 'pre' ? null : (k.ref || {})[r];
    const ad = `${REF_AD[r]}${ham && ham.gecen ? ` (${ham.gecen})` : ''}`;
    if (!x) return `  ${ad}: ${r === 'pre' ? 'yok' : ham && ham.kacti ? 'kaçırıldı (geç görüldü)' : 'bekleniyor'}`;
    return `  ${ad}: ${x.alt}–${x.ust}${f ? ` · ÜST fark ${isaretli(f.ust)} / ALT fark ${isaretli(f.alt)}` : ''}`;
  }).join('\n');

  function cizCanli(list) {
    if (!list.length) return bos('Şu an canlı basketbol maçı yok.');
    tablo(['Maç', 'Skor', 'Dk', 'Önce (alt–üst)', 'Canlı (alt–üst)', 'ÜST fark', 'ALT fark', 'Güncel'], list.map(k => {
      const oz = oyunZamani(k);
      return {
        h: [{ t: `${k.hn} - ${k.an}`, wrap: true }, k.skor || '-', oz ? `${oz.dk}' (Ç${oz.ceyrek} ${oz.kalan})` : '-', preYazi(k),
          k.aralik && k.canli != null ? `${k.aralik[0]}–${k.aralik[1]}` : 'kapalı',
          { t: isaretli(k.farkUst), css: k.farkUst >= AYAR.FARK ? KIRMIZI : '' },
          { t: isaretli(k.farkAlt), css: -k.farkAlt >= AYAR.FARK ? KIRMIZI : '' },
          k.canliZaman ? `${Math.round((Date.now() - k.canliZaman) / 1000)} sn` : '-'],
        tik: ac(k.id),
        ek: acik[k.id] ? `${k.lig || ''}\nMaç öncesi: en alt ${k.preAlt ?? '-'} · ana ${k.pre ?? '-'} · en üst ${k.preUst ?? '-'}\n\n` +
          `Referanslar (her biri ayrı sanal kupon açar):\n${refOzet(k)}\n\n` +
          `Açık canlı baremler:\n${(k.canliBaremler || []).map(x => `  ${x.sov}  Alt ${oranYazi(x.alt)} / Üst ${oranYazi(x.ust)}`).join('\n') || '  -'}\n\n` +
          `Canlı alt–üst geçmişi:\n${gecmisYazi(k.canliGecmis, 20)}` : null,
      };
    }));
    ipucu(`ÜST fark = canlı en üst − maç öncesi en üst; ALT fark = canlı en alt − maç öncesi en alt. Eşik ±${AYAR.FARK}. Satıra tıklayınca 5. dk ve 1. çeyrek referansları, baremler ve oranlar açılır.`);
  }

  function cizYaklasan(list) {
    if (!list.length) return bos('Barem kaydedilmiş yaklaşan maç yok.');
    tablo(['Başlama', 'Kalan', 'Maç', 'En alt', 'Ana', 'En üst'], list.map(k => ({
      h: [`${gun(k.d * 1000)} ${saat(k.d * 1000)}`, kalanYazi(k.d), { t: `${k.hn} - ${k.an}`, wrap: true },
        k.preAralikZaman ? k.preAlt : '…', k.pre, k.preAralikZaman ? k.preUst : '…'],
      tik: ac(k.id),
      ek: acik[k.id] ? `${k.lig || ''}\nAna barem geçmişi:\n${gecmisYazi(k.preGecmis, 20)}` : null,
    })));
    ipucu(`Maç başlayınca en alt / en üst baremler sabitlenir. "…" = bütün baremler henüz çekilmedi (başlamaya ${AYAR.PRE_DETAY_DK} dk kala her dakika çekilir).`);
  }

  function cizBiten(list) {
    if (!list.length) return bos('Henüz biten maç yok.');
    tablo(['Bitiş', 'Maç', 'Skor', 'Önce (alt–üst)', 'Max ÜST fark', 'Max ALT fark', 'Bahis'], list.map(k => ({
      h: [k.bitisZaman ? `${gun(k.bitisZaman)} ${saat(k.bitisZaman)}` : '-', { t: `${k.hn} - ${k.an}`, wrap: true },
        k.sanalZaman && k.sanalToplam != null ? `${k.sanalToplam} (${k.sonucKaynak})` : (k.skor || '-'), preYazi(k),
        { t: k.maxUst != null && isFinite(k.maxUst) ? isaretli(k.maxUst) : '-', css: k.maxUst >= AYAR.FARK ? KIRMIZI : '' },
        { t: k.minAlt != null && isFinite(k.minAlt) ? isaretli(k.minAlt) : '-', css: -k.minAlt >= AYAR.FARK ? KIRMIZI : '' },
        k.sanal && Object.keys(k.sanal).length ? String(Object.keys(k.sanal).length) : '–'],
    })));
  }

  function cizUyari(list) {
    if (!list.length) return bos('Henüz uyarı gönderilmedi.');
    tablo(['Zaman', 'Maç', 'Eşik', 'Dk', 'Yön', 'Barem', 'Fark', 'Skor', 'Kaynak'], list.map(u => ({
      h: [`${gun(u.t)} ${saatSn(u.t)}`, { t: u.mac, wrap: true }, u.esik ? `±${u.esik}${u.referans && u.referans !== 'pre' ? ` · ${REF_AD[u.referans]}` : ''}` : '-', u.dk ? `${u.dk}'` : '-',
        u.yon === 'ust' ? 'YUKARI' : 'AŞAĞI', `${u.preRef ?? u.pre} → ${u.canli}`, { t: isaretli(u.fark), css: KIRMIZI }, u.skor || '-', u.kaynak],
    })));
  }

  function sonucGir(id) {
    const k = db.mac[id];
    if (!k) return;
    const v = window.prompt(`${k.hn} - ${k.an}\nMaç sonucunu girin (ör. 83-98) ya da toplam sayıyı (ör. 181):`, k.sanalZaman && k.sanalToplam != null ? String(k.sanalToplam) : (k.skor || ''));
    if (v == null) return;
    const m = /^\s*(\d+)\s*[-:]\s*(\d+)\s*$/.exec(v);
    const toplam = m ? +m[1] + +m[2] : parseInt(v, 10);
    if (!(toplam > 0)) { window.alert('Geçersiz değer.'); return; }
    sonuclandir(k, toplam, 'elle');
    cizIste();
  }

  function cizSanal(list) {
    const yz = (x, n = 1) => (x == null ? '-' : x.toFixed(n));
    const tl = (x) => `${x > 0 ? '+' : ''}${Math.round(x).toLocaleString('tr-TR')} TL`;
    const renk = (x) => (x > 0 ? YESIL : x < 0 ? KIRMIZI : '');
    govde.append(el('div', 'color:#9ca3af;margin-bottom:4px;',
      `Her bahis ${AYAR.SANAL_TUTAR.toLocaleString('tr-TR')} TL. Ters: barem yukarı kaçınca en üst baremde ALT, aşağı kaçınca en alt baremde ÜST. ` +
      `Fark üç referansa göre ayrı ölçülür (maç öncesi, 5. dk, 1. çeyrek sonu); Telegram sadece ${AYAR.UYARI_REFERANSLAR.map(r => REF_AD[r].toLowerCase()).join(', ')} için gider.`));
    tablo(['Referans', 'Eşik', 'Bahis', 'Biten', 'K-Y', 'Kazanma', 'Başabaş', 'Ort. oran', 'Net', 'ROI'], sanalOzet(list).map(r => ({
      h: [REF_AD[r.referans] || r.referans, `±${r.esik}`, r.toplam, r.biten, `${r.kaz}-${r.kay}`, r.yuzde == null ? '-' : `${yz(r.yuzde)}%`,
        r.basabas == null ? '-' : `${yz(r.basabas)}%`, yz(r.ortOran, 2),
        { t: r.biten ? tl(r.net) : '-', css: renk(r.net) }, { t: r.roi == null ? '-' : `${yz(r.roi)}%`, css: renk(r.roi || 0) }],
    })));
    if (!list.length) return bos(`Henüz sanal bahis yok. ±${AYAR.FARK} geçildiğinde burada birikecek.`);
    govde.append(el('div', 'height:10px'));
    tablo(['Zaman', 'Maç', 'Ref', 'Eşik', 'Dk', 'Hareket', 'Bahis', 'Toplam'], list.map(b => {
      const x = b.ters, key = `s${b.id}_${b.referans}_${b.esik}_${b.yon}`;
      const sonucHucre = b.toplam != null
        ? { t: `${b.toplam}${x.yakin ? ' ⚠' : ''}`, tik: () => sonucGir(b.id) }
        : b.bitti ? { t: 'sonuç gir', css: 'color:#fbbf24;', tik: () => sonucGir(b.id) } : 'oynanıyor';
      return {
        h: [`${gun(b.t)} ${saat(b.t)}`, { t: b.mac, wrap: true }, REF_AD[b.referans] || b.referans, `±${b.esik}`, b.dk ? `${b.dk}'` : '-',
          `${b.preRef ?? b.pre} ${b.yon === 'ust' ? '↑ +' : '↓ -'}${b.fark}`,
          { t: `${x.taraf === 'ust' ? 'ÜST' : 'ALT'} ${x.sov} @${oranYazi(x.oran)}${x.sonuc ? (x.sonuc === 'K' ? ' ✓' : ' ✗') : ''}`,
            css: x.sonuc === 'K' ? 'color:#34d399;' : x.sonuc === 'Y' ? 'color:#f87171;' : '' },
          sonucHucre],
        tik: ac(key),
        ek: acik[key] ? `${b.lig || ''}\nReferans: ${REF_AD[b.referans] || b.referans}${b.refGecen ? ` (${b.refGecen})` : ''} en alt–en üst ${b.refAlt ?? b.preAlt ?? '-'}–${b.refUst ?? b.preUst ?? '-'}` +
          ` · maç öncesi ${b.preAlt ?? '-'}–${b.preUst ?? '-'}\nEşik anı: ${b.dkYazi || '-'} · skor ${b.skor || '-'} · ${b.kaynak}\nSonuç kaynağı: ${b.sonucKaynak || '-'}\n` +
          `Açık baremler:\n${(b.baremler || []).map(y => `  ${y.sov}  Alt ${oranYazi(y.alt)} / Üst ${oranYazi(y.ust)}  MBS ${y.mbc ?? '-'}`).join('\n')}` : null,
      };
    }));
    ipucu('Sonuç Sportradar\'dan otomatik gelir. Gelmezse "sonuç gir"e, düzeltmek için toplam sayıya tıklayın. ⚠ = son görülen skorla sonuçlandı ve bareme 3 sayıdan yakın; kontrol edin.');
  }

  let cizBekliyor = false;
  function cizIste() {                          // birleştirilmiş çizim; sekme arka plandayken çizim yapılmaz
    if (cizBekliyor || !govde) return;
    cizBekliyor = true;
    requestAnimationFrame(() => { cizBekliyor = false; ciz(); });
  }
  function ciz() {
    const maclar = Object.entries(db.mac).map(([id, k]) => Object.assign({ id }, k));
    const listeler = {
      canli: maclar.filter(k => k.canliBasladi && !k.bitti).sort((a, b) => a.d - b.d),
      // yaklaşan = şu an iddaa maç öncesi bülteninde olan ve başlamamış maçlar
      yaklasan: maclar.filter(k => !k.canliBasladi && k.pre != null && k.preGorulme && Date.now() - k.preGorulme < 10 * 60e3 && k.d * 1000 > Date.now() - 15 * 60e3).sort((a, b) => a.d - b.d),
      biten: maclar.filter(k => k.bitti).sort((a, b) => (b.bitisZaman || 0) - (a.bitisZaman || 0)),
      uyari: db.uyarilar || [],
      sanal: sanalListe(),
    };
    baslik.textContent = `13 Kuralı takip (±${AYAR.FARK})`;
    ust.textContent = '';
    if (farkGirdi && document.activeElement !== farkGirdi) { farkGirdi.value = String(AYAR.FARK); farkGirdi.disabled = !!uzakFark; }
    if (durduruldu) ust.append(el('div', 'color:#f87171;font-weight:700;', 'Yönetici tarafından durduruldu — uyarı ve sanal bahis kapalı.'));
    if (!tokenVar()) ust.append(el('div', 'color:#fbbf24;', 'Telegram ayarlı değil — başlıktaki "Telegram" düğmesinden token ve chat ID girin.'));
    const iyi = durum.ws === 'bağlı' && durum.wsSkor === 'bağlı';
    const veri = durum.sonVeri ? `son canlı barem ${Math.round((Date.now() - durum.sonVeri) / 1000)} sn önce` : 'canlı barem bekleniyor';
    ust.append(el('div', `color:${iyi ? '#34d399' : '#f87171'};`, `Bağlantı: oran ${durum.ws} · skor ${durum.wsSkor} · ${veri}`));
    if (KONTROL_ACIK) ust.append(el('div', 'color:#9ca3af;', `Uzaktan yönetim: ${durum.kontrol || 'bekleniyor'}${uzakFark ? ` · eşik yöneticiden: ±${uzakFark}` : ''}`));
    const sek = el('div', 'display:flex;gap:4px;margin-top:6px;padding-bottom:6px;border-bottom:1px solid #374151;');
    for (const [key, ad] of SEKMELER) {
      const b = el('button', 'font:12px system-ui;padding:3px 8px;border:0;border-radius:6px;cursor:pointer;' +
        (sekme === key ? 'background:#e67e22;color:#111827;font-weight:600;' : 'background:#1f2937;color:#d1d5db;'), `${ad} (${listeler[key].length})`);
      b.onclick = () => { sekme = key; try { localStorage.setItem('iddaa13_sekme', key); } catch (e) { /* */ } cizIste(); };
      sek.append(b);
    }
    ust.append(sek);
    const kaydirma = govde.scrollTop;
    govde.textContent = '';
    const cizici = { canli: cizCanli, yaklasan: cizYaklasan, biten: cizBiten, uyari: cizUyari, sanal: cizSanal }[sekme] ? sekme : 'canli';
    ({ canli: cizCanli, yaklasan: cizYaklasan, biten: cizBiten, uyari: cizUyari, sanal: cizSanal })[cizici](listeler[cizici]);
    govde.scrollTop = kaydirma;
  }

  // ---------- başlat ----------
  window.iddaa13 = { db: () => db, durum, AYAR, sanalListe, sanalOzet, sanalCSV, oyunZamani, refDeger }; // konsoldan inceleme için
  bakim();
  kaydet();
  panelKur();
  cizIste();
  log(`v${VERSIYON} başladı. Fark eşiği: ±${AYAR.FARK}`);
  kontrolCek().then(() => ligleriYukle()).then(() => { macOncesiTara(); canliTara(); });
  zamanlayici(AYAR.KONTROL_SN * 1000, kontrolCek);
  zamanlayici(AYAR.MAC_ONCESI_KONTROL_SN * 1000, macOncesiTara);
  zamanlayici(AYAR.CANLI_KONTROL_SN * 1000, canliTara);
  zamanlayici(3000, () => { if (kirli) kaydet(); });
  zamanlayici(5000, cizIste);
  zamanlayici(3600e3, ligleriYukle);
  window.addEventListener('pagehide', () => { if (kirli) kaydet(); });
  // Uzun süre açık kalan iddaa sayfası zamanla ağırlaşabilir: canlı maç yokken belirli aralıkla yenile
  if (AYAR.OTOMATIK_YENILE_SAAT > 0) {
    zamanlayici(60000, () => {
      if (Date.now() - durum.basladi < AYAR.OTOMATIK_YENILE_SAAT * 3600e3) return;
      if (Object.values(db.mac).some(k => k.canliBasladi && !k.bitti)) return;
      kaydet();
      location.reload();
    });
  }
})();
