// NIGHTHARBOR: procedural WebAudio.
// Owns: master gain, compressor, shared noise buffer, and all synthesized
// effects. No files, no network. Silent no-op until unlock() runs.

export function createAudio() {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let actx = null;
  let noise = null;
  let master = null;
  let bedGain = null;

  function initGraph() {
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 8;
    master = actx.createGain();
    master.gain.value = 0.5;
    master.connect(comp);
    comp.connect(actx.destination);
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.6), actx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    bedGain = actx.createGain();
    bedGain.gain.value = 0;
    src.connect(lp);
    lp.connect(bedGain);
    bedGain.connect(master);
    src.start();
  }

  function unlock() {
    if (!AC || actx) return;
    actx = new AC();
    initGraph();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  }

  function step() {
    if (!actx || !bedGain) return;
    bedGain.gain.setTargetAtTime(0.02, actx.currentTime, 0.8);
  }

  function burst(opts) {
    const when = opts.when || 0;
    const t0 = actx.currentTime + when;
    const src = actx.createBufferSource();
    src.buffer = noise;
    src.loop = false;
    const off = Math.max(0, Math.random() * (noise.duration - opts.dur - 0.05));
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(opts.cut, t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(90, opts.cut * 0.25), t0 + opts.dur);
    const g = actx.createGain();
    const atk = opts.attack || 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, opts.gain), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur + 0.02);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(t0 + off);
    src.stop(t0 + off + opts.dur + atk + 0.05);
  }

  function thump(opts) {
    const t0 = actx.currentTime + (opts.when || 0);
    const osc = actx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    osc.frequency.exponentialRampToValueAtTime(opts.freq * 0.5, t0 + opts.dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  function ping(opts) {
    const t0 = actx.currentTime + (opts.when || 0);
    const osc = actx.createOscillator();
    osc.type = 'sine';
    if (opts.rise > 0) osc.frequency.setValueAtTime(opts.freq, t0).exponentialRampToValueAtTime(opts.freq + opts.rise, t0 + opts.dur * 0.8);
    else osc.frequency.value = opts.freq;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  function blip(opts) {
    const t0 = actx.currentTime;
    const osc = actx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = opts.freq;
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  const api = {
    unlock,
    step,
    master: null,
    shot(name) {
      if (!actx || !master) return;
      const sg = name === 'EMBER 12';
      burst({ dur: sg ? 0.28 : 0.14, cut: sg ? 900 : 2400, gain: sg ? 0.5 : 0.4 });
      thump({ freq: sg ? 48 : 70, dur: sg ? 0.3 : 0.16, gain: sg ? 0.5 : 0.35 });
    },
    botShot(distance) {
      if (!actx || !master) return;
      const g = 0.35 / (1 + (distance || 0) * 0.08);
      burst({ dur: 0.2, cut: 1800, gain: Math.max(0.001, g * 0.5) });
      thump({ freq: 55, dur: 0.2, gain: Math.max(0.001, g * 0.3) });
    },
    reload(stage) {
      if (!actx || !master) return;
      if (stage === 'end') {
        burst({ dur: 0.05, cut: 4500, gain: 0.12 });
        burst({ when: 0.09, dur: 0.05, cut: 5500, gain: 0.15 });
      } else {
        burst({ dur: 0.05, cut: 5000, gain: 0.12 });
      }
    },
    footstep(surface) {
      if (!actx || !master) return;
      const tone = typeof surface === 'string' && surface.indexOf('steel') >= 0 ? 3000 : 1600;
      burst({ dur: 0.07, cut: tone, gain: 0.08, attack: 0.008 });
    },
    hit() {
      if (!actx || !master) return;
      ping({ freq: 1400, dur: 0.06, gain: 0.1 });
    },
    kill() {
      if (!actx || !master) return;
      ping({ freq: 1200, dur: 0.09, gain: 0.1, rise: 300 });
      ping({ freq: 1500, dur: 0.09, gain: 0.12, when: 0.08, rise: 500 });
    },
    plantBeep(fast) {
      if (!actx || !master) return;
      blip({ freq: fast ? 980 : 900, dur: fast ? 0.05 : 0.09, gain: 0.08 });
    },
    roundStart() {
      if (!actx || !master) return;
      ping({ freq: 180, dur: 0.5, gain: 0.25 });
      ping({ freq: 240, dur: 0.5, gain: 0.25, when: 0.18 });
    },
    roundEnd(win) {
      if (!actx || !master) return;
      ping({ freq: 220, dur: 0.45, gain: 0.22 });
      ping({ freq: win ? 330 : 262, dur: 0.55, gain: 0.22, when: 0.2 });
    },
  };

  Object.defineProperty(api, 'master', {
    get() {
      return master;
    },
  });

  return api;
}
