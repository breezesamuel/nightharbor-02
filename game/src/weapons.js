// NIGHTHARBOR: the player's two hitscan weapons.
// Owns: TR-9 rifle and Ember shotgun specs, viewmodel build and motion,
// firing, reload, recoil, ammo bookkeeping and the onHit damage seam.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// deterministic spread: the seed advances one step per ray, so capture frames reproduce
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

const SPECS = [
  {
    name: 'TR-9',
    auto: true,
    pellets: 1,
    damage: 22,
    headshot: 2.2,
    magazine: 30,
    reserve: 90,
    interval: 60 / 640,
    spread: 0.006,
    spreadMoving: 0.011,
    reload: 2.1,
    range: 120,
    kickPitch: 0.01,
    kickYaw: 0.004,
  },
  {
    name: 'Ember 12',
    auto: false,
    pellets: 7,
    damage: 9,
    headshot: 1,
    magazine: 6,
    reserve: 24,
    interval: 0.55,
    spread: 0.055,
    spreadMoving: 0.055,
    reload: 2.8,
    range: 45,
    kickPitch: 0.045,
    kickYaw: 0.012,
  },
];

const KICK_DECAY = 14;
const BASE_POS = new THREE.Vector3(0.19, -0.17, -0.42);

// map a ray hit onto the spark-tint kind; default is concrete
function kindFor(hit) {
  const obj = hit.object;
  const name = (obj && obj.name) || '';
  const mapName = obj && obj.material && obj.material.map ? obj.material.map.name : '';
  if (name.indexOf('steel') >= 0 || name.indexOf('rust') >= 0 || name.indexOf('barrel') >= 0 || mapName === 'steel' || mapName === 'rust') return 'steel';
  if (name.indexOf('crate') >= 0 || name.indexOf('pallet') >= 0 || mapName === 'crate') return 'wood';
  return 'concrete';
}

// uniform-angle cone: one seeded draw picks the cone angle, the other the azimuth
function spreadDir(rng, spread, out) {
  const cosT = 1 - rng() * spread * spread;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rng() * Math.PI * 2;
  out.set(sinT * Math.cos(phi), sinT * Math.sin(phi), cosT).normalize();
  return out;
}

function buildViewmodel(camera) {
  const steelMat = new THREE.MeshStandardMaterial({
    color: PALETTE.steel,
    roughness: 0.4,
    metalness: 0.7,
    depthWrite: true,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x0c0f12,
    roughness: 0.85,
    metalness: 0.2,
    depthWrite: true,
  });
  const hazardMat = new THREE.MeshStandardMaterial({
    color: PALETTE.hazard,
    roughness: 0.6,
    metalness: 0.3,
    depthWrite: true,
  });
  const emberMat = new THREE.MeshStandardMaterial({
    color: PALETTE.ember,
    roughness: 0.5,
    metalness: 0.1,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 1.6,
    depthWrite: true,
  });

  const group = new THREE.Group();
  group.renderOrder = 3;

  function add(parent, mesh) {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }

  // rifle: about 0.62 m long, reads at the bottom right of a 75 degree view
  const rifle = new THREE.Group();
  {
    const receiver = add(rifle, new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), steelMat));
    receiver.position.set(0, 0, -0.02);
    const barrel = add(rifle, new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.26, 10), steelMat));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.005, -0.28);
    const tip = add(rifle, new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10), darkMat));
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, 0.005, -0.41);
    tip.name = 'muzzle';
    const grip = add(rifle, new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.06), darkMat));
    grip.position.set(0, -0.06, 0.12);
    grip.rotation.x = 0.3;
    const mag = add(rifle, new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.09, 0.08), darkMat));
    mag.position.set(0, -0.05, 0.02);
    const rail = add(rifle, new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.015, 0.3), hazardMat));
    rail.position.set(0, 0.038, -0.02);
    const light = add(rifle, new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), emberMat));
    light.position.set(0.012, 0.02, -0.3);
  }
  rifle.rotation.y = -0.04;

  // shotgun: shorter, fatter body with a pump
  const shotgun = new THREE.Group();
  {
    const body = add(shotgun, new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), steelMat));
    body.position.set(0, 0, -0.04);
    const pump = add(shotgun, new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.14, 12), darkMat));
    pump.rotation.x = Math.PI / 2;
    pump.position.set(0, -0.01, -0.2);
    const sBarrel = add(shotgun, new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 10), steelMat));
    sBarrel.rotation.x = Math.PI / 2;
    sBarrel.position.set(0, 0.01, -0.32);
    const sTip = add(shotgun, new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10), darkMat));
    sTip.rotation.x = Math.PI / 2;
    sTip.position.set(0, 0.01, -0.43);
    sTip.name = 'muzzle';
    const sGrip = add(shotgun, new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.07), darkMat));
    sGrip.position.set(0, -0.06, 0.14);
    sGrip.rotation.x = 0.3;
    const sLight = add(shotgun, new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), emberMat));
    sLight.position.set(0.02, 0.03, -0.28);
  }
  shotgun.rotation.y = -0.04;
  group.add(rifle, shotgun);

  group.position.copy(BASE_POS);
  rifle.visible = true;
  shotgun.visible = false;
  camera.add(group);

  function muzzleTip(slot) {
    return (slot === 0 ? rifle : shotgun).getObjectByName('muzzle');
  }

  return { group, rifle, shotgun, muzzleTip };
}

