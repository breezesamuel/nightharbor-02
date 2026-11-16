// NIGHTHARBOR: the heads-up display.
// Owns: the #hud overlay canvas, the layout and type scale of every readout,
//       the transient feedback (hit marker, damage flash, kill feed) and the
//       animation clock that fades them.
// Owns: window.__paintHud, the seam the capture task uses to composite this
//       same HUD onto an offline render.
// Reads from: round.state, weapons.state and bots.aliveCount(). Writes nothing
// except the canvas; no gameplay state lives here.
import { PALETTE, rgba, withAlpha } from './palette.js';

/* ==========================================================================
 * 1. Fonts and transient lifetimes
 * ======================================================================= */

/** Monospace stack: every numeric readout uses it so digits never jitter. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** System stack: used only for the team captions beside the score. */
const SYS = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Fuse length in seconds; mirrored from round.js so the charge bar drains 1:1. */
const FUSE_TIME = 40;

/** Seconds the hit marker survives after a plain hit. */
const MARK_HIT = 0.18;
/** Seconds the hit marker survives after a kill (read as "confirmed"). */
const MARK_KILL = 0.35;
/** Seconds for a full-strength damage flash to fade to nothing. */
const FLASH_DECAY = 0.4;
/** Most kill-feed lines kept in memory; older lines roll off the top. */
const FEED_MAX = 4;
/** Seconds a kill-feed line stays eligible to draw. */
const FEED_LIFE = 5;

/* ==========================================================================
 * 2. Canvas sizing
 * ======================================================================= */

const HUD_CANVAS_ID = 'hud';
const MIN_DPR = 1;
const MAX_DPR = 2;

/* ==========================================================================
 * 3. Layout: timer block (top centre)
 * ======================================================================= */

const TIMER_SIZE = 22;
const TIMER_Y = 14;
const SCORE_SIZE = 13;
const SCORE_Y = 42;
const SIDE_SIZE = 9;
const SIDE_Y = 43;
/** Horizontal distance from the centre line to the TIDE / EMBER captions. */
const SIDE_OFFSET = 30;

const PIPS_Y = 58;
const PIPS_X = 46;
const PIP_COUNT = 3;
const PIP_SIZE = 6;
const PIP_STEP = 10;

/* ==========================================================================
 * 4. Layout: crosshair
 * ======================================================================= */

/** Tightest crosshair gap at rest, in CSS pixels. */
const CROSS_MIN_GAP = 9;
/** Extra gap applied at maximum spread. */
const CROSS_SWING = 13;
/** Half-length of each crosshair arm. */
const CROSS_ARM = 3.5;
/** Side of the centre dot. */
const CROSS_DOT = 1.5;
/** Weapon spread that maps to the tightest gap (rifle, standing). */
const SPREAD_MIN = 0.006;
/** Spread range that maps to the full swing (rifle -> shotgun). */
const SPREAD_SPAN = 0.054;

/* ==========================================================================
 * 5. Layout: health and armour (bottom left)
 * ======================================================================= */

/** Health at or below this value pulses red. */
const HP_LOW = 35;
/** Pulse rate of the low-health readout, in radians per second. */
const HP_PULSE = 6;
const HP_SIZE = 34;
const HP_LABEL_SIZE = 10;
const ARMOUR_SIZE = 14;
const HEALTH_X = 24;
/** Baseline offsets measured up from the bottom edge. */
const HP_DY = 36;
const HP_LABEL_DY = 24;
const ARMOUR_X = 92;
const ARMOUR_DY = 40;
const ARMOUR_BOX_X = 86;
const ARMOUR_BOX_Y = 54;
const ARMOUR_BOX_W = 22;
const ARMOUR_BOX_H = 18;
const ARMOUR_STRIPE_Y = 48;
const ARMOUR_STRIPE_X0 = 89;
const ARMOUR_STRIPE_X1 = 105;

/* ==========================================================================
 * 6. Layout: ammo block (bottom right)
 * ======================================================================= */

