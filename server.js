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
const CHUNK_SIZE = 31; // ~30x30 (odd size so the maze carving below has a clean cell grid)
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

// A player is "free" if they either don't have a roomId, or their roomId
// points at a room that no longer exists (stale). Used to stop a player
// from being dropped into a second match while still active in a first —
// which used to leave the old room's bot/update intervals running forever
// and left that socket receiving game_update from two rooms at once.
const isPlayerFree = (player) => !!player && !(player.roomId && rooms[player.roomId]);

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

// Cell grid: only EVEN grid coordinates (0,2,4...) are "cells"; odd
// coordinates are the walls carved between them. Every chunk edge lands on
// an even coordinate too (CHUNK_SIZE is odd), so two neighbouring chunks
// always line up on cell positions and — since every cell is guaranteed
// open below — the border between chunks is automatically walkable. No
// extra cross-chunk bookkeeping needed.
const CELLS_PER_SIDE = Math.floor((CHUNK_SIZE - 1) / 2) + 1; // e.g. 16 for size 31

// Builds a perfect maze (randomized-DFS spanning tree) over the cell grid.
// A spanning tree touches every single cell exactly once, so by
// construction there is no unreachable pocket — "không tịt đường" is
// structurally guaranteed, not just likely.
const carveSpanningTree = (grid, chunkX, chunkY) => {
  const visited = Array.from({ length: CELLS_PER_SIDE }, () => Array(CELLS_PER_SIDE).fill(false));
  const startCx = Math.floor(seededRandom(chunkX, chunkY, 5) * CELLS_PER_SIDE);
  const startCy = Math.floor(seededRandom(chunkX, chunkY, 7) * CELLS_PER_SIDE);
  const stack = [[startCx, startCy]];
  visited[startCy][startCx] = true;
  grid[startCy * 2][startCx * 2] = 0;
  let step = 0;

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const neighbors = [
      [cx + 1, cy, cx * 2 + 1, cy * 2],
      [cx - 1, cy, cx * 2 - 1, cy * 2],
      [cx, cy + 1, cx * 2, cy * 2 + 1],
      [cx, cy - 1, cx * 2, cy * 2 - 1],
    ].filter(([nx, ny]) => nx >= 0 && nx < CELLS_PER_SIDE && ny >= 0 && ny < CELLS_PER_SIDE && !visited[ny][nx]);

    if (!neighbors.length) {
      stack.pop();
      continue;
    }

    step += 1;
    const pickIndex = Math.floor(seededRandom(chunkX, chunkY, step * 131 + cx * 17 + cy * 29) * neighbors.length);
    const [nx, ny, wallX, wallY] = neighbors[pickIndex];
    visited[ny][nx] = true;
    grid[wallY][wallX] = 0; // knock down the wall between the two cells
    grid[ny * 2][nx * 2] = 0;
    stack.push([nx, ny]);
  }
};

// NOTE: this maze used to "braid" extra loops into the spanning tree so
// alternate routes existed. That's exactly what made it feel like open
// space with too few dead ends. It has been removed on purpose — the grid
// carved by carveSpanningTree() is left as a pure spanning tree (no loops,
// "không lai nữa"), so every branch that isn't on the route back to the
// start is a genuine ngõ cụt (dead end).

// BFS every open cell's distance from the chunk's start cell, then collect
// every dead end (an open cell with exactly one open neighbour) sorted by
// how far it is from the start. Used to give each chunk 3-4 candidate
// "farthest" points so a chunk's exit/landmark position can be picked at
// random per chunk/server instance instead of always the same fixed corner.
const findFarthestDeadEnds = (grid, startX, startY) => {
  const dist = Array.from({ length: CHUNK_SIZE }, () => Array(CHUNK_SIZE).fill(-1));
  const queue = [[startX, startY]];
  dist[startY][startX] = 0;
  let qi = 0;
  while (qi < queue.length) {
    const [x, y] = queue[qi];
    qi += 1;
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE) continue;
      if (grid[ny][nx] !== 0 || dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[y][x] + 1;
      queue.push([nx, ny]);
    }
  }

  const deadEnds = [];
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      if (grid[y][x] !== 0 || dist[y][x] <= 0) continue;
      let openNeighbors = 0;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE) continue;
        if (grid[ny][nx] === 0) openNeighbors += 1;
      }
      if (openNeighbors === 1) deadEnds.push({ x, y, dist: dist[y][x] });
    }
  }

  deadEnds.sort((a, b) => b.dist - a.dist);
  return deadEnds.slice(0, 4); // farthest 3-4 dead ends in this chunk
};

