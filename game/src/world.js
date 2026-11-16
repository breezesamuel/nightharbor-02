// Nightharbor: the visible level.
// Owns: turning mapdata.js into meshes, colliders, shootables, nav, sites, lamps,
// atmosphere, water and charge strips. Everything is static; step(dt) animates only
// water drift and strip pulse with zero allocation, updateShadows() is a reserved no-op.
//
// Module map:
//   1. seeded noise + canvas baking ............ mulberry32, paintCanvas, bake
//   2. procedural painters ..................... one painter per surface kind
//   3. texture and material caches ............. bake(), makeMaterial(), materialFor()
//   4. texel density ........................... repeatsFor()
//   5. props ................................... puddleMat(), buildProps()
//   6. signs ................................... paintSign(), buildSigns()
//   7. water ................................... buildWater()
//   8. atmosphere .............................. buildSky(), buildLighting()
//   9. entry point ............................. createWorld()
import * as THREE from 'three';
import { BOXES, PROPS, SIGNS, LAMPS, NAV, SITES, SPAWNS } from './mapdata.js';
import { PALETTE } from './palette.js';

// ---- shared numeric constants -------------------------------------------------
// Every tunable lives here so the painters and builders below read as intent
// rather than as columns of unexplained numbers.

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Bake sizes. Large surfaces get 512, small trim/hazard plates 256, the lamp
// glow 64 (it is a smooth gradient and gains nothing from more texels).
const TEXTURE_SIZE = 512;
const SMALL_TEXTURE_SIZE = 256;
const LAMP_TEXTURE_SIZE = 64;
const SKY_TEXTURE_SIZE = 256;

// Canvas bake grade: a night scene is dark because of its light budget, not
// because its albedo is charcoal, so each bake is lifted once after painting.
const BAKE_LIFT = 2.4;
const BAKE_CONTRAST = 1.06;

// A fixed, modest anisotropy. Textures are baked once at module load (and cached
// by kind), so the value cannot be raised later from the renderer's limits.
const ANISO = 4;

// Light budget.
const MAX_POINT_LIGHTS = 8;
const LAMP_GAIN = 40;

// Water and sky extents.
const WATER_SIZE = 420;
const WATER_Y = -0.35;
const WATER_REPEAT = 40;
const DEEP_SIZE = 700;
const DEEP_Y = -0.4;
const SKY_RADIUS = 400;
const FOG_NEAR = 40;
const FOG_FAR = 220;

// Level bounds handed to gameplay code (respawn clamps, HUD map).
const BOUNDS_MIN = { x: -28, y: 0, z: -36 };
const BOUNDS_MAX = { x: 28, y: 7, z: 36 };

// Charge-strip pulse: ~2.2 Hz, colour scaled between roughly 0.45x and 1.35x.
const STRIP_PULSE_HZ = 2.2;
const STRIP_PULSE_MIN = 0.45;
const STRIP_PULSE_AMP = 0.9;

// Water drift, in UV units per second.
const DRIFT_A_X = 0.004;
const DRIFT_B_X = -0.0027;
const DRIFT_B_Y = 0.0019;

// Box ids that identify the two charge strips; matched by prefix.
const STRIP_ID_PREFIXES = ['a-charge-strip', 'b-charge-strip'];
const GROUND_BOX_ID = 'ground';
const CHARGE_CRATE_BY_SITE = { a: 'a-charge', b: 'b-charge' };

// ---- 1. seeded noise + canvas baking ------------------------------------------

/**
 * Tiny mulberry32 PRNG. The level must look pixel-identical on every load, so
 * every painter seeds its own stream instead of using Math.random.
 * @param {number} seed any 32-bit integer
 * @returns {() => number} generator in [0, 1)
 */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paint one square canvas of the given size and optionally lift it once.
 * @param {number} size canvas edge in pixels
 * @param {(ctx: CanvasRenderingContext2D, size: number) => void} painter
 * @param {number} [lift] brightness multiplier; 1 skips the lift pass (already hot)
 * @returns {HTMLCanvasElement}
 */
function paintCanvas(size, painter, lift = BAKE_LIFT) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('world: 2D canvas context unavailable');
  painter(ctx, size);

  // Lift after painting so every painter keeps its own relative contrast and the
  // key light has something to reflect.
  if (lift !== 1) {
    const copy = document.createElement('canvas');
    copy.width = size;
    copy.height = size;
    const cctx = copy.getContext('2d');
    if (cctx) {
      cctx.filter = `brightness(${lift}) contrast(${BAKE_CONTRAST})`;
      cctx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(copy, 0, 0);
    }
  }
  return canvas;
}

/**
 * Wrap a baked canvas in a texture configured once: repeated, sRGB, mipmap-filtered
 * so large flat surfaces (asphalt, concrete) stay clean at a distance.
 * @param {HTMLCanvasElement} canvas
 * @returns {THREE.CanvasTexture}
 */
