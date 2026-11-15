// Nightharbor: the visible level.
// Owns: turning mapdata.js into meshes, colliders, shootables, nav, sites, lamps,
// atmosphere, water and charge strips. Everything is static; step(dt) animates only
// water drift and strip pulse with zero allocation, updateShadows() is a reserved no-op.
import * as THREE from 'three';
import { BOXES, PROPS, SIGNS, LAMPS, NAV, SITES, SPAWNS } from './mapdata.js';
import { PALETTE } from './palette.js';

// ---- texture plumbing: seeded bakes + shared material cache ----
// A tiny mulberry generator keeps every procedural surface pixel-identical on each load,
// so screenshots and the world stay stable between sessions.
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

// module-level anisotropy; raised later once the renderer's limits are known
let ANISO = 4;

// Bake a canvas into a texture configured once at module load: repeated, sRGB,
// mipmap-filtered so large flat surfaces (asphalt, concrete) stay clean at a distance.
function bakeTexture(size, painter, lift = 2.4) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  painter(ctx, size);
  // A night scene is dark because of its light budget, not because its albedo is charcoal.
  // Lift the bake once, after painting, so every painter keeps its own relative contrast and
  // the key light has something to reflect; the lamp bake is already hot and skips this.
  if (lift !== 1) {
    const copy = document.createElement('canvas');
    copy.width = size;
    copy.height = size;
    const cctx = copy.getContext('2d');
    cctx.filter = `brightness(${lift}) contrast(1.06)`;
    cctx.drawImage(canvas, 0, 0);
    ctx.drawImage(copy, 0, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ---- procedural paint: each surface is a seeded canvas bake ----

function paintConcrete(ctx, s) {
  const rnd = mulberry32(101);
  ctx.fillStyle = '#23292c';
  ctx.fillRect(0, 0, s, s);
  // a dozen soft darker blotches read as weathering, not noise
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.12 + rnd() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(8, 11, 13, 0.4)');
    g.addColorStop(1, 'rgba(8, 11, 13, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, s * (0.2 + 0.2 * i));
    ctx.lineTo(s, s * (0.2 + 0.2 * i));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, s / 1.5, s, s / 3); // darker bottom-third band
  for (let i = 0; i < 2; i++) {
    const x = s * (0.2 + 0.5 * rnd());
    ctx.fillStyle = 'rgba(10, 8, 6, 0.35)';
    ctx.fillRect(x, 0, 3, s);
  }
}

function paintWet(ctx, s) {
  const rnd = mulberry32(202);
  ctx.fillStyle = '#1a2226';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 7; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.2 + rnd() * 0.35);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(90, 110, 120, 0.14)');
    g.addColorStop(1, 'rgba(90, 110, 120, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 1 + rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // narrow sheen lines: standing water catching the sodium light
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const y = rnd() * s;
    ctx.strokeStyle = 'rgba(200, 225, 235, 0.35)';
    ctx.lineWidth = 1 + rnd() * 1.5;
    ctx.beginPath();
    ctx.moveTo(rnd() * s * 0.4, y);
    ctx.lineTo(s * (0.5 + rnd() * 0.45), y + (rnd() - 0.5) * 8);
    ctx.stroke();
  }
}

function paintAsphalt(ctx, s) {
  const rnd = mulberry32(303);
  ctx.fillStyle = '#14191c';
  ctx.fillRect(0, 0, s, s);
  // low-frequency tonal variation keeps big pavement areas from looking flat
  for (let i = 0; i < 22; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.2 + rnd() * 0.4);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(45, 50, 55, 0.12)' : 'rgba(0,0,0,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 6000; i++) {
    const v = 30 + Math.floor(rnd() * 90);
    ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.05)';
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  // one or two lighter aggregate stones
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = 'rgba(140, 140, 135, 0.5)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 4 + rnd() * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  for (let c = 0; c < 3; c++) {
    let x = rnd() * s;
    let y = rnd() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 8; j++) {
      x += (rnd() - 0.5) * 90;
      y += (rnd() - 0.5) * 90;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function paintSteel(ctx, s) {
  const rnd = mulberry32(404);
  ctx.fillStyle = '#2b3440';
  ctx.fillRect(0, 0, s, s);
  // vertical corrugation: 16 ribs, a light edge then a dark edge 1-2 px wide
  const step = s / 16;
  for (let i = 0; i < 16; i++) {
    const x = i * step + step * 0.45;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, 0, 1, s);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 1, 0, 2, s);
  }
  // rust streaks running down from the top at random x, fading out
  for (let i = 0; i < 9; i++) {
    const x = rnd() * s;
    const len = s * (0.2 + rnd() * 0.55);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(110, 65, 32, 0.45)');
    g.addColorStop(1, 'rgba(110, 65, 32, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 2 + rnd() * 3, len);
  }
}

function paintRust(ctx, s) {
  const rnd = mulberry32(505);
  ctx.fillStyle = '#46311f';
  ctx.fillRect(0, 0, s, s);
  const patches = ['#5b3f28', '#2f2116'];
  for (let i = 0; i < 46; i++) {
    ctx.fillStyle = patches[i % 2];
    ctx.globalAlpha = 0.2 + rnd() * 0.3;
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 10 + rnd() * 55, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // rivet dots every 64 px, horizontal rows
  ctx.fillStyle = 'rgba(15, 10, 6, 0.65)';
  for (let y = 32; y < s; y += 64) {
    for (let x = 32; x < s; x += 64) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    const len = s * (0.15 + rnd() * 0.5);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(25, 16, 10, 0.45)');
    g.addColorStop(1, 'rgba(25, 16, 10, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, s * 0.05, 2 + rnd() * 2, len);
  }
}

function paintContainer(ctx, s, base, seed) {
  const rnd = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  // 24 ribs with a highlight on the left edge of each
  const step = s / 24;
  for (let i = 0; i < 24; i++) {
    const x = i * step + step * 0.3;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, 0, 3, s);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(x + 4, 0, 2, s);
  }
  // lighter painted plate near the top left
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(s * 0.05, s * 0.07, s * 0.3, s * 0.15);
  // stencilled two-digit number in a contrasting colour
  ctx.font = 'bold ' + Math.floor(s * 0.3) + 'px monospace';
  ctx.fillStyle = 'rgba(235, 230, 215, 0.8)';
  ctx.fillText(String(10 + Math.floor(rnd() * 89)), s * 0.08, s * 0.45);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, s * 0.88, s, s * 0.12);
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = 'rgba(95, 58, 30, 0.35)';
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, 3 + rnd() * 9, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintCrate(ctx, s) {
  const rnd = mulberry32(606);
  ctx.fillStyle = '#42392c';
  ctx.fillRect(0, 0, s, s);
  // five horizontal slats with darker gaps between them
  const slat = s / 5;
  for (let i = 0; i < 5; i++) {
    const y = i * slat;
    ctx.fillStyle = i % 2 ? '#4b4030' : '#463b2b';
    ctx.fillRect(0, y + 3, s, slat - 6);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, y + slat - 3, s, 6);
    ctx.strokeStyle = 'rgba(25, 18, 10, 0.5)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const gy = y + slat * (0.25 + 0.25 * g);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(s, gy + (rnd() - 0.5) * 5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(15, 10, 6, 0.9)';
    ctx.beginPath();
    ctx.arc(s * 0.14, y + slat * 0.5, 4, 0, Math.PI * 2);
    ctx.arc(s * 0.86, y + slat * 0.5, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(s * 0.06, s * 0.06);
  ctx.lineTo(s * 0.94, s * 0.94);
  ctx.stroke();
}

function paintHazard(ctx, s) {
  const rnd = mulberry32(707);
  ctx.fillStyle = '#b8912f';
  ctx.fillRect(0, 0, s, s);
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#14110c';
  const band = s / 3;
  for (let x = -s; x < s * 1.5; x += band * 2) {
    ctx.fillRect(x, -s, band, s * 2);
  }
  ctx.restore();
  for (let i = 0; i < 350; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.05 + rnd() * 0.12) + ')';
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

function paintDark(ctx, s) {
  const rnd = mulberry32(808);
  ctx.fillStyle = '#0c0f12';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = 'rgba(150, 165, 175, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const x = rnd() * s;
    ctx.beginPath();
    ctx.moveTo(x, rnd() * s);
    ctx.lineTo(x + 20 + rnd() * 50, rnd() * s);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(140, 155, 165, 0.18)';
  ctx.fillRect(0, 0, s, 3);
}

function paintLamp(ctx, s) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, '#fff3d6');
  g.addColorStop(1, '#ffb257');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

function bake(kind) {
  switch (kind) {
    case 'concrete':
      return bakeTexture(512, paintConcrete);
    case 'wet':
      return bakeTexture(512, paintWet);
    case 'asphalt':
      return bakeTexture(512, paintAsphalt);
    case 'steel':
      return bakeTexture(512, paintSteel);
    case 'rust':
      return bakeTexture(512, paintRust);
    case 'containerTeal':
      return bakeTexture(512, (c, s) => paintContainer(c, s, '#1d5a55', 11));
    case 'containerOrange':
      return bakeTexture(512, (c, s) => paintContainer(c, s, '#8a3d1c', 12));
    case 'containerOlive':
      return bakeTexture(512, (c, s) => paintContainer(c, s, '#4a4a2a', 13));
    case 'crate':
      return bakeTexture(512, paintCrate);
    case 'hazard':
      return bakeTexture(256, paintHazard);
    case 'dark':
      return bakeTexture(256, paintDark);
    case 'lamp':
      return bakeTexture(64, paintLamp, 1);
    default:
      throw new Error('unknown texture kind ' + kind);
  }
}

// ---- material cache: one material per (kind, repeatX, repeatY) ----
// Repeated surfaces share a material so draw calls stay near the ~150 budget;
// the repeat is baked into the key because texture state lives on the map.
const materialCache = new Map();

function makeMaterial(kind) {
  switch (kind) {
    case 'lamp': {
      // lamp fixtures are unlit emissive: basic material, never cast a shadow
      const m = new THREE.MeshBasicMaterial({ map: bake('lamp') });
      m.shadowSide = THREE.DoubleSide;
      return m;
    }
    default: {
      const m = new THREE.MeshStandardMaterial({ map: bake(kind) });
      switch (kind) {
        case 'concrete':
        case 'asphalt':
          m.roughness = 0.92;
          m.metalness = 0.02;
          break;
        case 'wet':
          m.roughness = 0.35;
          m.metalness = 0.1;
          break;
        case 'steel':
        case 'rust':
          m.roughness = 0.72;
          m.metalness = 0.45;
          break;
        case 'containerTeal':
        case 'containerOrange':
        case 'containerOlive':
          m.roughness = 0.6;
          m.metalness = 0.35;
          break;
        case 'crate':
          m.roughness = 0.9;
          m.metalness = 0;
          break;
        case 'hazard':
          m.roughness = 0.8;
          m.metalness = 0;
          break;
        case 'dark':
          m.roughness = 0.5;
          m.metalness = 0.4;
          break;
        default:
          break;
      }
      return m;
    }
  }
}

function materialFor(kind, rx, ry) {
  const key = kind + '|' + rx + '|' + ry;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = makeMaterial(kind);
    mat.map.repeat.set(rx, ry);
    mat.map.needsUpdate = false;
    materialCache.set(key, mat);
  }
  return mat;
}

// Texel density: about one texture per 4 m of concrete/asphalt, per 2.6 m of
// container face, per 1.2 m of crate, per 2 m of steel. For boxes much wider
// than deep we split the repeat across axes so the long faces stay dense.
function repeatsFor(mat, w, h, d) {
  switch (mat) {
    case 'concrete':
    case 'asphalt':
      return [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4))];
    case 'containerTeal':
    case 'containerOrange':
    case 'containerOlive':
      return [Math.max(1, Math.round(d / 2.6)), Math.max(1, Math.round(w / 2.6))];
    case 'crate':
      return [Math.max(1, Math.round(d / 1.2)), Math.max(1, Math.round(w / 1.2))];
    case 'steel':
      return [Math.max(1, Math.round(d / 2)), Math.max(1, Math.round(w / 2))];
    case 'rust':
      return [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4))];
    case 'wet':
    case 'hazard':
    case 'dark':
      return [Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(d / 2))];
    default:
      return [1, 1];
  }
}

