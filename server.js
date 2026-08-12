const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const TILE_SIZE = 45;
const CHUNK_SIZE = 10;
const generatedChunks = {}; // Lưu map theo key "chunkX_chunkY"
const players = {};
const matchmakingQueue = [];
const rooms = {};
const roomIntervals = {};
const users = []; // Mock database tài khoản
let publicRooms = []; // Phòng PK công khai đang chờ

const buildLeaderboard = () => {
  return [...users].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.totalDistance - a.totalDistance;
  });
};

const broadcastLeaderboard = () => {
  io.emit('leaderboard_update', buildLeaderboard());
};

const findUser = (username) => users.find((user) => user.username === username);

const createPublicRoom = (hostName, hostId) => {
  const room = {
    roomId: hostId,
    host: hostName,
    status: 'waiting',
  };
  publicRooms = publicRooms.filter((roomItem) => roomItem.roomId !== hostId).concat(room);
  io.emit('room_list_update', publicRooms);
  return room;
};

const removePublicRoomByHostId = (hostId) => {
  const originalLength = publicRooms.length;
  publicRooms = publicRooms.filter((room) => room.roomId !== hostId);
  if (publicRooms.length !== originalLength) {
    io.emit('room_list_update', publicRooms);
  }
};

const resolvePublicRoom = (roomId) => publicRooms.find((room) => room.roomId === roomId);

const computeBotSpeed = (playerSpeed, totalDistance) => {
  const baseSpeed = playerSpeed * 0.85;
  const extra = Math.floor(totalDistance / 1000) * 0.05 * playerSpeed;
  const maxSpeed = playerSpeed * 1.1;
  return Math.min(baseSpeed + extra, maxSpeed);
};

let worldSeed = Math.random() * 100000;

