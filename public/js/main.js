import { Stage } from './scene.js';
import { FireworksEngine, PALETTES } from './fx.js';
import { Sfx } from './audio.js';
import { NameTags, Bubbles, bindChatInput, toast, ROLE_LABEL } from './ui.js';

const socket = io();
const $ = (sel) => document.querySelector(sel);

const el = {
  login: $('#login-overlay'),
  loginBox: $('.login-box'),
  room: $('#room-input'),
  nickname: $('#nickname-input'),
  join: $('#join-btn'),
  loginError: $('#login-error'),
  stageRoot: $('#stage'),
  bgRoot: $('#bg-root'),
  canvas: $('#fireworks-canvas'),
  bloom: $('#bloom-canvas'),
  toasts: $('#toast-container'),
  names: $('#names-container'),
  bubbles: $('#bubbles-container'),
  chat: $('#chat-container'),
  chatInput: $('#chat-input'),
  styleBtn: $('#toggle-style-btn'),
  soundBtn: $('#toggle-sound-btn'),
  heartBtn: $('#heart-btn'),
  roomTag: $('#room-tag'),
  dice: $('#dice-btn'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = new Stage(el.bgRoot);
const sfx = new Sfx();
const nameTags = new NameTags(el.names, stage);
const bubbles = new Bubbles(el.bubbles, stage);

const engine = new FireworksEngine(el.canvas, {
  reducedMotion,
  bloomCanvas: el.bloom,
  // The light spill onto the landscape is drawn by the engine itself now.
  onBurst: (nx, ny, hex, power) => sfx.burst(power),
});

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  style: 'anime',
  role: 'hamster',
  joined: false,
  myId: null,
  users: new Map(), // id -> user
  lastJoin: null,
  lastDragFire: 0,
};

const styleLabel = (s) => (s === 'anime' ? '動畫浪漫風' : '可愛像素風');

/* ------------------------------------------------------------------ *
 * Layout. A single rAF-batched pass keeps the canvas, the background
 * transform and every anchored element in agreement.
 * ------------------------------------------------------------------ */
let layoutQueued = false;
let zeroSizeRetries = 0;

function requestLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  const run = () => {
    if (!layoutQueued) return;
    layoutQueued = false;
    layout();
  };
  // rAF batches against paint, but it is starved while the tab is hidden
  // or not compositing — and the very first layout must not depend on it.
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

function layout() {
  const rect = el.stageRoot.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w === 0 || h === 0) {
    // Stylesheet not applied yet, or the tab is hidden. Retry rather than
    // silently leaving the canvas at its 300x150 default forever.
    if (zeroSizeRetries++ < 40) setTimeout(requestLayout, 60);
    return;
  }
  zeroSizeRetries = 0;

  // Cap DPR: a 3x backing store on a large phone costs a lot of fill rate
  // for detail nobody can see in a particle system.
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  stage.resize(w, h);
  engine.resize(w, h, dpr);
  engine.setHorizon(stage.variant.horizon * (stage.rect.h / h) + stage.rect.y / h);
  nameTags.position();
  bubbles.position();
  drawDebug();
}

// ResizeObserver on the stage element rather than window `resize`: mobile
// browsers fire resize continuously while the URL bar slides, and the
// element (pinned with dvh) reports the size we actually draw into.
new ResizeObserver(requestLayout).observe(el.stageRoot);
// ResizeObserver delivery is part of the rendering step and is skipped
// while a tab isn't compositing; `resize` still fires. Both paths are
// idempotent, and engine.resize() ignores no-op sizes.
window.addEventListener('resize', requestLayout);
window.addEventListener('orientationchange', requestLayout);
window.addEventListener('load', requestLayout);
// Fireflies keep the render loop running indefinitely, so stop it outright
// while the tab is in the background rather than animating for nobody.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    engine.stop();
  } else {
    engine.start();
    requestLayout();
  }
});

/* ------------------------------------------------------------------ *
 * Parallax. The sky drifts a few pixels against the pointer (or device
 * tilt), which is enough to stop the scene reading as a flat photograph.
 * The offset is applied inside Stage, so anchored name tags move with it.
 * ------------------------------------------------------------------ */
const parallax = { tx: 0, ty: 0, x: 0, y: 0, active: false };