function textureFromCanvas(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Paint and wrap in one call. Used for one-off textures (water ripples) where a
 * per-kind canvas cache would only add indirection.
 * @param {number} size
 * @param {(ctx: CanvasRenderingContext2D, size: number) => void} painter
 * @param {number} [lift]
 * @returns {THREE.CanvasTexture}
 */
function bakeTexture(size, painter, lift = BAKE_LIFT) {
  return textureFromCanvas(paintCanvas(size, painter, lift));
}

// ---- 2. procedural paint: each surface is a seeded canvas bake ------------------

/** Damp cast concrete: blotchy weathering, aggregate speckle, form lines. */
function paintConcrete(ctx, s) {
  const rnd = mulberry32(101);
  ctx.fillStyle = '#23292c';
  ctx.fillRect(0, 0, s, s);
  // a dozen soft darker blotches read as weathering, not noise
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.12 + rnd() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(8, 11, 13, 0.4)');
    g.addColorStop(1, 'rgba(8, 11, 13, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, s * (0.2 + 0.2 * i));
    ctx.lineTo(s, s * (0.2 + 0.2 * i));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, s / 1.5, s, s / 3); // darker bottom-third band
  for (let i = 0; i < 2; i++) {
    const x = s * (0.2 + 0.5 * rnd());
    ctx.fillStyle = 'rgba(10, 8, 6, 0.35)';
    ctx.fillRect(x, 0, 3, s);
  }
}

/** Standing water film: cool sheen pools, dark pits, thin run-off streaks. */
function paintWet(ctx, s) {
  const rnd = mulberry32(202);
  ctx.fillStyle = '#1a2226';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 7; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.2 + rnd() * 0.35);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(90, 110, 120, 0.14)');
    g.addColorStop(1, 'rgba(90, 110, 120, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 1 + rnd() * 3, 0, TAU);
    ctx.fill();
  }
  // narrow sheen lines: standing water catching the sodium light
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const y = rnd() * s;
    ctx.strokeStyle = 'rgba(200, 225, 235, 0.35)';
    ctx.lineWidth = 1 + rnd() * 1.5;
    ctx.beginPath();
    ctx.moveTo(rnd() * s * 0.4, y);
    ctx.lineTo(s * (0.5 + rnd() * 0.45), y + (rnd() - 0.5) * 8);
    ctx.stroke();
  }
}

/** Harbour asphalt: low-frequency tonal drift, aggregate grit, hairline cracks. */
function paintAsphalt(ctx, s) {
  const rnd = mulberry32(303);
  ctx.fillStyle = '#14191c';
  ctx.fillRect(0, 0, s, s);
  // low-frequency tonal variation keeps big pavement areas from looking flat
  for (let i = 0; i < 22; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.2 + rnd() * 0.4);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(45, 50, 55, 0.12)' : 'rgba(0,0,0,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 6000; i++) {
    const v = 30 + Math.floor(rnd() * 90);
    ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.05)';
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  // one or two lighter aggregate stones
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = 'rgba(140, 140, 135, 0.5)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 4 + rnd() * 4, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  for (let c = 0; c < 3; c++) {
    let x = rnd() * s;
    let y = rnd() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 8; j++) {
      x += (rnd() - 0.5) * 90;
      y += (rnd() - 0.5) * 90;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Corrugated cladding: sixteen ribs, then rust streaks running down from the top. */
function paintSteel(ctx, s) {
  const rnd = mulberry32(404);
  ctx.fillStyle = '#2b3440';
  ctx.fillRect(0, 0, s, s);
  // vertical corrugation: 16 ribs, a light edge then a dark edge 1-2 px wide
  const step = s / 16;
  for (let i = 0; i < 16; i++) {
    const x = i * step + step * 0.45;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, 0, 1, s);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 1, 0, 2, s);
  }
  // rust streaks running down from the top at random x, fading out
  for (let i = 0; i < 9; i++) {
    const x = rnd() * s;
    const len = s * (0.2 + rnd() * 0.55);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(110, 65, 32, 0.45)');
    g.addColorStop(1, 'rgba(110, 65, 32, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 2 + rnd() * 3, len);
  }
}

/** Oxidised plate: patchy corrosion, a rivet grid on a 64 px pitch, run-down stains. */
function paintRust(ctx, s) {
  const rnd = mulberry32(505);
  ctx.fillStyle = '#46311f';
  ctx.fillRect(0, 0, s, s);
  const patches = ['#5b3f28', '#2f2116'];
  for (let i = 0; i < 46; i++) {
    ctx.fillStyle = patches[i % 2];
    ctx.globalAlpha = 0.2 + rnd() * 0.3;
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 10 + rnd() * 55, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // rivet dots every 64 px, horizontal rows
  ctx.fillStyle = 'rgba(15, 10, 6, 0.65)';
  for (let y = 32; y < s; y += 64) {
    for (let x = 32; x < s; x += 64) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, TAU);
      ctx.fill();
    }
  }
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    const len = s * (0.15 + rnd() * 0.5);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(25, 16, 10, 0.45)');
    g.addColorStop(1, 'rgba(25, 16, 10, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, s * 0.05, 2 + rnd() * 2, len);
  }
}

/**
 * Ship container side: 24 ribs, a paint patch, a stencilled number and rust bites.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} s canvas edge in pixels
 * @param {string} base body colour as a CSS colour
 * @param {number} seed PRNG seed, unique per container colour
 */
function paintContainer(ctx, s, base, seed) {
  const rnd = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  // 24 ribs with a highlight on the left edge of each
  const step = s / 24;
  for (let i = 0; i < 24; i++) {
    const x = i * step + step * 0.3;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, 0, 3, s);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(x + 4, 0, 2, s);
  }
  // lighter painted plate near the top left
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(s * 0.05, s * 0.07, s * 0.3, s * 0.15);
  // stencilled two-digit number in a contrasting colour
  ctx.font = 'bold ' + Math.floor(s * 0.3) + 'px monospace';
  ctx.fillStyle = 'rgba(235, 230, 215, 0.8)';
  ctx.fillText(String(10 + Math.floor(rnd() * 89)), s * 0.08, s * 0.45);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, s * 0.88, s, s * 0.12);
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = 'rgba(95, 58, 30, 0.35)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 3 + rnd() * 9, 0, TAU);
    ctx.fill();
  }
}

