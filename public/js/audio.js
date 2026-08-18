/**
 * Synthesised firework audio. No sample files — everything is generated
 * with WebAudio, so this costs zero bytes of download.
 *
 * Muted by default. A firework page that starts making noise on a phone
 * at 11pm is a worse experience than a silent one, and the toggle makes
 * the choice obvious.
 *
 * A real firework is not one sound. It is three, and the earlier version
 * only had a rough approximation of the middle one:
 *
 *   1. CRACK   — a very short, bright transient. This is what makes the
 *                ear read "explosion" rather than "drum".
 *   2. BOOM    — a low body that decays over roughly half a second. It is
 *                filtered noise, not a sine: a pure tone reads as musical.
 *   3. CRACKLE — dozens of tiny pops scattered over the following second
 *                as the stars burn. This is the most recognisable part and
 *                was missing entirely.
 *
 * Everything is fed through a generated reverb so the burst sounds like it
 * is happening a few hundred metres away in open air, rather than inside
 * the listener's head.
 */

const MAX_VOICES = 5;

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverbSend = null;
    this.enabled = false;
    this.voices = 0;
    this._noise = null;
  }

  /** Must be called from a user gesture (the join click qualifies). */
  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // Two seconds of white noise, reused as the source for every layer.
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;

    // Generated impulse response: noise with an exponential decay. Cheap,
    // needs no asset, and gives the open-air tail a real firework has.
    const irLen = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = ir;

    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    convolver.connect(wet).connect(this.master);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(convolver);

    return true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && this._ensure() && this.ctx.state === 'suspended') this.ctx.resume();
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  _voice() {
    if (!this.enabled || !this.ctx || this.voices >= MAX_VOICES) return null;
    this.voices++;
    setTimeout(() => { this.voices--; }, 1400);
    return this.ctx;
  }

  /** Route a node to both the dry master and the reverb bus. */
  _out(node, wetAmount = 1) {
    node.connect(this.master);
    if (this.reverbSend && wetAmount > 0) {
      const send = this.ctx.createGain();
      send.gain.value = wetAmount;
      node.connect(send).connect(this.reverbSend);
    }
  }

  /** One short filtered-noise event. The building block for everything. */
  _pop({ at, dur, gain, type, freq, q = 1, attack = 0.001, wet = 0.6 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    // Random offset so repeated pops are not identical.
    const offset = Math.random() * (this._noise.duration - dur - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(filter).connect(g);
    this._out(g, wet);
    src.start(at, offset, dur + 0.05);
    src.stop(at + dur + 0.05);
  }

  /** Rising hiss as a shell climbs, plus the thud of ignition. */
  launch() {
    const ctx = this._voice();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Ignition thud.
    this._pop({ at: now, dur: 0.14, gain: 0.1, type: 'lowpass', freq: 220, wet: 0.4 });

    // Ascending hiss.
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 3.5;
    band.frequency.setValueAtTime(420, now);
    band.frequency.exponentialRampToValueAtTime(1700, now + 0.62);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);

    src.connect(band).connect(g);
    this._out(g, 0.5);
    src.start(now, Math.random() * 0.5);
    src.stop(now + 0.75);
  }

  /** Crack, then body, then a scatter of crackle. */
  burst(power = 1) {
    const ctx = this._voice();
    if (!ctx) return;
    const now = ctx.currentTime;
    const p = Math.min(1.3, power);

    // 1. CRACK — the bright transient that reads as an explosion.
    this._pop({
      at: now, dur: 0.055, gain: 0.32 * p,
      type: 'highpass', freq: 1600, attack: 0.0006, wet: 0.5,
    });

    // 2. BOOM — low body. Filtered noise rather than a tone, with the
    //    cutoff sweeping down as the pressure wave loses its edge.
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, now);
    lp.frequency.exponentialRampToValueAtTime(90, now + 0.5);
    lp.Q.value = 1.4;

    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, now);
    bg.gain.exponentialRampToValueAtTime(0.42 * p, now + 0.012);
    bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);

    src.connect(lp).connect(bg);
    this._out(bg, 1);
    src.start(now, Math.random() * 0.5);
    src.stop(now + 0.7);

    // A little sub weight underneath, well below the noise body.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(84, now);
    sub.frequency.exponentialRampToValueAtTime(32, now + 0.38);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.16 * p, now);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    sub.connect(sg);
    this._out(sg, 0.3);
    sub.start(now);
    sub.stop(now + 0.5);

    // 3. CRACKLE — the burning stars. Irregular timing matters; evenly
    //    spaced pops sound like a machine rather than a firework.
    const count = Math.round(26 + Math.random() * 18);
    for (let i = 0; i < count; i++) {
      const t = now + 0.06 + Math.pow(Math.random(), 0.7) * 1.25;
      this._pop({
        at: t,
        dur: 0.018 + Math.random() * 0.03,
        gain: (0.035 + Math.random() * 0.055) * p,
        type: 'bandpass',
        freq: 1800 + Math.random() * 3200,
        q: 2.5,
        attack: 0.0005,
        wet: 0.8,
      });
    }
  }
}
