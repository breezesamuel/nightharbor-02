/**
 * NIGHTHARBOR Game Configuration Module
 *
 * Centralizes all tunable constants for the game into a single source
 * of truth. Changes here propagate across all subsystems without
 * touching individual game modules. This follows the configuration
 * pattern recommended by the Three.js FPS kit documentation.
 *
 * @module config
 */

// ─── Audio Configuration ────────────────────────────────────────────────
/** WebAudio sample rate used by the procedural audio system. */
export const SAMPLE_RATE = 44100;
/** Default audio master volume (0.0 to 1.0). */
export const MASTER_VOLUME = 0.75;
/** Background ambient loop gain. */
export const AMBIENT_GAIN = 0.15;
/** Footstep sound pitch variation range. */
export const FOOTSTEP_PITCH_VARIATION = 0.12;
/** Number of simultaneous ambient drone voices. */
export const DRONE_VOICE_COUNT = 3;

// ─── Rendering Configuration ────────────────────────────────────────────
/** Three.js renderer antialiasing toggle. */
export const RENDER_AA = true;
/** Target frames per second for the game loop. */
export const TARGET_FPS = 60;
/** Minimum acceptable frames per second before throttling. */
export const MIN_FPS_THRESHOLD = 30;
/** Fog near plane distance in world units. */
export const FOG_NEAR = 15.0;
/** Fog far plane distance in world units. */
export const FOG_FAR = 80.0;
/** Fog color hex string matching the night harbor atmosphere. */
export const FOG_COLOR = '#0a1216';
/** Ambient light intensity multiplier. */
export const AMBIENT_LIGHT_INTENSITY = 0.3;
/** Directional light intensity (moonlight simulation). */
export const SUNLIGHT_INTENSITY = 0.6;

// ─── Input Configuration ────────────────────────────────────────────────
/** Mouse sensitivity factor for camera rotation. */
export const MOUSE_SENSITIVITY = 0.002;
/** Keyboard movement speed in world units per second. */
export const MOVE_SPEED = 5.0;
/** Sprint speed multiplier over base MOVE_SPEED. */
export const SPRINT_MULTIPLIER = 1.6;
/** Jump initial velocity in world units per second. */
export const JUMP_FORCE = 8.0;
/** Gravity acceleration in world units per second squared. */
export const GRAVITY = 20.0;
/** Crouch height multiplier (fraction of standing height). */
export const CROUCH_HEIGHT_FACTOR = 0.55;
/** Key bindings map for action lookup. */
export const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ShiftLeft', 'ShiftRight'],
  sprint: ['ShiftLeft'],
  fire: ['Mouse0'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  pause: ['Escape'],
};

// ─── Combat Configuration ───────────────────────────────────────────────
/** Maximum health points a player or bot can have. */
export const MAX_HEALTH = 100;
/** Damage dealt by the TR-9 rifle per bullet hit. */
export const RIFLE_DAMAGE = 18;
/** Damage dealt by the Ember 12 shotgun per pellet. */
export const SHOTGUN_DAMAGE = 12;
/** Number of pellets fired per shotgun blast. */
export const SHOTGUN_PELLETS = 8;
/** Shotgun spread angle in radians. */
export const SHOTGUN_SPREAD = 0.08;
/** Rifle fire rate in rounds per second. */
export const RIFLE_FIRE_RATE = 6.0;
/** Shotgun fire rate in rounds per second. */
export const SHOTGUN_FIRE_RATE = 1.5;
/** Bullet travel speed in world units per second. */
export const BULLET_SPEED = 80.0;
/** Hitscan detection tolerance (how close to surface match needed). */
export const HITSCAN_TOLERANCE = 0.05;

// ─── Round Configuration ────────────────────────────────────────────────
/** Rounds needed to win a match. */
export const ROUND_WIN_SCORE = 7;
/** Time limit per round in seconds. */
export const ROUND_TIMEOUT_SEC = 120;
/** Number of bots per team. */
export const BOT_COUNT_PER_TEAM = 3;
/** Total teams in the match. */
export const TEAM_COUNT = 2;
/** Points awarded for planting the charge. */
export const PLANT_BONUS_POINTS = 1;
/** Points awarded for defusing the charge. */
export const DEFUSE_BONUS_POINTS = 1;
/** Points awarded for eliminating an enemy bot. */
export const KILL_POINT_VALUE = 1;

// ─── UI / HUD Configuration ─────────────────────────────────────────────
/** HUD margin from screen edges in pixels. */
export const HUD_MARGIN = 16;
/** Crosshair arm length in pixels. */
export const CROSSHAIR_LENGTH = 12;
/** Crosshair gap (center opening) in pixels. */
export const CROSSHAIR_GAP = 6;
/** Health bar width in pixels. */
export const HEALTH_BAR_WIDTH = 200;
/** Health bar height in pixels. */
export const HEALTH_BAR_HEIGHT = 16;
/** Font family for HUD text. */
export const HUD_FONT_FAMILY = '"Courier New", Courier, monospace';
/** HUD font size in pixels. */
export const HUD_FONT_SIZE = 18;
/** HUD text color hex. */
export const HUD_TEXT_COLOR = '#c7a13a';

// ─── Network / Server Configuration ─────────────────────────────────────
/** Local dev server port for node serve.ts. */
export const DEV_SERVER_PORT = 8080;
/** WebSocket heartbeat interval in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** Maximum reconnection attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Validates that all numeric configs are within sane bounds.
 * Throws RangeError if any value falls outside acceptable limits.
 * Called automatically at module import time.
 *
 * @throws {RangeError} If any configuration value is invalid.
 */
export function validateConfig() {
  const checks = [
    [SAMPLE_RATE, 8000, 96000, 'SAMPLE_RATE'],
    [MASTER_VOLUME, 0.0, 1.0, 'MASTER_VOLUME'],
    [MOVE_SPEED, 1.0, 20.0, 'MOVE_SPEED'],
    [JUMP_FORCE, 2.0, 20.0, 'JUMP_FORCE'],
    [GRAVITY, 5.0, 50.0, 'GRAVITY'],
    [TARGET_FPS, 30, 144, 'TARGET_FPS'],
    [ROUND_WIN_SCORE, 3, 25, 'ROUND_WIN_SCORE'],
    [BOT_COUNT_PER_TEAM, 1, 8, 'BOT_COUNT_PER_TEAM'],
    [RIFLE_DAMAGE, 5, 50, 'RIFLE_DAMAGE'],
    [SHOTGUN_PELLETS, 4, 20, 'SHOTGUN_PELLETS'],
    [HUD_MARGIN, 4, 64, 'HUD_MARGIN'],
    [CROSSHAIR_LENGTH, 4, 40, 'CROSSHAIR_LENGTH'],
  ];
  for (const [value, min, max, name] of checks) {
    if (typeof value !== 'number' || value < min || value > max) {
      throw new RangeError(`${name}=${value} out of range [${min},${max}]`);
    }
  }
  return true;
}

// Run validation on import
validateConfig();
