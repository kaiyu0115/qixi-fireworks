'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 * Build id — automatic cache busting.
 * index.html carries __BUILD__ placeholders; we substitute a hash of the
 * client bundle at boot, so a deploy always invalidates css/js while the
 * large art assets stay cached forever.
 * ------------------------------------------------------------------ */
function computeBuildId() {
  const hash = crypto.createHash('sha1');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'assets') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(entry.name).update(fs.readFileSync(full));
    }
  };
  walk(PUBLIC_DIR);
  return hash.digest('hex').slice(0, 10);
}

const BUILD_ID = computeBuildId();
const INDEX_HTML = fs
  .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/__BUILD__/g, BUILD_ID);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8 * 1024,
  // Defaults (25s/20s) leave a dropped user holding their slot for up to
  // 45 seconds. If someone shuts a laptop lid mid-date, their partner
  // cannot rejoin until the ghost expires — so detect it sooner.
  pingInterval: 10000,
  pingTimeout: 8000,
});

app.disable('x-powered-by');

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
});

// Art assets are large and never change under a given filename -> cache
// them forever. Code is small and revalidates instead: a `?v=` query on
// the entry module does NOT propagate to its ES import specifiers, so
// immutable caching there would happily serve a stale scene.js next to a
// fresh main.js. Revalidation costs a 304 and removes the whole class of
// "I cleared my cache and still see the old version" bug.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    const isAsset = filePath.includes(path.sep + 'assets' + path.sep);
    res.set('Cache-Control', isAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
  },
}));

/* ------------------------------------------------------------------ *
 * Protocol vocabulary. Clients send enum names and palette indices,
 * never raw strings that we would hand straight to the renderer.
 * ------------------------------------------------------------------ */
const STYLES = ['anime', 'pixel'];
const ROLES = ['hamster', 'capybara'];
const SHAPES = ['peony', 'willow', 'ring', 'chrysanthemum', 'heart'];
const PALETTE_SIZE = 8;

const LIMITS = {
  ROOM_CODE: 24,
  NICKNAME: 16,
  CHAT: 80,
  ROOMS: 500,
  USERS_PER_ROOM: 2,
};

const ROOM_CODE_RE = /^[\w\u4e00-\u9fff-]{1,24}$/;

// Namespaced so a client can never address another client's private
// socket.id room by choosing it as a room code.
const roomKey = (code) => 'r:' + code;

/** roomCode -> { users: Map<socketId, User>, style } */
const rooms = new Map();

/* ------------------------------------------------------------------ *
 * Token-bucket rate limiting. A "last timestamp" check still lets a
 * client burst; a bucket bounds sustained rate *and* burst size.
 * ------------------------------------------------------------------ */
class Bucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refill = refillPerSec;
    this.last = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refill);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

const sanitizeText = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

const pickEnum = (value, list, fallback) => (list.includes(value) ? value : fallback);

io.on('connection', (socket) => {
  const limits = {
    firework: new Bucket(20, 10),
    chat: new Bucket(5, 1.5),
    style: new Bucket(4, 0.5),
  };

  socket.on('join_room', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (socket.data.roomCode) {
      return callback({ ok: false, error: 'ALREADY_JOINED', message: '你已經在房間裡了。' });
    }

    const payload = data && typeof data === 'object' ? data : {};
    // Room codes are validated at full length, not truncated: silently
    // cutting a long code to 24 chars would drop two people who typed
    // different codes into the same room.
    const roomCode = sanitizeText(payload.roomCode, 200);
    const nickname = sanitizeText(payload.nickname, LIMITS.NICKNAME);

    if (!ROOM_CODE_RE.test(roomCode)) {
      return callback({
        ok: false,
        error: 'BAD_ROOM',
        message: '房間密碼只能用中英文、數字或 - _，最多 24 字。',
      });
    }
    if (!nickname) {
      return callback({ ok: false, error: 'BAD_NICKNAME', message: '請輸入暱稱喔！' });
    }

    let room = rooms.get(roomCode);
    if (!room) {
      if (rooms.size >= LIMITS.ROOMS) {
        return callback({ ok: false, error: 'BUSY', message: '伺服器房間已滿，請稍後再試。' });
      }
      room = { users: new Map(), style: pickEnum(payload.style, STYLES, 'anime') };
      rooms.set(roomCode, room);
    }

    // Drop slots held by sockets that are already gone. On a network flap
    // the client reconnects with a new socket.id well before the old one
    // hits its ping timeout — without this, rejoining your own two-person
    // room fails with FULL and the user is locked out of their own date.
    for (const id of [...room.users.keys()]) {
      if (!io.sockets.sockets.has(id)) room.users.delete(id);
    }

    if (room.users.size >= LIMITS.USERS_PER_ROOM) {
      return callback({
        ok: false,
        error: 'FULL',
        message: '這個房號已經有兩個人了 —— 可能被別人先用走了。換一個專屬房號吧！',
      });
    }

    const wanted = pickEnum(payload.role, ROLES, 'hamster');
    const taken = new Set([...room.users.values()].map((u) => u.role));
    const role = taken.has(wanted) ? ROLES.find((r) => !taken.has(r)) : wanted;

    const user = { id: socket.id, nickname, role };
    room.users.set(socket.id, user);
    socket.join(roomKey(roomCode));
    socket.data.roomCode = roomCode;

    callback({
      ok: true,
      you: user,
      roleReassigned: role !== wanted,
      users: [...room.users.values()],
      style: room.style,
    });

    socket.to(roomKey(roomCode)).emit('user_joined', user);
  });

  socket.on('firework', (data) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !limits.firework.take()) return;
    const p = data && typeof data === 'object' ? data : {};
    socket.to(roomKey(roomCode)).emit('firework', {
      by: socket.id,
      x: clamp01(p.x),
      y: clamp01(p.y),
      color: Number.isInteger(p.color) ? ((p.color % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE : 0,
      shape: pickEnum(p.shape, SHAPES, 'peony'),
    });
  });

  socket.on('style_change', (style) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !limits.style.take()) return;
    room.style = pickEnum(style, STYLES, room.style);
    socket.to(roomKey(roomCode)).emit('style_change', room.style);
  });

  socket.on('chat', (msg) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !limits.chat.take()) return;
    const text = sanitizeText(msg, LIMITS.CHAT);
    if (!text) return;
    io.to(roomKey(roomCode)).emit('chat', { by: socket.id, text });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.users.delete(socket.id);
    io.to(roomKey(roomCode)).emit('user_left', socket.id);
    if (room.users.size === 0) rooms.delete(roomCode);
  });
});

/* ------------------------------------------------------------------ *
 * Ambient fireworks. Only does work while a room is occupied, and skips
 * beats at random so the cadence never feels mechanical.
 * ------------------------------------------------------------------ */
setInterval(() => {
  if (rooms.size === 0) return;
  for (const [code, room] of rooms) {
    if (room.users.size === 0) continue;
    if (Math.random() < 0.25) continue;
    io.to(roomKey(code)).emit('ambient', {
      x: 0.12 + Math.random() * 0.76,
      y: 0.1 + Math.random() * 0.32,
      color: Math.floor(Math.random() * PALETTE_SIZE),
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
    });
  }
}, 2600);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('build ' + BUILD_ID + ' — listening on http://localhost:' + PORT);
});
