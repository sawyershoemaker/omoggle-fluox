// ==UserScript==
// @name         Fluox
// @icon         https://cdn.discordapp.com/icons/1505771339976540283/a15f614617c258dc1a8944cda565c076.webp?size=1280
// @version      1.0.0
// @description  https://github.com/sawyershoemaker/omoggle-fluox/
// @match        https://omoggle.com/*
// @match        https://www.omoggle.com/*
// @match        https://*.omoggle.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // config
  const DEFAULT_STRENGTH = 0.3;
  let STRENGTH = DEFAULT_STRENGTH;
  const STRENGTH_STEP = 0.05;
  const STRENGTH_MIN = 0.0;
  const STRENGTH_MAX = 1.0;

  const LOG_PREFIX = '[fluox]';
  const HIDE_LOGS = true;
  const MOBILE_EDGE_CONTROLS = true;
  const MOBILE_EDGE_WIDTH = 24;

  const TARGET = {
    tilt: 4.25,
    eyeAspect: 0.26,
    jawWidth: 0.68,
    cheekbone: 1.14,
    midface: 0.305,
  };

  const OPS = { tilt: true, eyeAspect: true, jaw: true, cheekbone: true, midface: true, symmetry: true };
  const O = [0,1,10,33,46,50,58,63,70,105,116,123,132,133,136,145,148,150,152,159,171,172,174,176,187,234,263,276,280,288,293,300,334,345,352,361,362,365,374,377,379,386,396,397,399,401,411,454];
  const L = [[33,263],[133,362],[70,300],[63,293],[105,334],[46,276],[116,345],[123,352],[50,280],[187,411],[132,361],[174,399],[150,379],[172,397],[136,365],[171,396],[148,377],[176,401],[58,288]];
  const JAW = [[172,397],[150,379],[171,396]];
  const JAW_PTS = [172,397,150,379,171,396];
  const REF = { forehead: 10, chin: 152, nose: 1 };

  const UNION = (function () {
    const s = new Set([33,133,362,263, 159,145,386,374, 234,454, 0]);
    for (const p of JAW_PTS) s.add(p);
    for (const [a,b] of L) { s.add(a); s.add(b); }
    return Array.from(s);
  })();

  function log() { if (!HIDE_LOGS) { try { console.log.apply(console, [LOG_PREFIX].concat([].slice.call(arguments))); } catch (e) {} } }

  function warn() { try { console.warn.apply(console, [LOG_PREFIX].concat([].slice.call(arguments))); } catch (e) {} }
  
  const A = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const D = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);

  function rot(pt, cx, cy, deg) {
    const r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const dx = pt.x - cx, dy = pt.y - cy;
    return { x: cx + dx * cs - dy * sn, y: cy + dx * sn + dy * cs };
  }

  function sgn(v) { return v < 0 ? -1 : 1; }
  const state = { hooked: false, frames: 0, lastError: null, lastVideo: null, classLabel: null };

  function morphLandmarks(lm, vw, vh, strength) {
    if (strength <= 0) return;
    if (!lm || lm.length <= 454) return;
    if (!lm[REF.forehead] || !lm[REF.chin] || !lm[REF.nose]) return;

    const i = vh > 0 ? vw / vh : 1;
    const o = (idx) => ({ x: lm[idx].x * i, y: lm[idx].y });
    const c = D(o(REF.forehead), o(REF.chin)) - 90;
    const d = o(REF.nose);
    const toP = (idx) => rot(o(idx), d.x, d.y, -c);
    const fromP = (pp) => { const op = rot(pp, d.x, d.y, c); return { x: op.x / i, y: op.y }; };

    const P = {};
    const orig = {};
    for (const idx of UNION) { P[idx] = toP(idx); orig[idx] = { x: lm[idx].x, y: lm[idx].y }; }
    const pF = toP(REF.forehead), pC = toP(REF.chin);
    const f = A(pF, pC);
    if (!(f > 0)) return;

    if (OPS.eyeAspect) {
      const setEye = (wa, wb, ha, hb) => {
        const width = A(P[wa], P[wb]);
        if (!(width > 0)) return;
        const targetH = TARGET.eyeAspect * width;
        const midY = (P[ha].y + P[hb].y) / 2;
        P[ha] = { x: P[ha].x, y: midY + sgn(P[ha].y - midY) * (targetH / 2) };
        P[hb] = { x: P[hb].x, y: midY + sgn(P[hb].y - midY) * (targetH / 2) };
      };
      setEye(33, 133, 159, 145);
      setEye(263, 362, 386, 374);
    }

    const vCenter = () => (P[133].x + P[362].x) / 2;

    if (OPS.jaw) {
      let g = 0; for (const [a, b] of JAW) g = Math.max(g, A(P[a], P[b]));
      if (g > 0) {
        const scale = (TARGET.jawWidth * f) / g;
        const v = vCenter();
        for (const idx of JAW_PTS) P[idx] = { x: v + (P[idx].x - v) * scale, y: P[idx].y };
      }
    }

    if (OPS.cheekbone) {
      let g2 = 0; for (const [a, b] of JAW) g2 = Math.max(g2, A(P[a], P[b]));
      const T = A(P[234], P[454]);
      if (T > 0 && g2 > 0) {
        const targetT = TARGET.cheekbone * g2;
        const sc = targetT / T;
        const v = vCenter();
        for (const idx of [234, 454]) P[idx] = { x: v + (P[idx].x - v) * sc, y: P[idx].y };
      }
    }

    if (OPS.midface) {
      const N = ((P[133].y + P[33].y) / 2 + (P[362].y + P[263].y) / 2) / 2; // eye-line y
      const targetC = TARGET.midface * f;
      P[0] = { x: P[0].x, y: N + sgn(P[0].y - N) * targetC };
    }

    if (OPS.symmetry) {
      const v2 = vCenter();
      const w2 = (pF.y + pC.y) / 2;
      for (const [a, b] of L) {
        if (!P[a] || !P[b]) continue;
        const dxA = P[a].x - v2, dxB = P[b].x - v2;
        const ax = (Math.abs(dxA) + Math.abs(dxB)) / 2;
        P[a] = { x: v2 + sgn(dxA) * ax, y: P[a].y };
        P[b] = { x: v2 + sgn(dxB) * ax, y: P[b].y };
        const dyA = P[a].y - w2, dyB = P[b].y - w2;
        const ay = (Math.abs(dyA) + Math.abs(dyB)) / 2;
        P[a] = { x: P[a].x, y: w2 + sgn(dyA) * ay };
        P[b] = { x: P[b].x, y: w2 + sgn(dyB) * ay };
      }
    }

    if (OPS.tilt) {
      for (const [a, b] of [[33, 133], [362, 263]]) {
        const mid = { x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 };
        const cur = D(P[a], P[b]);
        const delta = (-TARGET.tilt) - cur;
        P[a] = rot(P[a], mid.x, mid.y, delta);
        P[b] = rot(P[b], mid.x, mid.y, delta);
      }
    }

    for (const idx of UNION) {
      const raw = fromP(P[idx]);
      if (!isFinite(raw.x) || !isFinite(raw.y)) continue;
      lm[idx].x = orig[idx].x + (raw.x - orig[idx].x) * strength;
      lm[idx].y = orig[idx].y + (raw.y - orig[idx].y) * strength;
    }
  }

  function patchClass(Klass, label) {
    try {
      if (!Klass || !Klass.prototype) return false;
      const proto = Klass.prototype;
      if (typeof proto.detectForVideo !== 'function' || proto.__lmHooked) return false;
      const orig = proto.detectForVideo;
      proto.detectForVideo = function (video, ts) {
        const res = orig.apply(this, arguments);
        try {
          const lms = res && res.faceLandmarks && res.faceLandmarks[0];
          if (lms && lms.length > 454) {
            const vw = (video && video.videoWidth) || 1;
            const vh = (video && video.videoHeight) || 1;
            state.lastVideo = vw + 'x' + vh;
            morphLandmarks(lms, vw, vh, STRENGTH);
            state.frames++;
          }
        } catch (e) { state.lastError = String(e && e.message || e); }
        return res;
      };
      proto.__lmHooked = true;
      state.hooked = true;
      state.classLabel = label || (Klass.name || 'FaceLandmarker');
      log('hooked detectForVideo on', state.classLabel);
      return true;
    } catch (e) { return false; }
  }

  let req = null;
  let patched = false;

  function scanCandidate(val, label) {
    if (!val) return false;
    if (patchClass(val, label)) return true;
    try {
      if (val.default && patchClass(val.default, label)) return true;
    } catch (e) {}
    return false;
  }

  function scanModules() {
    if (patched || !req) return;
    const m = req.m;
    if (!m) return;
    for (const id in m) {
      let src;
      try { src = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
      if (!src || src.indexOf('detectForVideo') === -1) continue;
      if (src.indexOf('createFromOptions') === -1 && src.indexOf('FaceLandmarker') === -1) continue;
      let exp;
      try { exp = req(id); } catch (e) { continue; }
      if (!exp) continue;
      if (scanCandidate(exp, 'export:' + id)) { patched = true; return; }
      try {
        for (const k in exp) { if (scanCandidate(exp[k], 'export:' + id + '.' + k)) { patched = true; return; } }
      } catch (e) {}
    }
  }

  function hookWebpack() {
    const c = window.webpackChunk_N_E;
    if (!c) return;
    if (!c.__lmReqHook) {
      c.__lmReqHook = true;
      try {
        const origPush = c.push.bind(c);
        c.push = function () { const r = origPush.apply(c, arguments); try { scanModules(); } catch (e) {} return r; };
      } catch (e) {}
    }
    if (!req) {
      try { c.push([['__lm_req'], {}, function (r) { req = r; }]); } catch (e) {}
    }
    scanModules();
  }

  let scanTimer = setInterval(function () {
    if (patched) { clearInterval(scanTimer); scanTimer = null; return; }
    hookWebpack();
  }, 400);
  hookWebpack();

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function roundStrength(v) { return Math.round(v * 100) / 100; }

  function setStrength(v) {
    STRENGTH = clamp(roundStrength(v), STRENGTH_MIN, STRENGTH_MAX);
    log('strength =', STRENGTH);
  }
  function bumpStrength(delta) { setStrength(STRENGTH + delta); }
  function resetStrength() { setStrength(DEFAULT_STRENGTH); }

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    const tgt = e.target;
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
    if (e.key === '=' || e.key === '+') { bumpStrength(STRENGTH_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { bumpStrength(-STRENGTH_STEP); e.preventDefault(); }
    else if (e.key === '0') { resetStrength(); e.preventDefault(); }
  }

  function isCoarsePointer() { try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  let lastEdgeTapAt = 0;
  function installMobileEdgeControls() {
    if (!MOBILE_EDGE_CONTROLS || !isCoarsePointer()) return;
    window.addEventListener('touchstart', function (e) {
      const t = e.touches && e.touches[0];
      if (!t) return;
      const x = t.clientX, w = window.innerWidth;
      const now = Date.now();
      if (now - lastEdgeTapAt < 250) return;
      if (x <= MOBILE_EDGE_WIDTH) { lastEdgeTapAt = now; bumpStrength(-STRENGTH_STEP); }
      else if (x >= w - MOBILE_EDGE_WIDTH) { lastEdgeTapAt = now; bumpStrength(STRENGTH_STEP); }
    }, { passive: true });
  }

  function installControls() {
    window.addEventListener('keydown', onKeydown, true);
    installMobileEdgeControls();
  }
  if (document.body || document.documentElement) installControls();
  else document.addEventListener('DOMContentLoaded', installControls);

  function diagnose() {
    const info = {
      strength: STRENGTH,
      hooked: state.hooked,
      classLabel: state.classLabel,
      framesMorphed: state.frames,
      lastVideo: state.lastVideo,
      lastError: state.lastError,
      webpackReq: !!req,
      ops: Object.assign({}, OPS),
      targets: Object.assign({}, TARGET),
    };
    log('diagnose', info);
    return info;
  }

  window.__fluox = {
    get strength() { return STRENGTH; },
    set strength(v) { setStrength(v); },
    setStrength: function (v) { setStrength(v); },
    bump: bumpStrength,
    reset: resetStrength,
    ops: OPS,
    targets: TARGET,
    diagnose: diagnose,
    _state: state,
  };

  log('installed with strength', STRENGTH, '(=/- to adjust, 0 to reset). Hooking FaceLandmarker…');
})();