// Places traps on open tiles, but only where a trap doesn't seal off the
// only remaining route: before committing a trap tile, BFS the graph of
// still-open (non-trapped) tiles from a fixed reference point and confirm
// removing this tile keeps everything else reachable. If it doesn't, the
// tile is a bridge — skip it so the maze never becomes unsolvable.
const placeTraps = (grid, chunkX, chunkY) => {
  const traps = [];
  const blocked = Array.from({ length: CHUNK_SIZE }, () => Array(CHUNK_SIZE).fill(false));

  const countReachable = (fromX, fromY) => {
    const seen = Array.from({ length: CHUNK_SIZE }, () => Array(CHUNK_SIZE).fill(false));
    const queue = [[fromX, fromY]];
    seen[fromY][fromX] = true;
    let count = 0;
    while (queue.length) {
      const [x, y] = queue.pop();
      count += 1;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE) continue;
        if (seen[ny][nx] || grid[ny][nx] !== 0 || blocked[ny][nx]) continue;
        seen[ny][nx] = true;
        queue.push([nx, ny]);
      }
    }
    return count;
  };

  // Reference point + baseline reachable count, computed once before any
  // traps exist.
  let refX = -1;
  let refY = -1;
  outer:
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      if (grid[y][x] === 0) { refX = x; refY = y; break outer; }
    }
  }
  if (refX === -1) return traps; // shouldn't happen — the spanning tree always opens cell (0,0)

  let baselineReachable = countReachable(refX, refY);

  const distance = Math.sqrt(chunkX * chunkX + chunkY * chunkY);
  const trapChance = Math.min(0.42, 0.22 + distance * 0.015); // denser further from spawn

  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      if (grid[y][x] !== 0 || blocked[y][x]) continue;
      if (x === refX && y === refY) continue;
      // Keep a little breathing room around already-placed traps so they
      // read as scattered hazards rather than a solid wall of spikes.
      const tooClose = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
        .some(([nx, ny]) => nx >= 0 && nx < CHUNK_SIZE && ny >= 0 && ny < CHUNK_SIZE && blocked[ny][nx]);
      if (tooClose) continue;
      if (seededRandom(chunkX + x, chunkY + y, 311) >= trapChance) continue;

      blocked[y][x] = true;
      const stillReachable = countReachable(refX, refY);
      if (stillReachable < baselineReachable - 1) {
        // This tile was a bridge — trapping it would strand another part
        // of the maze (or force the player through it). Undo and move on.
        blocked[y][x] = false;
      } else {
        baselineReachable = stillReachable;
        const absX = (chunkX * CHUNK_SIZE + x) * TILE_SIZE;
        const absY = (chunkY * CHUNK_SIZE + y) * TILE_SIZE;
        traps.push({ x: absX, y: absY });
      }
    }
  }

  return traps;
};

const generateChunk = (chunkX, chunkY) => {
  const key = getChunkKey(chunkX, chunkY);
  if (generatedChunks[key]) return generatedChunks[key];

  const grid = createEmptyGrid();
  carveSpanningTree(grid, chunkX, chunkY); // guarantees full connectivity, pure tree — lots of dead ends
  const traps = placeTraps(grid, chunkX, chunkY); // guaranteed not to block the only path

  // 3-4 farthest dead ends in this chunk, computed once and picked from at
  // random (per chunk, seeded — so every server/world instance still gets
  // a different but reproducible pick, no two chunks "lai" the same spot).
  const farthestDeadEnds = findFarthestDeadEnds(grid, 0, 0);
  let exitX = (CELLS_PER_SIDE - 1) * 2;
  let exitY = (CELLS_PER_SIDE - 1) * 2;
  if (farthestDeadEnds.length) {
    const pickIndex = Math.min(
      farthestDeadEnds.length - 1,
      Math.floor(seededRandom(chunkX, chunkY, 919) * farthestDeadEnds.length)
    );
    exitX = farthestDeadEnds[pickIndex].x;
    exitY = farthestDeadEnds[pickIndex].y;
  }

  const chunk = { grid, traps, entryX: 0, entryY: 0, exitX, exitY, farthestDeadEnds };
  generatedChunks[key] = chunk;
  return chunk;
};

const getPlayerDistance = (player) => {
  return Math.sqrt(player.x * player.x + player.y * player.y);
};