/** Wooden pallet crate: five slats, grain lines, dark nail heads, one brace. */
function paintCrate(ctx, s) {
  const rnd = mulberry32(606);
  ctx.fillStyle = '#42392c';
  ctx.fillRect(0, 0, s, s);
  // five horizontal slats with darker gaps between them
  const slat = s / 5;
  for (let i = 0; i < 5; i++) {
    const y = i * slat;
    ctx.fillStyle = i % 2 ? '#4b4030' : '#463b2b';
    ctx.fillRect(0, y + 3, s, slat - 6);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, y + slat - 3, s, 6);
    ctx.strokeStyle = 'rgba(25, 18, 10, 0.5)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const gy = y + slat * (0.25 + 0.25 * g);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(s, gy + (rnd() - 0.5) * 5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(15, 10, 6, 0.9)';
    ctx.beginPath();
    ctx.arc(s * 0.14, y + slat * 0.5, 4, 0, TAU);
    ctx.arc(s * 0.86, y + slat * 0.5, 4, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(s * 0.06, s * 0.06);
  ctx.lineTo(s * 0.94, s * 0.94);
  ctx.stroke();
}

/** Hazard chevrons: diagonal black bands on yellow, scuffed by abrasion. */
function paintHazard(ctx, s) {
  const rnd = mulberry32(707);
  ctx.fillStyle = '#b8912f';
  ctx.fillRect(0, 0, s, s);
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#14110c';
  const band = s / 3;
  for (let x = -s; x < s * 1.5; x += band * 2) {
    ctx.fillRect(x, -s, band, s * 2);
  }
  ctx.restore();
  for (let i = 0; i < 350; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.05 + rnd() * 0.12) + ')';
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/** Near-black machinery paint: faint scratches plus a lighter top edge. */
function paintDark(ctx, s) {
  const rnd = mulberry32(808);
  ctx.fillStyle = '#0c0f12';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = 'rgba(150, 165, 175, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    ctx.beginPath();
    ctx.moveTo(x, rnd() * s);
    ctx.lineTo(x + 20 + rnd() * 50, rnd() * s);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(140, 155, 165, 0.18)';
  ctx.fillRect(0, 0, s, 3);
}

/** Lamp lens: hot sodium core fading to amber, no noise (it is seen from far off). */
function paintLamp(ctx, s) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, '#fff3d6');
  g.addColorStop(1, '#ffb257');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

// ---- 3. texture and material caches --------------------------------------------

/**
 * Bake recipe per surface kind. Each painter is deterministic, so the canvas is
 * painted once per kind and reused by every material that repeats it.
 * @type {Record<string, {size: number, paint: Function, lift: number}>}
 */
const TEXTURE_SPECS = {
  concrete: { size: TEXTURE_SIZE, paint: paintConcrete, lift: BAKE_LIFT },
  wet: { size: TEXTURE_SIZE, paint: paintWet, lift: BAKE_LIFT },
  asphalt: { size: TEXTURE_SIZE, paint: paintAsphalt, lift: BAKE_LIFT },
  steel: { size: TEXTURE_SIZE, paint: paintSteel, lift: BAKE_LIFT },
  rust: { size: TEXTURE_SIZE, paint: paintRust, lift: BAKE_LIFT },
  containerTeal: { size: TEXTURE_SIZE, paint: (c, s) => paintContainer(c, s, '#1d5a55', 11), lift: BAKE_LIFT },
  containerOrange: { size: TEXTURE_SIZE, paint: (c, s) => paintContainer(c, s, '#8a3d1c', 12), lift: BAKE_LIFT },
  containerOlive: { size: TEXTURE_SIZE, paint: (c, s) => paintContainer(c, s, '#4a4a2a', 13), lift: BAKE_LIFT },
  crate: { size: TEXTURE_SIZE, paint: paintCrate, lift: BAKE_LIFT },
  hazard: { size: SMALL_TEXTURE_SIZE, paint: paintHazard, lift: BAKE_LIFT },
  dark: { size: SMALL_TEXTURE_SIZE, paint: paintDark, lift: BAKE_LIFT },
  lamp: { size: LAMP_TEXTURE_SIZE, paint: paintLamp, lift: 1 },
};

// One painted canvas per kind: the same surface requested at several repeat
// values shares the pixels instead of re-running a 512 px bake each time.
const paintedCanvases = new Map();

/**
 * Painted canvas for a surface kind, baked on first use.
 * @param {string} kind key of TEXTURE_SPECS
 * @returns {HTMLCanvasElement}
 */
function canvasFor(kind) {
  let canvas = paintedCanvases.get(kind);
  if (canvas) return canvas;
  const spec = TEXTURE_SPECS[kind];
  if (!spec) throw new Error('world: unknown texture kind ' + kind);
  canvas = paintCanvas(spec.size, spec.paint, spec.lift);
  paintedCanvases.set(kind, canvas);
  return canvas;
}

/**
 * A fresh texture for a surface kind. Fresh per call because repeat state lives
 * on the texture, which is exactly what the material cache keys on.
 * @param {string} kind key of TEXTURE_SPECS
 * @returns {THREE.CanvasTexture}
 */
function bake(kind) {
  return textureFromCanvas(canvasFor(kind));
}

// Repeated surfaces share a material so draw calls stay near the budget; the
// repeat is part of the key because texture state lives on the map.
const materialCache = new Map();

/**
 * Build the single material for a surface kind, without repeat state.
 * @param {string} kind key of TEXTURE_SPECS
 * @returns {THREE.Material}
 */
function makeMaterial(kind) {
  if (kind === 'lamp') {
    // lamp fixtures are unlit emissive: basic material, never cast a shadow
    const m = new THREE.MeshBasicMaterial({ map: bake('lamp') });
    m.shadowSide = THREE.DoubleSide;
    return m;
  }
  const m = new THREE.MeshStandardMaterial({ map: bake(kind) });
  switch (kind) {
    case 'concrete':
    case 'asphalt':
      m.roughness = 0.92;
      m.metalness = 0.02;
      break;
    case 'wet':
      m.roughness = 0.35;
      m.metalness = 0.1;
      break;
    case 'steel':
    case 'rust':
      m.roughness = 0.72;
      m.metalness = 0.45;
      break;
    case 'containerTeal':
    case 'containerOrange':
    case 'containerOlive':
      m.roughness = 0.6;
      m.metalness = 0.35;
      break;
    case 'crate':
      m.roughness = 0.9;
      m.metalness = 0;
      break;
    case 'hazard':
      m.roughness = 0.8;
      m.metalness = 0;
      break;
    case 'dark':
      m.roughness = 0.5;
      m.metalness = 0.4;
      break;
    default:
      break;
  }
  return m;
}

/**
 * Cached material for (kind, repeatX, repeatY). Callers must not mutate the
 * returned material; the charge strips clone theirs before tinting.
 * @param {string} kind key of TEXTURE_SPECS
 * @param {number} rx horizontal repeat
 * @param {number} ry vertical repeat
 * @returns {THREE.Material}
 */
function materialFor(kind, rx, ry) {
  const key = kind + '|' + rx + '|' + ry;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = makeMaterial(kind);
    if (mat.map) mat.map.repeat.set(rx, ry);
    materialCache.set(key, mat);
  }
  return mat;
}