const AMMO_RIGHT = 24;
const AMMO_DY = 34;
const AMMO_SIZE = 30;
const RESERVE_DY = 14;
const RESERVE_SIZE = 14;
const WEAPON_LABEL_DY = 2;
const WEAPON_LABEL_SIZE = 11;
/** Reload progress bar: right edge, height, and baseline offset from bottom. */
const RELOAD_RIGHT = 116;
const RELOAD_DY = 24;
const RELOAD_W = 92;
const RELOAD_H = 3;

/* ==========================================================================
 * 7. Layout: kill feed, message, charge bar
 * ======================================================================= */

const FEED_TOP = 78;
const FEED_STEP = 18;
const FEED_RIGHT = 20;
const FEED_SIZE = 12;
/** Last part of a line's life spent fading out, in seconds. */
const FEED_FADE = 1.2;
const FEED_BAR_DX = 8;
const FEED_BAR_DY = 1;
const FEED_BAR_W = 2;
const FEED_BAR_H = 10;

/** Message line sits this far down the viewport. */
const MESSAGE_Y_FRAC = 0.18;
/** Seconds of fade at the end of a message's life. */
const MESSAGE_FADE = 0.5;
const MESSAGE_MAX_ALPHA = 0.9;
/** Horizontal breathing room reserved on both sides of the message. */
const MESSAGE_MARGIN = 80;
/** Letter-spaced copy: two hair spaces between glyphs. */
const HAIR_GAP = '\u200a\u200a';

const CHARGE_Y_FRAC = 0.62;
const CHARGE_LABEL_DY = 10;
const CHARGE_BAR_W = 220;
const CHARGE_BAR_H = 2;

/* ==========================================================================
 * 8. Layout: damage flash
 * ======================================================================= */

/** Inner radius of the vignette, as a fraction of the short edge. */
const FLASH_INNER_FRAC = 0.32;
/** Outer radius of the vignette, as a fraction of the long edge. */
const FLASH_OUTER_FRAC = 0.62;
const FLASH_CLEAR = 'rgba(190, 20, 10, 0)';
const FLASH_TINT = 'rgba(190, 20, 10, 0.55)';
const FLASH_ARC_COLOR = 'rgba(255, 60, 40, 0.8)';
/** Offset and radius of the directional arc, share of the short edge. */
const FLASH_ARC_FRAC = 0.16;
const FLASH_ARC_RADIUS = 0.9;
const FLASH_ARC_WIDTH = 4;

/** Scrim painted under the "down" card. */
const DOWN_SCRIM = 'rgba(2, 4, 6, 0.35)';

/* ==========================================================================
 * 9. Small utilities
 * ======================================================================= */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Coerce to a finite number, so a missing field renders as 0 instead of NaN. */
function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Fixed-digit team score, defensively floored to an integer. */
function scoreOf(value) {
  return String(Math.floor(num(value)));
}

/* --------------------------------------------------------------------------
 * Colour strings are rebuilt every frame otherwise: palette rgba() parses a
 * hex string each call. Cache by key + alpha quantised to 1/128 (visually
 * identical) and fall back to the neutral UI accent if a key is unknown.
 * ----------------------------------------------------------------------- */
const COLOR_CACHE = new Map();
const COLOR_CACHE_LIMIT = 512;
const ALPHA_STEPS = 128;

function tint(name, alpha) {
  const q = Math.round(clamp(num(alpha, 1), 0, 1) * ALPHA_STEPS) / ALPHA_STEPS;
  const key = name + '|' + q;
  const cached = COLOR_CACHE.get(key);
  if (cached !== undefined) return cached;

  let css;
  try {
    css = rgba(name, q);
  } catch (err) {
    css = withAlpha(PALETTE.light, q);
  }
  if (COLOR_CACHE.size >= COLOR_CACHE_LIMIT) COLOR_CACHE.clear();
  COLOR_CACHE.set(key, css);
  return css;
}

/* ==========================================================================
 * 10. Fallback snapshots: keep drawing if a system is not wired yet
 * ======================================================================= */

const EMPTY_ROUND = Object.freeze({
  phase: 'live',
  roundNumber: 1,
  scoreTide: 0,
  scoreEmber: 0,
  timeLeft: 0,
  plantTimer: 0,
  chargeSite: null,
  chargePlanted: false,
  playerHealth: 100,
  playerArmour: 0,
  message: '',
  messageUntil: 0,
  winner: null,
});