const seededRandom = (x, y, extra = 0) => {
  const n = x * 374761393 + y * 668265263 + Math.floor(worldSeed * 1000) + extra * 987654321;
  const sinValue = Math.sin(n) * 43758.5453123;
  const cosValue = Math.cos(n * 1.61803398875) * 23421.63102512;
  const value = sinValue + cosValue;
  return value - Math.floor(value);
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getChunkKey = (x, y) => `${x}_${y}`;

// Ensure a chunk exists (generate lazily)
const addChunkIfMissing = (chunkX, chunkY) => {
  const k = getChunkKey(chunkX, chunkY);
  if (!generatedChunks[k]) {
    generatedChunks[k] = generateChunk(chunkX, chunkY);
  }
  return generatedChunks[k];
};

const createEmptyGrid = () => Array.from({ length: CHUNK_SIZE }, () => Array(CHUNK_SIZE).fill(1));

const resolveEdgePosition = (side, chunkX, chunkY, salt = 0) => {
  const edgeIndex = Math.floor(seededRandom(chunkX, chunkY, salt) * (CHUNK_SIZE - 2)) + 1;
  if (side === 'left') return { x: 0, y: edgeIndex };
  if (side === 'right') return { x: CHUNK_SIZE - 1, y: edgeIndex };
  if (side === 'top') return { x: edgeIndex, y: 0 };
  if (side === 'bottom') return { x: edgeIndex, y: CHUNK_SIZE - 1 };
  return { x: Math.floor(CHUNK_SIZE / 2), y: Math.floor(CHUNK_SIZE / 2) };
};

const generateChunk = (chunkX, chunkY) => {
  const key = getChunkKey(chunkX, chunkY);
  if (generatedChunks[key]) return generatedChunks[key];

  const grid = createEmptyGrid();
  const traps = [];
  const distance = Math.sqrt(chunkX * chunkX + chunkY * chunkY);
  const openness = Math.min(0.7, 0.12 + distance * 0.04);

  const midX = Math.floor(CHUNK_SIZE / 2);
  const midY = Math.floor(CHUNK_SIZE / 2);
  for (let x = 0; x < CHUNK_SIZE; x += 1) grid[midY][x] = 0;
  for (let y = 0; y < CHUNK_SIZE; y += 1) grid[y][midX] = 0;

  const branchCount = 4;
  for (let branch = 0; branch < branchCount; branch += 1) {
    let x = Math.floor(seededRandom(chunkX, chunkY, branch * 7) * CHUNK_SIZE);
    let y = Math.floor(seededRandom(chunkX, chunkY, branch * 13) * CHUNK_SIZE);
    const length = Math.max(6, Math.floor(5 + seededRandom(chunkX, chunkY, branch * 11) * 12));

    for (let step = 0; step < length; step += 1) {
      grid[y][x] = 0;
      const direction = Math.floor(seededRandom(chunkX, chunkY, branch * 23 + step) * 4);
      if (direction === 0 && x < CHUNK_SIZE - 1) x += 1;
      else if (direction === 1 && x > 0) x -= 1;
      else if (direction === 2 && y < CHUNK_SIZE - 1) y += 1;
      else if (direction === 3 && y > 0) y -= 1;
      if (seededRandom(chunkX, chunkY, branch * 29 + step) < openness) {
        grid[y][x] = 0;
      }
    }
  }

  const sideKeys = ['left', 'top', 'right', 'bottom'];
  const entrySide = sideKeys[Math.floor(seededRandom(chunkX, chunkY, 31) * sideKeys.length)];
  const exitSide = sideKeys[Math.floor(seededRandom(chunkX, chunkY, 37) * sideKeys.length)];
  const entryPos = resolveEdgePosition(entrySide, chunkX, chunkY, 41);
  const exitPos = resolveEdgePosition(exitSide, chunkX, chunkY, 43);
  grid[entryPos.y][entryPos.x] = 0;
  grid[exitPos.y][exitPos.x] = 0;

  const carveCorridor = (start, end, seedOffset) => {
    let cx = start.x;
    let cy = start.y;
    while (cx !== end.x || cy !== end.y) {
      grid[cy][cx] = 0;
      const dx = end.x - cx;
      const dy = end.y - cy;
      const choice = seededRandom(chunkX, chunkY, seedOffset + cx + cy);
      if (Math.abs(dx) > Math.abs(dy)) cx += dx > 0 ? 1 : -1;
      else cy += dy > 0 ? 1 : -1;
      if (choice > 0.4 && Math.abs(dx) > 0 && Math.abs(dy) > 0) {
        if (choice < 0.7) cy += dy > 0 ? 1 : -1;
        else cx += dx > 0 ? 1 : -1;
      }
      cx = clamp(cx, 0, CHUNK_SIZE - 1);
      cy = clamp(cy, 0, CHUNK_SIZE - 1);
      grid[cy][cx] = 0;
    }
  };

  carveCorridor(entryPos, exitPos, 53);

  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      if (grid[y][x] === 1) {
        const noise = seededRandom(chunkX, chunkY, x * 17 + y * 31);
        if (noise < openness * 0.2) grid[y][x] = 0;
      }
    }
  }

  for (let y = 1; y < CHUNK_SIZE - 1; y += 1) {
    for (let x = 1; x < CHUNK_SIZE - 1; x += 1) {
      if (grid[y][x] === 1) {
        if (grid[y + 1][x] === 0 || grid[y - 1][x] === 0 || grid[y][x + 1] === 0 || grid[y][x - 1] === 0) {
          if (seededRandom(chunkX + x, chunkY + y, 99) < 0.12) {
            const absX = (chunkX * CHUNK_SIZE + x) * TILE_SIZE;
            const absY = (chunkY * CHUNK_SIZE + y) * TILE_SIZE;
            traps.push({ x: absX, y: absY });
          }
        }
      }
    }
  }

  const chunk = { grid, traps, entryX: entryPos.x, entryY: entryPos.y, exitX: exitPos.x, exitY: exitPos.y };
  generatedChunks[key] = chunk;
  return chunk;
};

const getPlayerDistance = (player) => {
  return Math.sqrt(player.x * player.x + player.y * player.y);
};

