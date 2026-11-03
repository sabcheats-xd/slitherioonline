const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server, perMessageDeflate: { zlibDeflateOptions: { level: 1 } } });
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('HTTP+WS server on port ' + PORT));

const WORLD = 4000;
const FOOD_COUNT = 200;
const TICK_MS = 1000 / 60;

let players = {};
let foods = [];
let nextId = 1;

function rand(a, b) { return a + Math.random() * (b - a); }
function makeSegs(x, y) {
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push({ x: x - i * 6, y });
  return segs;
}
function spawnFood() {
  foods.push({ x: rand(0, WORLD), y: rand(0, WORLD), r: 3, value: 1, color: '#d29922' });
  if (foods.length > FOOD_COUNT) foods.splice(0, foods.length - FOOD_COUNT);
}
for (let i = 0; i < FOOD_COUNT; i++) spawnFood();

function killPlayer(id) {
  const p = players[id];
  if (!p || !p.alive) return;
  p.alive = false;
  for (const seg of p.snake) {
    if (Math.random() < 0.4) foods.push({ x: seg.x + rand(-3, 3), y: seg.y + rand(-3, 3), r: 4, value: 2, color: p.color });
  }
  setTimeout(() => {
    if (players[id]) {
      players[id].snake = makeSegs(rand(200, WORLD - 200), rand(200, WORLD - 200));
      players[id].targetLen = 20;
      players[id].alive = true;
      players[id].dir = 0;
      players[id].boost = 0;
      players[id].boostTimer = 0;
    }
  }, 3000);
}

function tick() {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    if (p.inputAngle !== undefined) p.dir = p.inputAngle;
    if (p.boostRequested && p.snake.length > 22) p.boostTimer = Math.min(60, p.boostTimer + 2);
    else p.boostTimer = Math.max(0, p.boostTimer - 1);
    p.boost = p.boostTimer;
    const sp = p.boost > 0 ? 5.0 * 1.6 : 5.0;
    const head = p.snake[0];
    const nx = head.x + Math.cos(p.dir) * sp;
    const ny = head.y + Math.sin(p.dir) * sp;
    p.snake.unshift({ x: nx, y: ny });
    if (p.boost > 0 && p.snake.length > 20 && Math.random() < 0.18) {
      const tail = p.snake.pop();
      if (tail) {
        p.targetLen = Math.max(20, p.targetLen - 1);
        foods.push({ x: tail.x + rand(-3, 3), y: tail.y + rand(-3, 3), r: 3, value: 1, color: p.color });
      }
    }
    while (p.snake.length > p.targetLen) p.snake.pop();
    // eat
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      if (Math.hypot(f.x - p.snake[0].x, f.y - p.snake[0].y) < 8 + f.r) {
        p.targetLen += f.value;
        foods.splice(i, 1);
        spawnFood();
      }
    }
    const h = p.snake[0];
    if (h.x < 0 || h.x > WORLD || h.y < 0 || h.y > WORLD) killPlayer(id);
  }

  const alivePlayers = Object.values(players).filter(p => p.alive);
  // head-to-head
  for (let a = 0; a < alivePlayers.length; a++) {
    for (let b = a + 1; b < alivePlayers.length; b++) {
      const A = alivePlayers[a], B = alivePlayers[b];
      if (Math.hypot(A.snake[0].x - B.snake[0].x, A.snake[0].y - B.snake[0].y) < 12) {
        if (A.snake.length > B.snake.length) { A.targetLen += B.snake.length; killPlayer(B.id); }
        else if (B.snake.length > A.snake.length) { B.targetLen += A.snake.length; killPlayer(A.id); }
        else { killPlayer(A.id); killPlayer(B.id); }
      }
    }
  }
  for (const p of alivePlayers) {
    if (!p.alive) continue;
    const h = p.snake[0];
    for (const other of alivePlayers) {
      if (other === p || !other.alive) continue;
      for (let i = 5; i < other.snake.length; i += 2) {
        if (Math.hypot(h.x - other.snake[i].x, h.y - other.snake[i].y) < 6) { killPlayer(p.id); break; }
      }
      if (!p.alive) break;
    }
  }

  const state = {
    type: 'state',
    players: Object.values(players).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, segs: p.snake })),
    foods: foods.map(f => ({ x: f.x, y: f.y, r: f.r, color: f.color })),
  };
  const msg = JSON.stringify(state);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const color = `hsl(${Math.random() * 360}, 70%, 55%)`;
  players[id] = {
    id, ws, name: 'Игрок', color,
    snake: makeSegs(rand(200, WORLD - 200), rand(200, WORLD - 200)),
    dir: 0, boost: 0, boostTimer: 0, targetLen: 20, alive: true,
    inputAngle: 0, boostRequested: false,
  };
  ws.send(JSON.stringify({ type: 'welcome', id, world: WORLD }));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') players[id].name = msg.name || 'Игрок';
      if (msg.type === 'input') { players[id].inputAngle = msg.angle; players[id].boostRequested = !!msg.boost; }
    } catch (e) { }
  });
  ws.on('close', () => { delete players[id]; });
});

setInterval(tick, TICK_MS);
console.log('Multiplayer server running on ws://localhost:8080');