// ---- 4. texel density ----------------------------------------------------------

// About one texture per 4 m of concrete/asphalt, per 2.6 m of container face,
// per 1.2 m of crate, per 2 m of steel. For boxes much wider than deep the
// repeat is split across axes so the long faces stay dense.
const METRES_PER_TILE = {
  concrete: 4,
  asphalt: 4,
  container: 2.6,
  crate: 1.2,
  steel: 2,
  rust: 4,
  detail: 2,
};

/**
 * Repeat counts for a box face of the given size.
 * @param {string} mat surface kind
 * @param {number} w width in metres
 * @param {number} h height in metres
 * @param {number} d depth in metres
 * @returns {[number, number]} repeat along the box's u and v axes
 */
function repeatsFor(mat, w, h, d) {
  const tiles = (extent, metres) => Math.max(1, Math.round(extent / metres));
  switch (mat) {
    case 'concrete':
    case 'asphalt':
      return [tiles(w, METRES_PER_TILE.concrete), tiles(h, METRES_PER_TILE.concrete)];
    case 'containerTeal':
    case 'containerOrange':
    case 'containerOlive':
      return [tiles(d, METRES_PER_TILE.container), tiles(w, METRES_PER_TILE.container)];
    case 'crate':
      return [tiles(d, METRES_PER_TILE.crate), tiles(w, METRES_PER_TILE.crate)];
    case 'steel':
      return [tiles(d, METRES_PER_TILE.steel), tiles(w, METRES_PER_TILE.steel)];
    case 'rust':
      return [tiles(w, METRES_PER_TILE.rust), tiles(h, METRES_PER_TILE.rust)];
    case 'wet':
    case 'hazard':
    case 'dark':
      return [tiles(w, METRES_PER_TILE.detail), tiles(d, METRES_PER_TILE.detail)];
    default:
      return [1, 1];
  }
}

// ---- 5. props: instanced meshes for the many, single meshes for the few --------
// Instancing keeps bollards, rings, cones and pallets at one draw call each;
// barrels, cables, lampheads and hooks vary too much in grouping to instance cleanly.

const PUDDLE_RADIUS = 0.7; // at scale 1, before the per-prop radius term
const PUDDLE_RADIUS_GAIN = 0.5;
const PUDDLE_LIFT = 0.02;
const PALLET_RUNNER_Z = 0.3;
const PALLET_RUNNER_Y = 0.02;

/**
 * Puddles reuse the wet map but with their own translucent state: depthWrite off
 * and a polygon offset keep them from z-fighting the ground slab underneath.
 * @param {THREE.Material} wetMat cached wet material whose map is shared
 * @returns {THREE.MeshStandardMaterial}
 */
