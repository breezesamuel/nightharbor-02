/**
 * NIGHTHARBOR Minimap Module
 * Renders a top-down minimap overlay using the game's world geometry.
 * The minimap reads mapdata.js layout tiles and projects them onto a
 * small canvas element positioned in the lower-right corner of the HUD.
 *
 * @module minimap
 */
import { PALETTE } from './palette.js';

/** Tile size in world units used by mapdata.js. */
const TILE_SIZE = 4.0;
/** Minimaps internal resolution scale factor. */
const MINIMAP_SCALE = 0.08;
/** Canvas size in pixels for the minimap rendering context. */
const MINIMAP_SIZE = 180;
/** Player dot radius in minimap pixels. */
const PLAYER_DOT_RADIUS = 4;
/** Bot dot radius in minimap pixels. */
const BOT_DOT_RADIUS = 3;

/**
 * Renders a minimap overlay onto the given 2D canvas context.
 * Reads the tile layout from mapdata.js (imported dynamically to avoid
 * circular dependency issues at module-load time).
 *
 * @param {CanvasRenderingContext2D} ctx - The 2D rendering context.
 * @param {Array<Array<number>>} layout - Tile layout array from mapdata.
 * @param {number} playerX - Player X position in world units.
 * @param {number} playerZ - Player Z position in world units.
 * @param {Array<{x:number,z:number,color:string}>} bots - Array of bot positions.
 */
export function renderMinimap(ctx, layout, playerX, playerZ, bots = []) {
  if (!ctx || !layout || layout.length === 0) return;
  const cols = layout[0].length;
  const rows = layout.length;
  const w = Math.min(MINIMAP_SIZE, cols * TILE_SIZE * MINIMAP_SCALE);
  const h = Math.min(MINIMAP_SIZE, rows * TILE_SIZE * MINIMAP_SCALE);

  // Clear with night harbor background
  ctx.fillStyle = PALETTE.night;
  ctx.fillRect(0, 0, w, h);

  // Draw walkable floor tiles
  ctx.fillStyle = PALETTE.concrete;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (layout[r][c] === 0) { // FLOOR tile
        ctx.fillRect(
          c * TILE_SIZE * MINIMAP_SCALE,
          r * TILE_SIZE * MINIMAP_SCALE,
          TILE_SIZE * MINIMAP_SCALE,
          TILE_SIZE * MINIMAP_SCALE
        );
      }
    }
  }

  // Draw walls
  ctx.fillStyle = PALETTE.steel;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (layout[r][c] === 1) { // WALL tile
        ctx.fillRect(
          c * TILE_SIZE * MINIMAP_SCALE,
          r * TILE_SIZE * MINIMAP_SCALE,
          TILE_SIZE * MINIMAP_SCALE,
          TILE_SIZE * MINIMAP_SCALE
        );
      }
    }
  }

  // Draw doors in hazard color
  ctx.fillStyle = PALETTE.hazard;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (layout[r][c] === 2) { // DOOR tile
        const cx = c * TILE_SIZE * MINIMAP_SCALE + TILE_SIZE * MINIMAP_SCALE / 2;
        const cy = r * TILE_SIZE * MINIMAP_SCALE + TILE_SIZE * MINIMAP_SCALE / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Draw player as bright teal dot
  const px = (playerX / (cols * TILE_SIZE)) * w;
  const pz = (playerZ / (rows * TILE_SIZE)) * h;
  ctx.fillStyle = PALETTE.tide;
  ctx.beginPath();
  ctx.arc(px, pz, PLAYER_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Draw bot dots in ember orange
  ctx.fillStyle = PALETTE.ember;
  for (const bot of bots) {
    const bx = (bot.x / (cols * TILE_SIZE)) * w;
    const bz = (bot.z / (rows * TILE_SIZE)) * h;
    ctx.beginPath();
    ctx.arc(bx, bz, BOT_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  // Border frame
  ctx.strokeStyle = PALETTE.steel;
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, w, h);
}

/**
 * Returns the minimap HTML canvas element configuration object.
 * Creates the canvas once and reuses it for subsequent renders.
 *
 * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, x:number, y:number}}
 */
export function getMinimapCanvas() {
  let canvas = document.getElementById('nightharbor-minimap');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'nightharbor-minimap';
    canvas.width = MINIMAP_SIZE;
    canvas.height = MINIMAP_SIZE;
    canvas.style.cssText = `
      position: absolute;
      bottom: 10px;
      right: 10px;
      border: 2px solid ${PALETTE.steel};
      background: ${PALETTE.night};
      image-rendering: pixelated;
      pointer-events: none;
      z-index: 100;
    `;
    document.body.appendChild(canvas);
  }
  return {
    canvas,
    ctx: canvas.getContext('2d'),
    x: MINIMAP_SIZE,
    y: MINIMAP_SIZE,
  };
}

/**
 * Computes the minimap viewport bounds from world coordinates.
 * Used for culling distant geometry during render passes.
 *
 * @param {number} centerX - World X center of camera view.
 * @param {number} centerZ - World Z center of camera view.
 * @param {number}视野RangeInWorldUnits - View range in world units.
 * @returns {{minX:number,minZ:number,maxX:number,maxZ:number}}
 */
export function computeMinimapBounds(centerX, centerZ, viewRange) {
  const HALF = viewRange / 2;
  return {
    minX: centerX - HALF,
    minZ: centerZ - HALF,
    maxX: centerX + HALF,
    maxZ: centerZ + HALF,
  };
}

/** Default export: alias for getMinimapCanvas convenience. */
export default getMinimapCanvas;
