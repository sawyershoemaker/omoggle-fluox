# small writeup on RE'ing Omoggle

complete map of omoggle's updated live‑scoring protocol was achieved by capturing the traffic, defeating cloudflare to pull the JavaScript, deobfuscating a minified Next.js bundle, decoding a binary WebSocket frame, and reversing the full landmark to score pipeline, then finding the one thing worth intercepting.

this is a walkthrough of method and reasoning, (please hire me.)

---

## 0. arbitrage framing

reverse engineering a scored system to me is a bit like a hunt for a mispricing, we are looking for a place where what the system *trusts* and what it *displays* diverge.

omoggle had moved its "price" (the score) from a place where i could trivially edit to somewhere deeper

> note: the readable `score_update` numbers are a decoy (or dead code from an incompetent vibecoder). the server settles on a binary stream of raw face landmarks, stamped with a server‑issued nonce. the original "mispricing" was my own assumption that the numbers mattered.

---

## 1. recon

i started from a traffic/state probe of a full match using a custom script of mine that returns a JSON capture of WebSocket frames, WebRTC data‑channel frames, the app's state store, and outbound serializations. despite the overwhelming amount of data collected, the goal was to be able to enumerate every channel a score could travel on:

- REST: `finalize` / `ranked` endpoints… captured empty, meaning that scoring had moved off HTTP
- WebRTC data channel (LiveKit): JSON `SCAN_STATE` messages carrying `overall`, `jawline`, `symmetry`, etc. this is peer‑to‑peer (p2p), basically what your opponent's client sees of you
- WebSocket `wss://omoggle.com/ws`: readable text frames:
  - `{"type":"score_update","payload":{"score":5.74}}` (occurred every 2 seconds)
  - `{"type":"score_submit","payload":{"self_score":…,"opponent_score":…,"scan_validity":{…}}}`
  - `{"type":"frame_nonce","payload":{"match_id":…,"nonce":1830534216}}`
- App state store (Zustand): `myScore`, `myScoreRaw`, `mogDifferential`, `tugPercent`, `frameNonce`, …

if you were to stop here, you'd reasonably conclude you just need to "patch `score_update` and `score_submit`." buuut that's a trap ^.^

### ruh roh!

scanning the WebSocket *send* timeline, interleaved with the readable text frames, was a frame the probe could only describe as opaque:

```
26.4s  ws-send  binary  len=396     ?
26.9s  ws-send  binary  len=396     ?
27.4s  ws-send  binary  len=396     ?
27.8s  ws-send  text    {"type":"score_update", ...}
28.4s  ws-send  binary  len=396     ?
...
```

woah! a 396‑byte binary frame, occuring roughly 2x/second, on the same socket as the score. the fact it's recurring means it's not a handshake and a cadence of twice per second, all match long, points to telemetry, and telemetry on the scoring socket is exactly where a server would put the data it actually trusts. 

*cha-ching!*

---

## 2. getting the javascript (ft. cloudflare)

to decode a binary frame you need the encoder, and the encoder is in the app bundle. naturally, the bundle URLs were visible in the probe's chunk list:

```
https://omoggle.com/_next/static/chunks/app/page-<hash>.js
https://omoggle.com/_next/static/chunks/2715-<hash>.js
https://omoggle.com/_next/static/chunks/8901.<hash>.js
...
```

`curl`‑ing them returned 5 KB of identical HTML.. cloudflare's "Just a moment…" challenge:

```html
<title>Just a moment...</title> ... window._cf_chl_opt = { ... }
```

cloudflare gates static asset fetches behind a JS/cookie challenge, meaning that a headless `curl` can't see the real file.

luckily we can easily fetch from inside a browser context that has already passed the challenge, so i drove a real browser tab to `https://omoggle.com/`, let the managed challenge resolve, then issued same‑origin `fetch()` calls from the page which automatically carry the `cf_clearance` cookie:

```js
const src = await (await fetch('/_next/static/chunks/app/page-<hash>.js')).text();
```

---

## 3. deobfuscating

the code is minified Next.js/webpack output; identifiable through single‑letter identifiers, comma‑sequenced expressions, and hoisted helpers. 

unfortunately this means we can't pretty print and read top-to-bottom, instead we must pivot on stable string anchors that survive minification:

- protocol literals like `"score_update"`, `"score_submit"`, `"frame_nonce"`, `"SCAN_STATE"`.
- public api names from third‑party libs like `detectForVideo`, `faceLandmarks`, `createFromOptions`, `publishData`.
- dom/math prims such as `Math.hypot`, `Math.atan2`, `ArrayBuffer`, `DataView`, `setFloat32`.

searching `"score_update"` landed directly inside the per‑frame loop, and a few hundred characters later sat the thing i was hunting:

```js
let r = store.getState().frameNonce;
if (r !== 0 && video.videoHeight > 0) {
  let n = function (e, t, r, a, n) {
    let l = O.length, s = new ArrayBuffer(12 + 2 * l * 4), i = new DataView(s);
    i.setUint8(0, 2);
    i.setUint32(1, t >>> 0, true);
    i.setFloat32(5, r, true);
    i.setUint8(9, l);
    i.setUint8(10, Math.round(255 * a));
    i.setUint8(11, U[n]);
    let o = 12;
    for (let t of O) { let r = e[t]; if (!r) return null;
      i.setFloat32(o, r.x, true); i.setFloat32(o + 4, r.y, true); o += 8; }
    return s;
  }(landmarks, r, video.videoWidth / video.videoHeight, e.qualityMultiplier, e.faceStatus);
  n && send(n);
}
```

`12 + 2 * l * 4 = 396` means `l = 48` 

396‑byte mystery frame! anchors beat beautifiers :)

---

## 4. decoding a binary frame

mapping the call arguments `(landmarks, frameNonce, videoWidth/videoHeight, qualityMultiplier, faceStatus)` onto the `DataView` writes gives the wire format:


| offset   | type                          | field                                                |
| -------- | ----------------------------- | ---------------------------------------------------- |
| 0        | `uint8`                       | frame type = `2`                                     |
| 1–4      | `uint32` LE                   | `frameNonce` (server‑issued)                         |
| 5–8      | `float32` LE                  | video aspect ratio                                   |
| 9        | `uint8`                       | landmark count = `48`                                |
| 10       | `uint8`                       | `qualityMultiplier * 255`                            |
| 11       | `uint8`                       | `faceStatus` enum (`{lost:0, warning:1, perfect:2}`) |
| 12 … 395 | `48 × (float32 x, float32 y)` | ++48 landmark coordinates++                          |


there is no score field.. and the "authoritative" frame doesn't send a number at all, it sends your raw face geometry (yikes), tagged with the nonce. however, that can only mean that the server scores the geometry itself amd the readable `score_update` is the client's self‑report, but the geometry stream is ground truth.

the 48 indices (`O`) are exactly which points the server is handed:

```
[0,1,10,33,46,50,58,63,70,105,116,123,132,133,136,145,148,150,152,159,171,172,174,176,187,234,
 263,276,280,288,293,300,334,345,352,361,362,365,374,377,379,386,396,397,399,401,411,454]
```

---

## 5. reversing the scoring pipeline

since the server scores geometry, i needed the geometry to score function. 

the client computes it locally for the live UI, so it's in the same bundle and (the working assumption) the server runs the same or an equivalent model. once again, anchoring on the `SCAN_STATE` payload keys (`jawline`, `symmetry`, `midface`, `cheekbones`, `eyeAspect`, `harmony`, `overall`) led to the metric function and its return:

```js
return {
  canthalTilt: m, jawWidth: b, symmetry: _, midfaceRatio: S,
  cheekboneWidth: E, eyeAspectRatio: z, harmony: J,
  overall: Math.round(10 * P(Z * X, 1.1, 10)) / 10,
  faceStatus: s, qualityMultiplier: X, ...
};
```

then those infamous helpers, deminified:

```js
A = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);          // distance
D = (a,b) => Math.atan2(b.y-a.y, b.x-a.x)*180/Math.PI; // angle (deg)
P = (e,t,r) => Math.max(t, Math.min(r, e));          // clamp
```

…and the full body: aspect‑correct `x`, derive head roll from forehead(10) to chin(152), de‑rotate every point around the nose(1), then compute each metric as a ratio/angle of specific landmarks, map it through a band function `F(value, idealLo, idealHi, hardMin, hardMax)`, and combine with fixed weights:

```text
canthalTilt = -avg(angle(33,133), angle(362,263))
jawWidth    = maxJawDist / faceHeight
symmetry    = 100*(1 - asymmetry/0.09)
midface     = |lip(0).y - eyeLine| / faceHeight
cheekbone   = cheekWidth(234,454) / jawWidth
eyeAspect   = avg(eyeHeight/eyeWidth)
Z = .12*eyes + .14*jaw + .024*symmetry + .14*midface + .1*cheek + .08*eyeAsp + .18*harmony
overall = round(10 * clamp(Z * qualityMultiplier, 1.1, 10)) / 10
```

i also recovered the 19 mirror pairs `L` used by the symmetry metric, and the `qualityMultiplier`
gate (a function of pose/centering/stillness that scales the whole score and is encoded as the
`faceStatus` enum + a 0–255 byte in the binary frame.)

at this point, the system is ++fully transparent++!

---

## 6. understanding `frame_nonce` (the guard)

before touching ANYTHING i needed to know what the nonce protects. so i had to trace it:

- the server sends `{"type":"frame_nonce","payload":{nonce}}` and the client stores it (`setFrameNonce`).
- the client then stamps that nonce into every 396‑byte telemetry frame (`uint32` at offset 1).