const EMPTY_WEAPONS = Object.freeze({
  ammo: 0,
  reserve: 0,
  reloading: false,
  reloadEndsAt: 0,
  spread: SPREAD_MIN,
});

const EMPTY_SPEC = Object.freeze({ name: '', reload: 1 });

/* ==========================================================================
 * 11. The HUD
 * ======================================================================= */

/**
 * Build the HUD: creates the overlay canvas, sizes it to the viewport, and
 * returns the handles the loop and the capture task drive.
 *
 * @param {{ round?: object, weapons?: object, bots?: object, player?: object }} opts
 * @returns {{
 *   canvas: HTMLCanvasElement,
 *   step: (dt: number) => void,
 *   paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
 *   hitMarker: (kind: 'hit'|'kill') => void,
 *   damageFlash: (amount?: number, side?: string|null) => void,
 *   addKill: (name: string) => void,
 * }}
 */
export function createHud(opts) {
  const { round, weapons, bots } = opts || {};

  /* ---- state accessors: never throw on a partially wired module --------- */
  function roundState() {
    return (round && round.state) || EMPTY_ROUND;
  }

  function weaponState() {
    return (weapons && weapons.state) || EMPTY_WEAPONS;
  }

  function currentSpec() {
    if (weapons && typeof weapons.current === 'function') {
      const spec = weapons.current();
      if (spec) return spec;
    }
    return EMPTY_SPEC;
  }

  function aliveCount(team) {
    if (!bots || typeof bots.aliveCount !== 'function') return 0;
    return Math.max(0, Math.floor(num(bots.aliveCount(team))));
  }

  /* ======================================================================
   * 11a. Canvas: one fixed, non-interactive overlay
   * =================================================================== */
  const canvas = document.createElement('canvas');
  canvas.id = HUD_CANVAS_ID;
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '5';
  canvas.style.background = 'transparent';
  document.body.appendChild(canvas);

  // Every draw routine paints into this binding. paint() swaps it for the
  // caller's context so a capture composite receives the same HUD the live
  // canvas shows.
  const ownCtx = canvas.getContext('2d');
  let ctx = ownCtx;

  function size() {
    const dpr = clamp(window.devicePixelRatio || MIN_DPR, MIN_DPR, MAX_DPR);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    // Assigning width/height clears the backing store, so only touch it when
    // the viewport actually changed.
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (ownCtx) ownCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size, { passive: true });

  /* ======================================================================
   * 11b. Transient state
   * =================================================================== */
  let clock = 0;
  let markA = 0;
  let markKind = 'hit';
  let flashA = 0;
  let flashSide = null;
  const feed = [];

  function hitMarker(kind) {
    markKind = kind === 'kill' ? 'kill' : 'hit';
    markA = markKind === 'kill' ? MARK_KILL : MARK_HIT;
  }

  function damageFlash(amount, side) {
    flashA = clamp(typeof amount === 'number' ? amount : 0.5, 0, 1);
    flashSide = typeof side === 'string' ? side : null;
  }

  function addKill(name) {
    const text = name === undefined || name === null ? '' : String(name);
    if (!text) return;
    feed.push({ text, age: 0 });
    if (feed.length > FEED_MAX) feed.shift();
  }

  function step(dt) {
    const d = num(dt, 0) > 0 ? dt : 0;
    clock += d;
    if (markA > 0) markA = Math.max(0, markA - d);
    if (flashA > 0) flashA = Math.max(0, flashA - d / FLASH_DECAY);
    for (let i = 0; i < feed.length; i++) feed[i].age += d;
    if (document.hidden) return; // nothing on screen to refresh
    paint(ownCtx, Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
  }

  /* ======================================================================
   * 11c. Canvas helpers: all drawing goes through these
   * =================================================================== */
  function setFont(px, family = MONO, weight = '') {
    ctx.font = (weight ? weight + ' ' : '') + px + 'px ' + family;
  }

  function write(text, x, y, maxWidth) {
    if (maxWidth === undefined) ctx.fillText(text, x, y);
    else ctx.fillText(text, x, y, maxWidth);
  }

  /** Letter-space copy the way the reference HUD does: hair spaces per glyph. */
  function spaced(text) {
    return String(text).split('').join(HAIR_GAP);
  }

  /** Run one draw routine inside its own save/restore scope. */
  function layer(draw, w, h) {
    if (typeof draw !== 'function') return;
    ctx.save();
    try {
      draw(w, h);
    } finally {
      ctx.restore();
    }
  }

  /* ======================================================================
   * 11d. Draw routines
   * =================================================================== */

  function pips(x, y, count) {
    for (let i = 0; i < PIP_COUNT; i++) {
      ctx.fillStyle = i < count ? tint('steel', 0.9) : tint('steel', 0.25);
      ctx.fillRect(x + i * PIP_STEP, y, PIP_SIZE, PIP_SIZE);
    }
  }

  function drawTimer(w) {
    const s = roundState();
    const t = Math.max(0, num(s.timeLeft));
    const cx = w / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    setFont(TIMER_SIZE);
    ctx.fillStyle = tint('ink', 0.9);
    write(pad2(Math.floor(t / 60)) + ':' + pad2(Math.floor(t % 60)), cx, TIMER_Y);

    setFont(SCORE_SIZE);
    ctx.fillStyle = tint('ink', 0.75);
    write(scoreOf(s.scoreTide) + ' : ' + scoreOf(s.scoreEmber), cx, SCORE_Y);

    setFont(SIDE_SIZE, SYS);
    ctx.textAlign = 'right';
    ctx.fillStyle = tint('tide', 0.75);
    write('TIDE', cx - SIDE_OFFSET, SIDE_Y);
    ctx.textAlign = 'left';
    ctx.fillStyle = tint('ember', 0.75);
    write('EMBER', cx + SIDE_OFFSET, SIDE_Y);

    pips(cx - PIPS_X, PIPS_Y, aliveCount('tide'));
    pips(cx + PIPS_X, PIPS_Y, aliveCount('ember'));
  }

  function drawCrosshair(w, h) {
    const ws = weaponState();
    const spread = num(ws.spread, SPREAD_MIN);
    const gap = CROSS_MIN_GAP + clamp((spread - SPREAD_MIN) / SPREAD_SPAN, 0, 1) * CROSS_SWING;
    const color = ws.reloading ? tint('ember', 0.9) : tint('ink', 0.9);
    const cx = w / 2;
    const cy = h / 2;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - gap, cy - CROSS_ARM);
    ctx.lineTo(cx - gap, cy + CROSS_ARM);
    ctx.moveTo(cx + gap, cy - CROSS_ARM);
    ctx.lineTo(cx + gap, cy + CROSS_ARM);
    ctx.moveTo(cx - CROSS_ARM, cy - gap);
    ctx.lineTo(cx + CROSS_ARM, cy - gap);
    ctx.moveTo(cx - CROSS_ARM, cy + gap);
    ctx.lineTo(cx + CROSS_ARM, cy + gap);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fillRect(cx - CROSS_DOT / 2, cy - CROSS_DOT / 2, CROSS_DOT, CROSS_DOT);
  }

  function drawHealth(w, h) {
    const s = roundState();
    const health = Math.max(0, num(s.playerHealth));
    const armour = Math.max(0, num(s.playerArmour));
    const low = health <= HP_LOW;
    const pulse = low ? 0.55 + 0.45 * Math.sin(clock * HP_PULSE) : 1;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    setFont(HP_SIZE, MONO, '600');
    if (low) {
      ctx.shadowColor = tint('ember', 0.5);
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = low ? tint('ember', 0.55 + 0.45 * pulse) : tint('ink', 0.92);
    write(String(Math.ceil(health)), HEALTH_X, h - HP_DY);
    ctx.shadowBlur = 0;

    setFont(HP_LABEL_SIZE);
    ctx.fillStyle = tint('muted', 0.8);
    write('HP', HEALTH_X, h - HP_LABEL_DY);

    setFont(ARMOUR_SIZE);
    ctx.fillStyle = tint('ink', 0.85);
    write(String(Math.ceil(armour)), ARMOUR_X, h - ARMOUR_DY);

    ctx.strokeStyle = tint('muted', 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(ARMOUR_BOX_X, h - ARMOUR_BOX_Y, ARMOUR_BOX_W, ARMOUR_BOX_H);
    ctx.beginPath();
    ctx.moveTo(ARMOUR_STRIPE_X0, h - ARMOUR_STRIPE_Y);
    ctx.lineTo(ARMOUR_STRIPE_X1, h - ARMOUR_STRIPE_Y);
    ctx.stroke();
  }

  function drawAmmo(w, h) {
    const s = weaponState();
    const spec = currentSpec();
    const x = w - AMMO_RIGHT;

    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';

    setFont(AMMO_SIZE, MONO, '600');
    ctx.fillStyle = tint('ink', 0.92);
    write(String(Math.max(0, Math.floor(num(s.ammo)))), x, h - AMMO_DY);

    setFont(RESERVE_SIZE);
    ctx.fillStyle = tint('muted', 0.8);
    write(' / ' + String(Math.max(0, Math.floor(num(s.reserve)))), x, h - RESERVE_DY);

    setFont(WEAPON_LABEL_SIZE);
    ctx.fillStyle = tint('muted', 0.55);
    write(String(spec.name || '').toUpperCase(), x, h - WEAPON_LABEL_DY);

    if (s.reloading) {
      const reload = Math.max(0.001, num(spec.reload, 1));
      const remaining = Math.max(0, num(s.reloadEndsAt) - clock);
      const frac = clamp(1 - remaining / reload, 0, 1);
      const barX = w - RELOAD_RIGHT;
      const barY = h - RELOAD_DY;
      ctx.fillStyle = tint('steel', 0.8);
      ctx.fillRect(barX, barY, RELOAD_W, RELOAD_H);
      ctx.fillStyle = tint('hazard', 0.9);
      ctx.fillRect(barX, barY, RELOAD_W * frac, RELOAD_H);
    }
  }

  function drawKillfeed(w) {
    for (let i = feed.length - 1; i >= 0; i--) {
      const line = feed[i];
      const fadeStart = FEED_LIFE - FEED_FADE;
      const alpha = clamp(1 - Math.max(0, line.age - fadeStart) / FEED_FADE, 0, 1);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = alpha;
      setFont(FEED_SIZE);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';

      const y = FEED_TOP + i * FEED_STEP;
      const x = w - FEED_RIGHT;
      ctx.fillStyle = tint('ink', 0.9);
      write(line.text, x, y);

      // Team stripe to the left of the copy: TIDE lines teal, everything else ember.
      const team = line.text.indexOf('TIDE') === 0 ? 'tide' : 'ember';
      const tw = ctx.measureText(line.text).width;
      ctx.fillStyle = tint(team, 0.9);
      ctx.fillRect(x - tw - FEED_BAR_DX, y + FEED_BAR_DY, FEED_BAR_W, FEED_BAR_H);
      ctx.restore();
    }
  }

  function drawMessage(w, h) {
    const s = roundState();
    if (!s.message || clock >= num(s.messageUntil)) return;
    const life = Math.max(0, num(s.messageUntil) - clock);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    setFont(13);
    ctx.fillStyle = tint('ink', clamp(life / MESSAGE_FADE, 0, MESSAGE_MAX_ALPHA));
    write(spaced(String(s.message).toUpperCase()), w / 2, h * MESSAGE_Y_FRAC, w - MESSAGE_MARGIN);
  }

  function drawCharge(w, h) {
    const s = roundState();
    if (!s.chargePlanted) return;
    const remain = clamp(num(s.plantTimer), 0, FUSE_TIME);
    const frac = remain / FUSE_TIME;
    const cx = w / 2;
    const barY = h * CHARGE_Y_FRAC;
    const barX = cx - CHARGE_BAR_W / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    setFont(9);
    ctx.fillStyle = tint('muted', 0.7);
    write('C H A R G E', cx, barY - CHARGE_LABEL_DY);

    ctx.fillStyle = tint('steel', 0.7);
    ctx.fillRect(barX, barY, CHARGE_BAR_W, CHARGE_BAR_H);
    // The bar empties right-to-left: the lit part is what is left of the fuse.
    ctx.fillStyle = s.phase === 'planted' ? tint('ember', 0.9) : tint('ink', 0.95);
    ctx.fillRect(barX + CHARGE_BAR_W * (1 - frac), barY, CHARGE_BAR_W * frac, CHARGE_BAR_H);
  }

  function drawFlash(w, h) {
    if (flashA <= 0) return;
    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.globalAlpha = clamp(flashA, 0, 1);
    const g = ctx.createRadialGradient(
      cx,
      cy,
      Math.min(w, h) * FLASH_INNER_FRAC,
      cx,
      cy,
      Math.max(w, h) * FLASH_OUTER_FRAC
    );
    g.addColorStop(0, FLASH_CLEAR);
    g.addColorStop(1, FLASH_TINT);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (flashSide) {
      const m = Math.min(w, h) * FLASH_ARC_FRAC;
      ctx.lineWidth = FLASH_ARC_WIDTH;
      ctx.strokeStyle = FLASH_ARC_COLOR;
      ctx.beginPath();
      if (flashSide === 'left') {
        ctx.arc(cx - m, cy, m * FLASH_ARC_RADIUS, Math.PI * 0.6, Math.PI * 1.4);
      } else if (flashSide === 'right') {
        ctx.arc(cx + m, cy, m * FLASH_ARC_RADIUS, -Math.PI * 0.4, Math.PI * 0.4);
      } else if (flashSide === 'front') {
        ctx.arc(cx, h - m, m, Math.PI * 1.15, Math.PI * 1.85);
      } else {
        ctx.arc(cx, m * 0.6, m, Math.PI * 0.15, Math.PI * 0.85);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDown(w, h) {
    ctx.fillStyle = DOWN_SCRIM;
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(20);
    ctx.fillStyle = tint('ink', 0.9);
    write('Y O U   A R E   D O W N', w / 2, h / 2);
  }

  function drawEnd(w, h) {
    const s = roundState();
    if (!s.winner) return;
    const tideWins = s.winner === 'tide';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(26);
    ctx.fillStyle = tint(tideWins ? 'tide' : 'ember', 0.95);
    write(tideWins ? 'TIDE TAKES THE DOCK' : 'EMBER HOLDS THE DOCK', w / 2, h / 2 - 8);

    setFont(13);
    ctx.fillStyle = tint('ink', 0.8);
    write(scoreOf(s.scoreTide) + ' : ' + scoreOf(s.scoreEmber), w / 2, h / 2 + 22);
  }

  function drawWarmup(w, h) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    setFont(10);
    ctx.fillStyle = tint('muted', 0.7);
    write('P R E P A R E  \u2014  B U Y  P H A S E', w / 2, h - 26);
  }

  /* ======================================================================
   * 11e. Composition
   * =================================================================== */

  /**
   * Paint the whole HUD into any 2D context. Used by step() for the live
   * canvas and by the capture task for the screenshot composite.
   *
   * @param {CanvasRenderingContext2D} pctx destination context
   * @param {number} w logical width in CSS pixels
   * @param {number} h logical height in CSS pixels
   */
  function paint(pctx, w, h) {
    if (!pctx) return;
    const s = roundState();
    const width = Math.max(1, num(w, window.innerWidth || 1));
    const height = Math.max(1, num(h, window.innerHeight || 1));
    const previous = ctx;
    ctx = pctx;
    try {
      layer(drawTimer, width, height);
      layer(drawAmmo, width, height);
      layer(drawHealth, width, height);
      layer(drawCrosshair, width, height);
      layer(drawKillfeed, width);
      layer(drawMessage, width, height);
      layer(drawCharge, width, height);
      layer(drawFlash, width, height);
      if (num(s.playerHealth) <= 0) layer(drawDown, width, height);
      if (s.winner) layer(drawEnd, width, height);
      if (s.phase === 'warmup') layer(drawWarmup, width, height);
    } finally {
      // A throwing routine must not leave the module painting into a temp ctx.
      ctx = previous;
    }
  }

  // Capture seam: the screenshot task composites the HUD into its own context.
  window.__paintHud = (c, ww, hh) => paint(c, ww, hh);

  return { canvas, step, paint, hitMarker, damageFlash, addKill };
}
