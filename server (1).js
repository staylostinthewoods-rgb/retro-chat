// Eyeliner & Mortgages: retro chatroom server.
// Zero dependencies. Needs Node 18+.  Run:  node server.js
//
// Env vars:
//   PORT             port to listen on (default 3000)
//   ADMIN_KEY        enables /op <key> so you can moderate (kick, mute)
//   ALLOWED_ORIGINS  comma-separated list of sites allowed to embed the chat,
//                    e.g. https://example.com,https://www.example.com
//                    (empty = allow any origin)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const MAX_TEXT = 300;
const HISTORY_LEN = 30;
const MAX_CUSTOM_ROOMS = 20;
const MAX_CLIENTS = 500;

const DEFAULT_ROOMS = [
  '#the-lounge',
  '#livejournal-refugees',
  '#hot-topic-survivors',
  '#myspace-top-8',
  '#eyeliner-and-mortgages',
  '#gig-memories-2004',
  '#over-30-night-owls',
];

// Optional word filter. Add words you want starred out.
const BANNED_WORDS = [];

// ---------- static files (whitelist, so no path tricks) ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const entry = FILES[url];
  if (!entry) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

// ---------- minimal WebSocket (text frames only) ----------
server.on('upgrade', (req, socket) => {
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (req.url.split('?')[0] !== '/ws' || upgrade !== 'websocket') return socket.destroy();
  if (ALLOWED.length && !ALLOWED.includes(req.headers.origin)) return socket.destroy();
  if (clients.size >= MAX_CLIENTS) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  newClient(socket);
});

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
    let len = b[1] & 127, off = 2;
    if (!masked) return c.socket.destroy();
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) return c.socket.destroy();
    if (len > 4096) return c.socket.destroy();
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (!fin || op === 0) return c.socket.destroy(); // fragmented messages not supported
    if (op === 8) { c.socket.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { c.socket.write(frame(10, data)); continue; }
    if (op === 1) handle(c, data.toString('utf8'));
  }
}

function send(c, obj) {
  if (!c.socket.destroyed && c.socket.writable) c.socket.write(frame(1, Buffer.from(JSON.stringify(obj))));
}

// ---------- chat state ----------
const clients = new Set();
const history = new Map(); // room -> last messages

const PALETTE = ['#800000', '#000080', '#006400', '#800080', '#008080', '#808000',
  '#b22222', '#4b0082', '#8b4513', '#2f4f4f', '#c71585', '#0000cd'];

function colorFor(nick) {
  let h = 0;
  for (const ch of nick.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function cleanText(s) {
  s = String(s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, MAX_TEXT);
  for (const w of BANNED_WORDS) {
    s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => '*'.repeat(m.length));
  }
  return s;
}

const NICK_RE = /^[A-Za-z0-9_\-\[\]^.]{2,16}$/;
const ROOM_RE = /^#[a-z0-9-]{2,24}$/;

function byNick(nick) {
  nick = nick.toLowerCase();
  for (const c of clients) if (c.nick && c.nick.toLowerCase() === nick) return c;
  return null;
}

function inRoom(room) { return [...clients].filter(c => c.nick && c.room === room); }

function broadcast(room, obj) { for (const c of inRoom(room)) send(c, obj); }

function sendUsers(room) {
  const users = inRoom(room).map(c => ({ nick: c.nick, color: c.color, op: c.op }))
    .sort((a, b) => a.nick.toLowerCase().localeCompare(b.nick.toLowerCase()));
  broadcast(room, { t: 'users', users });
}

function roomList() {
  const counts = new Map(DEFAULT_ROOMS.map(r => [r, 0]));
  for (const c of clients) if (c.nick && c.room) counts.set(c.room, (counts.get(c.room) || 0) + 1);
  return [...counts].filter(([r, n]) => DEFAULT_ROOMS.includes(r) || n > 0).map(([name, count]) => ({ name, count }));
}

function sendRooms() {
  const rooms = roomList();
  for (const c of clients) if (c.nick) send(c, { t: 'rooms', rooms });
}

function sys(room, text) { broadcast(room, { t: 'sys', text }); }

function remember(room, obj) {
  const h = history.get(room) || [];
  h.push(obj);
  if (h.length > HISTORY_LEN) h.shift();
  history.set(room, h);
}

function joinRoom(c, room) {
  if (c.room === room) return;
  const old = c.room;
  if (old) { c.room = null; sys(old, `*** ${c.nick} has left the room`); sendUsers(old); }
  c.room = room;
  send(c, { t: 'joined', room });
  for (const m of history.get(room) || []) send(c, m);
  sys(room, `*** ${c.nick} has entered the room`);
  sendUsers(room);
  sendRooms();
}

function newClient(socket) {
  const c = { socket, nick: null, room: null, color: '#000', op: false, muted: false, times: [], buf: Buffer.alloc(0) };
  clients.add(c);
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 16384) return socket.destroy();
    parse(c);
  });
  socket.on('close', () => drop(c));
  socket.on('error', () => socket.destroy());
}

function drop(c) {
  if (!clients.delete(c)) return;
  if (c.nick && c.room) { sys(c.room, `*** ${c.nick} has left the chat`); sendUsers(c.room); sendRooms(); }
}

function flooded(c) {
  const now = Date.now();
  c.times = c.times.filter(t => now - t < 5000);
  c.times.push(now);
  return c.times.length > 6;
}

