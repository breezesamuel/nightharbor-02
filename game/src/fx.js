// NIGHTHARBOR: pooled combat effects.
// Owns: muzzle flash light and cross, tracers, spark bursts, scorch decals;
// every geometry, material, plane and buffer is built once at construction.
import * as THREE from 'three';

const MUZZLE_TTL = 0.04;
const TRACER_TTL = 0.06;
const SPARK_TTL = 0.22;
const SPARK_GRAVITY = -6;
const SPARK_MAX = 16;
const SPARK_SPEED = 4.5;
const BURST_SPEED = 3.2;
const DECAL_MAX = 48;
const TRACER_MAX = 24;

// temporaries shared by every emit call so step and the emitters stay allocation-free
const _tmpV3 = new THREE.Vector3();
const _tmpV3B = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();

// deterministic Fibonacci-disk spread: 12 fixed spark directions, one per pool slot
const DISC = [];
(function buildDisk() {
  const GA = 2.399963229728653;
  for (let ring = 0; ring < 3; ring++) {
    for (let i = 0; i < 4; i++) {
      const a = (i + (ring + 1) * 0.5) * GA;
      const r = Math.sqrt((ring * 4 + i) / 12);
      const dir = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? 1 : -1) * 0.18);
      dir.normalize();
      const c = new THREE.Color();
      c.setHSL(0.08, 0.4 * (1 - r * 0.5), 0.5 + 0.3 * (i % 2));
      DISC.push({ v: dir, col: c });
    }
  }
})();

// spark tint per impact material
const SPARK_TINT = { concrete: '#cfd2d4', steel: '#fff3d0', wood: '#a86a34' };