if (!reducedMotion) {
  // Fine pointers only: on touch the finger is busy firing fireworks.
  if (window.matchMedia('(pointer: fine)').matches) {
    window.addEventListener('pointermove', (e) => {
      parallax.tx = (e.clientX / window.innerWidth) * 2 - 1;
      parallax.ty = (e.clientY / window.innerHeight) * 2 - 1;
      parallax.active = true;
    }, { passive: true });
  }

  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || e.beta == null) return;
    parallax.tx = Math.max(-1, Math.min(1, e.gamma / 30));
    parallax.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
    parallax.active = true;
  }, { passive: true });

  const drift = () => {
    requestAnimationFrame(drift);
    if (!parallax.active) return;
    // Ease toward the target so the sky glides instead of snapping.
    parallax.x += (parallax.tx - parallax.x) * 0.06;
    parallax.y += (parallax.ty - parallax.y) * 0.06;
    // Invert: the background should lag behind the pointer, not chase it.
    stage.setParallax(-parallax.x, -parallax.y);
    nameTags.position();
    bubbles.position();
  };
  requestAnimationFrame(drift);
}

/* ------------------------------------------------------------------ *
 * Firing
 * ------------------------------------------------------------------ */

// Warm indices for the hamster, cool for the capybara, so you can tell at
// a glance which shells are your partner's.
const ROLE_COLORS = { hamster: [2, 7, 6, 0], capybara: [1, 5, 3, 4] };

function pickColor(role) {
  const set = ROLE_COLORS[role] || ROLE_COLORS.hamster;
  return Math.random() < 0.65
    ? set[Math.floor(Math.random() * set.length)]
    : Math.floor(Math.random() * PALETTES.anime.length);
}

function pickShape() {
  const r = Math.random();
  if (r < 0.34) return 'peony';
  if (r < 0.62) return 'chrysanthemum';
  if (r < 0.78) return 'willow';
  if (r < 0.92) return 'ring';
  return 'heart';
}

function fire(nx, ny, shape) {
  if (!state.joined) return;
  const color = pickColor(state.role);
  const chosen = shape || pickShape();

  // Keep the shell in the sky. Rather than silently clamping the click
  // (which felt broken), the shell launches from the ground and rises —
  // the constraint becomes the performance.
  const skyLimit = stage.variant.horizon * (stage.rect.h / stage.vh) + stage.rect.y / stage.vh;
  const y = Math.min(ny, Math.max(0.08, skyLimit - 0.12));

  engine.launch({ x: nx, y, color, shape: chosen, mine: true });
  sfx.launch();
  socket.emit('firework', { x: nx, y, color, shape: chosen });
}

el.canvas.addEventListener('pointerdown', (e) => {
  if (!state.joined) return;
  el.canvas.setPointerCapture(e.pointerId);
  const r = el.canvas.getBoundingClientRect();
  fire((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  state.lastDragFire = performance.now();
});

// Drag to paint a barrage, throttled to stay inside the server's budget.
el.canvas.addEventListener('pointermove', (e) => {
  if (!state.joined || e.buttons === 0) return;
  const now = performance.now();
  if (now - state.lastDragFire < 190) return;
  state.lastDragFire = now;
  const r = el.canvas.getBoundingClientRect();
  fire((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
});

el.heartBtn.addEventListener('click', () => {
  fire(0.5 + (Math.random() - 0.5) * 0.25, 0.22, 'heart');
});

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */
function applyStyle(style, announce) {
  state.style = style;
  stage.setStyle(style);
  engine.setStyle(style);
  bubbles.setPixel(style === 'pixel');
  document.body.classList.toggle('is-pixel', style === 'pixel');
  // Label the *destination*, so the button says what will happen.
  el.styleBtn.textContent = '切換為' + styleLabel(style === 'anime' ? 'pixel' : 'anime');
  requestLayout();
  if (announce) toast(el.toasts, announce);
}

el.styleBtn.addEventListener('click', () => {
  const next = state.style === 'anime' ? 'pixel' : 'anime';
  applyStyle(next);
  socket.emit('style_change', next);
});

el.soundBtn.addEventListener('click', () => {
  const on = sfx.toggle();
  el.soundBtn.textContent = on ? '🔊' : '🔇';
  el.soundBtn.classList.remove('nudge');
  el.soundBtn.setAttribute('aria-label', on ? '關閉音效' : '開啟音效');
  toast(el.toasts, on ? '音效已開啟 🔊' : '音效已靜音 🔇', 1800);
});

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */
document.querySelectorAll('[data-role]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-role]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.role = btn.dataset.role;
  });
});

document.querySelectorAll('[data-style]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-style]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.style = btn.dataset.style;
  });
});

/* ------------------------------------------------------------------ *
 * Room codes.
 *
 * The room code IS the password — there is nothing else guarding a room.
 * Two couples who both pick "0819" therefore land in the SAME room: one
 * partner gets locked out, and private messages reach a stranger. The fix
 * is to make the unguessable path the easy path, via a generated code and
 * a shareable invite link.
 * ------------------------------------------------------------------ */

// Ambiguous glyphs (0/O, 1/I/L) omitted so a spoken or retyped code
// cannot be misread. 31^6 ≈ 887 million combinations.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode(len = 6) {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function inviteUrl(code) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', code);
  return url.toString();
}