// Turns the current chunk's randomly-picked farthest dead end into an
// absolute world-pixel point, so the client can show it as a goal marker.
// This is what farthestDeadEnds/exitX/exitY were computed for — previously
// they were stored on the chunk but never actually reached the client.
const getPlayerWaypoint = (player) => {
  const tileX = Math.floor(player.x / TILE_SIZE);
  const tileY = Math.floor(player.y / TILE_SIZE);
  const chunkX = Math.floor(tileX / CHUNK_SIZE);
  const chunkY = Math.floor(tileY / CHUNK_SIZE);
  const chunk = generatedChunks[getChunkKey(chunkX, chunkY)];
  if (!chunk) return null;
  return {
    x: (chunkX * CHUNK_SIZE + chunk.exitX) * TILE_SIZE + TILE_SIZE / 2,
    y: (chunkY * CHUNK_SIZE + chunk.exitY) * TILE_SIZE + TILE_SIZE / 2,
  };
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

// Instead of A*-cutting straight toward the player's *current* spot, the bot
// retraces the exact tiles the player has already walked, in order — like
// following footprints. Each room.bot.followIndexByPlayer[id] is how far
// along that player's trail the bot has walked to so far. If a player
// hasn't left enough of a trail yet (start of the run, or the bot just
// switched target), we fall back to moveBotAlongPath's A* chase so the bot
// isn't stuck standing still.
// Finds the point in `trail` closest to (x, y) in world pixels. Used the
// first time the bot ever targets a given player, so it starts following
// their trail from wherever is physically nearest instead of all the way
// back at their spawn point.
const findNearestTrailIndex = (trail, x, y) => {
  let bestIdx = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < trail.length; i += 1) {
    const dx = trail[i].x * TILE_SIZE - x;
    const dy = trail[i].y * TILE_SIZE - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIdx = i;
    }
  }
  return bestIdx;
};

const moveBotAlongPlayerTrail = (room, target) => {
  const bot = room.bot;
  const trail = target.trail || [];

  if (trail.length < 2) {
    moveBotAlongPath(room, target);
    return;
  }

  if (!room.bot.followIndexByPlayer) room.bot.followIndexByPlayer = {};
  let idx = room.bot.followIndexByPlayer[target.id];
  if (idx === undefined) {
    idx = findNearestTrailIndex(trail, bot.x, bot.y);
  }
  if (idx >= trail.length) idx = trail.length - 1;

  const nextTile = trail[idx];
  const targetX = nextTile.x * TILE_SIZE;
  const targetY = nextTile.y * TILE_SIZE;
  const dx = targetX - bot.x;
  const dy = targetY - bot.y;
  const distance = Math.hypot(dx, dy);

  if (distance <= bot.speed || distance === 0) {
    bot.x = targetX;
    bot.y = targetY;
    idx = Math.min(idx + 1, trail.length - 1);
  } else {
    const ratio = bot.speed / distance;
    bot.x += dx * ratio;
    bot.y += dy * ratio;
  }

  room.bot.followIndexByPlayer[target.id] = idx;
};

// Rebalanced from the previous pass: +3%/second compounding hit the 1.6x
// speed cap after only ~20s, leaving 80% of a 2-minute match with no rising
// tension. +0.4%/second reaches a gentler 1.45x cap around the ~90s mark
// instead — pressure builds across most of the match and only maxes out
// for a tense final stretch, rather than the bot going instantly deadly.
const BOT_SPEED_RAMP_PER_SECOND = 0.004;
const BOT_MAX_SPEED_MULTIPLIER = 1.45;

// How much closer (in px) a different player has to be before the bot will
// actually switch off its current target. Without this, two players at
// near-equal distance made the bot flip targets almost every 100ms tick —
// and since it now retraces trails instead of live-pathfinding, a flip
// meant visibly jumping into a completely different corridor.
const BOT_TARGET_SWITCH_MARGIN = TILE_SIZE * 4;

