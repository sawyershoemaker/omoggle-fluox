# omoggle-fluox

tampermonkey script that artificially boosts score on [Omoggle](https://omoggle.com) by editing the facial landmark geometry at its source rather than tampering with score values after the fact. most scripts being circulated interact with ever-changing stored values, breaking scripts and adding detection vectors with each update. editing landmark geometry locally allows for minimal tampering and the inability to break with updates.

> for the full reverse-engineering process (capturing traffic, getting past cloudflare, deobfuscating the bundle, decoding the binary frame, and reversing the scoring pipeline), see the [writeup](writeup.md).

## 1. typical scripts

a typical paid script for this patches the reported scores by intercepting the websocket message.
`{"type":"score_update","payload":{"score":5.7}}` and changing the 5.7 to 8.5

however, with the newest update:

- the readable `score_update` / `score_submit` messages are SECONDARY
- the client also streams raw facial landmarks to the server every 500 ms in a binary frame
- ^ server can recompute score from those landmarks, checking for inconsistencies and handing out bans

so if you boost the readable number but leave landmarks untouched, there is now a contradiction

we just need to attack the single source of truth, ++the landmarks themselves++. :)

## 2. architecture

this is what a deobfuscated version of omoggle's (poorly coded) per-frame loop looks like:

```js
m = faceLandmarker.detectForVideo(video, performance.now());
let j = m.faceLandmarks?.[0] ?? null;  // the landmark array with about 478 points {x,y,z}
if (j && j.length >= 468) {
  let e = computeMetrics(j, {videoWidth, videoHeight, ...});  // geometry to metrics to overall score
  // ^ this drives the on screen score, SCAN_STATE (data channel to opponent), and the binary ws frame
}
```

this means that every consumer of the score: the ui, p2p `SCAN_STATE`, and the binary telemetry all read from the same `j`. if we can mutate `j` once, immediately after `detectForVideo` returns, then everything downstream will be derived from our modified geometry, allowing everything to remain mutually consistent.

therefore we only wrap one function:

```js
FaceLandmarker.prototype.detectForVideo
```

## 3. scoring pipeline

how does this fancy system score your face anyways?

well, it computes a 0-10 `overall` score from the given landmarks.

reproduced roughly from bundle:

```text
#normalization
i  = videoWidth / videoHeight                 # for aspect correction
o(p)  = { x: p.x * i, y: p.y }                # stretch x into a square frame
roll  = angle(o[10], o[152]) - 90             # determine head roll from forehead(10) to chin(152)
p(idx) = rotate(o[idx], around nose o[1], by -roll)   # get non rotated and upright face

# metrics
canthalTilt (eyes) = -avg( angle(33,133), angle(362,263))
jawWidth           = maxJawPairDist / faceHeight(10,152)
symmetry           = 100 * (1 - asymmetry / 0.09)
midfaceRatio       = |lip(0).y - eyeLineY| / faceHeight
cheekboneWidth     = cheekWidth(234,454) / jawWidth
eyeAspectRatio     = avg(eyeHeight/eyeWidth, left & right)
eyeSpacing         = dist(133,362) / faceWidth

# subscores from band-mapping F() & a weighted sum
harmony J = .18*jaw + .24*midface + .18*cheek + .16*eyeAsp + .24*F(spacing)
Z = .12*eyes + .14*jaw + .024*symmetry + .14*midface + .1*cheek + .08*eyeAsp + .18*J
overall = round( 10 * clamp(Z * qualityMultiplier, 1.1, 10) ) / 10
```

two *very* popular helper functions:

```js
A = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);          // distance
D = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * 180/pi;  // angle in deg
```

`overall` rises when the metrics land inside their ideal bands, so we just move the landmarks such that each metric sits at the center of its band!

(`qualityMultiplier` is a separate gate that comes from pose/centering/stillness, capping the final score.)

---

## 4. morph algorithm

`morphLandmarks(lm, videoW, videoH, strength)` mutates the existing landmark array. fear not, it operates in
the same aspect corrected and de‑rotated space that the app uses, so each adjustment maps directly to the metric.

### 3 steps for a man, 1 step for mankind

1. compute aspect `i`, head roll `c`, nose center `d` and project the *touched* indices into p‑space with `p(idx)`.
  don't forget to save the original raw coordinates for the final blend!
  additionally, our references: (forehead `10`, chin `152`, nose `1`) are read but we don't move them since they fix scale and orientation for us.
2. per-metric adjustments with each pushing one metric toward its band center (as previously explained)
  - for eye aspect, set the vertical eyelid gap = `0.26 * eyeWidth` for each eye (indices 159/145, 386/374).
  - for jaw width, scale the jaw points (172/397, 150/379, 171/396) horizontally about the face axis so `jawWidth/faceHeight` goes towards `0.68`.
  - for cheekbone width, scale cheek points (234, 454) so `cheekWidth/jawWidth` goes towards `1.14`.
  - for midface ratio, move the upper‑lip point (0) vertically so `|lip.y - eyeLine| / faceHeight` goes towards `0.305`.
  - for symmetry, each of the 19 symmetric landmark pairs must be equalized such that each point's distance from the vertical/horizontal center to asymmetry to 0 to symmetry to 100.
  - for canthal tilt, rotate each eye‑corner line (33 to 133, 362 to 263) so its angle reaches the value that yields tilt roughly 4.25.
3. invert and blend by projecting each adjusted point back to raw normalized coordinates
  equationally, this looks like adding c, dividing x by i, and then linearly interpolating between the real and ideal positions by `strength`

---

## 5. controls


| key                                    | result                 |
| -------------------------------------- | ---------------------- |
| `=` / `+`                              | strength +5%           |
| `-` / `_`                              | strength −5%           |
| `0`                                    | reset to default (50%) |
| left/right screen edge tap (on mobile) | −/+ strength           |


console usage (`window.__fluox`):

```js
__fluox.strength            // strength value
__fluox.setStrength(0.7)    // unnecessary mutator (shoutout ap csa)
__fluox.bump(+0.05)         // increase
__fluox.reset()             // reset
__fluox.ops                 // toggles: { tilt, eyeAspect, jaw, cheekbone, midface, symmetry }
__fluox.targets             // ideal band centers
__fluox.diagnose()          // { hooked, classLabel, framesMorphed, lastVideo, lastError, webpackReq, ... } (mostly for debugging)
```

