/**
 * UI layer — toasts, floating names, speech bubbles, chat input.
 *
 * Names and bubbles live in *separate* containers. The old build wiped
 * one shared container on every re-render, so a partner joining or a
 * window resize would delete a speech bubble mid-sentence.
 */

const ROLE_LABEL = { hamster: '倉鼠 🐹', capybara: '卡皮巴拉 🦦' };
const ROLE_TINT = { hamster: '#ffd166', capybara: '#ff9ec7' };

export function toast(container, message, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 400);
  }, ms);
  return el;
}

export class NameTags {
  /**
   * @param {HTMLElement} container
   * @param {import('./scene.js').Stage} stage
   */
  constructor(container, stage) {
    this.container = container;
    this.stage = stage;
    this.tags = new Map(); // role -> element
  }

  /** @param {Array<{id,nickname,role}>} users */
  sync(users, myId) {
    const seen = new Set();

    for (const user of users) {
      seen.add(user.role);
      let tag = this.tags.get(user.role);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'floating-name';
        this.container.appendChild(tag);
        this.tags.set(user.role, tag);
      }
      tag.dataset.role = user.role;
      tag.dataset.userId = user.id;
      tag.classList.toggle('is-me', user.id === myId);
      tag.classList.remove('is-waiting');
      tag.style.setProperty('--tint', ROLE_TINT[user.role] || '#fff');

      const label = tag.textContent;
      if (label !== user.nickname) tag.textContent = user.nickname;
    }

    // The other animal is always drawn in the artwork. Leaving it unnamed
    // reads as broken, so give it a gentle placeholder instead.
    for (const role of Object.keys(ROLE_LABEL)) {
      if (seen.has(role)) continue;
      let tag = this.tags.get(role);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'floating-name';
        this.container.appendChild(tag);
        this.tags.set(role, tag);
      }
      tag.classList.add('is-waiting');
      tag.classList.remove('is-me');
      tag.dataset.role = role;
      delete tag.dataset.userId;
      tag.textContent = '等' + ROLE_LABEL[role].split(' ')[0] + '來…';
      tag.style.setProperty('--tint', ROLE_TINT[role]);
    }

    this.position();
  }

  position() {
    for (const [role, tag] of this.tags) {
      const p = this.stage.anchorOf(role);
      if (!p) {
        tag.style.display = 'none';
        continue;
      }
      tag.style.display = '';
      tag.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0) translate(-50%,-100%)';
    }
  }

  /** A heartbeat pulse on a character — used when their partner fires. */
  pulse(role) {
    const tag = this.tags.get(role);
    if (!tag) return;
    tag.classList.remove('pulse');
    void tag.offsetWidth; // restart the animation
    tag.classList.add('pulse');
  }
}

export class Bubbles {
  constructor(container, stage) {
    this.container = container;
    this.stage = stage;
    this.live = new Map(); // role -> {el, timer}
  }

  show(role, text, pixel) {
    // One bubble per character; a new message replaces the old one rather
    // than stacking two overlapping bubbles on one head.
    const existing = this.live.get(role);
    if (existing) {
      clearTimeout(existing.timer);
      existing.el.remove();
    }

    const el = document.createElement('div');
    el.className = 'speech-bubble' + (pixel ? ' pixel-bubble' : '');
    el.textContent = text;
    this.container.appendChild(el);

    const timer = setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => {
        el.remove();
        if (this.live.get(role)?.el === el) this.live.delete(role);
      }, 400);
    }, 4200);

    this.live.set(role, { el, timer });
    this.position();
  }

  setPixel(pixel) {
    for (const { el } of this.live.values()) el.classList.toggle('pixel-bubble', pixel);
  }

  position() {
    for (const [role, { el }] of this.live) {
      const p = this.stage.anchorOf(role);
      if (!p) continue;
      el.style.transform =
        'translate3d(' + p.x + 'px,' + (p.y - 44) + 'px,0) translate(-50%,-100%)';
    }
  }
}

/**
 * Chat input that is safe for Chinese IME.
 *
 * `keypress` + no composition guard means pressing Enter to *choose* a
 * candidate in 注音/拼音 submits a half-finished word. This is the single
 * most common input bug in zh-TW web apps.
 */
export function bindChatInput(input, onSend) {
  let composing = false;

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // `isComposing` covers browsers that fire keydown during composition.
    if (composing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(text);
  });
}

export { ROLE_LABEL, ROLE_TINT };
