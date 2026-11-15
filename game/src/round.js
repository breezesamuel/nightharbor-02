// Nightharbor: the match state machine.
// Owns: the round / score / timer rules that tie the player and the bots
// together, plant and defuse, player damage, and the HUD snapshot.
import * as THREE from 'three';
import { SPAWNS } from './mapdata.js';

const WARMUP_1 = 5;
const LIVE_TIME = 115;
const PLANT_TIME = 3.0;
const FUSE_TIME = 40;
const NEXT_DELAY = 2.5;
const PLANT_RANGE = 2.2;
const MESSAGE_TIME = 2.5;
const ALERT_SPEED = 4;
const ALERT_RANGE = 20;

function createRound(opts) {
  const { player, world, bots, weapons } = opts;

  const state = {
    phase: 'warmup',
    roundNumber: 1,
    scoreTide: 0,
    scoreEmber: 0,
    scoreToWin: 7,
    timeLeft: 0,
    plantTimer: 0,
    chargeSite: null,
    chargePlanted: false,
    playerHealth: 100,
    playerArmour: 100,
    message: '',
    messageUntil: 0,
    winner: null,
  };

  let lastKill = '';
  let matchOver = false;
  let nextAt = -1;
  let plantProgress = 0;
  let clock = 0;

  const eyeTmp = new THREE.Vector3();
  const playerSpawnPos = new THREE.Vector3(SPAWNS.tide.x, SPAWNS.tide.y, SPAWNS.tide.z);

  function say(text) {
    state.message = text;
    state.messageUntil = clock + MESSAGE_TIME;
  }

  function beginRound(n) {
    state.roundNumber = n;
    state.phase = 'live';
    state.timeLeft = LIVE_TIME;
    state.plantTimer = 0;
    state.chargeSite = null;
    state.chargePlanted = false;
    state.playerHealth = 100;
    state.playerArmour = 100;
    state.winner = null;
    lastKill = '';
    plantProgress = 0;
    nextAt = -1;
    player.teleport(playerSpawnPos, 0);
    bots.reset();
    say('ROUND ' + n);
  }

  function endRound(winner) {
    if (winner === 'tide') {
      state.scoreTide += 1;
    } else {
      state.scoreEmber += 1;
    }
    state.winner = winner;
    state.chargePlanted = false;
    state.chargeSite = null;
    state.plantTimer = 0;
    plantProgress = 0;
    state.phase = 'ended';
    if (state.scoreTide >= state.scoreToWin || state.scoreEmber >= state.scoreToWin) {
      matchOver = true;
    }
    nextAt = clock + NEXT_DELAY;
    say(winner === 'tide' ? 'TIDE TAKES THE ROUND' : 'EMBER TAKES THE ROUND');
  }

  function playerDamage(amount, fromBot) {
    if (state.playerHealth <= 0 || state.phase === 'ended' || state.phase === 'warmup') return;
    let left = amount;
    if (state.playerArmour > 0) {
      const absorbed = Math.min(state.playerArmour, left);
      state.playerArmour -= absorbed;
      left -= absorbed;
    }
    if (left > 0) state.playerHealth = Math.max(0, state.playerHealth - left);
    if (state.playerHealth > 0) return;
    if (state.chargePlanted) {
      say('DOWN - THE CHARGE STILL BURNS');
      return;
    }
    lastKill = fromBot ? fromBot.name.toUpperCase() : 'EMBER';
    say('YOU ARE DOWN');
    endRound('ember');
  }

  function siteDistance() {
    const p = player.state.position;
    let best = null;
    let bestD = PLANT_RANGE + 0.001;
    for (const key of ['a', 'b']) {
      const s = world.sites[key];
      if (!s || key === state.chargeSite) continue;
      const d = Math.hypot(p.x - s.plant.x, p.z - s.plant.z);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  function plant() {
    if (state.phase !== 'live' || state.chargePlanted || !player.state.onGround || state.playerHealth <= 0) return;
    const site = siteDistance();
    if (!site) return;
    state.chargeSite = site;
    state.chargePlanted = true;
    state.plantTimer = FUSE_TIME;
    state.phase = 'planted';
    plantProgress = 0;
    say('CHARGE PLANTED AT ' + site.toUpperCase());
  }

  function defuse() {
    if (state.phase !== 'planted' || !state.chargePlanted || !player.state.onGround || state.playerHealth <= 0) return;
    const s = world.sites[state.chargeSite];
    if (!s) return;
    const p = player.state.position;
    if (Math.hypot(p.x - s.plant.x, p.z - s.plant.z) > PLANT_RANGE) return;
    state.chargePlanted = false;
    state.chargeSite = null;
    state.plantTimer = 0;
    state.phase = 'live';
    plantProgress = 0;
    say('CHARGE DEFUSED');
  }

  weapons.onHit = (target, damage, point) => {
    const bot = bots.findByOwner(target);
    if (bot && bot.alive) {
      const died = bots.applyDamage(bot, damage, point);
      if (died) lastKill = bot.name.toUpperCase();
    }
  };

  function step(dt, keys) {
    clock += dt;

    if (state.phase === 'warmup') {
      state.timeLeft = WARMUP_1 - clock;
      if (clock >= WARMUP_1) beginRound(1);
      return;
    }

    if (state.phase === 'ended') {
      if (clock < nextAt) return;
      if (matchOver) {
        state.message = state.winner === 'tide' ? 'TIDE TAKES THE MATCH' : 'EMBER TAKES THE MATCH';
        state.messageUntil = clock + 5;
        return;
      }
      nextAt = -1;
      beginRound(state.roundNumber + 1);
      return;
    }

    // the fuse is the only thing that ends the round once the charge is burning
    if (state.chargePlanted) {
      state.plantTimer -= dt;
      if (state.plantTimer <= 0) {
        state.plantTimer = 0;
        state.chargePlanted = false;
        state.chargeSite = null;
        say('CHARGE DETONATES');
        endRound('tide');
        return;
      }
    }

    if (state.phase === 'live') {
      state.timeLeft -= dt;
      if (state.timeLeft <= 0) {
        state.timeLeft = 0;
        say('TIME - EMBER HOLDS');
        endRound('ember');
        return;
      }
      if (bots.aliveCount('ember') === 0) {
        say('SITE CLEARED');
        endRound('tide');
        return;
      }
    }

    // alert the embers when the player moves fast and close
    if (player.state.onGround && player.groundSpeed() > ALERT_SPEED) {
      const ppos = player.state.position;
      for (const b of bots.bots) {
        if (b.alive && b.team === 'ember' && Math.hypot(ppos.x - b.position.x, ppos.z - b.position.z) <= ALERT_RANGE) {
          player.eyePosition(eyeTmp);
          bots.alert(eyeTmp);
          break;
        }
      }
    }

    // plant channel: hold KeyE in range, cancelled by moving off the site
    if (state.phase === 'live' && !state.chargePlanted && state.playerHealth > 0 && keys && keys.has('KeyE') && player.state.onGround) {
      const site = siteDistance();
      if (site) {
        plantProgress += dt;
        if (plantProgress >= PLANT_TIME) {
          plantProgress = 0;
          plant();
          return;
        }
      } else {
        plantProgress = 0;
      }
    }

    // defuse channel: hold KeyE at the burning charge, cancelled by moving
    if (state.phase === 'planted' && state.chargePlanted && state.playerHealth > 0 && keys && keys.has('KeyE') && player.state.onGround) {
      const s = world.sites[state.chargeSite];
      if (s) {
        const p = player.state.position;
        if (Math.hypot(p.x - s.plant.x, p.z - s.plant.z) <= PLANT_RANGE) {
          plantProgress += dt;
          if (plantProgress >= PLANT_TIME) {
            plantProgress = 0;
            defuse();
            return;
          }
        } else {
          plantProgress = 0;
        }
      }
    }

    state.playerHealth = Math.max(0, state.playerHealth);
  }

  function startRound(n) {
    beginRound(n);
  }

  function hudSnapshot() {
    const w = weapons.state;
    return {
      phase: state.phase,
      roundNumber: state.roundNumber,
      scoreTide: state.scoreTide,
      scoreEmber: state.scoreEmber,
      timeLeft: Math.max(0, Math.ceil(state.timeLeft)),
      playerHealth: state.playerHealth,
      playerArmour: state.playerArmour,
      ammo: w ? w.ammo : 0,
      reserve: w ? w.reserve : 0,
      reloading: w ? w.reloading : false,
      scoreToWin: state.scoreToWin,
      message: state.message,
      aliveTide: bots.aliveCount('tide'),
      aliveEmber: bots.aliveCount('ember'),
      chargeSite: state.chargeSite,
      chargePlanted: state.chargePlanted,
      lastKill,
    };
  }

  state.phase = 'warmup';
  state.roundNumber = 1;
  state.timeLeft = WARMUP_1;
  state.winner = null;

  return {
    state,
    step,
    startRound,
    playerDamage,
    plant,
    defuse,
    hudSnapshot,
  };
}

export { createRound };