function puddleMat(wetMat) {
  return new THREE.MeshStandardMaterial({
    map: wetMat.map,
    color: 0x1c2830,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

/**
 * Build every decorative prop from the PROPS table and return the meshes bullets
 * may stop on (pallet slabs/runners and barrel parts).
 * @param {THREE.Group} group level group to add meshes to
 * @returns {THREE.Object3D[]} meshes that belong in world.shootables
 */
function buildProps(group) {
  const steelMat = materialFor('steel', 2, 1);
  const rustMat = materialFor('rust', 2, 1);
  const darkMat = materialFor('dark', 1, 1);
  const hazardMat = materialFor('hazard', 2, 1);
  const crateMat = materialFor('crate', 2, 1);
  const lampMat = materialFor('lamp', 1, 1);
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.6, metalness: 0 });

  const dummy = new THREE.Object3D();
  const runnerMatrix = new THREE.Matrix4();
  const runnerOffset = new THREE.Matrix4();
  const shootableProps = [];

  /**
   * Place one instanced mesh per prop kind that has entries in PROPS.
   * @param {string} kind PROPS kind to batch
   * @param {THREE.BufferGeometry} geometry shared geometry
   * @param {THREE.Material} material shared material
   * @param {number} yOff vertical offset, scaled by the prop's scale
   * @param {boolean} cast whether the batch casts shadows
   */
  function placeInstanced(kind, geometry, material, yOff, cast) {
    const list = PROPS.filter((p) => p.kind === kind);
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    list.forEach((p, i) => {
      const s = p.scale || 1;
      dummy.position.set(p.x, p.y + yOff * s, p.z);
      dummy.rotation.set(0, p.ry || 0, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }

  // bollard: squat tapered steel cylinder, castShadow true
  placeInstanced('bollard', new THREE.CylinderGeometry(0.18, 0.22, 0.55, 12), steelMat, 0.275, true);
  // ring: rust torus laid flat, never casts
  placeInstanced('ring', new THREE.TorusGeometry(0.3, 0.05, 8, 24), rustMat, 0.05, false);

  // cone: traffic cone with a white band ring
  {
    const cones = PROPS.filter((p) => p.kind === 'cone');
    if (cones.length) {
      const body = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.28, 0.7, 14),
        hazardMat,
        cones.length
      );
      body.receiveShadow = true;
      body.castShadow = true;
      const band = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.19, 0.22, 0.12, 14, 1, true),
        whiteMat,
        cones.length
      );
      band.receiveShadow = true;
      band.castShadow = true;
      cones.forEach((p, i) => {
        const s = p.scale || 1;
        dummy.position.set(p.x, p.y + 0.35 * s, p.z);
        dummy.rotation.set(0, p.ry || 0, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);
        dummy.position.y = p.y + 0.42 * s;
        dummy.updateMatrix();
        band.setMatrixAt(i, dummy.matrix);
      });
      group.add(body, band);
    }
  }

  // pallet: slab plus two runner boxes; bullets stop on these
  {
    const pallets = PROPS.filter((p) => p.kind === 'pallet');
    if (pallets.length) {
      const top = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.08, 0.8), crateMat, pallets.length);
      const runners = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.2, 0.06, 0.1),
        crateMat,
        pallets.length * 2
      );
      top.castShadow = true;
      runners.castShadow = true;
      top.receiveShadow = true;
      runners.receiveShadow = true;
      pallets.forEach((p, i) => {
        const s = p.scale || 1;
        dummy.position.set(p.x, p.y + 0.07 * s, p.z);
        dummy.rotation.set(0, p.ry || 0, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        top.setMatrixAt(i, dummy.matrix);
        for (let r = 0; r < 2; r++) {
          dummy.position.y = p.y + PALLET_RUNNER_Y * s;
          dummy.updateMatrix();
          runnerMatrix.copy(dummy.matrix);
          runnerOffset.makeTranslation(0, 0, (r ? PALLET_RUNNER_Z : -PALLET_RUNNER_Z) * s);
          runnerMatrix.multiply(runnerOffset);
          runners.setMatrixAt(i * 2 + r, runnerMatrix);
        }
      });
      group.add(top, runners);
      shootableProps.push(top, runners);
    }
  }

  // barrel: rust cylinder with two darker bands; bullets stop on it
  {
    const barrels = PROPS.filter((p) => p.kind === 'barrel');
    const bandGeo = new THREE.TorusGeometry(0.305, 0.025, 8, 24);
    barrels.forEach((p) => {
      const s = p.scale || 1;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16), rustMat);
      body.position.y = 0.45;
      const b1 = new THREE.Mesh(bandGeo, darkMat);
      b1.rotation.x = HALF_PI;
      b1.position.y = 0.3;
      const b2 = new THREE.Mesh(bandGeo, darkMat);
      b2.rotation.x = HALF_PI;
      b2.position.y = 0.6;
      g.add(body, b1, b2);
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.ry || 0;
      g.scale.setScalar(s);
      g.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      group.add(g);
      shootableProps.push(body, b1, b2);
    });
  }

  // cable: thin dark cylinder hanging at an angle, 1.5 m down from y+0.2
  PROPS.filter((p) => p.kind === 'cable').forEach((p) => {
    const s = p.scale || 1;
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), darkMat);
    cable.position.set(p.x, p.y + 0.2 + 0.75 * s, p.z);
    cable.rotation.z = 0.32 * s;
    cable.scale.set(s, 1, s);
    cable.castShadow = true;
    cable.receiveShadow = true;
    group.add(cable);
  });

  // lamphead: emissive slab with a thin dark housing above; the PointLight sits elsewhere
  PROPS.filter((p) => p.kind === 'lamphead').forEach((p) => {
    const s = p.scale || 1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), lampMat);
    head.position.set(p.x, p.y + 2.6 * s, p.z);
    head.rotation.y = p.ry || 0;
    head.scale.setScalar(s);
    head.castShadow = false;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.36), darkMat);
    housing.position.y = 0.12;
    housing.castShadow = true;
    head.add(housing);
    group.add(head);
  });

  // hook: small torus plus a 0.6 m three-link chain of thin cylinders
  PROPS.filter((p) => p.kind === 'hook').forEach((p) => {
    const s = p.scale || 1;
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 6, 14), steelMat);
    ring.castShadow = true;
    g.add(ring);
    for (let i = 0; i < 3; i++) {
      const link = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 6), steelMat);
      link.position.y = -0.2 * (i + 1);
      link.rotation.x = i % 2 ? HALF_PI : 0;
      link.castShadow = true;
      g.add(link);
    }
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(s);
    group.add(g);
  });

  // puddle: wet disc floating just above the ground; depthWrite off so it never
  // z-fights. All puddles share one translucent material.
  let sharedPuddleMat = null;
  PROPS.filter((p) => p.kind === 'puddle').forEach((p) => {
    const s = p.scale || 1;
    const r = PUDDLE_RADIUS + s * PUDDLE_RADIUS_GAIN; // ~1.4-2.6 m across
    if (!sharedPuddleMat) sharedPuddleMat = puddleMat(materialFor('wet', 1, 1));
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(r, 24), sharedPuddleMat);
    puddle.rotation.x = -HALF_PI;
    puddle.position.set(p.x, p.y + PUDDLE_LIFT, p.z);
    puddle.renderOrder = 2;
    group.add(puddle);
  });

  return shootableProps;
}

