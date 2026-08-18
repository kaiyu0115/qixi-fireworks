/**
 * Synthesised firework audio. No sample files — everything is generated
 * with WebAudio, so this costs zero bytes of download.
 *
 * Muted by default. A firework page that starts making noise on a phone
 * at 11pm is a worse experience than a silent one, and the toggle makes
 * the choice obvious.
 */

const MAX_VOICES = 6;

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.voices = 0;
    this._noise = null;
  }

  /** Must be called from a user gesture (the join click qualifies). */
  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused for every boom and crackle.
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
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
    setTimeout(() => { this.voices--; }, 1200);
    return this.ctx;
  }

  /** Rising whoosh as a shell climbs. */
  launch() {
    const ctx = this._voice();
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 6;
    band.frequency.setValueAtTime(380, now);
    band.frequency.exponentialRampToValueAtTime(1500, now + 0.5);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

    src.connect(band).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + 0.6);
  }

  /** Low thump + bright crackle tail. */
  burst(power = 1) {
    const ctx = this._voice();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Body: a fast pitch-dropping sine gives the chest thump.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160 * power, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.32);
    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(0.34 * power, now);
    oGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc.connect(oGain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.45);

    // Tail: filtered noise that decays into sparkle.
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(700, now);
    hp.frequency.exponentialRampToValueAtTime(3200, now + 0.9);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.22 * power, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
    src.connect(hp).connect(nGain).connect(this.master);
    src.start(now);
    src.stop(now + 1.05);
  }
}