const getNearbyTraps = (player) => {
  const tileX = Math.floor(player.x / TILE_SIZE);
  const tileY = Math.floor(player.y / TILE_SIZE);
  const chunkX = Math.floor(tileX / CHUNK_SIZE);
  const chunkY = Math.floor(tileY / CHUNK_SIZE);
  const traps = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const chunk = generatedChunks[getChunkKey(chunkX + dx, chunkY + dy)];
      if (chunk && Array.isArray(chunk.traps)) {
        traps.push(...chunk.traps);
      }
    }
  }
  return traps;
};

// Return nearby chunks (grids) around a player so client can render tile map locally.
const getNearbyChunks = (player) => {
  const tileX = Math.floor(player.x / TILE_SIZE);
  const tileY = Math.floor(player.y / TILE_SIZE);
  const chunkX = Math.floor(tileX / CHUNK_SIZE);
  const chunkY = Math.floor(tileY / CHUNK_SIZE);
  const chunks = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const cx = chunkX + dx;
      const cy = chunkY + dy;
      addChunkIfMissing(cx, cy);
      const chunk = generatedChunks[getChunkKey(cx, cy)];
      if (chunk) {
        // Send minimal grid (0/1) and chunk coords so client can position tiles
        chunks.push({ chunkX: cx, chunkY: cy, grid: chunk.grid });
      }
    }
  }
  return chunks;
};

const heuristic = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const rebuildPath = (cameFrom, currentKey) => {
  const path = [];
  let key = currentKey;
  while (key) {
    const [x, y] = key.split(',').map(Number);
    path.unshift({ x, y });
    key = cameFrom[key];
  }
  return path;
};

const findAStarPath = (start, goal, grid) => {
  const width = grid[0]?.length || 0;
  const height = grid.length;
  const startKey = `${start.x},${start.y}`;
  const goalKey = `${goal.x},${goal.y}`;
  if (startKey === goalKey) return [start];
  if (start.x < 0 || start.x >= width || start.y < 0 || start.y >= height) return [];
  if (goal.x < 0 || goal.x >= width || goal.y < 0 || goal.y >= height) return [];
  if (grid[start.y][start.x] === 1 || grid[goal.y][goal.x] === 1) return [];

  const openSet = [startKey];
  const cameFrom = {};
  const gScore = { [startKey]: 0 };
  const fScore = { [startKey]: heuristic(start, goal) };
  const closedSet = new Set();

  const getNeighbors = (x, y) => {
    const neighbors = [];
    const deltas = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    for (const { dx, dy } of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && grid[ny][nx] === 0) {
        neighbors.push({ x: nx, y: ny });
      }
    }
    return neighbors;
  };

  let iterations = 0;
  while (openSet.length && iterations < 2000) {
    iterations += 1;
    let currentIndex = 0;
    let currentKey = openSet[0];
    let currentF = fScore[currentKey] ?? Infinity;
    for (let i = 1; i < openSet.length; i += 1) {
      const key = openSet[i];
      const score = fScore[key] ?? Infinity;
      if (score < currentF) {
        currentF = score;
        currentKey = key;
        currentIndex = i;
      }
    }

    if (currentKey === goalKey) return rebuildPath(cameFrom, currentKey);
    openSet.splice(currentIndex, 1);
    closedSet.add(currentKey);

    const [cx, cy] = currentKey.split(',').map(Number);
    for (const neighbor of getNeighbors(cx, cy)) {
      const neighborKey = `${neighbor.x},${neighbor.y}`;
      if (closedSet.has(neighborKey)) continue;
      const tentativeG = (gScore[currentKey] || Infinity) + 1;
      const oldG = gScore[neighborKey] ?? Infinity;
      if (tentativeG < oldG) {
        cameFrom[neighborKey] = currentKey;
        gScore[neighborKey] = tentativeG;
        fScore[neighborKey] = tentativeG + heuristic(neighbor, goal);
        if (!openSet.includes(neighborKey)) openSet.push(neighborKey);
      }
    }
  }

  return [];
};

