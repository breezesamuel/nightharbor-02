// NIGHTHARBOR: the single entry point and the one game loop.
// Owns: renderer/camera, the input factory, the UI overlay, the fixed-step loop
// with its event glue, capture mode (?shot=NAME) and the window.__frame seam.
import * as THREE from 'three';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createFx } from './fx.js';
import { createWeapons } from './weapons.js';
import { createBots } from './bots.js';
import { createRound } from './round.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';

const FIX_DT = 1 / 60;
const MAX_CATCHUP = 5;
const EYE = new THREE.Vector3();
const STEP_KEYS = ['weapons', 'bots', 'match', 'hud', 'fx', 'audio'];

function makeInput(canvas) {
  const state = { keys: new Set(), locked: false, firing: false, lookX: 0, lookY: 0 };

  window.addEventListener('keydown', (e) => state.keys.add(e.code));
  window.addEventListener('keyup', (e) => state.keys.delete(e.code));
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && state.locked) state.firing = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firing = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.locked) return;
    state.lookX += e.movementX;
    state.lookY += e.movementY;
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) state.firing = false;
  });

  function requestLock() {
    try {
      canvas.requestPointerLock();
    } catch (err) {
      state.locked = false;
    }
  }

  // Drain the accumulated mouse delta; the caller feeds it to player.look().
  function takeLook() {
    const out = { x: state.lookX, y: state.lookY };
    state.lookX = 0;
    state.lookY = 0;
    return out;
  }

  return { state, requestLock, takeLook };
}

// ---- renderer, scene, camera ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
const mount = document.getElementById('game') || document.body;
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 260);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = createWorld(scene);
window.__ready = true;
const player = createPlayer(world);
const input = makeInput(renderer.domElement);

const fx = createFx(scene);
const weapons = createWeapons({ scene, camera, world, player, fx, input });
const audio = createAudio();
let round;
const bots = createBots({ scene, world, player, fx, onPlayerHit: (damage, bot) => {
  if (round) round.playerDamage(damage, bot);
  audio.hit();
} });
round = createRound({ player, world, bots, weapons });
const hud = createHud({ round, weapons, bots, player });
const systems = { weapons, bots, match: round, hud, fx, audio };

// ---- overlay: the pause card shown when pointer lock is lost ----
const overlay = document.getElementById('overlay');
const play = document.getElementById('play');
if (play && overlay) {
  play.addEventListener('click', () => {
    audio.unlock();
    input.requestLock();
    overlay.style.display = 'none';
  });
  document.addEventListener('pointerlockchange', () => {
    if (input.state.locked) {
      overlay.style.display = 'none';
      return;
    }
    const h1 = overlay.querySelector('h1');
    if (h1) h1.textContent = 'Paused';
    play.textContent = 'Resume';
    overlay.style.display = '';
  });
}

// ---- event glue: the one place audio and HUD transients are fired ----
// Remembered counters live here; runFixedStep compares them against the live
// state after every system step.
const seen = { shots: 0, hits: 0, kill: '', health: 100, round: 0, winner: null };
let stepClock = 0;
let footClock = 0;

function runFixedStep() {
  stepClock += FIX_DT;
  player.step(FIX_DT, input.state.keys);
  world.step(FIX_DT);
  for (const key of STEP_KEYS) {
    const mod = systems[key];
    if (mod && mod.step) mod.step(FIX_DT, input.state.keys);
  }
  const ws = weapons.state;
  const rs = round.state;
  if (ws.shots > seen.shots) {
    seen.shots = ws.shots;
    audio.shot(weapons.current().name);
  }
  if (ws.hits > seen.hits) {
    seen.hits = ws.hits;
    hud.hitMarker('hit');
    audio.hit();
  }
  if (rs.lastKill !== seen.kill && rs.lastKill) {
    seen.kill = rs.lastKill;
    hud.addKill(rs.lastKill);
    hud.hitMarker('kill');
    audio.kill();
  }
  if (rs.playerHealth < seen.health) {
    hud.damageFlash(Math.min(1, (seen.health - rs.playerHealth) / 40), 'front');
    audio.hit();
    seen.health = rs.playerHealth;
  }
  if (rs.roundNumber !== seen.round) {
    seen.round = rs.roundNumber;
    audio.roundStart();
    hud.addKill('ROUND ' + rs.roundNumber);
  }
  if (rs.winner !== seen.winner && rs.winner !== null) {
    seen.winner = rs.winner;
    audio.roundEnd(rs.winner === 'tide');
  }
  if (player.groundSpeed() > 3.5) {
    footClock += FIX_DT;
    if (footClock >= 0.42) {
      footClock = 0;
      audio.footstep('concrete');
    }
  } else {
    footClock = 0;
  }
}