export function createWeapons(opts) {
  const { camera, world, player, fx, input } = opts;
  const rng = mulberry32(0x5eed);

  const state = {
    slot: 0,
    ammo: SPECS[0].magazine,
    reserve: SPECS[0].reserve,
    reloading: false,
    reloadEndsAt: 0,
    shots: 0,
    hits: 0,
    cooldown: 0,
    spread: SPECS[0].spread,
    sway: 0,
    recoil: 0,
    lastHit: null,
  };
  // mutable damage seam: bots set this to receive (target, damage, point)
  let onHitFn = null;

  const perSlot = [
    { ammo: SPECS[0].magazine, reserve: SPECS[0].reserve },
    { ammo: SPECS[1].magazine, reserve: SPECS[1].reserve },
  ];
  let clockT = 0;
  let prevFiring = false;
  let kickBack = 0;

  const raycaster = new THREE.Raycaster();
  const _quat = new THREE.Quaternion();
  const _right = new THREE.Vector3();
  const _down = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _shotDir = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _end = new THREE.Vector3();
  const muzzleWorldPosition = new THREE.Vector3();

  const viewmodel = buildViewmodel(camera);

  function current() {
    return SPECS[state.slot];
  }

  function syncAmmo() {
    state.ammo = perSlot[state.slot].ammo;
    state.reserve = perSlot[state.slot].reserve;
  }

  function select(slot) {
    if (slot !== 0 && slot !== 1) return;
    if (slot === state.slot) return;
    state.slot = slot;
    state.reloading = false;
    state.cooldown = 0;
    viewmodel.rifle.visible = slot === 0;
    viewmodel.shotgun.visible = slot === 1;
    state.spread = current().spread;
    syncAmmo();
  }

  function canFire() {
    if (state.reloading || state.cooldown > 0 || state.ammo <= 0) return false;
    return input.state.locked || window.location.search.indexOf('?shot=') >= 0;
  }

  function startReload() {
    const spec = current();
    if (state.reloading || state.ammo >= spec.magazine || perSlot[state.slot].reserve <= 0) return;
    state.reloading = true;
    state.reloadEndsAt = clockT + spec.reload;
  }

  function fire() {
    if (!canFire()) return { hit: false, point: null, target: null };
    const spec = current();
    perSlot[state.slot].ammo -= 1;
    syncAmmo();
    state.shots += 1;
    state.cooldown = spec.interval;
    kickBack = 0.05;

    // world-space muzzle: camera position plus a right/down/forward offset
    camera.getWorldQuaternion(_quat);
    _right.set(1, 0, 0).applyQuaternion(_quat);
    _down.set(0, -1, 0).applyQuaternion(_quat);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    camera.getWorldPosition(_origin);
    _origin.addScaledVector(_right, 0.22).addScaledVector(_down, 0.16).addScaledVector(_fwd, 0.45);
    _camDir.set(0, 0, -1).applyQuaternion(_quat).normalize();

    let anyHit = false;
    let hitPoint = null;
    let hitTarget = null;
    for (let p = 0; p < spec.pellets; p++) {
      spreadDir(rng, state.spread, _shotDir.copy(_camDir));
      raycaster.set(_origin, _shotDir);
      raycaster.far = spec.range;
      const hits = raycaster.intersectObjects(world.shootables, false);
      const hit = hits.length ? hits[0] : null;
      _end.copy(_origin).addScaledVector(_shotDir, hit ? 40 : spec.range);
      if (hit) {
        anyHit = true;
        hitPoint = hit.point;
        hitTarget = hit.object.userData.owner || hit.object;
        state.lastHit = hitTarget;
        _end.copy(hit.point);
        if (hit.face) _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        else _normal.copy(_shotDir).negate();
        fx.impact(hit.point, _normal, kindFor(hit));
        if (hit.object.userData.owner) fx.burst(hit.point, PALETTE.ember);
        if (onHitFn) onHitFn(hitTarget, spec.damage * spec.headshot, hit.point);
      }
      fx.muzzle(_origin, _shotDir);
      fx.tracer(_origin, _end);
    }
    if (anyHit) state.hits += 1;
    player.kick(spec.kickPitch, spec.kickYaw * (rng() < 0.5 ? -1 : 1));
    return { hit: anyHit, point: hitPoint, target: hitTarget };
  }

  function step(dt, keys) {
    clockT += dt;
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
    if (state.reloading && clockT >= state.reloadEndsAt) {
      const a = perSlot[state.slot];
      const need = current().magazine - a.ammo;
      const take = Math.min(need, a.reserve);
      a.ammo += take;
      a.reserve -= take;
      state.reloading = false;
      syncAmmo();
    }
    if (keys.has('KeyR') && !state.reloading) startReload();
    if (keys.has('Digit1')) select(0);
    if (keys.has('Digit2')) select(1);

    const spec = current();
    const moving = player.groundSpeed() > 0.5;
    state.spread = moving ? spec.spreadMoving : spec.spread;

    const firingNow = input.state.firing;
    if (firingNow && canFire()) {
      if (spec.auto || !prevFiring) fire();
    }
    if (firingNow && state.ammo === 0) startReload();
    prevFiring = firingNow;

    // viewmodel motion: idle sway, walk bob, kick-back along +z; base is never reset
    const swayX = Math.sin(clockT * 2 * Math.PI * 1.1) * 0.004;
    const swayY = Math.sin(clockT * 2 * Math.PI * 1.1 + 1.3) * 0.003;
    const bob = Math.min(1, player.groundSpeed() / 5) * 0.012 * Math.sin(clockT * 2 * Math.PI * 8);
    viewmodel.group.position.set(BASE_POS.x + swayX, BASE_POS.y + swayY + bob, BASE_POS.z + kickBack);
    kickBack = Math.max(0, kickBack - KICK_DECAY * dt);
    state.sway = swayX;
    state.recoil = kickBack;
    const tip = viewmodel.muzzleTip(state.slot);
    if (tip) tip.getWorldPosition(muzzleWorldPosition);
  }

  // public property: assign a function to receive per-hit damage
  Object.defineProperty(state, 'onHit', {
    get: () => onHitFn,
    set: (fn) => {
      onHitFn = typeof fn === 'function' ? fn : null;
    },
    enumerable: true,
    configurable: true,
  });

  syncAmmo();
  return {
    state,
    viewmodel: viewmodel.group,
    step,
    fire,
    reload: startReload,
    select,
    current,
    muzzleWorldPosition,
  };
}