const buildSearchGrid = (botTile, playerTile) => {
  const botChunkX = Math.floor(botTile.x / CHUNK_SIZE);
  const botChunkY = Math.floor(botTile.y / CHUNK_SIZE);
  const playerChunkX = Math.floor(playerTile.x / CHUNK_SIZE);
  const playerChunkY = Math.floor(playerTile.y / CHUNK_SIZE);
  const minChunkX = Math.min(botChunkX, playerChunkX) - 1;
  const minChunkY = Math.min(botChunkY, playerChunkY) - 1;
  const maxChunkX = Math.max(botChunkX, playerChunkX) + 1;
  const maxChunkY = Math.max(botChunkY, playerChunkY) + 1;

  const width = (maxChunkX - minChunkX + 1) * CHUNK_SIZE;
  const height = (maxChunkY - minChunkY + 1) * CHUNK_SIZE;
  const grid = Array.from({ length: height }, () => Array(width).fill(1));

  for (let cx = minChunkX; cx <= maxChunkX; cx += 1) {
    for (let cy = minChunkY; cy <= maxChunkY; cy += 1) {
      addChunkIfMissing(cx, cy);
      const chunk = generatedChunks[getChunkKey(cx, cy)];
      if (!chunk) continue;
      const baseX = (cx - minChunkX) * CHUNK_SIZE;
      const baseY = (cy - minChunkY) * CHUNK_SIZE;
      for (let y = 0; y < CHUNK_SIZE; y += 1) {
        for (let x = 0; x < CHUNK_SIZE; x += 1) {
          grid[baseY + y][baseX + x] = chunk.grid[y][x];
        }
      }
    }
  }

  return {
    grid,
    offsetX: minChunkX * CHUNK_SIZE,
    offsetY: minChunkY * CHUNK_SIZE,
  };
};

const updateBotPath = (room, target) => {
  const bot = room.bot;
  const botTile = { x: Math.floor(bot.x / TILE_SIZE), y: Math.floor(bot.y / TILE_SIZE) };
  const playerTile = { x: Math.floor(target.x / TILE_SIZE), y: Math.floor(target.y / TILE_SIZE) };
  const search = buildSearchGrid(botTile, playerTile);
  const localStart = { x: botTile.x - search.offsetX, y: botTile.y - search.offsetY };
  const localGoal = { x: playerTile.x - search.offsetX, y: playerTile.y - search.offsetY };
  if (localStart.x < 0 || localStart.y < 0 || localGoal.x < 0 || localGoal.y < 0) {
    return [];
  }
  const localPath = findAStarPath(localStart, localGoal, search.grid);
  if (!localPath.length) return [];
  return localPath.map((node) => ({ x: node.x + search.offsetX, y: node.y + search.offsetY }));
};

const moveBotAlongPath = (room, target) => {
  const bot = room.bot;
  const botTile = { x: Math.floor(bot.x / TILE_SIZE), y: Math.floor(bot.y / TILE_SIZE) };
  const playerTile = { x: Math.floor(target.x / TILE_SIZE), y: Math.floor(target.y / TILE_SIZE) };
  const path = updateBotPath(room, target);
  if (!path.length || path.length < 2) {
    return;
  }

  const nextTile = path[1];
  const targetX = nextTile.x * TILE_SIZE;
  const targetY = nextTile.y * TILE_SIZE;
  const dx = targetX - bot.x;
  const dy = targetY - bot.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= bot.speed || distance === 0) {
    bot.x = targetX;
    bot.y = targetY;
    return;
  }

  const ratio = bot.speed / distance;
  bot.x += dx * ratio;
  bot.y += dy * ratio;
};

