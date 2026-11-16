// Owns: the single colour source for NIGHTHARBOR.
// Owns: the PALETTE table, its low-light NIGHT variant, and the tone(), rgba(),
//       withAlpha() and mix() helpers built on top of them.
// Owns: nothing else — no other colour logic lives here.
import * as THREE from 'three';

/**
 * The harbour at 03:00 — cold sodium light on wet concrete, oxidised steel,
 * and a single teal signal coming off the water. Every colour in the game
 * should come from this table so the whole scene can be re-graded in one edit.
 *
 * Values are grouped by job rather than by hue:
 *   structure  — large surfaces, darkest first
 *   metal      — man-made parts that catch the lamps
 *   signal     — emissive / interactive colours, the only saturated ones
 *   text       — UI and world-space copy
 */
const PALETTE = Object.freeze({
  // Structure: background, ground, walls. Low saturation, low value.
  night: '#0a1216',
  deep: '#101b21',
  concrete: '#1c2429',
  steel: '#2a3441',
  water: '#05141a',

  // Organic decay and worn metal.
  rust: '#4a3527',

  // Signal colours: hazard striping, lamps, sparks, and the tide marker.
  hazard: '#c7a13a',
  sodium: '#ffb257',
  ember: '#ff7a3c',
  tide: '#2fd6c4',

  // Text and UI. `light` is the neutral UI accent, `ink` is body copy.
  ink: '#e8e6df',
  muted: '#8896a0',
  light: '#cfd8dc',
});

/**
 * Low-light variant of the same table, used by the interior sections, the
 * underwater stretch, and the "lights out" set piece. It keeps every key so
 * call sites never change: blacks are crushed, signals are desaturated and
 * dimmed, and the shadows lean further teal. Switching a whole level is just
 * `tone(name, 1, 'night')`.
 */
const NIGHT = Object.freeze({
  night: '#05090b',
  deep: '#0a1216',
  concrete: '#131a1e',
  steel: '#1d252f',
  water: '#020c0f',

  rust: '#33251b',

  hazard: '#8f7529',
  sodium: '#c98a3d',
  ember: '#c85a2a',
  tide: '#1f9c90',

  ink: '#b8b5ab',
  muted: '#5f6b74',
  light: '#9aa5aa',
});

/** Named table variants. `base` is the default look for the whole game. */
const VARIANTS = Object.freeze({ base: PALETTE, night: NIGHT });

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Pick a palette table by variant name. Kept private: call sites should ask
 * for a key, not juggle whole tables.
 * @param {string} [name='base'] variant name, e.g. 'base' or 'night'
 * @returns {Readonly<Record<string, string>>}
 */
function tableFor(name) {
  const table = VARIANTS[name ?? 'base'];
  if (table === undefined) {
    throw new Error(`Unknown palette variant: '${name}'`);
  }
  return table;
}

/**
 * Look up a palette key, failing loudly so a typo never ships as black.
 * @param {string} name key from the palette table
 * @param {string} [variantName='base'] which variant table to read from
 * @returns {string} the hex string as written in the table
 */
function resolve(name, variantName = 'base') {
  const table = tableFor(variantName);
  const value = table[name];
  if (value === undefined) {
    throw new Error(`Unknown palette key: '${name}' in variant '${variantName}'`);
  }
  return value;
}

/**
 * Normalise any accepted hex form ('#abc' or '#aabbcc') into channels.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
function parseHex(hex) {
  if (typeof hex !== 'string' || !HEX_PATTERN.test(hex)) {
    throw new Error(`Expected a hex colour like '#aabbcc', got '${hex}'`);
  }
  let digits = hex.slice(1);
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  };
}

/** Clamp a 0..1 scalar (alpha, blend amount); non-finite values go opaque. */
function clamp01(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build a CSS rgba() string from any hex colour. Accepts the shorthand form
 * so hand-written constants ('#f80') can join the palette without cleanup.
 * @param {string} hex '#aabbcc' or '#abc'
 * @param {number} [alpha=1] clamped to 0..1
 * @returns {string} e.g. 'rgba(47, 214, 196, 0.4)'
 */
function withAlpha(hex, alpha = 1) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

/**
 * CSS rgba() string for a palette key — used for fog cards, decals and DOM UI.
 * @param {string} name key from the palette table
 * @param {number} [alpha=1]
 * @param {string} [variantName='base']
 */
function rgba(name, alpha = 1, variantName = 'base') {
  return withAlpha(resolve(name, variantName), alpha);
}

/**
 * A THREE.Color of a palette key, darkened or brightened by `factor`.
 * Returns a fresh instance — safe to mutate at the call site.
 * @param {string} name key from the palette table
 * @param {number} [factor=1] multiplier applied in linear-ish RGB space
 * @param {string} [variantName='base']
 * @returns {THREE.Color}
 */
function tone(name, factor = 1, variantName = 'base') {
  return new THREE.Color(resolve(name, variantName)).multiplyScalar(factor);
}

/**
 * Blend two palette keys — for fog rims, lamp falloff and gradients where a
 * material travels between two table entries.
 * @param {string} fromName palette key at amount 0
 * @param {string} toName palette key at amount 1
 * @param {number} [amount=0.5] clamped to 0..1
 * @param {string} [variantName='base']
 * @returns {THREE.Color}
 */
function mix(fromName, toName, amount = 0.5, variantName = 'base') {
  const from = new THREE.Color(resolve(fromName, variantName));
  const to = new THREE.Color(resolve(toName, variantName));
  return from.lerp(to, clamp01(amount));
}

export { PALETTE, NIGHT, VARIANTS, tone, rgba, withAlpha, mix, resolve };
