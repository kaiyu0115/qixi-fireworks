/**
 * Firework engine.
 *
 * Design notes worth keeping:
 *
 * - Glow is drawn with cached offscreen radial-gradient sprites composited
 *   with 'lighter'. Per-particle ctx.shadowBlur produces the same look and
 *   collapses to <20fps past a few hundred particles.
 * - All physics is delta-time based. The old build advanced one step per
 *   frame, so fireworks flew at double speed on 120Hz displays.
 * - The trail fade alpha is derived from dt (1 - e^-kt), otherwise trail
 *   length silently changes with refresh rate too.
 * - Particles come from a fixed pre-allocated pool. Capping *after*
 *   allocation still lets a burst churn hundreds of objects per second.
 */

export const SHAPES = ['peony', 'willow', 'ring', 'chrysanthemum', 'heart'];

/** Same indices in both styles — the wire protocol sends the index only. */
export const PALETTES = {
  anime: ['#ff5f8d', '#ff9ec7', '#ffd166', '#a8e0ff', '#7de2c3', '#c9a7ff', '#fff3d6', '#ff7a3d'],
  pixel: ['#ff3b6b', '#ff8fc0', '#ffc93c', '#66ccff', '#3fdca0', '#b07cff', '#fff8e0', '#ff6a1a'],
};

const MAX_PARTICLES = 1500;
const PIXEL_GRID = 3;

const TUNING = {
  // `fade` sets trail length. Too low and falling embers smear into long
  // vertical light columns that read as rain rather than fireworks.
  anime: { gravity: 92, drag: 0.9, fade: 5.2, sizeScale: 1, trailChance: 0.18 },
  pixel: { gravity: 132, drag: 1.5, fade: 7.5, sizeScale: 1.3, trailChance: 0.1 },
};

/**
 * Burst radius as a fraction of the smaller viewport axis. A firework
 * should read as a discrete flower in the sky — at 0.32 a single shell
 * spanned half the frame and swallowed the characters.
 */
const BURST_REACH = 0.195;

/**
 * Seconds over which gravity fades in after a burst.
 *
 * Applying full gravity from frame one makes the shell start dropping
 * while it is still opening, so it never reads as a sphere. Real shells
 * expand almost ballistically first, then droop as the sparks slow.
 */
const GRAVITY_RAMP = 0.55;

const rand = (a, b) => a + Math.random() * (b - a);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Incandescent sprite: white-hot core fading through the colour to
 * transparent. Reads as burning material rather than a flat dot.
 */
