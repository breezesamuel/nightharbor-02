// Nightharbor: the six combat bots.
// Owns: bot construction, A* over NAV, sight, patrol / hunt / engage AI,
// ember fire on the player, ambient tide fire, damage, death and reset.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { NAV, SPAWNS } from './mapdata.js';

const WALK = 3.1;
const ENGAGE = 2.2;
const STRAFE = 1.6;
const TURN = 6;
const EYE = 1.55;
const SIGHT_RANGE = 34;
const ENGAGE_RANGE = 26;
const FOV_PATROL = Math.cos((100 * Math.PI) / 360);
const HEAD_Y = 1.62;
const CHEST_Y = 1.18;
const ARRIVE = 0.3;
const TURN_EPS = 0.03;
const FIRE_START = 0.8;
const FIRE_GAP = 0.16;
const TIDE_CHANCE = 0.35;
const TIDE_DAMAGE = 14;
const EMBER_DAMAGE = 12;
const EMBER_BURST = 3;
const EMBER_GAP = 0.09;
const PAUSE_MIN = 0.7;
const PAUSE_MAX = 1.2;
const DEATH_TIME = 0.45;
const LIE_YAW = 22 * Math.PI / 180;
const LIE_DROP = 0.1;
const SWAY = (1.5 * Math.PI) / 180;

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

// adjacency over the flat NAV node tables, kept in plain arrays
const NODE_NAMES = Object.keys(NAV.nodes);
const NODE_INDEX = {};
for (let i = 0; i < NODE_NAMES.length; i++) NODE_INDEX[NODE_NAMES[i]] = i;
const ADJ = NODE_NAMES.map(function () { return []; });
for (const [a, b] of NAV.edges) {
  const ia = NODE_INDEX[a];
  const ib = NODE_INDEX[b];
  if (ia === undefined || ib === undefined) continue;
  ADJ[ia].push(ib);
  ADJ[ib].push(ia);
}

// precomputed pairwise node distances: the A* heuristic never allocates
const distCache = new Map();
function nodeDist(a, b) {
  const hi = a < b ? a : b;
  const lo = a < b ? b : a;
  const key = hi * 31 + lo;
  let d = distCache.get(key);
  if (d === undefined) {
    const pa = NAV.nodes[NODE_NAMES[hi]];
    const pb = NAV.nodes[NODE_NAMES[lo]];
    d = Math.hypot(pa.x - pb.x, pa.z - pb.z, (pa.y - pb.y) * 2);
    distCache.set(key, d);
  }
  return d;
}

// shared low-poly geometry: one set, cloned per bot
const G = {
  torso: new THREE.BoxGeometry(0.46, 0.62, 0.26),
  head: new THREE.BoxGeometry(0.22, 0.24, 0.22),
  leg: new THREE.BoxGeometry(0.16, 0.86, 0.2),
  arm: new THREE.BoxGeometry(0.13, 0.5, 0.16),
  visor: new THREE.BoxGeometry(0.26, 0.06, 0.02),
  patch: new THREE.BoxGeometry(0.1, 0.1, 0.02),
  stripe: new THREE.BoxGeometry(0.34, 0.035, 0.02),
};

const NAMES = ['TIDE-1', 'TIDE-2', 'TIDE-3', 'EMBER-1', 'EMBER-2', 'EMBER-3'];
const SPAWN_NODE = ['tideway-west', 'tideway-mid', 'tideway-east', 'ember-spawn', 'ember-spawn', 'ember-spawn'];
const ROUTES = [
  ['gantry', 'gantry-top'],
  ['hall-mid', 'mid-crates'],
  ['west-door'],
  ['yard-wall', 'a-approach'],
  ['yard-wall', 'b-south'],
  ['hall-mid', 'crane', 'crane-north'],
];

