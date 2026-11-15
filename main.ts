// NIGHTHARBOR entry (Node 22, standard library only): the game is this directory's
// game/ folder, plain static files the browser loads as ES modules with three.js from an
// import map, and the program hands it in. It copies game/ and screenshots/ from beside
// this file to the output directory (honouring MAKEFUN_OUTPUT_DIR, or /output inside the
// grader's container) and writes dossier.json, the summary the judge reads, with the
// vendored library. The dossier limits the scorer applies: 4 screenshots at most, one of
// them at most 256 KiB, a game/ of at most 993 files and 48 MiB in all.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);