const startRoomBotLoop = (roomId) => {
  if (!rooms[roomId]) return;
  if (!roomIntervals[roomId]) roomIntervals[roomId] = {};
  if (roomIntervals[roomId].bot) return;

  roomIntervals[roomId].bot = setInterval(() => {
    const room = rooms[roomId];
    if (!room || !room.players.length) return;
    const activePlayers = room.players.map((id) => players[id]).filter(Boolean);
    if (!activePlayers.length) return;

    let target = activePlayers[0];
    let bestDist = Math.abs(room.bot.x - target.x) + Math.abs(room.bot.y - target.y);
    for (let i = 1; i < activePlayers.length; i += 1) {
      const candidate = activePlayers[i];
      const d = Math.abs(room.bot.x - candidate.x) + Math.abs(room.bot.y - candidate.y);
      if (d < bestDist) {
        bestDist = d;
        target = candidate;
      }
    }

    const elapsed = Date.now() - room.createdAt;
    const boostSteps = Math.floor(elapsed / 10000);
    const maxSpeed = (target.speed || 4) * 1.12;
    const baseSpeed = 3.5 * Math.pow(1.03, boostSteps);
    room.bot.speed = Math.min(baseSpeed, maxSpeed);

    moveBotAlongPath(room, target);
  }, 100);
};

const clearRoomIntervals = (roomId) => {
  if (!roomIntervals[roomId]) return;
  if (roomIntervals[roomId].countdown) clearInterval(roomIntervals[roomId].countdown);
  if (roomIntervals[roomId].update) clearInterval(roomIntervals[roomId].update);
  if (roomIntervals[roomId].bot) clearInterval(roomIntervals[roomId].bot);
  delete roomIntervals[roomId];
};

const sendRoomGameUpdate = (roomId) => {
  const room = rooms[roomId];
  if (!room || !room.players.length) return;

  const entries = room.players
    .map((id) => ({ id, player: players[id] }))
    .filter((entry) => entry.player);
  if (!entries.length) return;

  const isCollidingWithTrapsOrBot = (player, traps, bot) => {
    const botDist = Math.hypot(player.x - bot.x, player.y - bot.y);
    if (botDist < 24) return true;
    for (const trap of traps) {
      const d = Math.hypot(player.x - trap.x, player.y - trap.y);
      if (d < 24) return true;
    }
    return false;
  };

  const perPlayer = entries.map(({ id, player }) => ({
    id,
    player,
    traps: getNearbyTraps(player),
    chunks: getNearbyChunks(player),
  }));

  if (!room.finished) {
    const loser = perPlayer.find(({ player, traps }) => isCollidingWithTrapsOrBot(player, traps, room.bot));
    if (loser) {
      room.finished = true;
      io.to(roomId).emit('player_died', {
        loserId: loser.id,
        finalTime: Date.now() - (room.startedAt || Date.now()),
      });

      // Award +1 win to the surviving user (meaningful in 2-player PvP; no-op in solo)
      try {
        const winnerEntry = perPlayer.find((entry) => entry.id !== loser.id);
        const winnerPlayer = winnerEntry && winnerEntry.player;
        if (winnerPlayer && winnerPlayer.name) {
          const userRecord = users.find((u) => u.username === winnerPlayer.name);
          if (userRecord) userRecord.wins = (userRecord.wins || 0) + 1;
        }
      } catch (err) {
        // ignore
      }

      broadcastLeaderboard();
      clearRoomIntervals(roomId);
      room.players.forEach((pid) => {
        if (players[pid]) players[pid].roomId = null;
      });

      setTimeout(() => {
        delete rooms[roomId];
      }, 250);

      return;
    }
  }

  perPlayer.forEach(({ id, player, traps, chunks }) => {
    const opponentEntry = perPlayer.find((entry) => entry.id !== id);
    const update = {
      you: { x: player.x, y: player.y, distance: getPlayerDistance(player) },
      opponent: opponentEntry
        ? { x: opponentEntry.player.x, y: opponentEntry.player.y, distance: getPlayerDistance(opponentEntry.player) }
        : null,
      bot: room.bot,
      traps,
      chunks,
    };
    const socket = io.sockets.sockets.get(id);
    if (socket) socket.emit('game_update', update);
  });
};

const startRoomUpdates = (roomId) => {
  if (!rooms[roomId]) return;
  if (!roomIntervals[roomId]) roomIntervals[roomId] = {};
  if (roomIntervals[roomId].update) return;
  roomIntervals[roomId].update = setInterval(() => {
    sendRoomGameUpdate(roomId);
  }, 100);
};

