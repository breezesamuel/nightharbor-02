import { PALETTE, rgba } from './palette.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SYS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const FUSE_TIME = 40;
const MARK_HIT = 0.18;
const MARK_KILL = 0.35;
const FLASH_DECAY = 0.4;
const FEED_MAX = 4;
const FEED_LIFE = 5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createHud(opts) {
  const { round, weapons, bots } = opts;

  const canvas = document.createElement('canvas');
  canvas.id = 'hud';
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '5';
  canvas.style.background = 'transparent';
  document.body.appendChild(canvas);
  const ownCtx = canvas.getContext('2d');
  // Every draw routine paints into this binding. paint() swaps it for the caller's
  // context so a capture composite receives the same HUD the live canvas shows.
  let ctx = ownCtx;

  function size() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ownCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size);

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
    feed.push({ text: String(name), age: 0 });
    if (feed.length > FEED_MAX) feed.shift();
  }

  function step(dt) {
    clock += dt;
    if (markA > 0) markA = Math.max(0, markA - dt);
    if (flashA > 0) flashA = Math.max(0, flashA - dt / FLASH_DECAY);
    for (let i = 0; i < feed.length; i++) feed[i].age += dt;
    paint(ctx, window.innerWidth, window.innerHeight);
  }

  function pips(x, y, count) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < count ? rgba('steel', 0.9) : rgba('steel', 0.25);
      ctx.fillRect(x + i * 10, y, 6, 6);
    }
  }

  function drawTimer(w) {
    const s = round.state;
    const t = Math.max(0, s.timeLeft);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '22px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.9);
    ctx.fillText(mm + ':' + ss, w / 2, 14);
    ctx.font = '13px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.75);
    ctx.fillText(s.scoreTide + ' : ' + s.scoreEmber, w / 2, 42);
    ctx.font = '9px ' + SYS;
    ctx.textAlign = 'right';
    ctx.fillStyle = rgba('tide', 0.75);
    ctx.fillText('TIDE', w / 2 - 30, 43);
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba('ember', 0.75);
    ctx.fillText('EMBER', w / 2 + 30, 43);
    pips(w / 2 - 46, 58, bots.aliveCount('tide'));
    pips(w / 2 + 46, 58, bots.aliveCount('ember'));
  }

  function drawCrosshair(w, h) {
    const ws = weapons.state;
    const gap = 9 + clamp((ws.spread - 0.006) / 0.054, 0, 1) * 13;
    const color = ws.reloading ? rgba('ember', 0.9) : rgba('ink', 0.9);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 2 - gap, h / 2 - 3.5);
    ctx.lineTo(w / 2 - gap, h / 2 + 3.5);
    ctx.moveTo(w / 2 + gap, h / 2 - 3.5);
    ctx.lineTo(w / 2 + gap, h / 2 + 3.5);
    ctx.moveTo(w / 2 - 3.5, h / 2 - gap);
    ctx.lineTo(w / 2 + 3.5, h / 2 - gap);
    ctx.moveTo(w / 2 - 3.5, h / 2 + gap);
    ctx.lineTo(w / 2 + 3.5, h / 2 + gap);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(w / 2 - 0.75, h / 2 - 0.75, 1.5, 1.5);
  }

  function drawHealth(w, h) {
    const s = round.state;
    const low = s.playerHealth <= 35;
    const pulse = low ? 0.55 + 0.45 * Math.sin(clock * 6) : 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 34px ' + MONO;
    if (low) {
      ctx.shadowColor = rgba('ember', 0.5);
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = low ? rgba('ember', 0.55 + 0.45 * pulse) : rgba('ink', 0.92);
    ctx.fillText(String(Math.ceil(s.playerHealth)), 24, h - 36);
    ctx.shadowBlur = 0;
    ctx.font = '10px ' + MONO;
    ctx.fillStyle = rgba('muted', 0.8);
    ctx.fillText('HP', 24, h - 24);
    ctx.font = '14px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.85);
    ctx.fillText(String(Math.ceil(s.playerArmour)), 92, h - 40);
    ctx.strokeStyle = rgba('muted', 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(86, h - 54, 22, 18);
    ctx.beginPath();
    ctx.moveTo(89, h - 48);
    ctx.lineTo(105, h - 48);
    ctx.stroke();
  }

  function drawAmmo(w, h) {
    const s = weapons.state;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 30px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.92);
    ctx.fillText(String(s.ammo), w - 24, h - 34);
    ctx.font = '14px ' + MONO;
    ctx.fillStyle = rgba('muted', 0.8);
    ctx.fillText(' / ' + String(s.reserve), w - 24, h - 14);
    ctx.font = '11px ' + MONO;
    ctx.fillStyle = rgba('muted', 0.55);
    ctx.fillText(weapons.current().name.toUpperCase(), w - 24, h - 2);
    if (s.reloading) {
      const spec = weapons.current();
      const frac = clamp(1 - Math.max(0, s.reloadEndsAt - clock) / spec.reload, 0, 1);
      ctx.fillStyle = rgba('steel', 0.8);
      ctx.fillRect(w - 116, h - 24, 92, 3);
      ctx.fillStyle = rgba('hazard', 0.9);
      ctx.fillRect(w - 116, h - 24, 92 * frac, 3);
    }
  }

  function drawKillfeed(w) {
    for (let i = feed.length - 1; i >= 0; i--) {
      const line = feed[i];
      const alpha = clamp(1 - Math.max(0, line.age - (FEED_LIFE - 1.2)) / 1.2, 0, 1);
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '12px ' + MONO;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const y = 78 + i * 18;
      ctx.fillStyle = rgba('ink', 0.9);
      ctx.fillText(line.text, w - 20, y);
      const tw = ctx.measureText(line.text).width;
      ctx.fillStyle = rgba(line.text.indexOf('TIDE') === 0 ? 'tide' : 'ember', 0.9);
      ctx.fillRect(w - 20 - tw - 8, y + 1, 2, 10);
      ctx.restore();
    }
  }

  function drawMessage(w, h) {
    const s = round.state;
    if (!s.message || clock >= s.messageUntil) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '13px ' + MONO;
    ctx.fillStyle = rgba('ink', clamp((s.messageUntil - clock) / 0.5, 0, 0.9));
    ctx.fillText(s.message.toUpperCase().split('').join('\u200a\u200a'), w / 2, h * 0.18, w - 80);
  }

  function drawCharge(w, h) {
    const s = round.state;
    if (!s.chargePlanted) return;
    const remain = clamp(s.plantTimer, 0, FUSE_TIME);
    const frac = remain / FUSE_TIME;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '9px ' + MONO;
    ctx.fillStyle = rgba('muted', 0.7);
    ctx.fillText('C H A R G E', w / 2, h * 0.62 - 10);
    ctx.fillStyle = rgba('steel', 0.7);
    ctx.fillRect(w / 2 - 110, h * 0.62, 220, 2);
    ctx.fillStyle = s.phase === 'planted' ? rgba('ember', 0.9) : rgba('ink', 0.95);
    ctx.fillRect(w / 2 - 110 + 220 * (1 - frac), h * 0.62, 220 * frac, 2);
  }

  function drawFlash(w, h) {
    if (flashA <= 0) return;
    ctx.save();
    ctx.globalAlpha = flashA;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.62);
    g.addColorStop(0, 'rgba(190, 20, 10, 0)');
    g.addColorStop(1, 'rgba(190, 20, 10, 0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (flashSide) {
      const m = Math.min(w, h) * 0.16;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255, 60, 40, 0.8)';
      ctx.beginPath();
      if (flashSide === 'left') ctx.arc(w / 2 - m, h / 2, m * 0.9, Math.PI * 0.6, Math.PI * 1.4);
      else if (flashSide === 'right') ctx.arc(w / 2 + m, h / 2, m * 0.9, -Math.PI * 0.4, Math.PI * 0.4);
      else if (flashSide === 'front') ctx.arc(w / 2, h - m, m, Math.PI * 1.15, Math.PI * 1.85);
      else ctx.arc(w / 2, m * 0.6, m, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDown(w, h) {
    ctx.fillStyle = 'rgba(2, 4, 6, 0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '20px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.9);
    ctx.fillText('Y O U   A R E   D O W N', w / 2, h / 2);
  }

  function drawEnd(w, h) {
    const s = round.state;
    if (!s.winner) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '26px ' + MONO;
    ctx.fillStyle = s.winner === 'tide' ? rgba('tide', 0.95) : rgba('ember', 0.95);
    ctx.fillText(s.winner === 'tide' ? 'TIDE TAKES THE DOCK' : 'EMBER HOLDS THE DOCK', w / 2, h / 2 - 8);
    ctx.font = '13px ' + MONO;
    ctx.fillStyle = rgba('ink', 0.8);
    ctx.fillText(s.scoreTide + ' : ' + s.scoreEmber, w / 2, h / 2 + 22);
  }

  function drawWarmup(w, h) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '10px ' + MONO;
    ctx.fillStyle = rgba('muted', 0.7);
    ctx.fillText('P R E P A R E  \u2014  B U Y  P H A S E', w / 2, h - 26);
  }

  function paint(pctx, w, h) {
    const s = round.state;
    const previous = ctx;
    ctx = pctx;
    pctx.save();
    drawTimer(w);
    pctx.restore();
    pctx.save();
    drawAmmo(w, h);
    pctx.restore();
    pctx.save();
    drawHealth(w, h);
    pctx.restore();
    pctx.save();
    drawCrosshair(w, h);
    pctx.restore();
    pctx.save();
    drawKillfeed(w);
    pctx.restore();
    pctx.save();
    drawMessage(w, h);
    pctx.restore();
    pctx.save();
    drawCharge(w, h);
    pctx.restore();
    pctx.save();
    drawFlash(w, h);
    pctx.restore();
    if (s.playerHealth <= 0) {
      pctx.save();
      drawDown(w, h);
      pctx.restore();
    }
    if (s.winner) {
      pctx.save();
      drawEnd(w, h);
      pctx.restore();
    }
    if (s.phase === 'warmup') {
      pctx.save();
      drawWarmup(w, h);
      pctx.restore();
    }
    ctx = previous;
  }

  window.__paintHud = (c, ww, hh) => paint(c, ww, hh);

  return { canvas, step, paint, hitMarker, damageFlash, addKill };
}
