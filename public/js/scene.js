/**
 * Scene layer — background art + image-space anchor projection.
 *
 * The core problem this solves: the characters live *inside* a JPEG that
 * gets cover-scaled to the viewport, and their left/right arrangement is
 * NOT the same between the landscape and portrait artwork. Positioning
 * names with hardcoded vw/vh can therefore never be correct.
 *
 * Instead every character has an anchor expressed in *image* coordinates
 * (0..1 of the source JPEG). We reproduce the cover transform in JS and
 * project those anchors into screen pixels. Exact at any aspect ratio.
 *
 * Deliberate decision: we do NOT use CSS `object-fit: cover`. If CSS owned
 * the transform and JS merely mirrored it, the two could silently drift
 * apart. JS owns it outright and applies explicit width/height/translate.
 */

/** Anchors are measured at the TOP OF THE HEAD, x centred on the body. */
export const SCENES = {
  anime: {
    landscape: {
      src: 'assets/anime_16x9.jpg',
      w: 1376,
      h: 768,
      horizon: 0.60,
      anchors: { hamster: { x: 0.440, y: 0.601 }, capybara: { x: 0.558, y: 0.419 } },
    },
    portrait: {
      src: 'assets/anime_9x16.jpg',
      w: 768,
      h: 1376,
      horizon: 0.57,
      // NOTE: reversed vs landscape — capybara sits on the LEFT here.
      anchors: { hamster: { x: 0.634, y: 0.719 }, capybara: { x: 0.458, y: 0.594 } },
    },
  },
  pixel: {
    landscape: {
      src: 'assets/pixel_16x9.jpg',
      w: 1376,
      h: 768,
      horizon: 0.50,
      anchors: { hamster: { x: 0.447, y: 0.612 }, capybara: { x: 0.549, y: 0.482 } },
    },
    portrait: {
      src: 'assets/pixel_9x16.jpg',
      w: 768,
      h: 1376,
      horizon: 0.62,
      anchors: { hamster: { x: 0.625, y: 0.752 }, capybara: { x: 0.432, y: 0.614 } },
    },
  },
};

/**
 * Which artwork best fits this viewport?
 *
 * Choosing the variant whose aspect is closest (in log space) to the
 * viewport minimises how much of the art gets cropped away. For our two
 * assets (1.792 and 0.558) the crossover lands exactly at 1.0, so this is
 * equivalent to an orientation test — but it stays correct if the art is
 * ever re-cut at different ratios.
 */
export function pickVariant(style, vw, vh) {
  const scene = SCENES[style] || SCENES.anime;
  const viewport = vw / vh;
  const land = scene.landscape;
  const port = scene.portrait;
  const dLand = Math.abs(Math.log(viewport / (land.w / land.h)));
  const dPort = Math.abs(Math.log(viewport / (port.w / port.h)));
  return dLand <= dPort ? land : port;
}

/**
 * Reproduce `object-fit: cover` + `object-position: 50% 100%`.
 * Returns the drawn rect of the image in CSS pixels.
 *
 * `overscan` scales the image slightly beyond cover so there is slack to
 * shift into for parallax without ever exposing an edge.
 */
export function coverRect(iw, ih, vw, vh, originX = 0.5, originY = 1, overscan = 1) {
  const scale = Math.max(vw / iw, vh / ih) * overscan;
  const w = iw * scale;
  const h = ih * scale;
  return { x: (vw - w) * originX, y: (vh - h) * originY, w, h, scale };
}

/** Extra zoom that buys room for the parallax shift. */
const OVERSCAN = 1.05;
/** Maximum parallax travel in CSS pixels, per axis. */
const PARALLAX_MAX = 11;

/** Project an image-space anchor (0..1) into screen CSS pixels. */
export function project(anchor, rect) {
  return { x: rect.x + anchor.x * rect.w, y: rect.y + anchor.y * rect.h };
}

export class Stage {
  /**
   * @param {HTMLElement} root  container that both <img> layers live in
   */
  constructor(root) {
    this.root = root;
    this.style = 'anime';
    this.variant = null;
    this.rect = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
    this.vw = 0;
    this.vh = 0;
    this.listeners = new Set();
    this._preloaded = new Set();
    // Normalised parallax input, each in [-1, 1].
    this.parallax = { x: 0, y: 0 };

    // Two stacked layers so a style change can crossfade instead of
    // flashing black while the next JPEG decodes.
    this.layers = [this._makeLayer(), this._makeLayer()];
    this.front = 0;
    this.layers[0].style.opacity = '1';
  }

