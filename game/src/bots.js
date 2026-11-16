// Nightharbor: the six combat bots.
//
// Owns: bot construction, A* over NAV, line-of-sight tests, the patrol / hunt /
// engage state machine, ember fire on the player, ambient tide fire, damage
// bookkeeping, the death fall and the per-round reset.
//
// Public API returned by createBots():
//   bots                 - the six bot records (also registered in world.shootables)
//   step(dt)             - advance the AI clock and every bot by dt seconds
//   reset()              - revive all six at their spawn points for a new round
//   applyDamage(t, n, p) - subtract health; returns true when the target dies
//   aliveCount(team)     - living bots on 'tide' or 'ember'
//   findByOwner(obj)     - resolve a raycast hit object to its bot record
//   alert(position)      - pull ember defenders toward a gunshot or sighting
//
// Injected dependencies: scene, world (nav.byName plus shootables), player,
// fx (muzzle / tracer / burst) and onPlayerHit(damage, bot).
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { NAV, SPAWNS } from './mapdata.js';

// ---- movement, sight and turn tuning -------------------------------------
const WALK = 3.1; // patrol / hunt ground speed, m/s
const ENGAGE = 2.2; // combat strafe speed cap, m/s
const STRAFE = 1.6; // lateral weight inside the engage velocity
const TURN = 6; // radians per second of body yaw
const EYE = 1.55; // sight ray height above the bot's feet
const SIGHT_RANGE = 34; // hard cut-off for every sight test, metres
const ENGAGE_RANGE = 26; // ember bots only shoot inside this radius
const FOV_PATROL = Math.cos((100 * Math.PI) / 360); // 100 degree patrol cone
const HEAD_Y = 1.62;
const CHEST_Y = 1.18;
const ARRIVE = 0.3; // distance at which a nav node counts as reached
const TURN_EPS = 0.03; // yaw error that snaps instead of easing
const FIRE_START = 0.8; // first shot delay after reset / round start
const FIRE_START_JITTER = 0.6;
const FIRE_GAP = 0.16; // tide bot shot cadence
const TIDE_CHANCE = 0.35; // tide bots are deliberately sloppy shots
const TIDE_DAMAGE = 14;
const EMBER_DAMAGE = 12;
const EMBER_BURST = 3;
const EMBER_GAP = 0.09; // gap inside an ember burst
const PAUSE_MIN = 0.7; // gap between ember bursts
const PAUSE_MAX = 1.2;
const DEATH_TIME = 0.45; // seconds of the fall-to-ground animation
const LIE_YAW = (22 * Math.PI) / 180; // final roll of a corpse
const LIE_DROP = 0.1; // final sink of a corpse
const SWAY = (1.5 * Math.PI) / 180; // walk sway amplitude

const MAX_HEALTH = 100;
const SHOT_ALERT_RADIUS = 20; // gunshots wake ember patrols inside this radius
const ENGAGE_CLOSE_DIST = 3; // closer than this the bot backs off
const ENGAGE_ADVANCE = 1.4; // forward weight of the engage velocity
const ENGAGE_BACKSTEP = -0.8; // backward weight when pressed
const ENGAGE_STRAFE_SCALE = 0.5; // lateral weight while at range
const STRAFE_HOLD_MIN = 0.5; // seconds a strafe direction is held
const STRAFE_HOLD_JITTER = 1;
const BOB_HZ = 9; // walk sway frequency
const SIGHT_EPS = 1e-6; // degenerate distance guard

// Ember hit model: chance falls off with range inside [NEAR, NEAR + SPAN].
const EMBER_HIT_BASE = 0.32;
const EMBER_HIT_FALLOFF = 0.22;
const EMBER_FALLOFF_NEAR = 10;
const EMBER_FALLOFF_SPAN = 15;