// ---- 6. signs: painted plates on double-sided quads, never colliders -----------

const SIGN_DEFAULT_W = 2;
const SIGN_DEFAULT_H = 1;
const SIGN_FONT_PX = 72;
const SIGN_GAP_PX = 14;
const SIGN_LINE_HEIGHT_PX = 110;

/**
 * Paint one sign plate: dark backing, letter-spaced uppercase text, worn specks.
 * @param {string} text plate copy; a space splits it over two lines
 * @param {string} colourName PALETTE key for the lettering
 * @param {boolean} twoLine whether to split the text across two lines
 * @returns {THREE.CanvasTexture}
 */
function paintSign(text, colourName, twoLine) {
  const h = twoLine ? 256 : 128;
  const w = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('world: 2D canvas context unavailable');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(5, 8, 10, 0.85)';
  ctx.fillRect(0, 0, w, h);
  const rnd = mulberry32(String(text).length * 31);
  const lines = twoLine ? String(text).split(' ', 2) : [String(text)];
  const colour = new THREE.Color(PALETTE[colourName] || PALETTE.ink);
  ctx.fillStyle = '#' + colour.getHexString();
  ctx.font = 'bold ' + SIGN_FONT_PX + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // letter-spaced uppercase: draw char by char with a fixed gap
  lines.forEach((line, li) => {
    const chars = line.toUpperCase().split('');
    let width = 0;
    for (const ch of chars) width += ctx.measureText(ch).width + SIGN_GAP_PX;
    let x = w / 2 - width / 2;
    const y = twoLine ? 64 + li * SIGN_LINE_HEIGHT_PX : h / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x + ctx.measureText(ch).width / 2, y);
      x += ctx.measureText(ch).width + SIGN_GAP_PX;
    }
  });
  // a few erase specks: worn plate
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = 'rgba(5, 8, 10, ' + (0.4 + rnd() * 0.4) + ')';
    ctx.beginPath();
    ctx.arc(rnd() * w, rnd() * h, 2 + rnd() * 5, 0, TAU);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;
  return tex;
}

/**
 * Build every world-space sign from the SIGNS table (unlit, unlit quads).
 * @param {THREE.Group} group level group to add meshes to
 */
function buildSigns(group) {
  for (const s of SIGNS) {
    const twoLine = typeof s.text === 'string' && s.text.includes(' ');
    const w = Number.isFinite(s.w) ? s.w : SIGN_DEFAULT_W;
    const h = Number.isFinite(s.h) ? s.h : SIGN_DEFAULT_H;
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      map: paintSign(s.text, s.colour, twoLine),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y, s.z);
    // ry convention: 0 faces -z, so the readable face points at whoever is on the +z side
    mesh.rotation.y = s.ry || 0;
    mesh.renderOrder = 3;
    group.add(mesh);
  }
}

// ---- 7. water: two drifting ripple layers plus a dark depth plane beneath ------

const RIPPLE_TEXTURE_SIZE = 256;

/**
 * One ripple layer: faint concentric rings plus short surface strokes, on a
 * transparent ground so it can be stacked as a map or an emissive map.
 * @param {number} seed PRNG seed; the two layers use different values
 * @returns {THREE.CanvasTexture}
 */
function rippleTexture(seed) {
  return bakeTexture(RIPPLE_TEXTURE_SIZE, (ctx, s) => {
    const rnd = mulberry32(seed);
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 24; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const r = 8 + rnd() * 30;
      ctx.strokeStyle = i % 2 ? 'rgba(90, 140, 160, 0.14)' : 'rgba(50, 95, 120, 0.16)';
      ctx.lineWidth = 1 + rnd() * 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
    }
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      ctx.strokeStyle = 'rgba(120, 170, 190, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 10 + rnd() * 22, y + (rnd() - 0.5) * 6);
      ctx.stroke();
    }
  });
}

/**
 * Build the harbour water: a large rippled plane plus a near-black depth plane.
 * The two ripple textures are animated by createWorld's step().
 * @param {THREE.Group} group level group to add meshes to
 * @returns {{texA: THREE.Texture, texB: THREE.Texture, t: number}}
 */