this means the nonce is acting as more of a freshness / anti‑replay challenge where the server can reject telemetry that doesn't echo a current nonce, defeating "record a good frame once and replay it forever" attack

crucially, the nonce is not a signature of the landmark bytes, it's a token you echo. so an honest client that produces different landmarks still passes the nonce check.

---

## 7. interception

two consumers read the landmarks, this being the scorer and the binary encoder. however, both read the ++same array,++ produced one line earlier:

```js
m = faceLandmarker.detectForVideo(video, performance.now());
let j = m.faceLandmarks?.[0] ?? null;   // holy moly
```

so the highest‑leverage and lowest‑risk intercept is a single wrapper on `FaceLandmarker.prototype.detectForVideo`, we just call the original, mutate `result.faceLandmarks[0]` in place and return it. this means everything downstream: UI score, `SCAN_STATE` to the opponent, and the nonce‑stamped binary telemetry is derived from the modified geometry and stays mutually consistent, with the nonce going through untouched.

now how might we reach the class at runtime?
it lives in a lazy‑loaded chunk (MediaPipe, `8901`), so the script hooks `webpackChunk_N_E.push`, and on each chunk load scans the webpack module factory map (`__webpack_require__.m`) for a factory whose source mentions `detectForVideo`/`createFromOptions`, requires it, and patches the prototype. (the webpack runtime here is webpack 5 and can be identified by its helper key signature `m, O, n, d, f, e, u, g, o, l, r, p, …` it also notably exposes no module cache, so the factory‑scan + `require()` route is necessary vs reading an instance cache.)

---

## 8. building a working transformer

knowing the scoring mechanics, we can determine that to raise `overall` you move each metric to the center of its ideal band.

to do this, i implemented per‑metric geometric operations in the same de‑rotated space the scorer uses (scale jaw points for `jawWidth`, set eyelid gaps for `eyeAspect`, mirror pairs for `symmetry`, rotate eye‑corner lines for canthal tilt, etc.), then blend real to ideal by an adjustable `strength`, because who doesn't love a little control?

### validation w/ no camera :c

i couldn't run a live match in the analysis environment (my pc has no webcam), so i built an oracle from the bundle's own formulas by re‑implementing the exact metric math and feeding a synthetic sub‑optimal face through the morph at several strengths, checking each metric marched to target:


| metric       | real  | 50%   | 100%  | ideal    |
| ------------ | ----- | ----- | ----- | -------- |
| canthal tilt | 0     | 2.13  | 4.25  | [2, 6.5] |
| jawWidth     | 0.333 | 0.507 | 0.68  | 0.68     |
| symmetry     | 56    | 79    | 99    | →100     |
| midface      | 0.333 | 0.319 | 0.305 | 0.305    |
| cheekbone    | 2.0   | 1.42  | 1.14  | 1.14     |
| eyeAspect    | 0.625 | 0.443 | 0.26  | 0.26     |


always debug!! through this i had caught a real bug. the symmetry op was equalizing the eye corners and re‑flattening the canthal tilt (the model treats a tilt as a small asymmetry), reordering tilt to run *after* symmetry fixed it.

---

## 9. constructive criticism and such

what i think omoggle did well, from an anti‑cheat standpoint:

- moving the source of truth off an editable space. scoring from raw landmark geometry rather than a client‑reported number defeats the entire class of "rewrite the score field" cheats and the readable `score_update`/`score_submit` channel is effectively a honeypot for lazy attackers. if you boost it alone and you create a self‑inconsistency the server can flag
- nonce‑gated telemetry is also a nice touch. the `frame_nonce` challenge stops replay of a single well-scoring frame.
- quality gate is also neat from a legit "cheating" perspective, (`qualityMultiplier` / pose/stillness) that bounds the score independent of geometry, limits a user's ability to "anglemaxx" to mess with the model.

where it's still exposed, and how i'd harden it:

- video to landmark binding. the real camera stream goes out over LiveKit, but the scored landmarks are just accepted on faith?
derive landmarks from the received video (or periodically cross‑check client landmarks against server‑run detection on sampled frames). this way spoofed geometry that doesn't track the actual face becomes detectable. 
- client-side scoring is fully recoverable. by shipping the exact weights, bands, and indices in the bundle you're handing an attacker the objective function. keeping the authoritative scorer server‑only (perhaps with the client computing at most an approximate preview) removes the closed‑form target.
- nonce guards freshness only. since it isn't a MAC over the payload, it doesn't stop fabricated (vs. replayed) frames. a simple HMAC over `(nonce ‖ landmark bytes)` keyed server‑side, or even better, not trusting client landmarks at ALL closes that.
- temporal plausibility. per‑frame geometry that jumps to ideal or is too stable relative to head motion, is statistically distinguishable from a real face over the course of a match.

---

thank you for reading my humble writeup ^.^