// ---- body proportions (shared by every bot) -------------------------------
const LEG_X = 0.12;
const LEG_Y = 0.43;
const VEST_Y = 0.5;
const VEST_Z = 0.03;
const PACK_Y = 0.45;
const PACK_Z = 0.2;
const ARM_X = 0.31; // arms reuse the leg box at chest height
const VISOR_Y = HEAD_Y + 0.02;
const VISOR_Z = -0.11;
const STRIPE_Y = CHEST_Y + 0.14;
const STRIPE_Z = -0.14;
const PATCH_X = 0.28;
const PATCH_Y = CHEST_Y + 0.2;
const PATCH_Z = -0.09;

const TEAM_TIDE = 'tide';
const TEAM_EMBER = 'ember';
const STATE_PATROL = 'patrol';
const STATE_HUNT = 'hunt';
const STATE_ENGAGE = 'engage';
const STATE_DEAD = 'dead';

// ---- deterministic RNG ----------------------------------------------------
// Seeded so a replay of the same player inputs lands the same shots.
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

// ---- nav graph ------------------------------------------------------------
// adjacency over the flat NAV node tables, kept in plain arrays; the index map
// has no prototype so an id such as "constructor" can never collide.
const NODE_NAMES = Object.keys(NAV.nodes);
const NODE_INDEX = Object.create(null);
for (let i = 0; i < NODE_NAMES.length; i++) NODE_INDEX[NODE_NAMES[i]] = i;
const ADJ = NODE_NAMES.map(function () { return []; });
for (const [a, b] of NAV.edges) {
  const ia = NODE_INDEX[a];
  const ib = NODE_INDEX[b];
  if (ia === undefined || ib === undefined) continue;
  ADJ[ia].push(ib);
  ADJ[ib].push(ia);
}

// precomputed pairwise node distances: the A* heuristic never allocates.
// The pair key is a plain integer hash; node counts are small enough that a
// collision would need two pairs with the same hi / lo product.
const PAIR_HASH_STRIDE = 31;
const distCache = new Map();
function nodeDist(a, b) {
  const hi = a < b ? a : b;
  const lo = a < b ? b : a;
  const key = hi * PAIR_HASH_STRIDE + lo;
  let d = distCache.get(key);
  if (d === undefined) {
    const pa = NAV.nodes[NODE_NAMES[hi]];
    const pb = NAV.nodes[NODE_NAMES[lo]];
    // the y term is doubled so ramps cost more than their flat distance
    d = Math.hypot(pa.x - pb.x, pa.z - pb.z, (pa.y - pb.y) * 2);
    distCache.set(key, d);
  }
  return d;
}

// ---- shared low-poly geometry (one set, cloned per bot) -------------------
const G = {
  torso: new THREE.BoxGeometry(0.46, 0.62, 0.26),
  head: new THREE.BoxGeometry(0.22, 0.24, 0.22),
  leg: new THREE.BoxGeometry(0.16, 0.86, 0.2),
  arm: new THREE.BoxGeometry(0.13, 0.5, 0.16),
  visor: new THREE.BoxGeometry(0.26, 0.06, 0.02),
  patch: new THREE.BoxGeometry(0.1, 0.1, 0.02),
  stripe: new THREE.BoxGeometry(0.34, 0.035, 0.02),
};

// ---- roster: name, spawn node, patrol route -------------------------------
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
const TIDE_COUNT = 3; // bots 0..2 hold the tideway, 3..5 defend the ember sites

// ---- mesh assembly --------------------------------------------------------
// Builds the blocky body, tags the shootable parts with `owner` and records
// them in bot.hitMeshes so damage, sight and death can find the bot again.
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
  // legs, then the vest plates that thicken them
  mk(G.leg, mats.body, -LEG_X, LEG_Y, 0, true);
  mk(G.leg, mats.body, LEG_X, LEG_Y, 0, true);
  mk(G.leg, mats.vest, -LEG_X, VEST_Y, VEST_Z, false);
  mk(G.leg, mats.vest, LEG_X, VEST_Y, VEST_Z, false);
  mk(G.leg, mats.vest, 0, PACK_Y, PACK_Z, false); // backpack
  // arms reuse the leg box, hung at chest height
  mk(G.leg, mats.body, -ARM_X, CHEST_Y, 0, false);
  mk(G.leg, mats.body, ARM_X, CHEST_Y, 0, false);
  bot.head = mk(G.head, mats.body, 0, HEAD_Y, 0, true);
  bot.head.userData.head = true;
  // team colour: visor, chest stripe and shoulder patches
  mk(G.visor, teamMat, 0, VISOR_Y, VISOR_Z, false);
  mk(G.stripe, teamMat, 0, STRIPE_Y, STRIPE_Z, false);
  mk(G.patch, teamMat, -PATCH_X, PATCH_Y, PATCH_Z, false);
  mk(G.patch, teamMat, PATCH_X, PATCH_Y, PATCH_Z, false);
  return group;
}