  _makeLayer() {
    const img = document.createElement('img');
    img.className = 'bg-layer';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.style.opacity = '0';
    this.root.appendChild(img);
    return img;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** Screen position of a character's head, in CSS pixels. */
  anchorOf(role) {
    const a = this.variant.anchors[role];
    if (!a) return null;
    return project(a, this.rect);
  }

  /** Y coordinate (CSS px) where sky meets land. */
  horizonY() {
    return this.rect.y + this.variant.horizon * this.rect.h;
  }

  /**
   * Recompute the drawn rect including the current parallax shift.
   *
   * The shift is baked into `this.rect`, which is the single source every
   * anchor projection reads from — so the name tags and speech bubbles
   * travel with the artwork instead of detaching from the characters.
   */
  _computeRect() {
    const v = this.variant;
    const base = coverRect(v.w, v.h, this.vw, this.vh, 0.5, 1, OVERSCAN);

    const slackX = Math.max(0, base.w - this.vw);
    const slackY = Math.max(0, base.h - this.vh);
    const budgetX = Math.min(PARALLAX_MAX, slackX / 2);
    const budgetY = Math.min(PARALLAX_MAX, slackY / 2);

    base.x += budgetX * this.parallax.x;
    // The artwork is bottom-anchored, so all vertical slack sits above it.
    // Travel only downward from that edge, or a gap opens under the grass.
    base.y += budgetY + budgetY * this.parallax.y;

    this.rect = base;
  }

  /** @param {number} nx @param {number} ny both in [-1, 1] */
  setParallax(nx, ny) {
    this.parallax.x = Math.max(-1, Math.min(1, nx));
    this.parallax.y = Math.max(-1, Math.min(1, ny));
    if (!this.variant) return;
    this._computeRect();
    this._applyTransform(this.layers[0]);
    this._applyTransform(this.layers[1]);
    this._emit();
  }

  resize(vw, vh) {
    this.vw = vw;
    this.vh = vh;
    const next = pickVariant(this.style, vw, vh);
    const variantChanged = next !== this.variant;
    this.variant = next;
    this._computeRect();

    const layer = this.layers[this.front];
    if (variantChanged) {
      layer.src = next.src;
    }
    this._applyTransform(layer);
    // Keep the back layer aligned too, so a crossfade never jumps.
    this._applyTransform(this.layers[1 - this.front]);
    this._emit();
  }

  _applyTransform(img) {
    const r = this.rect;
    img.style.width = r.w + 'px';
    img.style.height = r.h + 'px';
    img.style.transform = 'translate3d(' + r.x + 'px,' + r.y + 'px,0)';
  }

  setStyle(style) {
    if (!SCENES[style] || style === this.style) return;
    this.style = style;
    const next = pickVariant(style, this.vw, this.vh);
    this.variant = next;
    this._computeRect();

    const back = this.layers[1 - this.front];
    const frontLayer = this.layers[this.front];
    this._applyTransform(back);

    const reveal = () => {
      back.style.opacity = '1';
      frontLayer.style.opacity = '0';
      this.front = 1 - this.front;
      this._emit();
    };

    if (back.src.endsWith(next.src)) {
      reveal();
    } else {
      back.src = next.src;
      if (back.complete) reveal();
      else back.addEventListener('load', reveal, { once: true });
    }

    this.preloadAlternate();
  }

  /**
   * Warm the cache for the *other* style at the current orientation only.
   * Preloading all four assets would cost ~3MB on mobile data for art the
   * user may never see; one image is the honest trade.
   */
  preloadAlternate() {
    const other = this.style === 'anime' ? 'pixel' : 'anime';
    const variant = pickVariant(other, this.vw, this.vh);
    if (this._preloaded.has(variant.src)) return;
    this._preloaded.add(variant.src);
    const run = () => {
      const img = new Image();
      img.decoding = 'async';
      img.src = variant.src;
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
  }
}