function handle(c, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;

  if (m.t === 'login') {
    if (c.nick) return;
    const nick = String(m.nick || '').trim();
    if (m.adult !== true) return send(c, { t: 'login_error', text: 'You must confirm you are 18 or over.' });
    if (!NICK_RE.test(nick)) return send(c, { t: 'login_error', text: 'Nickname must be 2-16 characters: letters, numbers, _ - . [ ] ^' });
    if (byNick(nick)) return send(c, { t: 'login_error', text: 'That nickname is taken. Try another.' });
    c.nick = nick;
    c.color = colorFor(nick);
    send(c, { t: 'login_ok', nick });
    send(c, { t: 'sys', text: '*** Welcome to Eyeliner & Mortgages. Type /help for commands.' });
    joinRoom(c, DEFAULT_ROOMS[0]);
    return;
  }

  if (!c.nick || m.t !== 'say') return;
  if (flooded(c)) return send(c, { t: 'err', text: '*** Slow down, you are sending too fast.' });
  const text = cleanText(m.text || '');
  if (!text) return;
  if (text[0] === '/') return command(c, text);
  if (c.muted) return send(c, { t: 'err', text: '*** You have been muted by a moderator.' });
  const msg = { t: 'msg', nick: c.nick, color: c.color, text };
  remember(c.room, msg);
  broadcast(c.room, msg);
}

function command(c, text) {
  const [cmd, ...rest] = text.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const err = t => send(c, { t: 'err', text: '*** ' + t });
  const info = t => send(c, { t: 'sys', text: t });

  switch (cmd.toLowerCase()) {
    case 'help':
      ['*** Commands:',
        '/me <action>          do something',
        '/msg <nick> <text>    private message',
        '/join <#room>         change or create a room',
        '/rooms                list rooms',
        '/who                  list people in this room',
        '/nick <newname>       change nickname',
        '/clear                clear your screen',
        '/op <key>             moderator login'].forEach(info);
      break;
    case 'me': {
      if (c.muted) return err('You have been muted by a moderator.');
      if (!arg) return err('Usage: /me <action>');
      const msg = { t: 'action', nick: c.nick, color: c.color, text: arg };
      remember(c.room, msg); broadcast(c.room, msg);
      break;
    }
    case 'msg': case 'pm': case 'w': {
      const to = rest[0]; const body = rest.slice(1).join(' ').trim();
      if (!to || !body) return err('Usage: /msg <nick> <text>');
      const target = byNick(to);
      if (!target) return err(`${to} is not online.`);
      const pm = { t: 'pm', from: c.nick, to: target.nick, color: c.color, text: body };
      send(target, pm); if (target !== c) send(c, pm);
      break;
    }
    case 'join': {
      let room = arg.toLowerCase().replace(/\s+/g, '-');
      if (room && room[0] !== '#') room = '#' + room;
      if (!ROOM_RE.test(room)) return err('Room names look like #my-room (2-24 letters, numbers or dashes).');
      const exists = roomList().some(r => r.name === room);
      if (!exists && roomList().length >= DEFAULT_ROOMS.length + MAX_CUSTOM_ROOMS) return err('Too many rooms right now.');
      joinRoom(c, room);
      break;
    }
    case 'rooms': case 'list':
      info('*** Rooms: ' + roomList().map(r => `${r.name} (${r.count})`).join(', '));
      break;
    case 'who':
      info(`*** In ${c.room}: ` + inRoom(c.room).map(u => (u.op ? '@' : '') + u.nick).join(', '));
      break;
    case 'nick': {
      if (!NICK_RE.test(arg)) return err('Nickname must be 2-16 characters: letters, numbers, _ - . [ ] ^');
      const other = byNick(arg);
      if (other && other !== c) return err('That nickname is taken.');
      const old = c.nick; c.nick = arg; c.color = colorFor(arg);
      send(c, { t: 'login_ok', nick: arg });
      sys(c.room, `*** ${old} is now known as ${arg}`);
      sendUsers(c.room);
      break;
    }
    case 'clear':
      send(c, { t: 'clear' });
      break;
    case 'op': {
      if (!ADMIN_KEY) return err('Moderator login is not enabled.');
      const a = Buffer.from(arg), b = Buffer.from(ADMIN_KEY);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err('Wrong key.');
      c.op = true;
      sys(c.room, `*** ${c.nick} is now a moderator`);
      sendUsers(c.room);
      info('*** Moderator commands: /kick <nick>, /mute <nick>, /unmute <nick>');
      break;
    }
    case 'kick': case 'mute': case 'unmute': {
      if (!c.op) return err('Moderators only.');
      const target = byNick(arg);
      if (!target) return err(`${arg} is not online.`);
      if (target.op) return err('You cannot do that to another moderator.');
      if (cmd === 'kick') {
        send(target, { t: 'kicked' });
        sys(target.room, `*** ${target.nick} was kicked by ${c.nick}`);
        target.socket.end(frame(8, Buffer.alloc(0)));
      } else {
        target.muted = cmd === 'mute';
        sys(target.room, `*** ${target.nick} was ${target.muted ? 'muted' : 'unmuted'} by ${c.nick}`);
      }
      break;
    }
    default:
      err(`Unknown command /${cmd}. Type /help.`);
  }
}

server.listen(PORT, () => console.log(`Chat running on http://localhost:${PORT}`));