function buildBody(bot, mats, teamMat) {
  const group = new THREE.Group();
  function mk(geometry, material, x, y, z, owned) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    if (owned) {
      m.userData.owner = bot;
      bot.hitMeshes.push(m);
    }
    return m;
  }
  bot.torso = mk(G.torso, mats.body, 0, CHEST_Y, 0, true);
  mk(G.leg, mats.body, -0.12, 0.43, 0, true);
  mk(G.leg, mats.body, 0.12, 0.43, 0, true);
  mk(G.leg, mats.vest, -0.12, 0.5, 0.03, false);
  mk(G.leg, mats.vest, 0.12, 0.5, 0.03, false);
  mk(G.leg, mats.vest, 0, 0.45, 0.2, false);
  mk(G.leg, mats.body, -0.31, CHEST_Y, 0, false);
  mk(G.leg, mats.body, 0.31, CHEST_Y, 0, false);
  bot.head = mk(G.head, mats.body, 0, HEAD_Y, 0, true);
  bot.head.userData.head = true;
  mk(G.visor, teamMat, 0, HEAD_Y + 0.02, -0.11, false);
  mk(G.stripe, teamMat, 0, CHEST_Y + 0.14, -0.14, false);
  mk(G.patch, teamMat, -0.28, CHEST_Y + 0.2, -0.09, false);
  mk(G.patch, teamMat, 0.28, CHEST_Y + 0.2, -0.09, false);
  return group;
}