function paintScorch(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(12, 13, 14, 0.85)');
  g.addColorStop(0.6, 'rgba(10, 11, 12, 0.45)');
  g.addColorStop(1, 'rgba(10, 11, 12, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function createFx(scene) {
  const group = new THREE.Group();
  group.name = 'fx';
  scene.add(group);

  // ---- muzzle: a four-armed cross of additive quads plus one shared light ----
  // A flash is a light source, not a shape: keep it small enough that it reads as a burst
  // at the barrel instead of a white panel across the view at 0.45 m from the eye.
  const flashGeo = new THREE.PlaneGeometry(0.09, 0.028);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a8,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const cross = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Mesh(flashGeo, flashMat);
    arm.position.x = i < 2 ? -0.042 : 0.042;
    arm.rotation.z = (i % 2) * (Math.PI / 4);
    cross.add(arm);
  }
  cross.visible = false;
  group.add(cross);
  const flashLight = new THREE.PointLight(0xffd9a8, 14, 9, 2);
  flashLight.visible = false;
  group.add(flashLight);
  let flashT = 0;

  // ---- tracers: stretched additive quads recycled oldest first ----
  const tracerGeo = new THREE.PlaneGeometry(1, 0.02);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffe7b8,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const tracers = [];
  for (let i = 0; i < TRACER_MAX; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.visible = false;
    group.add(m);
    tracers.push({ mesh: m, from: new THREE.Vector3(), to: new THREE.Vector3(), life: -1 });
  }

  // ---- sparks: one Points cloud recycled per emit, shared per-tint materials ----
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(SPARK_MAX * 3);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparkMat = {};
  for (const key of Object.keys(SPARK_TINT)) {
    sparkMat[key] = new THREE.PointsMaterial({
      color: SPARK_TINT[key],
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
  }
  const sparks = [];
  const sparkVel = []; // per-pool-slot velocity vectors, built once
  for (let i = 0; i < SPARK_MAX; i++) {
    const pts = new THREE.Points(sparkGeo, sparkMat.concrete);
    pts.visible = false;
    pts.frustumCulled = false;
    group.add(pts);
    sparks.push({ pts, life: -1 });
    for (let j = 0; j < 4; j++) sparkVel.push(new THREE.Vector3());
  }

  // ---- scorch decals: a ring of fixed planes rotated to each hit normal ----
  const decalTex = new THREE.CanvasTexture(paintScorch(96));
  decalTex.colorSpace = THREE.SRGBColorSpace;
  const decalGeo = new THREE.PlaneGeometry(0.18, 0.18);
  const decalMat = new THREE.MeshBasicMaterial({
    map: decalTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  const decals = [];
  for (let i = 0; i < DECAL_MAX; i++) {
    const p = new THREE.Mesh(decalGeo, decalMat);
    p.visible = false;
    p.renderOrder = 2;
    group.add(p);
    decals.push(p);
  }
  let decalNext = 0;
  let tracerNext = 0;
  let sparkNext = 0;

  function muzzle(position, direction) {
    cross.visible = true;
    cross.position.copy(position);
    _tmpQ.setFromUnitVectors(_tmpV3.copy(direction).normalize(), _tmpV3B.set(0, 0, 1));
    cross.quaternion.copy(_tmpQ);
    cross.scale.setScalar(1.0);
    flashLight.visible = true;
    flashLight.position.copy(position);
    flashLight.intensity = 9;
    flashT = MUZZLE_TTL;
  }

  function tracer(from, to) {
    const t = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % TRACER_MAX;
    t.mesh.visible = true;
    t.from.copy(from);
    t.to.copy(to);
    t.life = TRACER_TTL;
    _tmpV3.copy(t.to).sub(t.from);
    const len = _tmpV3.length();
    t.mesh.position.copy(t.from).addScaledVector(_tmpV3, 0.5);
    _tmpQ.setFromUnitVectors(_tmpV3B.set(0, 0, 1), _tmpV3.normalize());
    t.mesh.quaternion.copy(_tmpQ);
    t.mesh.scale.set(len, 0.5, 1);
    tracerMat.opacity = 1;
  }

  function impact(point, normal, kind) {
    // decal: oldest recycled, oriented to the surface, nudged off the wall
    const d = decals[decalNext];
    decalNext = (decalNext + 1) % DECAL_MAX;
    d.visible = true;
    d.position.copy(point).addScaledVector(normal, 0.01);
    _tmpQ.setFromUnitVectors(_tmpV3B.set(0, 0, 1), _tmpV3.copy(normal).normalize());
    d.quaternion.copy(_tmpQ);
    // 8 short-lived sparks thrown along the normal with a disk spread
    const s = sparks[sparkNext];
    sparkNext = (sparkNext + 1) % SPARK_MAX;
    s.life = SPARK_TTL;
    const tint = SPARK_TINT[kind] ? kind : 'concrete';
    s.pts.material = sparkMat[tint];
    s.pts.visible = true;
    const base = sparkNext * 4; // velocity slots follow the pool slot
    for (let i = 0; i < 8; i++) {
      const v = sparkVel[base + i];
      _tmpV3B.copy(normal).addScaledVector(_tmpV3.copy(DISC[i].v), 0.55);
      v.copy(_tmpV3B.normalize().multiplyScalar(SPARK_SPEED * (0.55 + DISC[i].col.r)));
      sparkPos[i * 3] = point.x;
      sparkPos[i * 3 + 1] = point.y;
      sparkPos[i * 3 + 2] = point.z;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
  }

  function burst(point, colour) {
    const s = sparks[sparkNext];
    sparkNext = (sparkNext + 1) % SPARK_MAX;
    s.life = SPARK_TTL;
    s.pts.material = sparkMat.concrete;
    s.pts.visible = true;
    const base = sparkNext * 4;
    for (let i = 0; i < 8; i++) {
      const v = sparkVel[base + i];
      v.copy(DISC[i].v).multiplyScalar(BURST_SPEED * (0.5 + DISC[i].col.g));
      sparkPos[i * 3] = point.x;
      sparkPos[i * 3 + 1] = point.y;
      sparkPos[i * 3 + 2] = point.z;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
  }

  function step(dt) {
    // muzzle flash: fade light over the remaining 40 ms
    if (flashT > 0) {
      flashT -= dt;
      const k = Math.max(0, flashT / MUZZLE_TTL);
      flashLight.intensity = 14 * k;
      cross.scale.setScalar(0.8 + 0.5 * k);
      if (flashT <= 0) {
        flashLight.visible = false;
        flashLight.intensity = 0;
        cross.visible = false;
      }
    }
    // tracers: quick fade
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.visible = t.life > 0;
      t.mesh.material.opacity = Math.max(0, t.life / TRACER_TTL);
    }
    // sparks: gravity + fade, positions written in place
    for (let si = 0; si < SPARK_MAX; si++) {
      const s = sparks[si];
      if (s.life <= 0) continue;
      s.life -= dt;
      s.pts.visible = s.life > 0;
      s.pts.material.opacity = Math.max(0, s.life / SPARK_TTL);
      for (let i = 0; i < 8; i++) {
        const v = sparkVel[si * 4 + i];
        v.y += SPARK_GRAVITY * dt;
        sparkPos[i * 3] += v.x * dt;
        sparkPos[i * 3 + 1] += v.y * dt;
        sparkPos[i * 3 + 2] += v.z * dt;
      }
      s.pts.geometry.attributes.position.needsUpdate = true;
    }
  }

  function clear() {
    for (const t of tracers) {
      t.life = -1;
      t.mesh.visible = false;
      t.mesh.material.opacity = 1;
    }
    for (const s of sparks) {
      s.life = -1;
      s.pts.visible = false;
      s.pts.material.opacity = 1;
    }
    for (const d of decals) d.visible = false;
    cross.visible = false;
    flashLight.visible = false;
    flashLight.intensity = 0;
    flashT = 0;
    flashMat.opacity = 1;
  }

  clear();
  return { group, step, muzzle, tracer, impact, burst, clear };
}