/**
 * Creates the bot system: six bodies, their AI and the shared damage / reset
 * bookkeeping for a round.
 *
 * @param {object} opts
 * @param {THREE.Scene} opts.scene              parent for every bot group
 * @param {object} opts.world                   world.nav.byName + world.shootables
 * @param {object} opts.player                  player.state.position, player.eyePosition(out)
 * @param {object} opts.fx                      muzzle / tracer / burst effects
 * @param {(damage:number, bot:object)=>void} opts.onPlayerHit
 * @returns {object} see the module header for the public surface
 */
export function createBots(opts) {
  const { scene, world, player, fx } = opts;
  const onPlayerHit = typeof opts.onPlayerHit === 'function' ? opts.onPlayerHit : function () {};
  const rng = mulberry32(20260714);
  const nav = (world && world.nav) || {};
  const byName = nav.byName || NAV.nodes;
  const shootables = world.shootables || (world.shootables = []);

  // ---- shared materials ---------------------------------------------------
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x39454b, roughness: 0.7, metalness: 0.25 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x222c30, roughness: 0.85, metalness: 0.15 });
  const tideVisor = new THREE.MeshStandardMaterial({ color: PALETTE.tide, emissive: new THREE.Color(PALETTE.tide), emissiveIntensity: 3.4 });
  const emberVisor = new THREE.MeshStandardMaterial({ color: PALETTE.ember, emissive: new THREE.Color(PALETTE.ember), emissiveIntensity: 3.4 });
  const mats = { body: bodyMat, vest: vestMat };

  // ---- bot records --------------------------------------------------------
  const bots = [];
  for (let i = 0; i < 6; i++) {
    const team = i < TIDE_COUNT ? TEAM_TIDE : TEAM_EMBER;
    const bot = {
      name: NAMES[i],
      team,
      index: i,
      group: null,
      health: MAX_HEALTH,
      alive: true,
      position: new THREE.Vector3(),
      yaw: 0,
      speed: 0,
      node: SPAWN_NODE[i],
      route: ROUTES[i].slice(),
      state: STATE_PATROL,
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
      bobPhase: i * 1.3, // desynchronises the walk sway
    };
    bot.group = buildBody(bot, mats, team === TEAM_TIDE ? tideVisor : emberVisor);
    bot.group.rotation.z = LIE_YAW;
    bot.group.visible = false;
    scene.add(bot.group);
    for (const m of bot.hitMeshes) shootables.push(m);
    bots.push(bot);
  }

  let clock = 0; // seconds since construction, shared by every timer below

  // ---- pathfinding --------------------------------------------------------
  // A* over the nav graph: iterative, one linear scan of the open set per pop.
  // Returns an array of node names from `fromName` to `toName`, or null.
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
    if (!closed[goal]) return null; // goal unreachable from here
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
      if (!p) continue;
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

  // ---- shared scratch objects (no per-frame allocation) --------------------
  const raycaster = new THREE.Raycaster();
  const lookDir = new THREE.Vector3();
  const toNext = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const eyeRay = new THREE.Vector3();

  function ownerOf(mesh) {
    return (mesh && mesh.userData && mesh.userData.owner) || null;
  }

  // Horizontal distance between two world-space points. Bots never fly, so
  // every sight / alert / damage range check stays on the XZ plane.
  function flatDist(ax, az, bx, bz) {
    return Math.hypot(ax - bx, az - bz);
  }

  // ---- sight tests --------------------------------------------------------
  // Straight sight to an enemy bot: a wall blocks, a teammate or corpse does not.
  function botVisible(fromBot, target) {
    if (!target || !target.position) return false;
    const dx = target.position.x - fromBot.position.x;
    const dz = target.position.z - fromBot.position.z;
    const dist = flatDist(target.position.x, target.position.z, fromBot.position.x, fromBot.position.z);
    if (dist > SIGHT_RANGE) return false;
    if (dist < SIGHT_EPS) return true; // standing on top of the mark
    // an already-alerted bot looks in every direction, a patrolling one only
    // inside its forward cone (meshes face -z at yaw 0)
    if (fromBot.visible) {
      if (dist > ENGAGE_RANGE) return false;
    } else if (Math.cos(fromBot.yaw) * -dx / dist + Math.sin(fromBot.yaw) * -dz / dist < FOV_PATROL) {
      return false;
    }
    eyeRay.set(fromBot.position.x, fromBot.position.y + EYE, fromBot.position.z);
    raycaster.set(eyeRay, lookDir.set(dx / dist, 0, dz / dist));
    raycaster.far = dist;
    for (const h of raycaster.intersectObjects(shootables, true)) {
      const o = ownerOf(h.object);
      if (o) {
        if (!o.alive || o.team === fromBot.team) continue;
        return o === target;
      }
      return false; // world geometry between the two
    }
    return true;
  }

  // Player sight: walls block, same-team and dead bodies never do.
  function playerVisible(bot) {
    const ppos = player.state.position;
    const dx = ppos.x - bot.position.x;
    const dz = ppos.z - bot.position.z;
    const dist = flatDist(ppos.x, ppos.z, bot.position.x, bot.position.z);
    if (dist > SIGHT_RANGE) return false;
    if (dist < SIGHT_EPS) return true;
    eyeRay.set(bot.position.x, bot.position.y + EYE, bot.position.z);
    raycaster.set(eyeRay, lookDir.set(dx / dist, 0, dz / dist));
    raycaster.far = dist;
    for (const h of raycaster.intersectObjects(shootables, true)) {
      const o = ownerOf(h.object);
      if (o && o.alive && o.team !== bot.team && o !== bot.target) return false;
    }
    return true;
  }

  // ---- movement helpers ---------------------------------------------------
  // Eases yaw toward targetYaw along the shortest arc; snaps inside TURN_EPS.
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

  // Walk a node route; y follows the node (ramp, gantry, platform), so step-up
  // is instant. Reaching a node sets bot.node and clears the speed reading.
  function followRoute(bot, dt, speed) {
    let nextName = bot.route[0];
    if (!nextName) {
      bot.route = ROUTES[bot.index].slice(); // route exhausted: loop it
      nextName = bot.route[0];
    }
    const next = byName[nextName];
    if (!next) {
      bot.route.shift(); // stale node id, drop it
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

  // Walk the hunt path toward the last known mark; recompute when it runs out.
  function followHunt(bot, dt, speed) {
    if (bot.route.length === 0) bot.route = [nearestNode(bot.markX, bot.markZ)];
    followRoute(bot, dt, speed);
  }

  // Any ember bot that can see the shot, or any patrol inside the alert radius,
  // converges on the position. Called by the round on every player shot.
  function alert(position) {
    if (!position) return;
    const x = position.x;
    const z = position.z;
    for (const b of bots) {
      if (!b.alive || b.team !== TEAM_EMBER) continue;
      const d = flatDist(x, z, b.position.x, b.position.z);
      const seesIt = d <= SIGHT_RANGE && playerVisible(b);
      const hearsIt = d <= SHOT_ALERT_RADIUS && b.state === STATE_PATROL;
      if (seesIt || hearsIt) {
        b.markX = x;
        b.markZ = z;
        b.state = STATE_HUNT;
      }
    }
  }

  // ---- shooting -----------------------------------------------------------
  // One ember shot at the player: tracer always, damage rolled with distance.
  function emberShot(bot) {
    chest.set(bot.position.x, bot.position.y + CHEST_Y, bot.position.z);
    player.eyePosition(aim);
    fx.muzzle(chest);
    fx.tracer(chest, aim);
    const dist = flatDist(aim.x, aim.z, chest.x, chest.z);
    // within 10 m the roll is at its base value, 25 m out it is weakest
    const t = Math.max(0, Math.min(1, (dist - EMBER_FALLOFF_NEAR) / EMBER_FALLOFF_SPAN));
    if (rng() < EMBER_HIT_BASE - t * EMBER_HIT_FALLOFF) {
      onPlayerHit(EMBER_DAMAGE, bot);
      fx.burst(aim, PALETTE.ember);
    }
    bot.burstLeft--;
    bot.nextShotAt = bot.burstLeft > 0
      ? clock + EMBER_GAP
      : clock + PAUSE_MIN + rng() * (PAUSE_MAX - PAUSE_MIN);
  }

  // One tide shot at an enemy bot: only lands if the target is still in sight.
  function tideShot(bot, target) {
    if (!botVisible(bot, target)) return;
    chest.set(bot.position.x, bot.position.y + CHEST_Y, bot.position.z);
    aim.set(target.position.x, target.position.y + CHEST_Y, target.position.z);
    fx.muzzle(chest);
    fx.tracer(chest, aim);
    if (rng() < TIDE_CHANCE) applyDamage(target, TIDE_DAMAGE, aim);
    bot.nextShotAt = clock + FIRE_GAP;
  }

  // ---- per-frame AI -------------------------------------------------------
  function stepBot(bot, dt) {
    // dead: sink and roll into the corpse pose, nothing else runs
    if (!bot.alive) {
      bot.deathT += dt;
      const k = Math.min(1, bot.deathT / DEATH_TIME);
      bot.group.rotation.z = LIE_YAW * k;
      bot.group.position.set(bot.position.x, bot.position.y - LIE_DROP * k, bot.position.z);
      return;
    }

    const isEmber = bot.team === TEAM_EMBER;
    const ppos = player.state.position;
    const pDist = flatDist(ppos.x, ppos.z, bot.position.x, bot.position.z);
    let target = null;
    let heading = bot.yaw;

    // ---- target acquisition ----
    if (isEmber) {
      bot.visible = pDist <= SIGHT_RANGE && playerVisible(bot);
      if (bot.visible && pDist <= ENGAGE_RANGE) {
        bot.state = STATE_ENGAGE;
        bot.markX = ppos.x;
        bot.markZ = ppos.z;
      } else if (bot.state === STATE_ENGAGE) {
        bot.state = STATE_HUNT; // lost the player: chase the last mark
      }
    } else {
      for (const o of bots) {
        if (!o.alive || o.team === TEAM_TIDE) continue;
        if (botVisible(bot, o)) {
          target = o;
          break;
        }
      }
      bot.target = target;
      // no enemy in sight this frame: the tide bots fall back to their route
      bot.state = target ? STATE_ENGAGE : STATE_PATROL;
    }

    // ---- movement ----
    if (bot.state === STATE_ENGAGE) {
      const tx = isEmber ? ppos.x : target.position.x;
      const tz = isEmber ? ppos.z : target.position.z;
      const dx = tx - bot.position.x;
      const dz = tz - bot.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.001) {
        lookDir.set(dx / dist, 0, dz / dist);
        heading = Math.atan2(-lookDir.x, -lookDir.z);
      }
      // re-roll the strafe direction every 0.5 - 1.5 s
      if (clock > bot.strafeUntil) {
        bot.strafeUntil = clock + STRAFE_HOLD_MIN + rng() * STRAFE_HOLD_JITTER;
        bot.strafe = rng() < 0.5 ? -1 : 1;
      }
      const close = dist < ENGAGE_CLOSE_DIST;
      desired.set(lookDir.x, 0, lookDir.z).multiplyScalar(close ? ENGAGE_BACKSTEP : ENGAGE_ADVANCE);
      const lateral = STRAFE * bot.strafe * (close ? 1 : ENGAGE_STRAFE_SCALE);
      desired.x += -lookDir.z * lateral;
      desired.z += lookDir.x * lateral;
      const m = Math.hypot(desired.x, desired.z);
      if (m > ENGAGE) desired.multiplyScalar(ENGAGE / m); // cap the combat speed
      bot.speed = ENGAGE;
      bot.position.x += desired.x * dt;
      bot.position.z += desired.z * dt;
    } else if (bot.state === STATE_HUNT) {
      followHunt(bot, dt, WALK);
    } else {
      followRoute(bot, dt, WALK);
    }

    // ---- facing ----
    // While walking, the heading reuses the lookDir scratch, which still holds
    // the direction of the last sight test or engage aim.
    if (bot.state === STATE_ENGAGE) {
      turnToward(bot, heading, dt);
    } else if (bot.speed > 0.01) {
      turnToward(bot, Math.atan2(-lookDir.x, -lookDir.z), dt);
    }

    // group yaw mirrors bot yaw (a mesh faces -z at rotation 0)
    bot.group.rotation.y = -bot.yaw;
    bot.group.rotation.z = bot.speed > 0.05 ? Math.sin(clock * BOB_HZ + bot.bobPhase) * SWAY : 0;
    bot.group.position.copy(bot.position);

    // ---- firing ----
    if (clock < bot.nextShotAt) return;
    if (!isEmber) {
      if (target) tideShot(bot, target);
      return;
    }
    if (bot.state === STATE_ENGAGE && bot.visible) {
      if (bot.burstLeft <= 0) bot.burstLeft = EMBER_BURST;
      emberShot(bot);
    }
  }

  /**
   * Subtracts health. Accepts either a bot record or a hit mesh; returns true
   * only on the transition from alive to dead.
   */
  function applyDamage(target, amount, point) {
    let bot = target;
    if (!bot || typeof bot.health === 'undefined') bot = ownerOf(target);
    if (!bot || !bot.alive) return false;
    if (typeof amount !== 'number' || !isFinite(amount)) return false;
    bot.health -= amount;
    if (bot.health > 0) return false;
    bot.health = 0;
    bot.alive = false;
    bot.state = STATE_DEAD;
    bot.deathT = 0;
    bot.nextShotAt = 0;
    bot.burstLeft = 0;
    for (const m of bot.hitMeshes) delete m.userData.owner; // corpses stop blocking rays
    fx.burst(point || bot.position, PALETTE.ember);
    return true;
  }

  function aliveCount(team) {
    let n = 0;
    for (const b of bots) if (b.alive && b.team === team) n++;
    return n;
  }

  // Resolves a raycast hit (mesh) or an already-resolved bot record.
  function findByOwner(target) {
    if (!target) return null;
    if (typeof target.health !== 'undefined') return target;
    return ownerOf(target);
  }

  // ---- round reset --------------------------------------------------------
  function reset() {
    const emberYaw = (SPAWNS.ember.yaw * Math.PI) / 180;
    for (const b of bots) {
      b.alive = true;
      b.health = MAX_HEALTH;
      b.state = STATE_PATROL;
      b.target = null;
      b.visible = false;
      b.markX = 0;
      b.markZ = 0;
      b.burstLeft = 0;
      b.strafe = 1;
      b.strafeUntil = 0;
      b.deathT = 0;
      b.speed = 0;
      b.nextShotAt = clock + FIRE_START + rng() * FIRE_START_JITTER;
      b.node = b.team === TEAM_TIDE ? SPAWN_NODE[b.index] : 'ember-spawn';
      b.lastNode = b.node;
      b.route = ROUTES[b.index].slice();
      b.group.rotation.z = LIE_YAW;
      b.group.visible = true;
      for (const m of b.hitMeshes) m.userData.owner = b;
      const spawn = b.team === TEAM_TIDE ? SPAWNS.tide : SPAWNS.ember;
      b.position.set(spawn.x, spawn.y, spawn.z);
      b.yaw = b.team === TEAM_TIDE ? 0 : emberYaw;
      b.group.position.copy(b.position);
    }
    // the two ember site defenders walk to their sites, the third to the middle
    for (const b of bots) {
      if (b.team === TEAM_TIDE) continue;
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