export function createBots(opts) {
  const { scene, world, player, fx } = opts;
  const rng = mulberry32(20260714);
  const byName = world.nav.byName;

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x39454b, roughness: 0.7, metalness: 0.25 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x222c30, roughness: 0.85, metalness: 0.15 });
  const tideVisor = new THREE.MeshStandardMaterial({ color: PALETTE.tide, emissive: new THREE.Color(PALETTE.tide), emissiveIntensity: 3.4 });
  const emberVisor = new THREE.MeshStandardMaterial({ color: PALETTE.ember, emissive: new THREE.Color(PALETTE.ember), emissiveIntensity: 3.4 });
  const mats = { body: bodyMat, vest: vestMat };

  const bots = [];
  for (let i = 0; i < 6; i++) {
    const team = i < 3 ? 'tide' : 'ember';
    const bot = {
      name: NAMES[i],
      team,
      index: i,
      group: null,
      health: 100,
      alive: true,
      position: new THREE.Vector3(),
      yaw: 0,
      speed: 0,
      node: SPAWN_NODE[i],
      route: ROUTES[i].slice(),
      state: 'patrol',
      target: null,
      nextShotAt: 0,
      hitMeshes: [],
      torso: null,
      head: null,
      markX: 0,
      markZ: 0,
      lastNode: SPAWN_NODE[i],
      burstLeft: 0,
      visible: false,
      strafe: 1,
      strafeUntil: 0,
      deathT: 0,
      bobPhase: i * 1.3,
    };
    bot.group = buildBody(bot, mats, team === 'tide' ? tideVisor : emberVisor);
    bot.group.rotation.z = LIE_YAW;
    bot.group.visible = false;
    scene.add(bot.group);
    for (const m of bot.hitMeshes) world.shootables.push(m);
    bots.push(bot);
  }

  let clock = 0;

  // A* over the nav graph: iterative, one linear scan of the open set per pop
  function findPath(fromName, toName) {
    const start = NODE_INDEX[fromName];
    const goal = NODE_INDEX[toName];
    if (start === undefined || goal === undefined) return null;
    if (start === goal) return [toName];
    const n = NODE_NAMES.length;
    const g = new Array(n).fill(Infinity);
    const parent = new Array(n).fill(-1);
    const closed = new Array(n).fill(false);
    g[start] = 0;
    for (let total = 0; total < n; total++) {
      let best = -1;
      let bestF = Infinity;
      for (let i = 0; i < n; i++) {
        if (closed[i]) continue;
        const f = g[i] + nodeDist(i, goal);
        if (f < bestF) {
          bestF = f;
          best = i;
        }
      }
      if (best === -1) return null;
      closed[best] = true;
      if (best === goal) break;
      for (const j of ADJ[best]) {
        if (closed[j]) continue;
        const ng = g[best] + nodeDist(best, j);
        if (ng < g[j]) {
          g[j] = ng;
          parent[j] = best;
        }
      }
    }
    if (!closed[goal]) return null;
    const out = [toName];
    let cur = goal;
    while (cur !== start) {
      cur = parent[cur];
      out.push(NODE_NAMES[cur]);
    }
    out.reverse();
    return out;
  }

  // nearest nav node to a world position, for hunting a mark between nodes
  function nearestNode(x, z) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < NODE_NAMES.length; i++) {
      const p = byName[NODE_NAMES[i]];
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return NODE_NAMES[best];
  }

  const raycaster = new THREE.Raycaster();
  const lookDir = new THREE.Vector3();
  const toNext = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const aim = new THREE.Vector3();

  function ownerOf(mesh) {
    return mesh.userData.owner || null;
  }

  // straight sight to an enemy bot: a wall blocks, a teammate or corpse does not
  function botVisible(fromBot, target) {
    const dx = target.position.x - fromBot.position.x;
    const dz = target.position.z - fromBot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > SIGHT_RANGE) return false;
    if (fromBot.visible) return dist <= ENGAGE_RANGE;
    if (Math.cos(fromBot.yaw) * -dx / dist + Math.sin(fromBot.yaw) * -dz / dist < FOV_PATROL) return false;
    raycaster.set(new THREE.Vector3(fromBot.position.x, fromBot.position.y + EYE, fromBot.position.z), lookDir.set(dx / dist, 0, dz / dist));
    raycaster.far = dist;
    for (const h of raycaster.intersectObjects(world.shootables, true)) {
      const o = ownerOf(h.object);
      if (o) {
        if (!o.alive || o.team === fromBot.team) continue;
        return o === target;
      }
      return false;
    }
    return true;
  }

  // player sight: walls block, same-team and dead bodies never do
  function playerVisible(bot) {
    const ppos = player.state.position;
    const dx = ppos.x - bot.position.x;
    const dz = ppos.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > SIGHT_RANGE) return false;
    raycaster.set(new THREE.Vector3(bot.position.x, bot.position.y + EYE, bot.position.z), lookDir.set(dx / dist, 0, dz / dist));
    raycaster.far = dist;
    for (const h of raycaster.intersectObjects(world.shootables, true)) {
      const o = ownerOf(h.object);
      if (o && o.alive && o.team !== bot.team && o !== bot.target) return false;
    }
    return true;
  }

  function turnToward(bot, targetYaw, dt) {
    let diff = targetYaw - bot.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < TURN_EPS) {
      bot.yaw = targetYaw;
      return;
    }
    const step = TURN * dt;
    bot.yaw += Math.abs(diff) <= step ? diff : diff > 0 ? step : -step;
  }

  // walk a node route; y follows the node (ramp, gantry, platform), step-up is instant
  function followRoute(bot, dt, speed) {
    let nextName = bot.route[0];
    if (!nextName) {
      bot.route = ROUTES[bot.index].slice();
      nextName = bot.route[0];
    }
    const next = byName[nextName];
    if (!next) {
      bot.route.shift();
      return;
    }
    toNext.set(next.x - bot.position.x, 0, next.z - bot.position.z);
    const d = toNext.length();
    if (d < ARRIVE) {
      bot.route.shift();
      bot.node = nextName;
      bot.lastNode = nextName;
      bot.position.set(next.x, next.y, next.z);
      bot.speed = 0;
      return;
    }
    toNext.multiplyScalar(1 / d);
    bot.speed = speed;
    bot.position.x += toNext.x * speed * dt;
    bot.position.z += toNext.z * speed * dt;
    bot.position.y = next.y;
  }

  // walk the hunt path toward the last known mark; recompute when it runs out
  function followHunt(bot, dt, speed) {
    if (bot.route.length === 0) bot.route = [nearestNode(bot.markX, bot.markZ)];
    followRoute(bot, dt, speed);
  }

  // any shot inside 20 m or a sighting drops the ember patrol; hunting chases the mark
  function alert(position) {
    const x = position.x;
    const z = position.z;
    for (const b of bots) {
      if (!b.alive || b.team !== 'ember') continue;
      const d = Math.hypot(x - b.position.x, z - b.position.z);
      if ((d <= SIGHT_RANGE && playerVisible(b)) || (d <= 20 && b.state === 'patrol')) {
        b.markX = x;
        b.markZ = z;
        b.state = 'hunt';
      }
    }
  }

  function emberShot(bot) {
    chest.set(bot.position.x, bot.position.y + CHEST_Y, bot.position.z);
    player.eyePosition(aim);
    fx.muzzle(chest);
    fx.tracer(chest, aim);
    const dist = Math.hypot(aim.x - chest.x, aim.z - chest.z);
    const t = Math.max(0, Math.min(1, (dist - 10) / 15));
    if (rng() < 0.32 - t * 0.22) {
      opts.onPlayerHit(EMBER_DAMAGE, bot);
      fx.burst(aim, PALETTE.ember);
    }
    bot.burstLeft--;
    bot.nextShotAt = bot.burstLeft > 0 ? clock + EMBER_GAP : clock + PAUSE_MIN + rng() * (PAUSE_MAX - PAUSE_MIN);
  }

  function tideShot(bot, target) {
    if (!botVisible(bot, target)) return;
    chest.set(bot.position.x, bot.position.y + CHEST_Y, bot.position.z);
    aim.set(target.position.x, target.position.y + CHEST_Y, target.position.z);
    fx.muzzle(chest);
    fx.tracer(chest, aim);
    if (rng() < TIDE_CHANCE) applyDamage(target, TIDE_DAMAGE, aim);
    bot.nextShotAt = clock + FIRE_GAP;
  }

  function stepBot(bot, dt) {
    if (!bot.alive) {
      bot.deathT += dt;
      const k = Math.min(1, bot.deathT / DEATH_TIME);
      bot.group.rotation.z = LIE_YAW * k;
      bot.group.position.set(bot.position.x, bot.position.y - LIE_DROP * k, bot.position.z);
      return;
    }
    const isEmber = bot.team === 'ember';
    const ppos = player.state.position;
    const pDist = Math.hypot(ppos.x - bot.position.x, ppos.z - bot.position.z);
    let target = null;
    let heading = bot.yaw;

    if (isEmber) {
      bot.visible = pDist <= SIGHT_RANGE && playerVisible(bot);
      if (bot.visible && pDist <= ENGAGE_RANGE) {
        bot.state = 'engage';
        bot.markX = ppos.x;
        bot.markZ = ppos.z;
      } else if (bot.state === 'engage') {
        bot.state = 'hunt';
      }
    } else {
      for (const o of bots) {
        if (!o.alive || o.team === 'tide') continue;
        if (botVisible(bot, o)) {
          target = o;
          break;
        }
      }
      bot.target = target;
      bot.state = target ? 'engage' : 'patrol';
    }

    if (bot.state === 'engage') {
      const tx = isEmber ? ppos.x : target.position.x;
      const tz = isEmber ? ppos.z : target.position.z;
      const dx = tx - bot.position.x;
      const dz = tz - bot.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.001) {
        lookDir.set(dx / dist, 0, dz / dist);
        heading = Math.atan2(-lookDir.x, -lookDir.z);
      }
      if (clock > bot.strafeUntil) {
        bot.strafeUntil = clock + 0.5 + rng();
        bot.strafe = rng() < 0.5 ? -1 : 1;
      }
      const close = dist < 3;
      desired.set(lookDir.x, 0, lookDir.z).multiplyScalar(close ? -0.8 : 1.4);
      desired.x += -lookDir.z * STRAFE * bot.strafe * (close ? 1 : 0.5);
      desired.z += lookDir.x * STRAFE * bot.strafe * (close ? 1 : 0.5);
      const m = Math.hypot(desired.x, desired.z);
      if (m > ENGAGE) desired.multiplyScalar(ENGAGE / m);
      bot.speed = ENGAGE;
      bot.position.x += desired.x * dt;
      bot.position.z += desired.z * dt;
    } else if (bot.state === 'hunt') {
      followHunt(bot, dt, WALK);
    } else {
      followRoute(bot, dt, WALK);
    }

    if (bot.state === 'engage') {
      turnToward(bot, heading, dt);
    } else if (bot.speed > 0.01) {
      turnToward(bot, Math.atan2(-lookDir.x, -lookDir.z), dt);
    }

    // group yaw mirrors bot yaw (a mesh faces -z at rotation 0)
    bot.group.rotation.y = -bot.yaw;
    bot.group.rotation.z = bot.speed > 0.05 ? Math.sin(clock * 9 + bot.bobPhase) * SWAY : 0;
    bot.group.position.copy(bot.position);

    if (clock < bot.nextShotAt) return;
    if (!isEmber) {
      if (target) tideShot(bot, target);
      return;
    }
    if (bot.state === 'engage' && bot.visible) {
      if (bot.burstLeft <= 0) bot.burstLeft = EMBER_BURST;
      emberShot(bot);
    }
  }

  function applyDamage(target, amount, point) {
    let bot = target;
    if (!bot || typeof bot.health === 'undefined') bot = ownerOf(target);
    if (!bot || !bot.alive) return false;
    bot.health -= amount;
    if (bot.health > 0) return false;
    bot.health = 0;
    bot.alive = false;
    bot.state = 'dead';
    bot.deathT = 0;
    bot.nextShotAt = 0;
    bot.burstLeft = 0;
    for (const m of bot.hitMeshes) delete m.userData.owner;
    fx.burst(point || bot.position, PALETTE.ember);
    return true;
  }

  function aliveCount(team) {
    let n = 0;
    for (const b of bots) if (b.alive && b.team === team) n++;
    return n;
  }

  function findByOwner(target) {
    if (!target) return null;
    if (typeof target.health !== 'undefined') return target;
    return ownerOf(target);
  }

  function reset() {
    const emberYaw = (SPAWNS.ember.yaw * Math.PI) / 180;
    for (const b of bots) {
      b.alive = true;
      b.health = 100;
      b.state = 'patrol';
      b.target = null;
      b.visible = false;
      b.markX = 0;
      b.markZ = 0;
      b.burstLeft = 0;
      b.strafe = 1;
      b.strafeUntil = 0;
      b.deathT = 0;
      b.speed = 0;
      b.nextShotAt = clock + FIRE_START + rng() * 0.6;
      b.node = b.team === 'tide' ? SPAWN_NODE[b.index] : 'ember-spawn';
      b.lastNode = b.node;
      b.route = ROUTES[b.index].slice();
      b.group.rotation.z = LIE_YAW;
      b.group.visible = true;
      for (const m of b.hitMeshes) m.userData.owner = b;
      const spawn = b.team === 'tide' ? SPAWNS.tide : SPAWNS.ember;
      b.position.set(spawn.x, spawn.y, spawn.z);
      b.yaw = b.team === 'tide' ? 0 : emberYaw;
      b.group.position.copy(b.position);
    }
    // the two ember site defenders walk to the sites, the third walks to the middle
    for (const b of bots) {
      if (b.team === 'tide') continue;
      const p = findPath('ember-spawn', b.route[0]);
      if (!p) continue;
      b.route = p.slice();
      b.node = p[0];
      b.lastNode = p[0];
    }
  }

  reset();

  return {
    bots,
    step: function (dt) {
      clock += dt;
      for (const b of bots) stepBot(b, dt);
    },
    reset,
    applyDamage,
    aliveCount,
    findByOwner,
    alert,
  };
}
