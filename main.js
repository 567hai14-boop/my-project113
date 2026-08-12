/* main.js: socket connection, input handling, drawScene with pseudo-3D, ghosts, and event handling */
(() => {
  const socket = io({ transports: ['polling', 'websocket'] });

  // DOM
  const loginScreen = document.getElementById('loginScreen');
  const lobbyScreen = document.getElementById('lobbyScreen');
  const pvpRoomScreen = document.getElementById('pvpRoomScreen');
  const gameScreen = document.getElementById('gameScreen');
  const usernameInput = document.getElementById('usernameInput');
  const passwordInput = document.getElementById('passwordInput');
  const loginButton = document.getElementById('loginButton');
  const loginStatus = document.getElementById('loginStatus');
  const displayName = document.getElementById('displayName');
  const winCount = document.getElementById('winCount');
  const leaderboardList = document.getElementById('leaderboardList');
  const chatHistory = document.getElementById('chatHistory');
  const chatInput = document.getElementById('chatInput');
  const chatSendButton = document.getElementById('chatSendButton');
  const singleModeBtn = document.getElementById('singleModeBtn');
  const pvpModeBtn = document.getElementById('pvpModeBtn');
  const createRoomButton = document.getElementById('createRoomButton');
  const waitingRoomList = document.getElementById('waitingRoomList');
  const hudOverlay = document.getElementById('hudOverlay');
  const statusPlayer = document.getElementById('statusPlayer');
  const statusOpponent = document.getElementById('statusOpponent');
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  // State
  const state = {
    username: null,
    leaderboard: [],
    currentTab: 'score',
    publicRooms: [],
    match: null,
    game: null,
    chatCollapsed: false,
    losses: 0,
  };

  // Game variables
  let gameState = {
    you: { x: 100, y: 100, distance: 0 },
    opponent: { x: 220, y: 120, distance: 0 },
    bot: { x: 80, y: 320 },
    traps: [],
    chunks: [],
  };

  // Configs (must match server)
  const TILE_SIZE = 45;
  const CHUNK_SIZE = 10;
  const MOVE_SPEED = 4; // px per server tick — must match server's player.speed

  // Client-side prediction: we move this locally every animation frame using
  // the same collision rule as the server, so movement feels instant instead
  // of waiting for a server round-trip. It's reconciled against each
  // authoritative 'game_update' below.
  let predicted = null; // { x, y }

  const isWalkable = (x, y) => {
    const tileX = Math.floor(x / TILE_SIZE);
    const tileY = Math.floor(y / TILE_SIZE);
    const chunkX = Math.floor(tileX / CHUNK_SIZE);
    const chunkY = Math.floor(tileY / CHUNK_SIZE);
    const localX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const chunk = (gameState.chunks || []).find((c) => c.chunkX === chunkX && c.chunkY === chunkY);
    if (!chunk) return false; // chunk not loaded yet client-side: be conservative
    const row = chunk.grid[localY];
    return !!row && row[localX] === 0;
  };

  const getYouPos = () => predicted || gameState.you || null;

  // Utility & UI helpers
  const showScreen = (screen) => {
    loginScreen.classList.add('hidden');
    lobbyScreen.classList.add('hidden');
    pvpRoomScreen.classList.add('hidden');
    gameScreen.classList.add('hidden');
    if (screen === 'login') loginScreen.classList.remove('hidden');
    if (screen === 'lobby') lobbyScreen.classList.remove('hidden');
    if (screen === 'pvpRoom') pvpRoomScreen.classList.remove('hidden');
    if (screen === 'game') gameScreen.classList.remove('hidden');
  };

  const renderLeaderboard = () => {
    leaderboardList.innerHTML = '';
    state.leaderboard.forEach((player) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-item' + (player.username === state.username ? ' self' : '');
      row.textContent = `${player.username} • ${player.wins} thắng`;
      leaderboardList.appendChild(row);
    });
  };

  const renderChatMessage = (chat) => {
    const item = document.createElement('div');
    item.className = 'chat-message';
    const author = document.createElement('div');
    author.className = 'chat-author';
    author.textContent = chat.from;
    const text = document.createElement('div');
    text.textContent = chat.message;
    item.appendChild(author);
    item.appendChild(text);
    chatHistory.appendChild(item);
    chatHistory.scrollTop = chatHistory.scrollHeight;
  };

  const renderWaitingRooms = () => {
    waitingRoomList.innerHTML = '';
    state.publicRooms.forEach((room) => {
      const item = document.createElement('button');
      item.className = 'waiting-item';
      item.textContent = `${room.host} đang chờ đấu`;
      item.onclick = () => socket.emit('join_public_room', room.roomId);
      waitingRoomList.appendChild(item);
    });
  };

  // Login
  let loginTimeoutId = null;

  const setLoginStatus = (text, isError) => {
    if (!text) {
      loginStatus.classList.add('hidden');
      loginStatus.textContent = '';
      return;
    }
    loginStatus.textContent = text;
    loginStatus.classList.remove('hidden');
    loginStatus.classList.toggle('is-error', !!isError);
  };

  const resetLoginUi = () => {
    if (loginTimeoutId) { clearTimeout(loginTimeoutId); loginTimeoutId = null; }
    loginButton.disabled = false;
  };

  loginButton.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (!username || !password) {
      setLoginStatus('Nhập đủ tên tài khoản và mật khẩu.', true);
      return;
    }
    if (!socket.connected) {
      setLoginStatus('Chưa kết nối được tới máy chủ. Đang thử lại...', true);
      return;
    }
    loginButton.disabled = true;
    setLoginStatus('Đang đăng nhập...', false);
    socket.emit('user_login', { username, password });

    if (loginTimeoutId) clearTimeout(loginTimeoutId);
    loginTimeoutId = setTimeout(() => {
      resetLoginUi();
      setLoginStatus('Máy chủ không phản hồi. Kiểm tra kết nối mạng hoặc thử lại sau.', true);
    }, 8000);
  });

  // Surface connection problems instead of leaving the login button hanging
  socket.on('connect', () => setLoginStatus(''));
  socket.on('connect_error', () => {
    resetLoginUi();
    setLoginStatus('Không thể kết nối tới máy chủ.', true);
  });
  socket.on('disconnect', () => {
    if (state.username) return; // already in-game, don't spam the (hidden) login screen
    setLoginStatus('Mất kết nối tới máy chủ.', true);
  });

  // Chat
  const sendChat = () => {
    const message = chatInput.value.trim();
    if (!message) return;
    socket.emit('send_chat_message', message);
    chatInput.value = '';
    chatInput.focus();
  };
  chatSendButton.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.leaderboard-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.leaderboard-tab').forEach((n) => n.classList.remove('active'));
      tab.classList.add('active');
      state.currentTab = tab.dataset.tab;
    });
  });

  singleModeBtn.addEventListener('click', () => {
    if (!state.username) return;
    hudOverlay.textContent = 'Đang tạo phòng luyện tập...';
    socket.emit('start_single_run');
  });
  pvpModeBtn.addEventListener('click', () => showScreen('pvpRoom'));
  createRoomButton.addEventListener('click', () => socket.emit('create_public_room'));

  // Socket handlers
  socket.on('user_login_success', (data) => {
    resetLoginUi();
    setLoginStatus('');
    state.username = data.username;
    displayName.textContent = data.username;
    winCount.textContent = `${data.wins} trận thắng`;
    state.leaderboard = data.leaderboard;
    state.publicRooms = data.activeRooms || [];
    renderLeaderboard();
    renderWaitingRooms();
    showScreen('lobby');
  });

  socket.on('user_login_failed', (error) => {
    resetLoginUi();
    setLoginStatus(error?.message || 'Đăng nhập thất bại', true);
  });

  socket.on('leaderboard_update', (leaderboard) => {
    state.leaderboard = leaderboard.slice(0, 10);
    renderLeaderboard();
  });

  socket.on('chat_message', (chat) => renderChatMessage(chat));
  socket.on('room_list_update', (rooms) => { state.publicRooms = rooms; renderWaitingRooms(); });
  socket.on('public_room_created', (data) => { state.publicRooms = data.activeRooms; renderWaitingRooms(); });

  socket.on('match_start', (data) => {
    hudOverlay.textContent = '3';
    showScreen('game');
    predicted = null;
    let count = 3;
    const countdown = setInterval(() => {
      count -= 1;
      hudOverlay.textContent = count > 0 ? String(count) : 'BẮT ĐẦU!';
      if (count <= 0) {
        clearInterval(countdown);
        hudOverlay.textContent = 'Đang thi đấu...';
      }
    }, 1000);
    state.match = { roomId: data.roomId, seed: data.seed, opponent: data.opponent || null };
    statusPlayer.textContent = `Người chơi: ${state.username}`;
    if (state.match.opponent) {
      statusOpponent.classList.remove('hidden');
      statusOpponent.textContent = `Đối thủ: ${state.match.opponent}`;
    } else {
      statusOpponent.classList.add('hidden');
    }
  });

  socket.on('match_countdown', (count) => { hudOverlay.textContent = count > 0 ? String(count) : 'BẮT ĐẦU!'; });

  // Game update arrives
  socket.on('game_update', (update) => {
    // update: you/opponent/bot/traps/chunks
    gameState = Object.assign({}, update, { chunks: update.chunks || [], traps: update.traps || [] });

    if (gameState.you) {
      if (!predicted) {
        predicted = { x: gameState.you.x, y: gameState.you.y };
      } else {
        const drift = Math.hypot(predicted.x - gameState.you.x, predicted.y - gameState.you.y);
        if (drift > 6) {
          // Local prediction diverged too far from the server (lag/packet loss) — snap to truth
          predicted.x = gameState.you.x;
          predicted.y = gameState.you.y;
        }
      }
    }

    // update HUD distances
    const youDist = Math.floor((gameState.you && gameState.you.distance) || 0);
    statusPlayer.textContent = `Người chơi: ${state.username || '-'} • ${youDist}`;
    if (gameState.opponent) {
      const oppDist = Math.floor(gameState.opponent.distance || 0);
      statusOpponent.textContent = `Đối thủ: ${state.match?.opponent || '-'} • ${oppDist}`;
    }
  });

  // Enhanced "player_died" handler per request:
  socket.on('player_died', (payload) => {
    // Hide game screen and show result overlay
    gameScreen.classList.add('hidden');

    const amLoser = payload?.loserId === socket.id;
    const finalMs = payload?.finalTime ?? 0;
    const seconds = Math.floor(finalMs / 1000);

    // Update leaderboard immediately
    renderLeaderboard();

    // Build overlay
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.display = 'grid';
    overlay.style.placeItems = 'center';
    overlay.style.background = 'rgba(0,0,0,0.6)';
    overlay.style.zIndex = '9999';

    const box = document.createElement('div');
    box.className = 'result-overlay-box';
    box.innerHTML = amLoser
      ? `<div style="font-size:20px">💀 SYSTEM FAILURE - BẠN ĐÃ BỊ HỦY DIỆT</div>
         <div style="margin-top:12px;font-weight:800">SURVIVED: ${seconds}s</div>`
      : `<div style="font-size:20px">🏆 CHIẾN THẮNG - ĐỐI THỦ ĐÃ BỊ HẠ GỤC</div>
         <div style="margin-top:12px;font-weight:800">THỜI GIAN: ${seconds}s</div>`;

    const retryBtn = document.createElement('div');
    retryBtn.className = 'result-button';
    retryBtn.textContent = 'THỬ LẠI LƯỢT KHÁC';
    retryBtn.onclick = () => {
      // Cleanup: remove overlay, reset local game state, return to lobby safely
      overlay.remove();
      predicted = null;
      gameState = { you: { x: 100, y: 100, distance: 0 }, opponent: { x: 220, y: 120, distance: 0 }, bot: { x: 80, y: 320 }, traps: [], chunks: [] };
      state.match = null;
      hudOverlay.textContent = '';
      showScreen('lobby');
    };

    box.appendChild(retryBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });

  // Opponent disconnected / room force-closed mid-match — server already
  // sends this, but the client never listened for it before, leaving the
  // remaining player stuck on the game screen indefinitely.
  socket.on('match_cancelled', (payload) => {
    predicted = null;
    state.match = null;
    hudOverlay.textContent = '';
    showScreen('lobby');
    alert(payload?.reason ? `Trận đấu đã bị huỷ: ${payload.reason}` : 'Trận đấu đã bị huỷ.');
  });

  // Movement input handling (keyboard and touch). Emit at ~60Hz.
  const keysPressed = { up: false, down: false, left: false, right: false };
  const keyMap = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right'
  };

  window.addEventListener('keydown', (e) => {
    const m = keyMap[e.key];
    if (m) { keysPressed[m] = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const m = keyMap[e.key];
    if (m) { keysPressed[m] = false; e.preventDefault(); }
  });

  // Emit movement 60Hz
  setInterval(() => {
    socket.emit('player_move', keysPressed);
  }, 1000 / 60);

  // Touch swipe
  let touchStartX = 0, touchStartY = 0;
  const SWIPE_THRESHOLD = 35;
  canvas.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0];
    touchStartX = t.clientX; touchStartY = t.clientY;
  }, { passive: true });

  canvas.addEventListener('touchend', (ev) => {
    const t = ev.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    // Reset keys briefly then set based on swipe
    const resetHold = () => { keysPressed.up = keysPressed.down = keysPressed.left = keysPressed.right = false; };
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
      if (dx > 0) { keysPressed.right = true; setTimeout(resetHold, 150); }
      else { keysPressed.left = true; setTimeout(resetHold, 150); }
    } else if (Math.abs(dy) > SWIPE_THRESHOLD) {
      if (dy > 0) { keysPressed.down = true; setTimeout(resetHold, 150); }
      else { keysPressed.up = true; setTimeout(resetHold, 150); }
    }
    socket.emit('player_move', keysPressed);
  }, { passive: true });

  // Chat toggling
  const chatPanel = document.getElementById('chatPanel');
  const chatHeader = document.getElementById('chatHeader');
  const chatToggleButton = document.getElementById('chatToggleButton');
  chatHeader.addEventListener('click', () => {
    state.chatCollapsed = !state.chatCollapsed;
    if (state.chatCollapsed) { chatPanel.classList.add('chat-collapsed'); chatToggleButton.textContent = '▲'; }
    else { chatPanel.classList.remove('chat-collapsed'); chatToggleButton.textContent = '▼'; }
  });

  // Game drawing: enhanced pseudo-3D walls, trap clusters, ghosts, fog of war
  // Size the canvas to the real viewport (with DPR) instead of stretching a
  // fixed 1200x800 buffer via CSS, which distorted the image on most screens.
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Ghost trail - last 3 points
  const ghostTrail = []; // [{x,y,alpha,size}]
  const MAX_TRAIL = 3;
  const TRAIL_DECAY = 0.04; // per frame alpha decay
  const TRAIL_SIZE_DECAY = 0.75;

  // Utility to add trail sample
  let lastPlayerPos = { x: gameState.you.x, y: gameState.you.y };
  function sampleTrailIfFast() {
    const cur = getYouPos();
    if (!cur) return;
    const dx = cur.x - lastPlayerPos.x;
    const dy = cur.y - lastPlayerPos.y;
    const dist = Math.hypot(dx, dy);
    // threshold for high speed
    const SPEED_THRESHOLD = 3.2;
    if (dist > SPEED_THRESHOLD) {
      // add new trail sample
      ghostTrail.unshift({ x: lastPlayerPos.x, y: lastPlayerPos.y, alpha: 0.6, size: 32 });
      if (ghostTrail.length > MAX_TRAIL) ghostTrail.pop();
    }
    lastPlayerPos.x = cur.x; lastPlayerPos.y = cur.y;
  }

  function drawPseudo3DWalls(sx, sy, size) {
    // sx,sy top-left on screen
    // base wall
    ctx.fillStyle = '#334155'; // slate
    ctx.fillRect(sx, sy, size, size);
    // neon cyan thin top border
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, sy + 1);
    ctx.lineTo(sx + size - 0.5, sy + 1);
    ctx.stroke();
    // heavy black bottom shadow to create depth
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, sy + size - 3, size, 3);
  }

  function drawTrapCluster(absX, absY, camX, camY) {
    // Draw three small jagged triangles next to each other (anchored to tile)
    const baseX = absX - camX;
    const baseY = absY - camY;
    const triW = 12;
    const triH = 16;
    const offsets = [-14, 0, 14];
    ctx.fillStyle = '#ff9f1c';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    for (let i = 0; i < offsets.length; i++) {
      const cx = baseX + offsets[i];
      const cy = baseY;
      ctx.beginPath();
      // jagged triangle (3 teeth)
      ctx.moveTo(cx, cy - triH/2);
      ctx.lineTo(cx + triW/2, cy + triH/2);
      ctx.lineTo(cx - triW/2, cy + triH/2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // small inner jag for "tooth" look
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - triH/6);
      ctx.lineTo(cx + 4, cy + triH/6);
      ctx.lineTo(cx - 6, cy + triH/6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawGhostTrail(camX, camY) {
    for (let i = 0; i < ghostTrail.length; i++) {
      const t = ghostTrail[i];
      const alpha = t.alpha;
      const size = Math.max(6, t.size * Math.pow(TRAIL_SIZE_DECAY, i));
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = '#00f0ff';
      // slightly larger and more transparent for earlier entries
      ctx.fillRect(t.x - camX, t.y - camY, size, size);
      ctx.restore();
      // decay
      t.alpha = Math.max(0, t.alpha - TRAIL_DECAY);
      t.size = t.size * 0.98;
    }
    // remove fully faded
    while (ghostTrail.length && ghostTrail[ghostTrail.length - 1].alpha <= 0.01) ghostTrail.pop();
  }

  function drawScene() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);

    // Background gradient for depth
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#07111a');
    bgGrad.addColorStop(1, '#021018');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Camera centered on the (locally predicted) player position
    const youPos = getYouPos();
    const camX = youPos ? youPos.x - width / 2 : 0;
    const camY = youPos ? youPos.y - height / 2 : 0;

    // Draw chunks -> tiles
    if (Array.isArray(gameState.chunks)) {
      for (const chunk of gameState.chunks) {
        const grid = chunk.grid || [];
        for (let gy = 0; gy < grid.length; gy++) {
          const row = grid[gy];
          for (let gx = 0; gx < row.length; gx++) {
            const cell = row[gx];
            const absX = (chunk.chunkX * CHUNK_SIZE + gx) * TILE_SIZE;
            const absY = (chunk.chunkY * CHUNK_SIZE + gy) * TILE_SIZE;
            const sx = Math.round(absX - camX);
            const sy = Math.round(absY - camY);
            if (sx + TILE_SIZE < 0 || sy + TILE_SIZE < 0 || sx > width || sy > height) continue;
            if (cell === 1) {
              drawPseudo3DWalls(sx, sy, TILE_SIZE);
            } else {
              // path tile (slightly darker)
              ctx.fillStyle = '#07121a';
              ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
            }
          }
        }
      }
    }

    // Draw traps (clusters of spikes)
    (gameState.traps || []).forEach((trap) => {
      const tx = trap.x;
      const ty = trap.y;
      // Draw three teeth cluster anchored to ground
      drawTrapCluster(tx, ty, camX, camY);
    });

    // Sample trail if fast
    sampleTrailIfFast();
    // Draw ghost trail behind player
    drawGhostTrail(camX, camY);

    // Draw bot
    if (gameState.bot) {
      const bx = gameState.bot.x - camX;
      const by = gameState.bot.y - camY;
      ctx.save();
      ctx.shadowBlur = 18;
      ctx.shadowColor = '#ff3333';
      ctx.fillStyle = '#ff3333';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.fillRect(bx, by, 34, 34);
      ctx.strokeRect(bx, by, 34, 34);
      ctx.restore();
    }

    // Draw opponent with alpha 0.4 kept
    if (gameState.opponent) {
      const ox = gameState.opponent.x - camX;
      const oy = gameState.opponent.y - camY;
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#ff0055';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.fillRect(ox, oy, 32, 32);
      ctx.strokeRect(ox, oy, 32, 32);
      ctx.restore();
    }

    // Draw player (cyan) on top of trail
    if (youPos) {
      const px = youPos.x - camX;
      const py = youPos.y - camY;
      ctx.fillStyle = '#00f0ff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.fillRect(px, py, 32, 32);
      ctx.strokeRect(px, py, 32, 32);

      // Fog of war / radial mask
      const centerX = px + 16;
      const centerY = py + 16;
      const radius = 150;
      // darken whole screen and cut a hole at player
      ctx.fillStyle = 'rgba(3,8,12,0.9)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Optional: UI overlays drawn by DOM, so we skip drawing HUD here
  }

  // Move the predicted position locally, using the same "check the final
  // tile, don't slide along walls" rule the server uses, so what you see
  // responds instantly to input instead of waiting for a round-trip.
  let lastFrameTime = null;
  function updatePrediction(now) {
    if (!predicted) { lastFrameTime = now; return; }
    if (lastFrameTime === null) { lastFrameTime = now; return; }
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;
    // Scale to a 60Hz baseline so movement speed doesn't depend on refresh rate
    const speed = MOVE_SPEED * (dtMs / (1000 / 60));

    let nextX = predicted.x;
    let nextY = predicted.y;
    if (keysPressed.up) nextY -= speed;
    if (keysPressed.down) nextY += speed;
    if (keysPressed.left) nextX -= speed;
    if (keysPressed.right) nextX += speed;

    if ((nextX !== predicted.x || nextY !== predicted.y) && isWalkable(nextX, nextY)) {
      predicted.x = nextX;
      predicted.y = nextY;
    }
  }

  // Loop
  function loop(now) {
    updatePrediction(now);
    drawScene();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Utility: request initial room list & leaderboard
  socket.emit('request_room_list');

  // Expose some globals for dev debugging (optional)
  window.__MR = { socket, state, gameState, renderLeaderboard, showScreen };

})();
