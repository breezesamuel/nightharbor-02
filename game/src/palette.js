// Owns: the single colour source for NIGHTHARBOR.
// Owns: palette constants, tone(), and rgba() helpers.
// Owns: nothing else — no other colour logic lives here.
import * as THREE from 'three';

const PALETTE = {
  night: '#0b1418',
  deep: '#101c22',
  concrete: '#20262a',
  steel: '#2b3440',
  rust: '#4a3527',
  hazard: '#b8912f',
  tide: '#2fd6c4',
  ember: '#ff7a3c',
  sodium: '#ffb257',
  ink: '#e8e6df',
  muted: '#8a97a0',
  water: '#06161a',
  light: '#cfd8dc',
};

function resolve(name) {
  const value = PALETTE[name];
  if (value === undefined) {
    throw new Error(`Unknown palette key: '${name}'`);
  }
  return value;
}

function tone(name, factor) {
  return new THREE.Color(resolve(name)).multiplyScalar(factor);
}

function rgba(name, alpha) {
  const value = resolve(name);
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export { PALETTE, tone, rgba };