const startRoomBotLoop = (roomId) => {
  if (!rooms[roomId]) return;
  if (!roomIntervals[roomId]) roomIntervals[roomId] = {};
  if (roomIntervals[roomId].bot) return;

  roomIntervals[roomId].bot = setInterval(() => {
    const room = rooms[roomId];
    if (!room || !room.players.length) return;
    const activePlayers = room.players.map((id) => players[id]).filter(Boolean);
    if (!activePlayers.length) return;

    let nearest = activePlayers[0];
    let nearestDist = Math.abs(room.bot.x - nearest.x) + Math.abs(room.bot.y - nearest.y);
    for (let i = 1; i < activePlayers.length; i += 1) {
      const candidate = activePlayers[i];
      const d = Math.abs(room.bot.x - candidate.x) + Math.abs(room.bot.y - candidate.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = candidate;
      }
    }

    let target = nearest;
    if (room.bot.currentTargetId && room.bot.currentTargetId !== nearest.id) {
      const current = activePlayers.find((p) => p.id === room.bot.currentTargetId);
      if (current) {
        const currentDist = Math.abs(room.bot.x - current.x) + Math.abs(room.bot.y - current.y);
        if (currentDist - nearestDist < BOT_TARGET_SWITCH_MARGIN) {
          target = current; // nearest isn't clearly closer enough to justify switching
        }
      }
    }
    room.bot.currentTargetId = target.id;

    // Bot speed ramps up by a fixed percentage every second the match has
    // been running (measured from when the countdown ended, not from room
    // creation, so waiting in the lobby/countdown never counts against the
    // player), capped so it can never wildly outrun the player.
    const elapsed = Date.now() - (room.startedAt || room.createdAt);
    const secondsElapsed = Math.floor(elapsed / 1000);
    const maxSpeed = (target.speed || 4) * BOT_MAX_SPEED_MULTIPLIER;
    const baseSpeed = 3.5 * Math.pow(1 + BOT_SPEED_RAMP_PER_SECOND, secondsElapsed);
    room.bot.speed = Math.min(baseSpeed, maxSpeed);

    moveBotAlongPlayerTrail(room, target);
  }, 100);
};

const clearRoomIntervals = (roomId) => {
  if (!roomIntervals[roomId]) return;
  if (roomIntervals[roomId].countdown) clearInterval(roomIntervals[roomId].countdown);
  if (roomIntervals[roomId].update) clearInterval(roomIntervals[roomId].update);
  if (roomIntervals[roomId].bot) clearInterval(roomIntervals[roomId].bot);
  if (roomIntervals[roomId].matchTimeout) clearTimeout(roomIntervals[roomId].matchTimeout);
  delete roomIntervals[roomId];
};

const MATCH_TIME_LIMIT_MS = 120000; // 2 minutes, PvP (2-player) rooms only