function buildWater(group) {
  const texA = rippleTexture(9);
  const texB = rippleTexture(10);
  texA.repeat.set(WATER_REPEAT, WATER_REPEAT);
  texB.repeat.set(WATER_REPEAT, WATER_REPEAT);
  // a second texture on a stacked material: the two layers drift at different rates
  const mat = new THREE.MeshStandardMaterial({
    color: 0x06161a,
    roughness: 0.22,
    metalness: 0.15,
    map: texA,
  });
  mat.emissiveMap = texB;
  mat.emissive = 0x0a1c22;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE), mat);
  plane.rotation.x = -HALF_PI;
  plane.position.y = WATER_Y;
  plane.receiveShadow = true;
  group.add(plane);

  const deep = new THREE.Mesh(
    new THREE.PlaneGeometry(DEEP_SIZE, DEEP_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x03090c, roughness: 0.9, metalness: 0.2 })
  );
  deep.rotation.x = -HALF_PI;
  deep.position.y = DEEP_Y;
  group.add(deep);

  return { texA, texB, t: 0 };
}

// ---- 8. atmosphere: sky dome, key light, fill lights ---------------------------

/** Vertical night gradient with a low sodium glow on the north side. */
function buildSky(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = SKY_TEXTURE_SIZE;
  canvas.height = SKY_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('world: 2D canvas context unavailable');
  const g = ctx.createLinearGradient(0, SKY_TEXTURE_SIZE, 0, 0);
  g.addColorStop(0, '#060a0c');
  g.addColorStop(1, '#16242c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SKY_TEXTURE_SIZE, SKY_TEXTURE_SIZE);
  const glow = ctx.createRadialGradient(128, 210, 4, 128, 210, 130);
  glow.addColorStop(0, 'rgba(255, 178, 87, 0.30)');
  glow.addColorStop(1, 'rgba(255, 178, 87, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SKY_TEXTURE_SIZE, SKY_TEXTURE_SIZE);

  const skyTex = new THREE.CanvasTexture(canvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
  );
  scene.add(dome);
}

/**
 * Warm shadow-casting key, cool shadowless counter-fill, hemisphere and ambient.
 * Three.js lights are physical: intensity is candela, so these are authored as
 * real harbour values rather than 0..1 mixers.
 * @param {THREE.Scene} scene
 */
function buildLighting(scene) {
  const KEY_COLOUR = 0xffd9a8;
  const KEY_INTENSITY = 3.4;
  const KEY_POS = { x: -40, y: 60, z: -50 };
  const SHADOW_MAP = 2048;
  const SHADOW_SIDE_X = 34;
  const SHADOW_SIDE_Z = 44;
  const SHADOW_NEAR = 1;
  const SHADOW_FAR = 170;
  const SHADOW_BIAS = -0.0006;
  const SHADOW_NORMAL_BIAS = 0.02;
  const FILL_COLOUR = 0x9fc0dd;
  const FILL_INTENSITY = 0.6;
  const FILL_POS = { x: 48, y: 38, z: 62 };
  const FILL_TARGET = { x: 0, y: 0, z: -6 };

  const sun = new THREE.DirectionalLight(KEY_COLOUR, KEY_INTENSITY);
  sun.position.set(KEY_POS.x, KEY_POS.y, KEY_POS.z);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.left = -SHADOW_SIDE_X;
  sun.shadow.camera.right = SHADOW_SIDE_X;
  sun.shadow.camera.top = SHADOW_SIDE_Z;
  sun.shadow.camera.bottom = -SHADOW_SIDE_Z;
  sun.shadow.camera.near = SHADOW_NEAR;
  sun.shadow.camera.far = SHADOW_FAR;
  sun.shadow.bias = SHADOW_BIAS;
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x24323c, 0x0a0f12, 1.9);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x223038, 0.55);
  scene.add(ambient);

  // A cool counter-fill with no shadow: the warm key carves the north faces, this keeps
  // the south and east faces from collapsing into a single black shape at night.
  const moon = new THREE.DirectionalLight(FILL_COLOUR, FILL_INTENSITY);
  moon.position.set(FILL_POS.x, FILL_POS.y, FILL_POS.z);
  moon.target.position.set(FILL_TARGET.x, FILL_TARGET.y, FILL_TARGET.z);
  moon.castShadow = false;
  scene.add(moon, moon.target);
}

// ---- 9. main entry: build the whole visible level -------------------------------

/**
 * Is this box id one of the two animated charge strips?
 * @param {string} id box id
 * @returns {boolean}
 */
function isStripId(id) {
  if (typeof id !== 'string') return false;
  return STRIP_ID_PREFIXES.some((prefix) => id.indexOf(prefix) === 0);
}

/**
 * Build the complete static harbour level and return the handles the rest of the
 * game reads: collision boxes, bullet targets, the nav graph, site records, spawns,
 * lamp records, world bounds, the per-frame animator and the shadow-camera seam.
 *
 * Everything is added to `scene` (or to one child group of it); nothing here is
 * disposed, so a world is built once per page load.
 *
 * @param {THREE.Scene} scene live scene owned by main.js
 * @returns {{
 *   group: THREE.Group,
 *   colliders: THREE.Box3[],
 *   shootables: THREE.Object3D[],
 *   nav: { nodes: object, edges: Array<[string, string]>, byName: object },
 *   sites: object,
 *   spawns: object,
 *   lamps: Array<{ x: number, y: number, z: number, colour: number,
 *                  intensity: number, distance: number, position: THREE.Vector3 }>,
 *   bounds: THREE.Box3,
 *   step: (dt: number) => void,
 *   updateShadows: () => void
 * }}
 */