async function copyInvite(code) {
  const url = inviteUrl(code);
  try {
    await navigator.clipboard.writeText(url);
    toast(el.toasts, '邀請連結已複製，傳給另一半吧 💌');
  } catch {
    // clipboard needs a secure context; fall back to showing the link.
    toast(el.toasts, url, 8000);
  }
}

el.dice.addEventListener('click', () => {
  el.room.value = generateRoomCode();
  el.room.focus();
  el.room.select();
});

el.roomTag.addEventListener('click', () => {
  if (state.lastJoin) copyInvite(state.lastJoin.roomCode);
});

// A partner arriving via an invite link should not have to type anything.
const invited = new URLSearchParams(location.search).get('room');
if (invited) {
  el.room.value = invited.slice(0, 24);
  // setTimeout rather than rAF: rAF does not fire while the tab is hidden,
  // and the field would silently never receive focus.
  setTimeout(() => el.nickname.focus(), 0);
}

function showLoginError(msg) {
  el.loginError.textContent = msg;
  el.loginError.classList.add('visible');
  el.loginBox.classList.remove('shake');
  void el.loginBox.offsetWidth;
  el.loginBox.classList.add('shake');
}

function join() {
  const roomCode = el.room.value.trim();
  const nickname = el.nickname.value.trim();
  if (!roomCode) return showLoginError('請輸入房間密碼');
  if (!nickname) return showLoginError('請輸入你的暱稱');

  if (!socket.connected) {
    return showLoginError('還沒連上伺服器，請確認伺服器已啟動。');
  }

  el.join.disabled = true;
  state.lastJoin = { roomCode, nickname, role: state.role, style: state.style };

  // Never leave the button dead with no explanation: if the server does
  // not answer, say so instead of looking like a frozen page.
  let settled = false;
  const giveUp = setTimeout(() => {
    if (settled) return;
    settled = true;
    el.join.disabled = false;
    state.lastJoin = null;
    showLoginError('伺服器沒有回應，請重新啟動伺服器後再試。');
  }, 8000);

  socket.emit('join_room', state.lastJoin, (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(giveUp);
    el.join.disabled = false;

    // A server running an older build replies in a different shape
    // ({success:...}), which would otherwise fail this check with an
    // undefined message and strand the user on a silent login screen.
    if (!res || typeof res !== 'object' || !('ok' in res)) {
      state.lastJoin = null;
      return showLoginError('伺服器版本不符，請重新啟動伺服器（npm start）。');
    }
    if (!res.ok) {
      state.lastJoin = null;
      return showLoginError(res.message || '無法加入房間，請再試一次。');
    }

    state.joined = true;
    state.myId = res.you.id;
    state.role = res.you.role;
    state.users = new Map(res.users.map((u) => [u.id, u]));

    applyStyle(res.style);
    nameTags.sync([...state.users.values()], state.myId);

    el.login.classList.add('hidden');
    setTimeout(() => { el.login.style.display = 'none'; }, 500);
    el.chat.hidden = false;
    el.roomTag.hidden = false;
    el.roomTag.textContent = '房間 ' + roomCode + ' · 複製邀請 💌';
    el.roomTag.title = '點一下複製邀請連結';

    // The join click is a user gesture, so the audio context can be
    // created now — it just starts muted until they ask for sound.
    sfx.setEnabled(false);
    el.soundBtn.classList.add('nudge');

    if (res.roleReassigned) {
      // Reflect it in the picker too, so the change is visible rather
      // than just asserted in a message.
      document.querySelectorAll('[data-role]').forEach((b) => {
        b.classList.toggle('active', b.dataset.role === res.you.role);
      });
      toast(el.toasts, '這個角色被搶走了，你成為' + ROLE_LABEL[res.you.role], 4000);
    }
    toast(el.toasts, '進入星空了 ✨ 點畫面放煙火');
    // Alone in the room: nudge toward the invite link rather than leaving
    // them to dictate a room code over the phone.
    if (state.users.size === 1) {
      setTimeout(() => toast(el.toasts, '左上角可複製邀請連結，傳給另一半 💌', 5000), 3400);
    }
    stage.preloadAlternate();
  });
}

el.join.addEventListener('click', join);
[el.room, el.nickname].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) join();
  });
});

bindChatInput(el.chatInput, (text) => {
  socket.emit('chat', text);
});

/* ------------------------------------------------------------------ *
 * Socket events
 * ------------------------------------------------------------------ */
socket.on('firework', (d) => {
  const from = state.users.get(d.by);
  engine.launch({ x: d.x, y: d.y, color: d.color, shape: d.shape, mine: false });
  sfx.launch();
  if (from) nameTags.pulse(from.role);
});

socket.on('ambient', (d) => {
  engine.burst(d.x, d.y, d.color, d.shape, 0.72, false);
});