function makeGlowSprite(hex, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const [red, green, blue] = hexToRgb(hex);
  const rgb = red + ',' + green + ',' + blue;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  // The white core must stay TINY. A wide white centre plus additive
  // blending saturates every overlap to pure white and the firework
  // loses its colour entirely — pink and gold survive only at the fringe.
  grad.addColorStop(0.00, 'rgba(255,255,255,0.90)');
  grad.addColorStop(0.06, 'rgba(255,255,255,0.50)');
  grad.addColorStop(0.16, 'rgba(' + rgb + ',0.72)');
  grad.addColorStop(0.42, 'rgba(' + rgb + ',0.20)');
  grad.addColorStop(1.00, 'rgba(' + rgb + ',0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * Lingering smoke left behind by a burst. Drawn with 'source-over' as a
 * faint warm haze — real firework smoke is lit by the city glow below,
 * so it reads slightly lighter than the night sky rather than darker.
 */
function makeSmokeSprite(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(176,170,190,0.20)');
  grad.addColorStop(0.45, 'rgba(150,146,168,0.10)');
  grad.addColorStop(1.0, 'rgba(140,136,160,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Warm green glow for the fireflies drifting over the grass. */
function makeFireflySprite(size = 32) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.25, 'rgba(214,255,140,0.75)');
  grad.addColorStop(1.0, 'rgba(170,230,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Soft wide flash used for the light a burst throws onto the scene. */
function makeFlashSprite(hex, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const [red, green, blue] = hexToRgb(hex);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(' + red + ',' + green + ',' + blue + ',0.55)');
  grad.addColorStop(0.35, 'rgba(' + red + ',' + green + ',' + blue + ',0.18)');
  grad.addColorStop(1.0, 'rgba(' + red + ',' + green + ',' + blue + ',0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/* ------------------------------------------------------------------ *
 * Burst shape generators.
 * Each returns a unit direction {x,y,z} plus a speed multiplier. The z
 * component never moves anything — it drives size and brightness so a
 * flat 2D burst reads as a sphere turned toward the viewer.
 * ------------------------------------------------------------------ */

function spherePoint() {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return { x: r * Math.cos(t), y: r * Math.sin(t), z };
}

const SHAPE_GEN = {
  peony(i, n) {
    const p = spherePoint();
    return { ...p, speed: rand(0.72, 1.0), life: rand(1.1, 1.7), trail: false };
  },

  willow(i, n) {
    const p = spherePoint();
    // Slow, heavy, long-lived -> droops into a weeping canopy.
    return { ...p, speed: rand(0.42, 0.66), life: rand(2.2, 3.1), trail: true, heavy: 1.9 };
  },

  ring(i, n) {
    // A circle tilted in 3D reads as a ring seen at an angle.
    const t = (i / n) * Math.PI * 2 + rand(-0.03, 0.03);
    const tilt = 0.55;
    const x = Math.cos(t);
    const y = Math.sin(t) * Math.cos(tilt);
    const z = Math.sin(t) * Math.sin(tilt);
    return { x, y, z, speed: rand(0.9, 1.0), life: rand(1.3, 1.8), trail: false };
  },

  chrysanthemum(i, n) {
    const p = spherePoint();
    return { ...p, speed: rand(0.55, 1.0), life: rand(1.6, 2.3), trail: true, crackle: true };
  },

  heart(i, n) {
    // Classic parametric heart, normalised to roughly unit radius.
    const t = (i / n) * Math.PI * 2;
    const hx = 16 * Math.pow(Math.sin(t), 3);
    const hy =
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const s = 1 / 17;
    return {
      x: hx * s + rand(-0.04, 0.04),
      y: -hy * s + rand(-0.04, 0.04), // canvas Y grows downward
      z: rand(-0.35, 0.35),
      speed: rand(0.92, 1.06),
      life: rand(1.7, 2.4),
      trail: false,
    };
  },
};

const SHAPE_COUNT = {
  peony: 90,
  willow: 80,
  ring: 68,
  chrysanthemum: 95,
  heart: 110,
};

/** Bloom source is rendered at 1/N scale — the blur hides the resolution. */
const BLOOM_SCALE = 4;
const BLOOM_STRENGTH = { anime: 0.85, pixel: 0.4 };

export class FireworksEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.style = 'anime';
    this.reducedMotion = !!opts.reducedMotion;
    this.onBurst = opts.onBurst || (() => {});

    // Optional second canvas, composited over the main one with `screen`.
    // Downsampling first means the blur is cheap; at full resolution a
    // per-frame blur of this size is not affordable on a phone.
    this.bloomCanvas = opts.bloomCanvas || null;
    this.bloomCtx = this.bloomCanvas ? this.bloomCanvas.getContext('2d') : null;
    this.bloomEnabled = !!this.bloomCanvas && !this.reducedMotion;

    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.horizon = 0.6;

    this.rockets = [];
    this.flashes = [];
    this.streaks = [];
    this.smoke = [];

    // Fixed pool — never grows, never triggers GC churn mid-show.
    // `free` is a stack of dead slot indices so allocation stays O(1);
    // scanning the pool for a gap would cost O(n) per particle, and a
    // single heart burst allocates 110 of them.
    this.pool = new Array(MAX_PARTICLES);
    this.free = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool[i] = { alive: false, slot: i, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1 };
      this.free[i] = MAX_PARTICLES - 1 - i;
    }
    this.cursor = 0;
    this.liveCount = 0;

    this.smokeSprite = makeSmokeSprite();
    this.fireflySprite = makeFireflySprite();
    this.fireflies = [];
    this.sprites = { anime: [], pixel: [] };
    this.flashSprites = { anime: [], pixel: [] };
    for (const style of ['anime', 'pixel']) {
      for (const hex of PALETTES[style]) {
        this.sprites[style].push(makeGlowSprite(hex));
        this.flashSprites[style].push(makeFlashSprite(hex));
      }
    }

    this._raf = 0;
    this._last = 0;
    this._idleFrames = 0;
    this._nextStreak = rand(4, 10);
  }

  setStyle(style) {
    if (PALETTES[style]) this.style = style;
  }

  setHorizon(fraction) {
    // Only reseed when the horizon actually moved, otherwise every layout
    // pass would teleport the fireflies to new positions.
    const changed = Math.abs(this.horizon - fraction) > 0.001;
    this.horizon = fraction;
    if (changed || this.fireflies.length === 0) this._seedFireflies();
  }

  /**
   * Fireflies live in the grass band below the horizon. Both artworks
   * already have them painted in, so animating a few makes the still
   * illustration feel inhabited.
   */
  _seedFireflies() {
    if (this.reducedMotion || !this.w || !this.h) {
      this.fireflies.length = 0;
      return;
    }
    const top = this.h * this.horizon;
    const band = Math.max(40, this.h - top);
    const count = Math.round(Math.min(22, Math.max(8, this.w / 70)));

    this.fireflies.length = 0;
    for (let i = 0; i < count; i++) {
      this.fireflies.push({
        x: Math.random() * this.w,
        // Denser near the ground, thinning out toward the horizon.
        y: top + Math.pow(Math.random(), 0.65) * band * 0.92,
        vx: rand(-9, 9),
        drift: rand(0.3, 0.9),
        bob: Math.random() * Math.PI * 2,
        phase: Math.random(),
        period: rand(1.9, 4.2),
        size: rand(1.9, 3.4),
      });
    }
  }

  resize(cssW, cssH, dpr) {
    // Assigning canvas.width clears the bitmap. Mobile browsers fire
    // resize continuously while the URL bar slides, which would wipe the
    // show several times a second — so ignore no-op resizes.
    if (this.w === cssW && this.h === cssH && this.dpr === dpr) return;
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    // Draw in CSS pixels; the backing store carries the extra density.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (this.bloomCanvas) {
      this.bloomCanvas.width = Math.max(1, Math.round(cssW / BLOOM_SCALE));
      this.bloomCanvas.height = Math.max(1, Math.round(cssH / BLOOM_SCALE));
      this.bloomCanvas.style.width = cssW + 'px';
      this.bloomCanvas.style.height = cssH + 'px';
    }
  }

  /**
   * Bloom pass: downscale the finished frame, blur it, and let CSS
   * composite it back with `screen`. Only the bright additive pixels
   * survive the screen blend, so the glow lands on the fireworks alone.
   */
  _renderBloom() {
    if (!this.bloomEnabled) return;
    const b = this.bloomCtx;
    const bw = this.bloomCanvas.width;
    const bh = this.bloomCanvas.height;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, bw, bh);
    b.globalAlpha = BLOOM_STRENGTH[this.style];
    b.filter = 'blur(' + (this.style === 'pixel' ? 1.5 : 2.5) + 'px)';
    b.drawImage(this.canvas, 0, 0, bw, bh);
    b.filter = 'none';
    b.globalAlpha = 1;
  }

  _spawn() {
    if (this.free.length > 0) {
      const p = this.pool[this.free.pop()];
      p.alive = true;
      this.liveCount++;
      return p;
    }
    // Pool exhausted: recycle round-robin. Already alive, so liveCount
    // and the free stack both stay balanced.
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return p;
  }

  _kill(p) {
    p.alive = false;
    this.liveCount--;
    this.free.push(p.slot);
  }

  /** Launch a shell from the ground that rises and bursts at (nx, ny). */
  launch({ x, y, color = 0, shape = 'peony', mine = false }) {
    const tx = x * this.w;
    const ty = y * this.h;
    const groundY = this.h * 1.04;
    const rise = Math.max(60, groundY - ty);

    const g = 300;
    const t = Math.sqrt((2 * rise) / g);
    const originX = tx + rand(-0.05, 0.05) * this.w;

    this.rockets.push({
      x: originX,
      y: groundY,
      vx: (tx - originX) / t,
      vy: -g * t,
      g,
      color,
      shape,
      mine,
      spark: 0,
    });
  }

  /** Burst immediately with no rocket — used for ambient shells. */
  burst(nx, ny, color = 0, shape = 'peony', power = 1, mine = false) {
    const x = nx * this.w;
    const y = ny * this.h;
    const gen = SHAPE_GEN[shape] || SHAPE_GEN.peony;
    const tuning = TUNING[this.style];

    let n = SHAPE_COUNT[shape] || 90;
    if (this.reducedMotion) n = Math.round(n * 0.45);
    // Scale the show down on small screens; 110 particles on a phone is
    // visual mush, not generosity.
    const areaScale = Math.min(1, Math.max(0.55, (this.w * this.h) / (1280 * 720)));
    n = Math.round(n * areaScale * power);

    const baseSpeed = Math.min(this.w, this.h) * BURST_REACH * power;

    for (let i = 0; i < n; i++) {
      const d = gen(i, n);
      const p = this._spawn();
      const speed = baseSpeed * d.speed;
      p.x = x;
      p.y = y;
      p.vx = d.x * speed;
      p.vy = d.y * speed;
      p.z = d.z;
      p.color = color;
      p.maxLife = d.life * (this.reducedMotion ? 0.7 : 1);
      p.life = p.maxLife;
      p.heavy = d.heavy || 1;
      p.trail = !!d.trail;
      p.crackle = !!d.crackle;
      p.size = rand(1.6, 3.4) * tuning.sizeScale * (0.75 + 0.45 * (d.z + 1) / 2);
      p.spark = false;
    }

    if (!this.reducedMotion) {
      this.flashes.push({ x, y, color, life: 0.42, maxLife: 0.42, power });

      // Smoke is an anime-style flourish only. Soft grey haze in a pixel
      // scene fights the hard-edged art rather than supporting it.
      if (this.style === 'anime') {
        const reach = Math.min(this.w, this.h) * BURST_REACH;
        // Many small overlapping puffs at varied sizes and offsets. A few
        // large ones just read as circles; the irregularity is the whole
        // point of smoke.
        for (let i = 0; i < 11; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * reach * 0.85;
          const life = rand(2.4, 4.8);
          this.smoke.push({
            x: x + Math.cos(a) * d,
            y: y + Math.sin(a) * d * 0.8,
            vx: Math.cos(a) * rand(3, 16),
            vy: Math.sin(a) * rand(3, 16) - rand(5, 12), // drifts upward
            r0: reach * rand(0.16, 0.45),
            grow: reach * rand(0.35, 0.85),
            life,
            maxLife: life,
          });
        }
      }
    }
    this.onBurst(x / this.w, y / this.h, PALETTES[this.style][color], power, mine);
    this._wake();
  }

  _spawnSpark(x, y, color, size, spread, life) {
    const p = this._spawn();
    const a = Math.random() * Math.PI * 2;
    const s = Math.random() * spread;
    p.x = x;
    p.y = y;
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.z = 0;
    p.color = color;
    p.maxLife = life;
    p.life = life;
    p.heavy = 0.5;
    p.trail = false;
    p.crackle = false;
    p.size = size;
    p.spark = true;
  }

  start() {
    if (this._raf) return;
    this._last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      // Clamp dt so a backgrounded tab doesn't teleport every particle.
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this._step(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _wake() {
    this._idleFrames = 0;
  }

  _step(dt) {
    const ctx = this.ctx;
    const tuning = TUNING[this.style];
    const pixel = this.style === 'pixel';
    // Fireflies are permanent ambience, so they keep the loop alive. The
    // per-frame cost is one composite plus a couple of dozen small sprites;
    // battery is protected by pausing outright when the tab is hidden.
    const busy =
      this.liveCount > 0 || this.rockets.length > 0 || this.flashes.length > 0 ||
      this.streaks.length > 0 || this.smoke.length > 0 || this.fireflies.length > 0;

    if (!busy) {
      // Nothing to draw. Let the canvas settle, then stop burning frames
      // entirely — this used to run a full-screen composite forever.
      if (this._idleFrames < 30) {
        this._idleFrames++;
        this._fadeOrClear(dt, tuning);
        this._renderBloom();
      }
      this._maybeStreak(dt);
      return;
    }
    this._idleFrames = 0;

    this._fadeOrClear(dt, tuning);
    this._maybeStreak(dt);

    // Smoke sits behind everything luminous, and is the only element drawn
    // normally rather than additively.
    this._stepSmoke(dt);

    ctx.globalCompositeOperation = 'lighter';

    this._stepFireflies(dt);
    this._stepFlashes(dt);
    this._stepRockets(dt, tuning);
    this._stepStreaks(dt);
    this._stepParticles(dt, tuning, pixel);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    this._renderBloom();
  }

  /**
   * Trails are produced by repeatedly fading the previous frame. That fade
   * can never actually reach zero: `destination-out` computes
   * `alpha * (1 - a)` in 8-bit integers, so an alpha of 1/255 multiplied by
   * 0.95 rounds straight back to 1 and sticks there forever. Fireflies are
   * redrawn in the same band every frame, so that floor accumulated into a
   * permanent haze across the bottom of the screen — which bloom then
   * blurred and amplified.
   *
   * Only firework elements actually need a trail. When none are on screen,
   * hard-clear instead of fading, which wipes the accumulated floor. Quiet
   * moments are frequent, so the canvas self-cleans continuously.
   */
  _fadeOrClear(dt, tuning) {
    const needsTrail =
      this.liveCount > 0 || this.rockets.length > 0 ||
      this.smoke.length > 0 || this.streaks.length > 0;

    if (needsTrail) {
      this._fade(dt, tuning);
      return;
    }
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.w, this.h);
  }

  /** Framerate-independent trail decay. */
  _fade(dt, tuning) {
    const ctx = this.ctx;
    const alpha = 1 - Math.exp(-tuning.fade * dt);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,' + alpha.toFixed(4) + ')';
    ctx.fillRect(0, 0, this.w, this.h);
  }

  _stepFireflies(dt) {
    const flies = this.fireflies;
    if (flies.length === 0) return;
    const ctx = this.ctx;
    const pixel = this.style === 'pixel';
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      f.phase += dt / f.period;
      f.bob += dt * f.drift;
      f.x += f.vx * dt;
      if (f.x < -20) f.x = this.w + 20;
      else if (f.x > this.w + 20) f.x = -20;

      const y = f.y + Math.sin(f.bob) * 5;

      // Cubed sine gives a sharp pulse with long dark gaps, which is how
      // fireflies actually blink — a plain sine just throbs.
      const s = Math.sin(f.phase * Math.PI * 2);
      const glow = s > 0 ? s * s * s : 0;
      if (glow < 0.02) continue;

      if (pixel) {
        // Two grid cells — a single 3px cell disappears entirely against
        // the busy pixel grass.
        const g = PIXEL_GRID;
        const s = g * 2;
        ctx.globalAlpha = glow > 0.5 ? 1 : 0.55;
        ctx.fillStyle = '#d6ff8c';
        ctx.fillRect(Math.round(f.x / g) * g, Math.round(y / g) * g, s, s);
      } else {
        // Kept small and dim: any larger and they read as lens bokeh
        // rather than as insects in the grass.
        const size = f.size * 2.4;
        ctx.globalAlpha = glow * 0.55;
        ctx.drawImage(this.fireflySprite, f.x - size / 2, y - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  _stepSmoke(dt) {
    if (this.smoke.length === 0) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';

    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.smoke.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy -= 3 * dt; // keeps rising as it cools

      const t = s.life / s.maxLife;
      const age = 1 - t;
      const r = s.r0 + s.grow * age;
      // Fade in quickly, then linger and dissipate.
      const alpha = Math.min(1, age * 6) * t * t * 0.18;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.smokeSprite, s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  _stepFlashes(dt) {
    const ctx = this.ctx;
    const sprites = this.flashSprites[this.style];
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      const t = f.life / f.maxLife;
      // Sized off the burst itself, not the whole viewport: a flash that
      // spans half the sky reads as fog and washes out the sparks.
      const size = Math.min(this.w, this.h) * BURST_REACH * (1.6 + (1 - t) * 1.4) * f.power;
      ctx.globalAlpha = t * t * (this.style === 'pixel' ? 0.22 : 0.42);
      ctx.drawImage(sprites[f.color], f.x - size / 2, f.y - size / 2, size, size);
    }
  }

  _stepRockets(dt, tuning) {
    const ctx = this.ctx;
    const sprites = this.sprites[this.style];
    const emberColor = 2; // gold

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.vy += r.g * dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;

      // Burst at apex.
      if (r.vy >= 0) {
        this.rockets.splice(i, 1);
        this.burst(r.x / this.w, r.y / this.h, r.color, r.shape, 1, r.mine);
        continue;
      }

      r.spark += dt;
      if (r.spark > 0.012) {
        r.spark = 0;
        this._spawnSpark(r.x, r.y, emberColor, rand(1, 2.2), 18, rand(0.18, 0.4));
      }

      const size = 14;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(sprites[emberColor], r.x - size / 2, r.y - size / 2, size, size);
    }
  }

  _maybeStreak(dt) {
    if (this.reducedMotion) return;
    this._nextStreak -= dt;
    if (this._nextStreak > 0) return;
    this._nextStreak = rand(6, 16);
    const skyH = this.h * this.horizon;
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.streaks.push({
      x: dir === 1 ? -40 : this.w + 40,
      y: rand(skyH * 0.08, skyH * 0.55),
      vx: dir * rand(320, 520),
      vy: rand(90, 170),
      life: 1.4,
      maxLife: 1.4,
    });
    this._wake();
  }

  _stepStreaks(dt) {
    const ctx = this.ctx;
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.streaks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const t = s.life / s.maxLife;
      const len = 90;
      const nx = s.vx, ny = s.vy;
      const mag = Math.hypot(nx, ny) || 1;
      const grad = ctx.createLinearGradient(
        s.x, s.y,
        s.x - (nx / mag) * len, s.y - (ny / mag) * len
      );
      grad.addColorStop(0, 'rgba(255,255,255,' + (t * 0.85).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - (nx / mag) * len, s.y - (ny / mag) * len);
      ctx.stroke();
    }
  }

  _stepParticles(dt, tuning, pixel) {
    const ctx = this.ctx;
    const sprites = this.sprites[this.style];
    const palette = PALETTES[this.style];
    // Additive blending is what makes the anime style glow, but it turns
    // overlapping pixel squares into white mush. Pixel art wants flat,
    // opaque colour with hard edges.
    ctx.globalCompositeOperation = pixel ? 'source-over' : 'lighter';
    // Exponential drag is the frame-rate-correct form of `v *= k`.
    const dragFactor = Math.exp(-tuning.drag * dt);
    const groundY = this.h * this.horizon;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;

      p.life -= dt;
      if (p.life <= 0) {
        this._kill(p);
        // Chrysanthemum crackle: a last flicker of tiny sparks.
        if (p.crackle && !this.reducedMotion && Math.random() < 0.35) {
          for (let k = 0; k < 3; k++) {
            this._spawnSpark(p.x, p.y, p.color, rand(1, 2), 40, rand(0.12, 0.3));
          }
        }
        continue;
      }

      p.vx *= dragFactor;
      p.vy *= dragFactor;
      // Ease gravity in, so the burst opens as a sphere before it falls.
      // Sparks (rocket embers, crackle) are already short-lived debris and
      // should just drop.
      const gRamp = p.spark ? 1 : Math.min(1, (p.maxLife - p.life) / GRAVITY_RAMP);
      p.vy += tuning.gravity * p.heavy * gRamp * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.trail && !p.spark && !this.reducedMotion && Math.random() < tuning.trailChance) {
        this._spawnSpark(p.x, p.y, p.color, p.size * 0.5, 6, rand(0.15, 0.35));
      }

      const t = p.life / p.maxLife;
      // Twinkle: embers flicker as they cool rather than fading linearly.
      const flicker = p.spark ? 1 : 0.75 + Math.random() * 0.25;
      let alpha = Math.min(1, t * 1.6) * flicker;

      // Sparks that fall past the horizon sink into the landscape instead
      // of sitting on top of the grass. Cheap depth without a cutout mask.
      if (p.y > groundY) {
        const sink = (p.y - groundY) / (this.h * 0.18);
        alpha *= Math.max(0, 1 - sink);
        if (alpha <= 0.01) {
          this._kill(p);
          continue;
        }
      }

      if (pixel) {
        const g = PIXEL_GRID;
        const px = Math.round(p.x / g) * g;
        const py = Math.round(p.y / g) * g;
        const s = Math.max(g, Math.round((p.size * 1.6) / g) * g);
        ctx.globalAlpha = alpha > 0.55 ? 1 : alpha > 0.25 ? 0.6 : 0.3; // posterised
        ctx.fillStyle = palette[p.color];
        ctx.fillRect(px, py, s, s);
      } else {
        // Tighter sprite = distinct sparks. Large soft sprites merge into
        // a cotton-ball blob and lose the radiating structure.
        const s = p.size * (1.5 + (1 - t) * 0.9) * 2;
        // Held well under 1 so that N overlapping sprites sum toward a
        // bright colour instead of clipping straight to white.
        ctx.globalAlpha = alpha * 0.6;
        ctx.drawImage(sprites[p.color], p.x - s / 2, p.y - s / 2, s, s);
      }
    }

    if (pixel) ctx.globalAlpha = 1;
  }
}