// When time runs out in a PvP match, whoever has covered less distance loses
// (matches the "AI CHẾT TRƯỚC HOẶC XA ĐÍCH HƠN SẼ THUA" rule). Re-uses the
// same player_died flow the death-by-collision path uses, so the client
// needs no new event listener.
const startMatchTimer = (roomId) => {
  if (!rooms[roomId]) return;
  roomIntervals[roomId] = roomIntervals[roomId] || {};
  if (roomIntervals[roomId].matchTimeout) return;

  roomIntervals[roomId].matchTimeout = setTimeout(() => {
    const room = rooms[roomId];
    if (!room || room.finished) return;
    const entries = room.players
      .map((id) => ({ id, player: players[id] }))
      .filter((entry) => entry.player);
    if (entries.length < 2) return; // solo runs don't time out this way

    entries.sort((a, b) => (a.player.distance || 0) - (b.player.distance || 0));
    const loser = entries[0];
    const winnerEntry = entries[entries.length - 1];

    room.finished = true;
    io.to(roomId).emit('player_died', {
      loserId: loser.id,
      finalTime: Date.now() - (room.startedAt || Date.now()),
      reason: 'time_up',
    });

    try {
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
  }, MATCH_TIME_LIMIT_MS);
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
    waypoint: getPlayerWaypoint(player),
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

  perPlayer.forEach(({ id, player, traps, chunks, waypoint }) => {
    const opponentEntry = perPlayer.find((entry) => entry.id !== id);
    const update = {
      you: { x: player.x, y: player.y, distance: getPlayerDistance(player) },
      opponent: opponentEntry
        ? { x: opponentEntry.player.x, y: opponentEntry.player.y, distance: getPlayerDistance(opponentEntry.player) }
        : null,
      bot: room.bot,
      traps,
      chunks,
      waypoint,
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
  rooms[roomId].countdownActive = true; // player_move ignores input while this is true
  roomIntervals[roomId] = roomIntervals[roomId] || {};
  let count = 3;
  roomIntervals[roomId].countdown = setInterval(() => {
    io.to(roomId).emit('match_countdown', count);
    if (count <= 0) {
      clearInterval(roomIntervals[roomId].countdown);
      roomIntervals[roomId].countdown = null;
      const room = rooms[roomId];
      if (room) {
        room.startedAt = Date.now();
        room.countdownActive = false;
        if (room.players.length === 2) startMatchTimer(roomId);
      }
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

    const freeA = isPlayerFree(playerA);
    const freeB = isPlayerFree(playerB);
    if (!freeA || !freeB) {
      // Whoever is still connected and free goes back to the front of the
      // queue to wait for the next candidate; whoever is gone or already
      // mid-match elsewhere is dropped instead of being force-matched.
      if (freeA) matchmakingQueue.unshift(playerIdA);
      if (freeB) matchmakingQueue.unshift(playerIdB);
      if (!freeA && !freeB) continue; // both unusable — keep draining the queue
      break; // one side is waiting on a fresh opponent
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
      timeLimitMs: MATCH_TIME_LIMIT_MS,
    };
    const payloadB = {
      roomId,
      seed: rooms[roomId].seed,
      opponent: playerA.name || `Player_${playerIdA.slice(-4)}`,
      timeLimitMs: MATCH_TIME_LIMIT_MS,
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
    player.trail = []; // fresh spawn — old trail would point at the previous run's maze

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
      trail: [],
    };
    players[socket.id].name = data.name || players[socket.id].name;

    if (!isPlayerFree(players[socket.id])) {
      socket.emit('find_match_failed', { message: 'Bạn đang trong một trận đấu khác.' });
      return;
    }

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
      trail: [],
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

  // Player backed out of the "waiting for opponent" screen without ever
  // getting matched — drop their public listing (if any) so it doesn't
  // keep showing up to others as "waiting" forever.
  socket.on('leave_public_room', () => {
    removePublicRoomByHostId(socket.id);
  });

  socket.on('join_public_room', (roomId) => {
    const publicRoom = resolvePublicRoom(roomId);
    if (!publicRoom || publicRoom.status !== 'waiting') {
      socket.emit('join_public_room_failed', { message: 'Room unavailable or already started.' });
      return;
    }

    const hostSocketId = publicRoom.roomId;
    const guestSocketId = socket.id;

    if (guestSocketId === hostSocketId) {
      socket.emit('join_public_room_failed', { message: 'Không thể tự vào phòng của chính bạn.' });
      return;
    }

    const hostPlayer = players[hostSocketId];
    const guestPlayer = players[guestSocketId];
    if (!hostPlayer || !guestPlayer) {
      socket.emit('join_public_room_failed', { message: 'Both players must be connected and ready.' });
      return;
    }

    if (!isPlayerFree(hostPlayer)) {
      // Host wandered into another match/run without properly leaving this
      // listing — clean the stale listing up instead of double-booking them.
      removePublicRoomByHostId(hostSocketId);
      socket.emit('join_public_room_failed', { message: 'Chủ phòng đang trong một trận đấu khác.' });
      return;
    }
    if (!isPlayerFree(guestPlayer)) {
      socket.emit('join_public_room_failed', { message: 'Bạn đang trong một trận đấu khác.' });
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
      timeLimitMs: MATCH_TIME_LIMIT_MS,
    };
    const payloadGuest = {
      roomId: matchRoomId,
      seed: rooms[matchRoomId].seed,
      opponent: hostPlayer.name || `Player_${hostSocketId.slice(-4)}`,
      timeLimitMs: MATCH_TIME_LIMIT_MS,
    };
    if (socketHost) socketHost.emit('match_start', payloadHost);
    if (socketGuest) socketGuest.emit('match_start', payloadGuest);

    startRoomCountdown(matchRoomId);
  });

  socket.on('player_move', (dir) => {
    const player = players[socket.id];
    if (!player) return;

    // Frozen during the pre-match countdown — this is the authoritative
    // check; the client also avoids sending input during this window, but
    // we don't trust that alone.
    if (player.roomId && rooms[player.roomId] && rooms[player.roomId].countdownActive) return;

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

      // Record the tile the player just entered so the bot can retrace the
      // exact route later (see moveBotAlongPlayerTrail). Only append on an
      // actual tile change, not every 60Hz tick, so the trail stays a clean
      // list of distinct stepping stones instead of thousands of duplicates.
      if (!player.trail) player.trail = [];
      const lastStep = player.trail[player.trail.length - 1];
      if (!lastStep || lastStep.x !== tileX || lastStep.y !== tileY) {
        player.trail.push({ x: tileX, y: tileY });
        // Safety cap — a 2-minute match at normal speed leaves a trail far
        // shorter than this, but this keeps memory bounded either way.
        if (player.trail.length > 4000) player.trail.shift();
      }
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