function placeCamera() {
  player.eyePosition(camera.position);
  camera.rotation.set(
    player.state.pitch + player.state.kickPitch,
    player.state.yaw + player.state.kickYaw,
    0
  );
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);

// ---- capture mode: one deterministic frame, no live loop ----
const shotName = new URLSearchParams(location.search).get('shot');
if (shotName === 'cover' || shotName === 'engage' || shotName === 'plant' || shotName === 'buy') {
  const POSES = {
    cover: { x: -9.5, y: 0, z: 14.2, yaw: 0.42, pitch: -0.06 },
    engage: { x: 1.0, y: 0, z: 13.4, yaw: 0.0, pitch: -0.03 },
    plant: { x: 14.6, y: 0, z: -17.4, yaw: -0.62, pitch: -0.1 },
    buy: { x: 0.0, y: 0, z: 30.5, yaw: 0.0, pitch: -0.04 },
  };
  const ENEMY_PLACEMENTS = {
    cover: [
      [3, -16.5, 0, -2.0],
      [4, -12.0, 0, -6.0],
    ],
    engage: [
      [5, 1.5, 0, -5.0],
      [4, 5.0, 0, -9.0],
    ],
    plant: [
      [4, 18.2, 0, -26.5],
      [5, 21.0, 0, -21.0],
    ],
    buy: [
      [3, -5.0, 0, 22.0],
    ],
  };
  const pose = POSES[shotName];
  renderer.setPixelRatio(1);
  renderer.setSize(1280, 720);
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  if (overlay) overlay.style.display = 'none';

  player.state.position.set(pose.x, pose.y, pose.z);
  player.teleport(player.state.position, pose.yaw);
  player.state.pitch = pose.pitch;

  // Put two ember bots where the shot has a target before the settle runs,
  // so their bodies and guns are placed and their AI gets a chance to aim back.
  const pp = player.state.position;
  for (const [bi, x, y, z] of ENEMY_PLACEMENTS[shotName]) {
    const b = bots.bots[bi];
    b.position.set(x, y, z);
    b.group.position.copy(b.position);
    b.yaw = Math.atan2(-(pp.x - x), -(pp.z - z));
    b.group.rotation.y = b.yaw;
  }

  for (let i = 0; i < 24; i++) runFixedStep();
  placeCamera();
  weapons.fire();
  for (let i = 0; i < 2; i++) runFixedStep();
  placeCamera();

  // A plausible mid-match HUD state: the fields are set directly on round.state
  // because the HUD module owns its own clock that the capture task cannot reach.
  const rs = round.state;
  rs.roundNumber = 4;
  rs.scoreTide = 3;
  rs.scoreEmber = 2;
  rs.phase = 'live';
  rs.timeLeft = 84;
  rs.playerHealth = 78;
  rs.playerArmour = 100;
  rs.chargePlanted = false;
  rs.chargeSite = null;
  rs.winner = null;
  rs.message = 'HOLD THE COLD STORE';
  rs.messageUntil = 1e9;

  window.__frame = { player, world, camera, renderer, scene, systems };
  window.__frame.input = input;

  renderer.render(scene, camera);
  renderer.render(scene, camera);
  // Export in the same task as the render: a tab the browser is not painting never runs
  // requestAnimationFrame, and the drawing buffer is only guaranteed inside its own task.
  try {
    const c2 = document.createElement('canvas');
    c2.width = 1280;
    c2.height = 720;
    const ctx = c2.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0);
    if (typeof window.__paintHud === 'function') window.__paintHud(ctx, 1280, 720);
    window.__SHOT = c2.toDataURL('image/jpeg', 0.86);
  } catch (err) {
    window.__SHOT = '';
    window.__shotError = String(err && err.message ? err.message : err);
  }
  window.__shotReady = true;
} else {
  // ---- live loop ----
  const clock = new THREE.Clock();
  let accumulator = 0;
  requestAnimationFrame(function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIX_DT && steps < MAX_CATCHUP) {
      runFixedStep();
      accumulator -= FIX_DT;
      steps++;
    }
    if (steps === MAX_CATCHUP) accumulator = 0;

    if (input.state.locked) {
      const look = input.takeLook();
      player.look(look.x, look.y, 0.0022);
    }
    placeCamera();
    renderer.render(scene, camera);
  });
}