// ---- props: instanced meshes for the many, single meshes for the few ----
// Instancing keeps bollards, rings, cones and pallets at one draw call each;
// barrels, cables, lampheads and hooks vary too much in grouping to instance cleanly.

// Puddles reuse the wet map but with their own translucent state: depthWrite off and a
// polygon offset keep them from z-fighting the ground slab underneath.
function puddleMat(wetMat) {
  return new THREE.MeshStandardMaterial({
    map: wetMat.map,
    color: 0x1c2830,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

function buildProps(group) {
  const stopMats = materialFor('steel', 2, 1);
  const rustMat = materialFor('rust', 2, 1);
  const darkMat = materialFor('dark', 1, 1);
  const hazardMat = materialFor('hazard', 2, 1);
  const crateMat = materialFor('crate', 2, 1);
  const lampMat = materialFor('lamp', 1, 1);
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.6, metalness: 0 });

  const dummy = new THREE.Object3D();
  const shootableProps = [];

  function placeInstanced(kind, geometry, material, yOff, cast) {
    const list = PROPS.filter((p) => p.kind === kind);
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    list.forEach((p, i) => {
      dummy.position.set(p.x, p.y + yOff * p.scale, p.z);
      dummy.rotation.set(0, p.ry || 0, 0);
      dummy.scale.setScalar(p.scale || 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }

  // bollard: squat tapered steel cylinder, castShadow true
  placeInstanced(
    'bollard',
    new THREE.CylinderGeometry(0.18, 0.22, 0.55, 12),
    stopMats,
    0.275,
    true
  );
  // ring: rust torus laid flat, never casts
  placeInstanced('ring', new THREE.TorusGeometry(0.3, 0.05, 8, 24), rustMat, 0.05, false);
  // cone: traffic cone with a white band ring
  {
    const cones = PROPS.filter((p) => p.kind === 'cone');
    const body = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.28, 0.7, 14),
      hazardMat,
      cones.length
    );
    body.castShadow = true;
    const band = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.19, 0.22, 0.12, 14, 1, true),
      whiteMat,
      cones.length
    );
    band.castShadow = true;
    cones.forEach((p, i) => {
      const s = p.scale || 1;
      dummy.position.set(p.x, p.y + 0.35 * s, p.z);
      dummy.rotation.set(0, p.ry || 0, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      dummy.position.y = p.y + 0.42 * s;
      dummy.updateMatrix();
      band.setMatrixAt(i, dummy.matrix);
    });
    group.add(body, band);
  }
  // pallet: slab plus two runner boxes; bullets stop on these
  {
    const pallets = PROPS.filter((p) => p.kind === 'pallet');
    const top = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.08, 0.8), crateMat, pallets.length);
    const runners = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.06, 0.1), crateMat, pallets.length * 2);
    top.castShadow = true;
    runners.castShadow = true;
    top.receiveShadow = true;
    runners.receiveShadow = true;
    pallets.forEach((p, i) => {
      const s = p.scale || 1;
      dummy.position.set(p.x, p.y + 0.07 * s, p.z);
      dummy.rotation.set(0, p.ry || 0, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      top.setMatrixAt(i, dummy.matrix);
      for (let r = 0; r < 2; r++) {
        dummy.position.y = p.y + 0.02 * s;
        dummy.updateMatrix();
        const m = new THREE.Matrix4().copy(dummy.matrix);
        const off = new THREE.Matrix4().makeTranslation(0, 0, (r ? 0.3 : -0.3) * s);
        m.multiply(off);
        runners.setMatrixAt(i * 2 + r, m);
      }
    });
    group.add(top, runners);
    shootableProps.push(top, runners);
  }

  // barrel: rust cylinder with two darker bands; bullets stop on it
  {
    const barrels = PROPS.filter((p) => p.kind === 'barrel');
    barrels.forEach((p) => {
      const s = p.scale || 1;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16), rustMat);
      body.position.y = 0.45;
      const bandGeo = new THREE.TorusGeometry(0.305, 0.025, 8, 24);
      const b1 = new THREE.Mesh(bandGeo, darkMat);
      b1.rotation.x = Math.PI / 2;
      b1.position.y = 0.3;
      const b2 = new THREE.Mesh(bandGeo, darkMat);
      b2.rotation.x = Math.PI / 2;
      b2.position.y = 0.6;
      g.add(body, b1, b2);
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.ry || 0;
      g.scale.setScalar(s);
      g.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      group.add(g);
      shootableProps.push(body, b1, b2);
    });
  }

  // cable: thin dark cylinder hanging at an angle, 1.5 m down from y+0.2
  PROPS.filter((p) => p.kind === 'cable').forEach((p) => {
    const s = p.scale || 1;
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), darkMat);
    cable.position.set(p.x, p.y + 0.2 + 0.75 * s, p.z);
    cable.rotation.z = 0.32 * s;
    cable.scale.set(s, 1, s);
    cable.castShadow = true;
    cable.receiveShadow = true;
    group.add(cable);
  });

  // lamphead: emissive slab with a thin dark housing above; the PointLight sits elsewhere
  PROPS.filter((p) => p.kind === 'lamphead').forEach((p) => {
    const s = p.scale || 1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), lampMat);
    head.position.set(p.x, p.y + 2.6 * s, p.z);
    head.rotation.y = p.ry || 0;
    head.scale.setScalar(s);
    head.castShadow = false;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.36), darkMat);
    housing.position.y = 0.12;
    housing.castShadow = true;
    head.add(housing);
    group.add(head);
  });

  // hook: small torus plus a 0.6 m three-link chain of thin cylinders
  PROPS.filter((p) => p.kind === 'hook').forEach((p) => {
    const s = p.scale || 1;
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 6, 14), stopMats);
    ring.castShadow = true;
    g.add(ring);
    for (let i = 0; i < 3; i++) {
      const link = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 6), stopMats);
      link.position.y = -0.2 * (i + 1);
      link.rotation.x = i % 2 ? Math.PI / 2 : 0;
      link.castShadow = true;
      g.add(link);
    }
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(s);
    group.add(g);
  });

  // puddle: wet disc floating 0.02 above the ground; depthWrite off so it never z-fights
  PROPS.filter((p) => p.kind === 'puddle').forEach((p) => {
    const s = p.scale || 1;
    const r = 0.7 + s * 0.5; // 1.4-2.6 m across
    const puddle = new THREE.Mesh(
      new THREE.CircleGeometry(r, 24),
      puddleMat(materialFor('wet', 1, 1))
    );
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.set(p.x, p.y + 0.02, p.z);
    puddle.renderOrder = 2;
    group.add(puddle);
  });

  return shootableProps;
}