socket.on('user_joined', (user) => {
  state.users.set(user.id, user);
  nameTags.sync([...state.users.values()], state.myId);
  toast(el.toasts, user.nickname + ' 來了！💕');
});

socket.on('user_left', (id) => {
  const user = state.users.get(id);
  if (!user) return;
  state.users.delete(id);
  nameTags.sync([...state.users.values()], state.myId);
  toast(el.toasts, user.nickname + ' 離開了…');
});

socket.on('style_change', (style) => {
  applyStyle(style, '另一半切換成' + styleLabel(style) + '了');
});

socket.on('chat', (d) => {
  const user = state.users.get(d.by);
  if (!user) return;
  bubbles.show(user.role, d.text, state.style === 'pixel');
});

socket.on('disconnect', () => {
  if (state.joined) toast(el.toasts, '連線中斷，正在重新連線…', 5000);
});

// Socket.IO reconnects on its own, but the server issues a brand new
// socket.id — without rejoining, names and bubbles silently stop working.
socket.on('connect', () => {
  if (!state.joined || !state.lastJoin) return;
  socket.emit('join_room', state.lastJoin, (res) => {
    if (!res.ok) {
      toast(el.toasts, '重新連線失敗：' + res.message, 6000);
      return;
    }
    state.myId = res.you.id;
    state.role = res.you.role;
    state.users = new Map(res.users.map((u) => [u.id, u]));
    applyStyle(res.style);
    nameTags.sync([...state.users.values()], state.myId);
    toast(el.toasts, '已重新連線 ✨');
  });
});

/* ------------------------------------------------------------------ *
 * Anchor calibration overlay — open with ?debug=1
 *
 * The anchor values were measured by eye off the artwork. This overlay
 * draws a crosshair at each one so a 1% error is visible and fixable in
 * seconds instead of being argued about.
 * ------------------------------------------------------------------ */
const DEBUG = new URLSearchParams(location.search).has('debug');
let debugCanvas = null;

function drawDebug() {
  if (!DEBUG) return;
  if (!debugCanvas) {
    debugCanvas = document.createElement('canvas');
    debugCanvas.id = 'debug-canvas';
    el.stageRoot.appendChild(debugCanvas);
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  debugCanvas.width = stage.vw * dpr;
  debugCanvas.height = stage.vh * dpr;
  debugCanvas.style.width = stage.vw + 'px';
  debugCanvas.style.height = stage.vh + 'px';

  const g = debugCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, stage.vw, stage.vh);
  g.font = '12px monospace';

  for (const role of ['hamster', 'capybara']) {
    const p = stage.anchorOf(role);
    g.strokeStyle = role === 'hamster' ? '#ffd166' : '#ff9ec7';
    g.fillStyle = g.strokeStyle;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(p.x - 24, p.y); g.lineTo(p.x + 24, p.y);
    g.moveTo(p.x, p.y - 24); g.lineTo(p.x, p.y + 24);
    g.stroke();
    g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.stroke();
    const a = stage.variant.anchors[role];
    g.fillText(role + ' ' + a.x.toFixed(3) + ',' + a.y.toFixed(3), p.x + 12, p.y - 12);
  }

  const hy = stage.horizonY();
  g.strokeStyle = 'rgba(0,255,255,.6)';
  g.setLineDash([6, 6]);
  g.beginPath(); g.moveTo(0, hy); g.lineTo(stage.vw, hy); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(0,255,255,.9)';
  g.fillText('horizon ' + stage.variant.horizon.toFixed(3), 8, hy - 6);
}

if (DEBUG) {
  window.__fw = { engine, stage, state, socket, nameTags, bubbles };

  // Nudge the focused anchor with the arrow keys and print the result.
  let target = 'hamster';
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); target = target === 'hamster' ? 'capybara' : 'hamster'; }
    const a = stage.variant.anchors[target];
    const step = e.shiftKey ? 0.01 : 0.002;
    if (e.key === 'ArrowLeft') a.x -= step;
    else if (e.key === 'ArrowRight') a.x += step;
    else if (e.key === 'ArrowUp') a.y -= step;
    else if (e.key === 'ArrowDown') a.y += step;
    else if (e.key !== 'Tab') return;
    e.preventDefault();
    nameTags.position();
    bubbles.position();
    drawDebug();
    console.log(JSON.stringify({ style: stage.style, variant: stage.variant.src, anchors: stage.variant.anchors }, null, 2));
  });
  console.info('[debug] Tab 切換角色，方向鍵微調錨點，Shift 加速。數值會印在這裡。');
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
// layout() drives the first stage.resize(), which picks the variant for
// this viewport and assigns the initial background src.
layout();
el.styleBtn.textContent = '切換為' + styleLabel('pixel');
engine.start();