export function createWorld(scene) {
  if (!scene || typeof scene.add !== 'function') {
    throw new TypeError('createWorld(scene): a THREE.Scene is required');
  }

  const group = new THREE.Group();
  scene.add(group);

  const colliders = [];
  const shootables = [];

  // --- boxes: one mesh each, materials shared through the cache ------------------
  // Lamp boxes are never colliders and never shootable: they are unlit emissive
  // fixtures that the charge-strip pulse animates via their basic material colour.
  const meshById = {};
  for (const b of BOXES) {
    const isLamp = b.mat === 'lamp';
    const isGround = b.id === GROUND_BOX_ID;
    const [rx, ry] = isLamp ? [1, 1] : repeatsFor(b.mat, b.w, b.h, b.d);
    const mat = materialFor(b.mat, rx, ry);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = isLamp || isGround ? false : b.cast !== false;
    mesh.receiveShadow = true; // every surface receives; the ground slab only receives
    group.add(mesh);
    meshById[b.id] = mesh;
    if (b.move && !isLamp) colliders.push(new THREE.Box3().setFromObject(mesh));
    if (b.bullet && !isLamp) shootables.push(mesh);
  }

  // --- props: instanced + single meshes, barrels and pallets stop bullets --------
  const stopProps = buildProps(group);
  shootables.push(...stopProps);

  // --- signs --------------------------------------------------------------------
  buildSigns(group);

  // --- point lights: capped, no shadows; fixtures are the lamp boxes ------------
  // The gain turns the authored relative lamp values into real harbour-lamp pools
  // without changing their ratios.
  const lightDefs = LAMPS.slice(0, MAX_POINT_LIGHTS);
  const lampOut = [];
  for (const l of lightDefs) {
    const pl = new THREE.PointLight(l.colour, l.intensity * LAMP_GAIN, l.distance, 2);
    pl.position.set(l.x, l.y, l.z);
    pl.castShadow = false;
    group.add(pl);
    lampOut.push({ ...l, position: new THREE.Vector3(l.x, l.y, l.z) });
  }

  // --- atmosphere: night background, fog, sky dome, key light, fill -------------
  scene.background = new THREE.Color(PALETTE.night);
  scene.fog = new THREE.Fog(PALETTE.night, FOG_NEAR, FOG_FAR);
  buildSky(scene);
  buildLighting(scene);

  // --- water --------------------------------------------------------------------
  const water = buildWater(group);

  // --- charge strips: hold base colours, pulse emissive on the existing materials
  // The two strip ids are resolved at build time; step(dt) only scales their
  // existing basic-material colour.
  const strips = [];
  for (const b of BOXES) {
    if (!isStripId(b.id)) continue;
    const m = meshById[b.id];
    if (!m) continue;
    // strips share one cached lamp material; give each its own colour to pulse from
    m.material = m.material.clone();
    strips.push({ mesh: m, base: m.material.color.clone() });
  }

  /**
   * Advance the two cheap animations: water drift and the strip pulse. Allocates
   * nothing and never touches the light rig.
   * @param {number} dt seconds since the previous frame
   */
  function step(dt) {
    water.t += dt;
    // two textures drift at slightly different rates and directions: the surface
    // appears to move, nothing is allocated or recreated here
    water.texA.offset.x += dt * DRIFT_A_X;
    water.texB.offset.x += dt * DRIFT_B_X;
    water.texB.offset.y += dt * DRIFT_B_Y;
    // ~2.2 Hz sine pulse on the emissive colour, no lighting change
    const pulse = 0.5 + 0.5 * Math.sin(water.t * STRIP_PULSE_HZ * TAU);
    const scale = STRIP_PULSE_MIN + STRIP_PULSE_AMP * pulse;
    for (let i = 0; i < strips.length; i++) {
      strips[i].mesh.material.color.copy(strips[i].base).multiplyScalar(scale);
    }
  }

  // --- nav: expose node links so A* walks an adjacency list instead of scanning edges
  const byName = {};
  for (const name of Object.keys(NAV.nodes)) {
    const node = NAV.nodes[name];
    byName[name] = {
      name,
      x: node.x,
      y: node.y,
      z: node.z,
      links: [],
    };
  }
  for (const [a, b] of NAV.edges) {
    if (byName[a]) byName[a].links.push(b);
    if (byName[b]) byName[b].links.push(a);
  }

  // --- sites: attach the charge crate's world position to each site record ------
  const sitesOut = {};
  for (const key of Object.keys(SITES)) {
    const site = { ...SITES[key] };
    const crateId = CHARGE_CRATE_BY_SITE[key];
    const crate = crateId ? meshById[crateId] : undefined;
    const halfHeight =
      crate && crate.geometry && crate.geometry.parameters
        ? crate.geometry.parameters.h / 2
        : 0.3;
    site.charge = crate
      ? new THREE.Vector3(crate.position.x, crate.position.y + halfHeight, crate.position.z)
      : new THREE.Vector3(site.plant.x, site.plant.y + 0.3, site.plant.z);
    sitesOut[key] = site;
  }

  const bounds = new THREE.Box3(
    new THREE.Vector3(BOUNDS_MIN.x, BOUNDS_MIN.y, BOUNDS_MIN.z),
    new THREE.Vector3(BOUNDS_MAX.x, BOUNDS_MAX.y, BOUNDS_MAX.z)
  );

  return {
    group,
    colliders,
    shootables,
    nav: { nodes: NAV.nodes, edges: NAV.edges, byName },
    sites: sitesOut,
    spawns: SPAWNS,
    lamps: lampOut,
    bounds,
    step,
    // reserved for a later module that moves the shadow camera with the player
    updateShadows() {},
  };
}