// ---- signs: painted plates on double-sided quads, never colliders ----
function paintSign(text, colourName, twoLine) {
  const h = twoLine ? 256 : 128;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, h);
  ctx.fillStyle = 'rgba(5, 8, 10, 0.85)';
  ctx.fillRect(0, 0, 512, h);
  const rnd = mulberry32(text.length * 31);
  const lines = twoLine ? text.split(' ', 2) : [text];
  const colour = new THREE.Color(PALETTE[colourName]);
  ctx.fillStyle = '#' + colour.getHexString();
  ctx.font = 'bold 72px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // letter-spaced uppercase: draw char by char with a fixed gap
  lines.forEach((line, li) => {
    const chars = line.toUpperCase().split('');
    const gap = 14;
    let width = 0;
    for (const ch of chars) width += ctx.measureText(ch).width + gap;
    let x = 256 - width / 2;
    const y = twoLine ? 64 + li * 110 : h / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x + ctx.measureText(ch).width / 2, y);
      x += ctx.measureText(ch).width + gap;
    }
  });
  // a few erase specks: worn plate
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = 'rgba(5, 8, 10, ' + (0.4 + rnd() * 0.4) + ')';
    ctx.beginPath();
    ctx.arc(rnd() * 512, rnd() * h, 2 + rnd() * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;
  return tex;
}

