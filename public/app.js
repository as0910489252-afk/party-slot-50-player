'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  const symbolsFallback = ['❔', '❔', '❔'];
  let currentRoom = null;
  let currentPlayerId = localStorage.getItem('partySlotPlayerId') || '';
  let currentRoomCode = localStorage.getItem('partySlotRoomCode') || '';
  let me = null;
  let toastTimer;
  const setConnection = (text, status) => { $('connectionText').textContent = text; $('connectionDot').className = `dot ${status || ''}`; };
  function toast(message, error = false) {
    const el = $('toast'); el.textContent = message; el.classList.remove('hidden', 'error'); if (error) el.classList.add('error');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  }
  function setBusy(busy) { $('createBtn').disabled = busy; $('joinBtn').disabled = busy; }
  function validInputs() {
    const name = $('playerName').value.trim();
    const team = Number($('teamSelect').value);
    if (!name) { toast('請先輸入玩家暱稱。', true); $('playerName').focus(); return null; }
    if (!Number.isInteger(team) || team < 1 || team > 10) { toast('請選擇組別。', true); return null; }
    return { name, team };
  }
  function showGame(room) {
    $('entryPanel').classList.add('hidden'); $('gamePanel').classList.remove('hidden');
    $('roomCode').textContent = room.code;
    const url = new URL(location.href); url.searchParams.set('room', room.code); url.hash = '';
    $('roomLink').textContent = url.toString();
    $('qrImage').src = `/api/qr?text=${encodeURIComponent(url.toString())}`;
    $('myName').textContent = me ? me.name : '—'; $('myTeam').textContent = me ? `第 ${me.team} 組` : '—';
    const isHost = me && room.hostId === me.id;
    $('startBtn').classList.toggle('hidden', !isHost || room.started);
    $('resetBtn').classList.toggle('hidden', !isHost);
    renderRoom(room);
  }
  function renderRoom(room) {
    currentRoom = room;
    if (me) {
      const self = room.players.find(p => p.id === me.id);
      if (self) {
        me = { ...me, ...self };
        $('myName').textContent = self.name; $('myTeam').textContent = `第 ${self.team} 組`;
        $('remainingCount').textContent = `${self.remaining} 次`;
        $('spinBtn').disabled = !room.started || self.remaining <= 0;
        if (!room.started) $('spinMessage').textContent = '等待主持人開始遊戲';
        else if (self.remaining <= 0) $('spinMessage').textContent = '你的 3 次拉霸已用完';
        else $('spinMessage').textContent = `還可以拉霸 ${self.remaining} 次`;
      }
    }
    $('playerCount').textContent = `目前 ${room.playerCount} / ${room.maxPlayers} 人｜每組最多 ${room.teamSize} 人`;
    const sorted = [...room.teams].sort((a,b) => b.score - a.score || a.number - b.number);
    $('teamBoard').replaceChildren();
    sorted.forEach((team, index) => {
      const card = document.createElement('div'); card.className = `team-card ${index === 0 && team.count ? 'top' : ''}`;
      const head = document.createElement('div'); head.className = 'team-card-head';
      const title = document.createElement('span'); title.textContent = `${index === 0 && team.count ? '👑 ' : ''}第 ${team.number} 組`;
      const occupancy = document.createElement('span'); occupancy.textContent = `${team.count}/5`;
      head.append(title, occupancy);
      const score = document.createElement('div'); score.className = 'team-score'; score.textContent = `${team.score} 分`;
      const meta = document.createElement('div'); meta.className = 'team-meta'; meta.textContent = `在線 ${team.online} 人`;
      card.append(head, score, meta); $('teamBoard').append(card);
    });
    $('playerList').replaceChildren();
    const players = [...room.players].sort((a,b) => a.team - b.team || a.name.localeCompare(b.name, 'zh-Hant'));
    if (!players.length) { $('playerList').textContent = '尚無玩家'; }
    players.forEach(p => {
      const row = document.createElement('div'); row.className = 'player-row';
      const left = document.createElement('div'); const name = document.createElement('div'); name.className = 'player-name'; name.textContent = `${p.name}${p.id === room.hostId ? ' 👑' : ''}`;
      const sub = document.createElement('div'); sub.className = 'player-sub'; sub.textContent = `第 ${p.team} 組・已拉 ${p.spins}/3 次・`;
      const online = document.createElement('span'); online.className = p.online ? 'online' : 'offline'; online.textContent = p.online ? '在線' : '離線'; sub.append(online); left.append(name, sub);
      const score = document.createElement('div'); score.className = 'player-score'; score.textContent = `${p.score} 分`; row.append(left, score); $('playerList').append(row);
    });
    $('startBtn').classList.toggle('hidden', !(me && room.hostId === me.id) || room.started);
    $('resetBtn').classList.toggle('hidden', !(me && room.hostId === me.id));
    if (room.finished) { $('spinMessage').textContent = '本局所有玩家已完成 3 次拉霸！'; $('spinBtn').disabled = true; }
  }
  function clearSession() { currentRoom = null; currentPlayerId = ''; currentRoomCode = ''; me = null; localStorage.removeItem('partySlotPlayerId'); localStorage.removeItem('partySlotRoomCode'); }
  function joinAction(eventName) {
    if (!socket.connected) { toast('尚未連上遊戲伺服器，請稍候再試。', true); return; }
    const inputs = validInputs(); if (!inputs) return;
    const payload = { ...inputs };
    if (eventName === 'join-room') payload.code = $('roomCodeInput').value.trim().toUpperCase();
    if (eventName === 'join-room' && !payload.code) { toast('請輸入 6 碼房間碼。', true); return; }
    setBusy(true); socket.emit(eventName, payload); setTimeout(() => { if (!$('gamePanel').classList.contains('hidden')) return; setBusy(false); }, 8000);
  }
  $('createBtn').addEventListener('click', () => joinAction('create-room'));
  $('joinBtn').addEventListener('click', () => joinAction('join-room'));
  $('roomCodeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0,6); });
  $('spinBtn').addEventListener('click', () => { if (!socket.connected) return toast('連線已中斷，請稍候。', true); $('spinBtn').disabled = true; socket.emit('spin'); setTimeout(() => { if (currentRoom && me) { const self = currentRoom.players.find(p => p.id === me.id); if (self && self.remaining > 0 && currentRoom.started) $('spinBtn').disabled = false; } }, 8000); });
  $('startBtn').addEventListener('click', () => socket.emit('start-game'));
  $('resetBtn').addEventListener('click', () => { if (confirm('確定重設所有玩家的分數與拉霸次數？')) socket.emit('reset-room'); });
  $('copyLinkBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('roomLink').textContent); toast('已複製加入連結！'); } catch (_e) { toast('請長按加入連結並手動複製。'); } });
  $('leaveBtn').addEventListener('click', () => { if (confirm('離開後仍會保留你的玩家席位；要回到首頁嗎？')) { socket.disconnect(); clearSession(); location.href = location.pathname; } });
  socket.on('connect', () => {
    setConnection('已連線', 'ok');
    const urlRoom = new URLSearchParams(location.search).get('room');
    const code = urlRoom || currentRoomCode;
    if (urlRoom) $('roomCodeInput').value = urlRoom.toUpperCase();
    if (code && currentPlayerId && (!urlRoom || urlRoom.toUpperCase() === currentRoomCode)) socket.emit('rejoin-room', { code, playerId: currentPlayerId });
  });
  socket.on('disconnect', () => { setConnection('連線中斷，正在重連…', 'bad'); $('spinBtn').disabled = true; });
  socket.on('connect_error', () => setConnection('連線失敗，請重新整理', 'bad'));
  socket.on('server-ready', () => setConnection('已連線', 'ok'));
  socket.on('joined-room', data => {
    currentPlayerId = data.playerId; currentRoomCode = data.room.code; me = data.room.players.find(p => p.id === currentPlayerId) || null;
    localStorage.setItem('partySlotPlayerId', currentPlayerId); localStorage.setItem('partySlotRoomCode', currentRoomCode);
    history.replaceState({}, '', `${location.pathname}?room=${currentRoomCode}`);
    showGame(data.room); toast(`成功加入房間 ${currentRoomCode}！`); setBusy(false);
  });
  socket.on('room-state', room => { if (currentRoomCode && room.code !== currentRoomCode) return; if (!me && currentPlayerId) me = room.players.find(p => p.id === currentPlayerId) || null; if (me) showGame(room); });
  socket.on('spin-result', result => {
    $('reels').replaceChildren(); result.result.forEach(symbol => { const el = document.createElement('span'); el.textContent = symbol; $('reels').append(el); });
    $('spinMessage').textContent = result.points > 0 ? `恭喜！本次獲得 ${result.points} 分` : '這次沒有得分，再接再厲！';
    toast(`第 ${result.spin} 次拉霸：${result.points} 分`);
    if (currentRoom) renderRoom(currentRoom);
  });
  socket.on('game-error', data => { setBusy(false); toast(data.message || '發生未知錯誤', true); });
  socket.on('notice', data => toast(data.message || '遊戲狀態已更新'));
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('roomCodeInput').value = urlRoom.toUpperCase();
  if (!socket.connected) setConnection('正在連線…', '');
  $('reels').replaceChildren(); symbolsFallback.forEach(symbol => { const el = document.createElement('span'); el.textContent = symbol; $('reels').append(el); });
})();
