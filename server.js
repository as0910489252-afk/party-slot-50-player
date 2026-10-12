'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { randomUUID, randomBytes } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const TEAM_COUNT = 10;
const TEAM_SIZE = 5;
const SPINS_PER_PLAYER = 3;
const rooms = new Map();

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
// Serve real files from /public. Do not use an HTML catch-all for missing .js/.css files:
// that causes the browser's strict MIME type errors seen in the previous deployment.
app.use(express.static(path.join(__dirname, 'public'), { index: false, fallthrough: true }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/qr', async (req, res) => {
  const value = String(req.query.text || '');
  if (!value || value.length > 1500) return res.status(400).json({ error: 'Missing or overly long QR text' });
  try {
    const png = await QRCode.toBuffer(value, { type: 'png', width: 280, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (_e) { res.status(500).json({ error: 'Could not create QR code' }); }
});
app.use((req, res) => {
  if (/\.(js|css|ico|png|svg|woff2?)$/i.test(req.path)) return res.status(404).type('text/plain').send('Asset not found');
  return res.status(404).type('text/plain').send('Not found');
});

function newRoomCode() {
  let code;
  do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function cleanName(value) {
  return String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 20);
}
function teamNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= TEAM_COUNT ? n : 0;
}
function roomSummary(room) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, team: p.team, score: p.score, spins: p.spins,
    online: p.online, remaining: SPINS_PER_PLAYER - p.spins
  }));
  const teams = Array.from({ length: TEAM_COUNT }, (_, idx) => {
    const number = idx + 1;
    const members = players.filter(p => p.team === number);
    return { number, score: members.reduce((sum, p) => sum + p.score, 0), count: members.length, online: members.filter(p => p.online).length, members };
  });
  return { code: room.code, hostId: room.hostId, players, teams, playerCount: players.length,
    maxPlayers: MAX_PLAYERS, teamSize: TEAM_SIZE, spinsPerPlayer: SPINS_PER_PLAYER,
    started: room.started, finished: players.length > 0 && players.every(p => p.spins >= SPINS_PER_PLAYER), createdAt: room.createdAt };
}
function publish(room) { io.to(room.code).emit('room-state', roomSummary(room)); }
function sendError(socket, message) { socket.emit('game-error', { message }); }
function enterRoom(socket, room, player) {
  player.socketId = socket.id;
  player.online = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  socket.emit('joined-room', { playerId: player.id, room: roomSummary(room) });
  publish(room);
}
function validateRoomInputs(payload) {
  const name = cleanName(payload && payload.name);
  const team = teamNumber(payload && payload.team);
  if (!name) return { error: '請先輸入玩家暱稱（最多 20 字）。' };
  if (!team) return { error: '請選擇第 1 組至第 10 組。' };
  return { name, team };
}
function addPlayer(room, name, team) {
  if (room.players.size >= MAX_PLAYERS) return { error: '房間已滿，最多 50 人。' };
  const count = [...room.players.values()].filter(p => p.team === team).length;
  if (count >= TEAM_SIZE) return { error: `第 ${team} 組已滿（每組最多 5 人），請選擇其他組別。` };
  const player = { id: randomUUID(), name, team, score: 0, spins: 0, online: false, socketId: null, history: [] };
  room.players.set(player.id, player);
  return { player };
}
function getPlayer(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return { error: '找不到房間，請重新建立或加入。' };
  const player = room.players.get(socket.data.playerId);
  if (!player) return { error: '找不到玩家資料，請重新加入房間。' };
  return { room, player };
}

io.on('connection', socket => {
  socket.emit('server-ready', { ok: true });

  socket.on('create-room', (payload = {}) => {
    const input = validateRoomInputs(payload);
    if (input.error) return sendError(socket, input.error);
    const code = newRoomCode();
    const room = { code, hostId: null, players: new Map(), started: false, createdAt: Date.now() };
    rooms.set(code, room);
    const added = addPlayer(room, input.name, input.team);
    if (added.error) { rooms.delete(code); return sendError(socket, added.error); }
    room.hostId = added.player.id;
    enterRoom(socket, room, added.player);
  });

  socket.on('join-room', (payload = {}) => {
    const input = validateRoomInputs(payload);
    if (input.error) return sendError(socket, input.error);
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendError(socket, '找不到這個房間碼，請確認後再試一次。');
    const added = addPlayer(room, input.name, input.team);
    if (added.error) return sendError(socket, added.error);
    enterRoom(socket, room, added.player);
  });

  socket.on('rejoin-room', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '');
    const room = rooms.get(code);
    const player = room && room.players.get(playerId);
    if (!room || !player) return sendError(socket, '無法恢復原本的玩家資料，請重新加入房間。');
    const oldSocketId = player.socketId;
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) oldSocket.leave(code);
    }
    enterRoom(socket, room, player);
  });

  socket.on('start-game', () => {
    const found = getPlayer(socket); if (found.error) return sendError(socket, found.error);
    if (found.room.hostId !== found.player.id) return sendError(socket, '只有建立房間的主持人可以開始遊戲。');
    found.room.started = true; publish(found.room);
  });

  socket.on('spin', () => {
    const found = getPlayer(socket); if (found.error) return sendError(socket, found.error);
    const { room, player } = found;
    if (!room.started) return sendError(socket, '請先由主持人開始遊戲。');
    if (player.spins >= SPINS_PER_PLAYER) return sendError(socket, '你的 3 次拉霸已經用完。');
    const symbols = ['🍒', '🍋', '🔔', '🍀', '⭐', '7️⃣'];
    const result = Array.from({ length: 3 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
    let points = 0;
    if (result[0] === result[1] && result[1] === result[2]) points = result[0] === '7️⃣' ? 100 : 50;
    else if (result[0] === result[1] || result[0] === result[2] || result[1] === result[2]) points = 10;
    player.spins += 1; player.score += points;
    player.history.push({ result, points, spin: player.spins, at: Date.now() });
    socket.emit('spin-result', { result, points, spin: player.spins, score: player.score, remaining: SPINS_PER_PLAYER - player.spins });
    publish(room);
  });

  socket.on('reset-room', () => {
    const found = getPlayer(socket); if (found.error) return sendError(socket, found.error);
    if (found.room.hostId !== found.player.id) return sendError(socket, '只有主持人可以重設遊戲。');
    for (const p of found.room.players.values()) { p.score = 0; p.spins = 0; p.history = []; }
    found.room.started = false; publish(found.room);
    io.to(found.room.code).emit('notice', { message: '主持人已重設本局，所有玩家的 3 次拉霸已恢復。' });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && room.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.online = false; player.socketId = null; publish(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Party Slot server listening on ${PORT}`));