const startRoomCountdown = (roomId) => {
  if (!rooms[roomId]) return;
  clearRoomIntervals(roomId);
  roomIntervals[roomId] = roomIntervals[roomId] || {};
  let count = 3;
  roomIntervals[roomId].countdown = setInterval(() => {
    io.to(roomId).emit('match_countdown', count);
    if (count <= 0) {
      clearInterval(roomIntervals[roomId].countdown);
      roomIntervals[roomId].countdown = null;
      const room = rooms[roomId];
      if (room) room.startedAt = Date.now();
      startRoomUpdates(roomId);
      startRoomBotLoop(roomId);
      return;
    }
    count -= 1;
  }, 1000);
};

const tryMatchQueue = () => {
  while (matchmakingQueue.length >= 2) {
    const playerIdA = matchmakingQueue.shift();
    const playerIdB = matchmakingQueue.shift();
    const playerA = players[playerIdA];
    const playerB = players[playerIdB];
    if (!playerA || !playerB) {
      if (playerA) matchmakingQueue.unshift(playerIdA);
      if (playerB) matchmakingQueue.unshift(playerIdB);
      break;
    }

    const roomId = `room_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const playerASpeed = playerA.speed || 4;
    const playerBSpeed = playerB.speed || 4;
    const botSpeed = computeBotSpeed(Math.max(playerASpeed, playerBSpeed), Math.max(playerA.distance || 0, playerB.distance || 0));

    rooms[roomId] = {
      roomId,
      seed: Math.floor(seededRandom(playerIdA.length, playerIdB.length, Date.now()) * 1000000000),
      players: [playerIdA, playerIdB],
      bot: { x: 45, y: 45, speed: botSpeed },
      createdAt: Date.now(),
    };
    playerA.roomId = roomId;
    playerB.roomId = roomId;

    const socketA = io.sockets.sockets.get(playerIdA);
    const socketB = io.sockets.sockets.get(playerIdB);
    if (socketA) socketA.join(roomId);
    if (socketB) socketB.join(roomId);

    const payloadA = {
      roomId,
      seed: rooms[roomId].seed,
      opponent: playerB.name || `Player_${playerIdB.slice(-4)}`,
    };
    const payloadB = {
      roomId,
      seed: rooms[roomId].seed,
      opponent: playerA.name || `Player_${playerIdA.slice(-4)}`,
    };
    if (socketA) socketA.emit('match_start', payloadA);
    if (socketB) socketB.emit('match_start', payloadB);

    startRoomCountdown(roomId);
  }
};

const CHUNK_KEEP_RADIUS = 3;

const cleanupFarChunks = () => {
  const activePlayers = Object.values(players);
  if (!activePlayers.length) return; // nobody connected: leave cache as-is, cheap either way

  const keep = new Set();
  activePlayers.forEach((player) => {
    const tileX = Math.floor(player.x / TILE_SIZE);
    const tileY = Math.floor(player.y / TILE_SIZE);
    const chunkX = Math.floor(tileX / CHUNK_SIZE);
    const chunkY = Math.floor(tileY / CHUNK_SIZE);
    for (let dx = -CHUNK_KEEP_RADIUS; dx <= CHUNK_KEEP_RADIUS; dx += 1) {
      for (let dy = -CHUNK_KEEP_RADIUS; dy <= CHUNK_KEEP_RADIUS; dy += 1) {
        keep.add(getChunkKey(chunkX + dx, chunkY + dy));
      }
    }
  });

  Object.keys(generatedChunks).forEach((key) => {
    if (!keep.has(key)) delete generatedChunks[key];
  });
};

setInterval(cleanupFarChunks, 60000);

io.on('connection', (socket) => {
  socket.on('start_single_run', () => {
    const player = players[socket.id];
    if (!player) {
      socket.emit('user_login_failed', { message: 'Vui lòng đăng nhập trước khi chơi.' });
      return;
    }
    if (player.roomId && rooms[player.roomId]) return; // already in a run

    // Fresh spawn for this run
    player.x = (CHUNK_SIZE * TILE_SIZE) / 2;
    player.y = (CHUNK_SIZE * TILE_SIZE) / 2;
    player.distance = 0;

    for (let cx = -1; cx <= 1; cx += 1) {
      for (let cy = -1; cy <= 1; cy += 1) {
        addChunkIfMissing(cx, cy);
      }
    }

    const roomId = `solo_${socket.id}_${Date.now()}`;
    const botSpeed = computeBotSpeed(player.speed || 4, player.distance || 0);
    rooms[roomId] = {
      roomId,
      seed: Math.floor(seededRandom(socket.id.length, 1, Date.now()) * 1000000000),
      players: [socket.id],
      bot: { x: 45, y: 45, speed: botSpeed },
      createdAt: Date.now(),
    };
    player.roomId = roomId;
    socket.join(roomId);

    socket.emit('match_start', {
      roomId,
      seed: rooms[roomId].seed,
      opponent: null,
    });

    startRoomCountdown(roomId);
  });

  socket.on('find_match', (data) => {
    players[socket.id] = players[socket.id] || {
      id: socket.id,
      name: data.name || `Player_${socket.id.slice(-4)}`,
      x: (CHUNK_SIZE * TILE_SIZE) / 2,
      y: (CHUNK_SIZE * TILE_SIZE) / 2,
      speed: 4,
      distance: 0,
      roomId: null,
    };
    players[socket.id].name = data.name || players[socket.id].name;

    for (let cx = -1; cx <= 1; cx += 1) {
      for (let cy = -1; cy <= 1; cy += 1) {
        addChunkIfMissing(cx, cy);
      }
    }

    if (!matchmakingQueue.includes(socket.id)) matchmakingQueue.push(socket.id);
    tryMatchQueue();
  });

  socket.on('cancel_match', () => {
    const index = matchmakingQueue.indexOf(socket.id);
    if (index !== -1) matchmakingQueue.splice(index, 1);
  });

  socket.on('user_login', (data) => {
    if (!data || !data.username || !data.password) {
      socket.emit('user_login_failed', { message: 'Username and password are required' });
      return;
    }

    let user = findUser(data.username);
    if (!user) {
      user = {
        username: data.username,
        password: data.password,
        wins: 0,
        totalDistance: 0,
      };
      users.push(user);
    } else if (user.password !== data.password) {
      socket.emit('user_login_failed', { message: 'Sai mật khẩu' });
      return;
    }

    socket.user = user;
    players[socket.id] = players[socket.id] || {
      id: socket.id,
      name: data.username,
      x: (CHUNK_SIZE * TILE_SIZE) / 2,
      y: (CHUNK_SIZE * TILE_SIZE) / 2,
      speed: 4,
      distance: 0,
      roomId: null,
    };
    players[socket.id].name = data.username;

    socket.emit('user_login_success', {
      username: user.username,
      wins: user.wins,
      totalDistance: user.totalDistance,
      leaderboard: buildLeaderboard().slice(0, 10),
      activeRooms: publicRooms,
    });
  });

  socket.on('send_chat_message', (message) => {
    const user = socket.user || players[socket.id];
    const author = user?.username || players[socket.id]?.name || `Player_${socket.id.slice(-4)}`;
    const chatPayload = {
      from: author,
      message,
      timestamp: Date.now(),
    };
    io.emit('chat_message', chatPayload);
  });

  socket.on('request_room_list', () => {
    socket.emit('room_list_update', publicRooms);
  });

  socket.on('create_public_room', () => {
    const user = socket.user || players[socket.id];
    if (!user) {
      socket.emit('create_public_room_failed', { message: 'Login or enter your display name first.' });
      return;
    }
    createPublicRoom(user.username, socket.id);
    socket.emit('public_room_created', { activeRooms: publicRooms });
  });

  socket.on('join_public_room', (roomId) => {
    const publicRoom = resolvePublicRoom(roomId);
    if (!publicRoom || publicRoom.status !== 'waiting') {
      socket.emit('join_public_room_failed', { message: 'Room unavailable or already started.' });
      return;
    }

    const hostSocketId = publicRoom.roomId;
    const guestSocketId = socket.id;
    const hostPlayer = players[hostSocketId];
    const guestPlayer = players[guestSocketId];
    if (!hostPlayer || !guestPlayer) {
      socket.emit('join_public_room_failed', { message: 'Both players must be connected and ready.' });
      return;
    }

    publicRooms = publicRooms.filter((room) => room.roomId !== roomId);
    io.emit('room_list_update', publicRooms);

    const matchRoomId = `room_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const playerASpeed = hostPlayer.speed || 4;
    const playerBSpeed = guestPlayer.speed || 4;
    const botSpeed = computeBotSpeed(Math.max(playerASpeed, playerBSpeed), Math.max(hostPlayer.distance || 0, guestPlayer.distance || 0));

    rooms[matchRoomId] = {
      roomId: matchRoomId,
      seed: Math.floor(seededRandom(hostSocketId.length, guestSocketId.length, Date.now()) * 1000000000),
      players: [hostSocketId, guestSocketId],
      bot: { x: 45, y: 45, speed: botSpeed },
      createdAt: Date.now(),
    };
    hostPlayer.roomId = matchRoomId;
    guestPlayer.roomId = matchRoomId;

    const socketHost = io.sockets.sockets.get(hostSocketId);
    const socketGuest = io.sockets.sockets.get(guestSocketId);
    if (socketHost) socketHost.join(matchRoomId);
    if (socketGuest) socketGuest.join(matchRoomId);

    const payloadHost = {
      roomId: matchRoomId,
      seed: rooms[matchRoomId].seed,
      opponent: guestPlayer.name || `Player_${guestSocketId.slice(-4)}`,
    };
    const payloadGuest = {
      roomId: matchRoomId,
      seed: rooms[matchRoomId].seed,
      opponent: hostPlayer.name || `Player_${hostSocketId.slice(-4)}`,
    };
    if (socketHost) socketHost.emit('match_start', payloadHost);
    if (socketGuest) socketGuest.emit('match_start', payloadGuest);

    startRoomCountdown(matchRoomId);
  });

  socket.on('player_move', (dir) => {
    const player = players[socket.id];
    if (!player) return;

    let nextX = player.x;
    let nextY = player.y;
    if (dir.up) nextY -= player.speed;
    if (dir.down) nextY += player.speed;
    if (dir.left) nextX -= player.speed;
    if (dir.right) nextX += player.speed;

    const tileX = Math.floor(nextX / TILE_SIZE);
    const tileY = Math.floor(nextY / TILE_SIZE);
    const chunkX = Math.floor(tileX / CHUNK_SIZE);
    const chunkY = Math.floor(tileY / CHUNK_SIZE);
    const localTileX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localTileY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

    addChunkIfMissing(chunkX, chunkY);
    addChunkIfMissing(chunkX + 1, chunkY);
    addChunkIfMissing(chunkX - 1, chunkY);
    addChunkIfMissing(chunkX, chunkY + 1);
    addChunkIfMissing(chunkX, chunkY - 1);

    const currentChunk = generatedChunks[getChunkKey(chunkX, chunkY)];
    if (currentChunk && currentChunk.grid[localTileY][localTileX] === 0) {
      player.x = nextX;
      player.y = nextY;
      player.distance = getPlayerDistance(player);
    }

    if (player.roomId) sendRoomGameUpdate(player.roomId);
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player && player.roomId) {
      const roomId = player.roomId;
      const room = rooms[roomId];
      if (room) {
        room.players = room.players.filter((id) => id !== socket.id);
        io.to(roomId).emit('match_cancelled', { reason: 'Opponent disconnected' });
        clearRoomIntervals(roomId);
        delete rooms[roomId];
      }
    }
    removePublicRoomByHostId(socket.id);
    const queueIndex = matchmakingQueue.indexOf(socket.id);
    if (queueIndex !== -1) matchmakingQueue.splice(queueIndex, 1);
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server chạy tại http://localhost:${PORT}`);
});
