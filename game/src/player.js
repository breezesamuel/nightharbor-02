// NIGHTHARBOR: first-person body and movement.
// Owns: wish-direction accel/friction, jump, crouch, per-axis AABB collision
// with step-up, landing dip, head bob, view kick decay and eye position.
import * as THREE from 'three';

const WALK = 5.0;
const SPRINT = 7.2;
const CROUCH = 2.2;
const GROUND_ACCEL = 40;
const AIR_ACCEL = 8;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP = 6.0;
const TERMINAL = 40;
const RADIUS = 0.34;
const STAND_H = 1.8;
const CROUCH_H = 1.2;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.02;
const STEP_UP = 0.4;
const SKIN = 0.04;
const SENS = 0.0022;
const SENS_Y = 1.2;
const SENS_X = 1.8;

const wishDir = new THREE.Vector3();
const box = new THREE.Box3();
const boxAt = new THREE.Box3();

function createPlayer(world) {
  const spawn = world.spawns.tide;
  const yaw = (spawn.yaw * Math.PI) / 180;
  const state = {
    position: new THREE.Vector3(spawn.x, 0, spawn.z),
    velocity: new THREE.Vector3(),
    yaw,
    pitch: 0,
    eye: EYE_STAND,
    onGround: false,
    crouching: false,
    height: STAND_H,
    bob: 0,
    bobAmount: 0,
    landDip: 0,
    kickPitch: 0,
    kickYaw: 0,
    sprinting: false,
  };

  function boxHere(out) {
    out.min.set(
      state.position.x - RADIUS + SKIN,
      state.position.y + SKIN,
      state.position.z - RADIUS + SKIN
    );
    out.max.set(
      state.position.x + RADIUS - SKIN,
      state.position.y + state.height - SKIN,
      state.position.z + RADIUS - SKIN
    );
    return out;
  }

  // Horizontal axis sweep. If a collider blocks the moved box, first try to
  // step up on it: when the top is within STEP_UP of the feet and the box at
  // that lifted height clears the collider, raise the feet; otherwise clamp
  // the position at the collider face.
  function moveAxis(axis, amount) {
    if (amount === 0) return;
    state.position[axis] += amount;
    boxHere(box);
    for (const c of world.colliders) {
      if (!box.intersectsBox(c)) continue;
      const lifted = stepUpOn(c);
      if (lifted > 0) {
        state.position.y = lifted;
        boxHere(box);
        if (!box.intersectsBox(c)) continue;
      }
      if (axis === 'x') {
        state.position.x = amount > 0 ? c.min.x - RADIUS + SKIN : c.max.x + RADIUS - SKIN;
      } else {
        state.position.z = amount > 0 ? c.min.z - RADIUS + SKIN : c.max.z + RADIUS - SKIN;
      }
      boxHere(box);
      break;
    }
  }

  // Top of a collider the feet can step onto, or null when not step-up-able.
  function stepUpOn(c) {
    const top = c.max.y;
    if (top <= state.position.y || top - state.position.y > STEP_UP) return null;
    boxAt.min.set(
      state.position.x - RADIUS + SKIN,
      top + SKIN,
      state.position.z - RADIUS + SKIN
    );
    boxAt.max.set(
      state.position.x + RADIUS - SKIN,
      top + state.height - SKIN,
      state.position.z + RADIUS - SKIN
    );
    if (boxAt.intersectsBox(c)) return null;
    // the lift only counts if no other collider still blocks at the new height
    for (const o of world.colliders) {
      if (o === c) continue;
      if (boxAt.intersectsBox(o)) return null;
    }
    return top;
  }

  function step(dt, keys) {
    // --- look: I/J turn yaw at 1.8 rad/s, K/L pitch at 1.2 rad/s ---
    let turn = 0;
    let pitchMove = 0;
    if (keys.has('KeyI')) turn += SENS_X * dt;
    if (keys.has('KeyJ')) turn -= SENS_X * dt;
    if (keys.has('KeyK')) pitchMove += SENS_Y * dt;
    if (keys.has('KeyL')) pitchMove -= SENS_Y * dt;
    state.yaw += turn;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + pitchMove));

    // --- crouch state ---
    const crouching = keys.has('ControlLeft') || keys.has('ControlRight');
    state.crouching = crouching;
    const targetH = crouching ? CROUCH_H : STAND_H;
    state.height += (targetH - state.height) * Math.min(1, 12 * dt);

    // --- wish direction: WASD, arrows always move ---
    const fwd = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
    const back = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;
    const left = keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0;
    const right = keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0;
    const f = fwd - back;
    const s = right - left;
    const sy = Math.sin(state.yaw);
    const cy = Math.cos(state.yaw);
    // yaw 0 faces -z; forward is -z, right is +x
    wishDir.set(s * cy - f * sy, 0, -s * sy - f * cy);
    if (wishDir.lengthSq() > 0) wishDir.normalize();

    // --- speed limit: sprint when Shift held and not firing ---
    const sprint = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !keys.has('Mouse0');
    state.sprinting = sprint;
    const speed = crouching ? CROUCH : sprint ? SPRINT : WALK;
    const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const factor = Math.min(1, (accel * dt) / speed);
    state.velocity.x += (wishDir.x * speed - state.velocity.x) * factor;
    state.velocity.z += (wishDir.z * speed - state.velocity.z) * factor;
    if (wishDir.lengthSq() === 0 && state.onGround) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      state.velocity.x *= damp;
      state.velocity.z *= damp;
      if (Math.abs(state.velocity.x) < 0.01) state.velocity.x = 0;
      if (Math.abs(state.velocity.z) < 0.01) state.velocity.z = 0;
    }

    // --- jump ---
    if (keys.has('Space') && state.onGround) {
      state.velocity.y = JUMP;
      state.onGround = false;
    }

    // --- gravity, clamped at terminal fall ---
    state.velocity.y = Math.max(-TERMINAL, state.velocity.y - GRAVITY * dt);

    // --- horizontal: one axis at a time, step-up before blocking ---
    moveAxis('x', state.velocity.x * dt);
    moveAxis('z', state.velocity.z * dt);

    // --- vertical: land on tops, stop under low ceilings ---
    const oldY = state.position.y;
    state.position.y += state.velocity.y * dt;
    state.onGround = false;
    if (state.position.y < 0) state.position.y = 0;
    {
      boxHere(box);
      for (const c of world.colliders) {
        if (!box.intersectsBox(c)) continue;
        if (state.velocity.y <= 0 && c.max.y <= oldY + SKIN) {
          // falling: the collider top is below the old feet, land on it
          const fall = oldY - c.max.y;
          state.position.y = c.max.y;
          state.velocity.y = 0;
          state.onGround = true;
          if (fall > 0.6) state.landDip = 0.08;
        } else if (state.velocity.y > 0 && c.min.y >= oldY + state.height - SKIN) {
          // rising: the collider bottom is above the old head, stop
          state.position.y = c.min.y - state.height;
          state.velocity.y = 0;
        }
      }
    }
    if (state.position.y < 0) state.position.y = 0;

    // --- camera feel: bob, dip, kick decay, eye easing ---
    const hSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const bobTarget = state.onGround ? Math.min(hSpeed / WALK, 1.5) * 0.035 : 0;
    state.bobAmount += (bobTarget - state.bobAmount) * Math.min(1, 10 * dt);
    if (state.onGround && hSpeed > 0.01) {
      state.bob += (hSpeed / WALK) * 2 * Math.PI * 9 * dt;
    }
    state.landDip = Math.max(0, state.landDip - 0.32 * dt);
    const kickDecay = Math.min(1, 12 * dt);
    state.kickPitch *= 1 - kickDecay;
    state.kickYaw *= 1 - kickDecay;
    const eyeTarget = crouching ? EYE_CROUCH : EYE_STAND;
    state.eye += (eyeTarget - state.eye) * Math.min(1, 12 * dt);
  }

  function look(dx, dy, sensitivity = SENS) {
    state.yaw -= dx * sensitivity;
    state.pitch -= dy * sensitivity * SENS_Y;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch));
  }

  function kick(pitch, yaw) {
    state.kickPitch += pitch;
    state.kickYaw += yaw;
  }

  function groundSpeed() {
    return Math.hypot(state.velocity.x, state.velocity.z);
  }

  function eyePosition(target) {
    const bobY = Math.sin(state.bob) * state.bobAmount;
    target.set(
      state.position.x,
      state.position.y + state.eye + bobY - state.landDip,
      state.position.z
    );
    return target;
  }

  function teleport(position, yawRadians) {
    state.position.copy(position);
    state.velocity.set(0, 0, 0);
    state.yaw = yawRadians;
    state.pitch = 0;
    state.onGround = false;
  }

  function setCrouch(v) {
    state.crouching = v;
  }

  return { state, step, look, kick, groundSpeed, eyePosition, teleport, setCrouch };
}

export { createPlayer };