function buildSigns(group) {
  for (const s of SIGNS) {
    const twoLine = s.text.includes(' ');
    const geo = new THREE.PlaneGeometry(s.w, s.h);
    const mat = new THREE.MeshBasicMaterial({
      map: paintSign(s.text, s.colour, twoLine),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y, s.z);
    // ry convention: 0 faces -z, so the readable face points at whoever is on the +z side
    mesh.rotation.y = s.ry || 0;
    mesh.renderOrder = 3;
    group.add(mesh);
  }
}

// ---- water: two drifting ripple layers plus a dark depth plane beneath ----
function buildWater(group) {
  function ripple(seed) {
    const tex = bakeTexture(256, (ctx, s) => {
      const rnd = mulberry32(seed);
      ctx.clearRect(0, 0, s, s);
      for (let i = 0; i < 24; i++) {
        const x = rnd() * s;
        const y = rnd() * s;
        const r = 8 + rnd() * 30;
        ctx.strokeStyle = i % 2 ? 'rgba(90, 140, 160, 0.14)' : 'rgba(50, 95, 120, 0.16)';
        ctx.lineWidth = 1 + rnd() * 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let i = 0; i < 26; i++) {
        const x = rnd() * s;
        const y = rnd() * s;
        ctx.strokeStyle = 'rgba(120, 170, 190, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10 + rnd() * 22, y + (rnd() - 0.5) * 6);
        ctx.stroke();
      }
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  const texA = ripple(9);
  const texB = ripple(10);
  texA.repeat.set(40, 40);
  texB.repeat.set(40, 40);
  // a second texture on a stacked material: the two layers drift at different rates
  const mat = new THREE.MeshStandardMaterial({
    color: 0x06161a,
    roughness: 0.22,
    metalness: 0.15,
    map: texA,
  });
  mat.emissiveMap = texB;
  mat.emissive = 0x0a1c22;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.35;
  plane.receiveShadow = true;
  group.add(plane);

  const deep = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 700),
    new THREE.MeshStandardMaterial({ color: 0x03090c, roughness: 0.9, metalness: 0.2 })
  );
  deep.rotation.x = -Math.PI / 2;
  deep.position.y = -0.4;
  group.add(deep);

  return { texA, texB, t: 0 };
}

// ---- charge strip bookkeeping: the two strip ids are resolved at build time;
//      step(dt) only scales their existing basic-material colour ----

// ---- main entry: build the whole visible level ----
export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const colliders = [];
  const shootables = [];

  // --- boxes: one mesh each, materials shared through the cache ---
  // Lamp boxes are never colliders and never shootable: they are unlit emissive fixtures
  // that the charge-strip pulse animates via their basic material colour.
  const meshById = {};
  for (const b of BOXES) {
    const isLamp = b.mat === 'lamp';
    const isGround = b.id === 'ground';
    const [rx, ry] = isLamp ? [1, 1] : repeatsFor(b.mat, b.w, b.h, b.d);
    const mat = isLamp ? materialFor('lamp', 1, 1) : materialFor(b.mat, rx, ry);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = isLamp || isGround ? false : b.cast !== false;
    mesh.receiveShadow = !isGround; // the ground slab only receives
    group.add(mesh);
    meshById[b.id] = mesh;
    if (b.move && !isLamp) colliders.push(new THREE.Box3().setFromObject(mesh));
    if (b.bullet && !isLamp) shootables.push(mesh);
  }

  // --- props: instanced + single meshes, barrels and pallets stop bullets ---
  const stopProps = buildProps(group);
  shootables.push(...stopProps);

  // --- signs ---
  buildSigns(group);

  // --- point lights: capped at 8, no shadows; fixtures are the lamp boxes ---
  // Three.js lights are physical now: intensity is candela, so a fixture recorded as
  // 1.5 reads as a candle at 3 m. The gain turns the authored relative values into
  // real harbour-lamp pools without changing their ratios.
  const LAMP_GAIN = 40;
  const lightDefs = LAMPS.slice(0, 8);
  const lampOut = [];
  for (const l of lightDefs) {
    const pl = new THREE.PointLight(l.colour, l.intensity * LAMP_GAIN, l.distance, 2);
    pl.position.set(l.x, l.y, l.z);
    pl.castShadow = false;
    group.add(pl);
    lampOut.push({ ...l, position: new THREE.Vector3(l.x, l.y, l.z) });
  }

  // --- atmosphere: night background, fog, sky dome, key light, fill ---
  scene.background = new THREE.Color(PALETTE.night);
  scene.fog = new THREE.Fog(PALETTE.night, 40, 220);

  {
    // sky dome: vertical night gradient with a low sodium glow on the north side
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 256, 0, 0);
    g.addColorStop(0, '#060a0c');
    g.addColorStop(1, '#16242c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const glow = ctx.createRadialGradient(128, 210, 4, 128, 210, 130);
    glow.addColorStop(0, 'rgba(255, 178, 87, 0.30)');
    glow.addColorStop(1, 'rgba(255, 178, 87, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 256, 256);
    const skyTex = new THREE.CanvasTexture(canvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(400, 32, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    scene.add(dome);
  }

  const sun = new THREE.DirectionalLight(0xffd9a8, 3.4);
  sun.position.set(-40, 60, -50);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -34;
  sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 44;
  sun.shadow.camera.bottom = -44;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 170;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x24323c, 0x0a0f12, 1.9);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x223038, 0.55);
  scene.add(ambient);
  // A cool counter-fill with no shadow: the warm key carves the north faces, this keeps
  // the south and east faces from collapsing into a single black shape at night.
  const moon = new THREE.DirectionalLight(0x9fc0dd, 0.6);
  moon.position.set(48, 38, 62);
  moon.target.position.set(0, 0, -6);
  moon.castShadow = false;
  scene.add(moon, moon.target);

  // --- water ---
  const water = buildWater(group);

  // --- charge strips: hold base colours, pulse emissive on the existing basic materials ---
  const strips = [];
  for (const b of BOXES) {
    if (b.id.indexOf('a-charge-strip') === 0 || b.id.indexOf('b-charge-strip') === 0) {
      const m = meshById[b.id];
      // strips share one cached lamp material; give each its own colour to pulse from
      m.material = m.material.clone();
      strips.push({ mesh: m, base: m.material.color.clone() });
    }
  }

  function step(dt) {
    water.t += dt;
    // two textures drift at slightly different rates and directions: the surface
    // appears to move, nothing is allocated or recreated here
    water.texA.offset.x += dt * 0.004;
    water.texB.offset.x -= dt * 0.0027;
    water.texB.offset.y += dt * 0.0019;
    // about 2.2 Hz sine pulse on the emissive colour, no lighting change
    const pulse = 0.5 + 0.5 * Math.sin(water.t * 2.2 * Math.PI * 2);
    const scale = 0.45 + 0.9 * pulse;
    for (let i = 0; i < strips.length; i++) {
      strips[i].mesh.material.color.copy(strips[i].base).multiplyScalar(scale);
    }
  }

  // --- nav: expose node links so A* walks an adjacency list instead of scanning edges ---
  const byName = {};
  for (const name of Object.keys(NAV.nodes)) {
    byName[name] = {
      name,
      x: NAV.nodes[name].x,
      y: NAV.nodes[name].y,
      z: NAV.nodes[name].z,
      links: [],
    };
  }
  for (const [a, b] of NAV.edges) {
    if (byName[a]) byName[a].links.push(b);
    if (byName[b]) byName[b].links.push(a);
  }

  // --- sites: attach the charge crate's world position to each site record ---
  const sitesOut = {};
  for (const key of Object.keys(SITES)) {
    const site = { ...SITES[key] };
    const crateId = key === 'a' ? 'a-charge' : 'b-charge';
    const crate = meshById[crateId];
    site.charge = crate
      ? new THREE.Vector3(crate.position.x, crate.position.y + crate.geometry.parameters.h / 2, crate.position.z)
      : new THREE.Vector3(site.plant.x, site.plant.y + 0.3, site.plant.z);
    sitesOut[key] = site;
  }

  const bounds = new THREE.Box3(new THREE.Vector3(-28, 0, -36), new THREE.Vector3(28, 7, 36));

  return {
    group,
    colliders,
    shootables,
    nav: { nodes: NAV.nodes, edges: NAV.edges, byName },
    sites: sitesOut,
    spawns: SPAWNS,
    lamps: lampOut,
    bounds,
    step,
    // reserved for a later module that moves the shadow camera with the player
    updateShadows() {},
  };
}
