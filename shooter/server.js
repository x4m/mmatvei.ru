/* ============================================================
   NEON LABYRINTH — сервер мультиплеерного шутера
   Запуск:  npm install  →  node server.js  (порт 8080)
   Матчи 5 на 5 слотов: свободные места занимают боты.
   ============================================================ */
"use strict";
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SERVER_NAME = process.env.SERVER_NAME || 'Лабиринт · Локальный';

/* ---------- параметры матча ---------- */
const MAX_SLOTS  = 5;                 // всего бойцов на карте (люди + боты)
const HP_MAX     = 100;
const MATCH_MS   = (+process.env.MATCH_SEC || 300) * 1000;   // матч 5 минут
const BREAK_MS   = (+process.env.BREAK_SEC || 12)  * 1000;   // перерыв между матчами
const LOBBY_MS   = (+process.env.LOBBY_SEC || 15)  * 1000;   // ждём живых игроков, потом добиваем ботами
const RESPAWN_MS = 3000;
const SNAP_HZ    = 20;                // рассылка снапшотов
const TICK_HZ    = 30;                // симуляция ботов

/* ---------- оружие ---------- */
const DMG_BODY = 20, DMG_HEAD = 45;   // 5 попаданий в корпус = смерть
const RANGE = 90, MIN_SHOT_MS = 85;   // ограничение скорострельности (античит)

/* гранатомёт */
const NADE_SPEED = 34, NADE_G = 22, NADE_FUSE = 3000, MIN_NADE_MS = 650;
const BOOM_R = 6.5, BOOM_DMG = 85, SELF_MULT = 0.45;   //自 урон меньше — иначе rocket jump смертелен

/* награда за серию */
const HEAL_EVERY = 3;                 // каждые 3 убитых — полное здоровье

/* ---------- вышки ---------- */
/* Ступенчатая пирамида. Два жёстких условия, иначе вышка ломает карту:
   · каждый ярус уже предыдущего минимум на габарит бойца (0.75) — иначе
     на нижнем ярусе негде стоять, верхний выталкивает;
   · подъём между ярусами не выше прыжка (0.86) с запасом на шаг (0.6). */
const TOWER_TIERS = [
  { half: 2.2, top: 1.2 },     // на него запрыгиваешь с земли
  { half: 1.0, top: 4.5 },     // мачта: сюда только rocket jump-ом
];
const STEP = 0.7;                     // на сколько можно шагнуть вверх без прыжка

/* ---------- геометрия арены ---------- */
const ARENA_R = 58;                   // радиус круглой арены (как в исходной карте)
const CELL = 9, COLS = 13, ROWS = 13; // сетка лабиринта
const THICK = 1.1, WALL_H = 6;
const ORIGIN_X = -COLS * CELL / 2, ORIGIN_Z = -ROWS * CELL / 2;
const R_ACTIVE = ARENA_R - CELL * 0.55;

/* ---------- хитбокс бойца ---------- */
const EYE = 1.62, HEAD_Y = 1.45, BODY_TOP = 1.80, P_RAD = 0.55, MOVE_RAD = 0.75;

const BOT_NAMES = ['Вихрь','Сокол','Гром','Тень','Кобра','Рысь','Фантом','Титан',
                   'Скорпион','Барс','Призрак','Вектор','Сумрак','Клинок'];

/* ============================================================
   Генерация лабиринта
   ============================================================ */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function buildMaze(seed){
  const rnd = mulberry32(seed);
  const N = COLS * ROWS;
  const cx = i => ORIGIN_X + i * CELL + CELL / 2;
  const cz = j => ORIGIN_Z + j * CELL + CELL / 2;

  /* активная зона — вписанный круг, чтобы карта осталась круглой ареной */
  const active = new Array(N).fill(false);
  for(let j = 0; j < ROWS; j++) for(let i = 0; i < COLS; i++)
    active[j*COLS+i] = Math.hypot(cx(i), cz(j)) <= R_ACTIVE;

  const key = (a,b) => a < b ? a+'_'+b : b+'_'+a;
  const linked = new Set();
  const gridNbrs = idx => {
    const i = idx % COLS, j = (idx / COLS) | 0, r = [];
    if(i > 0)        r.push(idx-1);
    if(i < COLS-1)   r.push(idx+1);
    if(j > 0)        r.push(idx-COLS);
    if(j < ROWS-1)   r.push(idx+COLS);
    return r.filter(n => active[n]);
  };

  /* 1. остовное дерево (случайный DFS) — гарантирует связность */
  const start = active.indexOf(true);
  const seen = new Set([start]);
  const stack = [start];
  while(stack.length){
    const cur = stack[stack.length-1];
    const free = gridNbrs(cur).filter(n => !seen.has(n));
    if(!free.length){ stack.pop(); continue; }
    const nx = free[(rnd()*free.length)|0];
    linked.add(key(cur,nx)); seen.add(nx); stack.push(nx);
  }

  /* 2. «заплетаем» лабиринт — часть стен убираем, чтобы не было тупиков-ловушек */
  for(let idx = 0; idx < N; idx++){
    if(!active[idx]) continue;
    for(const n of gridNbrs(idx)){
      if(n < idx) continue;
      if(!linked.has(key(idx,n)) && rnd() < 0.24) linked.add(key(idx,n));
    }
  }

  /* 3. открытые площадки. Вышки ставим только сюда и снимаем у клетки все стены:
     иначе основание вышки затыкает клетку — между ним и стеной боец не пролезает,
     и лабиринт разваливается на изолированные куски. */
  const cells = [];
  for(let idx = 0; idx < N; idx++) if(active[idx]) cells.push(idx);

  const towers = [];
  const roomy = cells.filter(idx => gridNbrs(idx).length === 4)
                     .sort(() => rnd() - 0.5);
  for(const idx of roomy){
    if(towers.length >= 4) break;
    const tx = cx(idx%COLS), tz = cz((idx/COLS)|0);
    if(towers.some(t => Math.hypot(t.x-tx, t.z-tz) < 20)) continue;
    for(const n of gridNbrs(idx)) linked.add(key(idx,n));   // клетка становится площадкой
    towers.push({ idx, x: tx, z: tz });
  }
  for(let k = 0; k < 3; k++){                                // ещё немного простора
    const c = cells[(rnd()*cells.length)|0];
    for(const n of gridNbrs(c)) linked.add(key(c,n));
  }

  /* 4. список смежности для навигации ботов */
  const nbrs = new Array(N);
  for(const idx of cells) nbrs[idx] = gridNbrs(idx).filter(n => linked.has(key(idx,n)));

  /* 5. стены: вертикальные и горизонтальные отрезки, слитые в длинные блоки */
  const vRuns = {}, hRuns = {};
  for(let j = 0; j < ROWS; j++) for(let i = -1; i < COLS; i++){
    const a = i >= 0 ? j*COLS+i : -1, b = i+1 < COLS ? j*COLS+i+1 : -1;
    const aa = a >= 0 && active[a], ab = b >= 0 && active[b];
    if(!aa && !ab) continue;
    if(aa && ab && linked.has(key(a,b))) continue;
    (vRuns[i] || (vRuns[i] = [])).push(j);
  }
  for(let i = 0; i < COLS; i++) for(let j = -1; j < ROWS; j++){
    const a = j >= 0 ? j*COLS+i : -1, b = j+1 < ROWS ? (j+1)*COLS+i : -1;
    const aa = a >= 0 && active[a], ab = b >= 0 && active[b];
    if(!aa && !ab) continue;
    if(aa && ab && linked.has(key(a,b))) continue;
    (hRuns[j] || (hRuns[j] = [])).push(i);
  }

  const walls = [];
  const addBox = (x, z, hw, hd) => walls.push({
    x, z, hw, hd, x0: x-hw, x1: x+hw, z0: z-hd, z1: z+hd
  });
  const merge = (arr) => {                       // [3,4,5,8,9] → [[3,5],[8,9]]
    arr.sort((a,b)=>a-b);
    const out = []; let s = arr[0], p = arr[0];
    for(let k = 1; k < arr.length; k++){
      if(arr[k] === p+1){ p = arr[k]; continue; }
      out.push([s,p]); s = p = arr[k];
    }
    out.push([s,p]); return out;
  };
  for(const i in vRuns){
    const xline = ORIGIN_X + (Number(i)+1) * CELL;
    for(const [j1,j2] of merge(vRuns[i])){
      const z1 = ORIGIN_Z + j1*CELL, z2 = ORIGIN_Z + (j2+1)*CELL;
      addBox(xline, (z1+z2)/2, THICK/2, (z2-z1)/2 + THICK/2);
    }
  }
  for(const j in hRuns){
    const zline = ORIGIN_Z + (Number(j)+1) * CELL;
    for(const [i1,i2] of merge(hRuns[j])){
      const x1 = ORIGIN_X + i1*CELL, x2 = ORIGIN_X + (i2+1)*CELL;
      addBox((x1+x2)/2, zline, (x2-x1)/2 + THICK/2, THICK/2);
    }
  }

  /* 6. точки респавна — просторные клетки без вышки */
  const spawns = cells.filter(idx => nbrs[idx].length >= 2 && !towers.some(t => t.idx === idx))
                      .map(idx => ({ idx, x: cx(idx%COLS), z: cz((idx/COLS)|0) }));

  /* 7. единый список объёмов для физики: стены до потолка + ярусы вышек */
  const solids = walls.map(w => ({ x0:w.x0, x1:w.x1, z0:w.z0, z1:w.z1, y1: WALL_H }));
  for(const t of towers) for(const tier of TOWER_TIERS)
    solids.push({ x0:t.x-tier.half, x1:t.x+tier.half,
                  z0:t.z-tier.half, z1:t.z+tier.half, y1: tier.top });

  return { seed, walls, towers, solids, cells, nbrs, active, spawns,
           cell: CELL, cols: COLS, rows: ROWS,
           originX: ORIGIN_X, originZ: ORIGIN_Z, arenaR: ARENA_R, wallH: WALL_H };
}

function cellOf(x, z){
  const i = Math.floor((x - ORIGIN_X) / CELL), j = Math.floor((z - ORIGIN_Z) / CELL);
  if(i < 0 || j < 0 || i >= COLS || j >= ROWS) return -1;
  return j*COLS + i;
}
function cellCenter(idx){
  return { x: ORIGIN_X + (idx%COLS)*CELL + CELL/2,
           z: ORIGIN_Z + ((idx/COLS)|0)*CELL + CELL/2 };
}

/* ============================================================
   Физика: столкновения и трассировка луча
   ============================================================ */
/* Объём ниже ног (с запасом на шаг) не мешает — на него можно зайти сверху.
   Поэтому столкновения зависят от текущей высоты бойца. */
function resolveSolids(solids, e, rad){
  const feet = e.y || 0;
  for(let pass = 0; pass < 3; pass++){
    let touched = false;
    for(const w of solids){
      if(w.y1 <= feet + STEP) continue;
      const nx = Math.max(w.x0, Math.min(e.x, w.x1));
      const nz = Math.max(w.z0, Math.min(e.z, w.z1));
      const dx = e.x - nx, dz = e.z - nz;
      const d2 = dx*dx + dz*dz;
      if(d2 >= rad*rad) continue;
      touched = true;
      const d = Math.sqrt(d2);
      if(d < 1e-6){                                  // центр внутри блока
        const l = e.x - w.x0, r = w.x1 - e.x, t = e.z - w.z0, b = w.z1 - e.z;
        const m = Math.min(l, r, t, b);
        if(m === l) e.x = w.x0 - rad;
        else if(m === r) e.x = w.x1 + rad;
        else if(m === t) e.z = w.z0 - rad;
        else e.z = w.z1 + rad;
      } else {
        const push = (rad - d) / d;
        e.x += dx * push; e.z += dz * push;
      }
    }
    if(!touched) break;
  }
  const rr = Math.hypot(e.x, e.z);
  if(rr > ARENA_R - 1.2){ const k = (ARENA_R - 1.2) / rr; e.x *= k; e.z *= k; }
}

/* высота опоры под точкой: пол или крыша яруса вышки */
function groundAt(solids, x, z, feetY){
  let g = 0;
  for(const w of solids){
    if(w.y1 > feetY + STEP) continue;
    if(x < w.x0 || x > w.x1 || z < w.z0 || z > w.z1) continue;
    if(w.y1 > g) g = w.y1;
  }
  return g;
}

/* дистанция до ближайшего препятствия вдоль луча (полный 3D-тест: у вышек есть верх) */
function raySolids(solids, ox, oy, oz, dx, dy, dz, maxD){
  let best = maxD;
  for(const w of solids){
    let t0 = 0, t1 = best;
    if(Math.abs(dx) < 1e-9){ if(ox < w.x0 || ox > w.x1) continue; }
    else {
      let ta = (w.x0-ox)/dx, tb = (w.x1-ox)/dx;
      if(ta > tb){ const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if(t0 > t1) continue;
    }
    if(Math.abs(dy) < 1e-9){ if(oy < 0 || oy > w.y1) continue; }
    else {
      let ta = (0-oy)/dy, tb = (w.y1-oy)/dy;
      if(ta > tb){ const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if(t0 > t1) continue;
    }
    if(Math.abs(dz) < 1e-9){ if(oz < w.z0 || oz > w.z1) continue; }
    else {
      let ta = (w.z0-oz)/dz, tb = (w.z1-oz)/dz;
      if(ta > tb){ const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if(t0 > t1) continue;
    }
    if(t1 < 0) continue;
    if(t0 < best) best = Math.max(0, t0);
  }
  return best;
}

/* точка внутри объёма — для подрыва гранаты при касании */
function insideSolid(solids, x, y, z, r){
  for(const w of solids)
    if(x > w.x0-r && x < w.x1+r && z > w.z0-r && z < w.z1+r && y < w.y1+r) return true;
  return false;
}

/* пересечение луча с цилиндром бойца → расстояние или null */
function rayPlayer(ox, oy, oz, dx, dy, dz, p, rad){
  const fx = ox - p.x, fz = oz - p.z;
  const a = dx*dx + dz*dz;
  if(a < 1e-9) return null;
  const b = 2*(fx*dx + fz*dz);
  const c = fx*fx + fz*fz - rad*rad;
  const disc = b*b - 4*a*c;
  if(disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2*a);
  if(t < 0) t = (-b + sq) / (2*a);
  if(t < 0) return null;
  const y = oy + t*dy;
  if(y < p.y || y > p.y + BODY_TOP) return null;
  return { t, y, head: y >= p.y + HEAD_Y };
}

/* ============================================================
   Комнаты
   ============================================================ */
let nextRoomId = 1, nextEntId = 1, nextNadeId = 1;
const rooms = [];

function send(ws, obj){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

class Room {
  constructor(){
    this.id = nextRoomId++;
    this.ents = new Map();
    this.nades = new Map();
    this.maze = buildMaze((Math.random()*1e9)|0);
    this.phase = 'lobby';
    this.matchNum = 0;
    this.endsAt = 0;
    this.lobbyEndsAt = 0;
    this.breakEndsAt = 0;
    console.log(`[комната ${this.id}] создана, seed лабиринта ${this.maze.seed}`);
  }

  humans(){ const a = []; for(const e of this.ents.values()) if(!e.bot) a.push(e); return a; }
  botList(){ const a = []; for(const e of this.ents.values()) if(e.bot) a.push(e); return a; }

  broadcast(obj, exceptId){
    const s = JSON.stringify(obj);
    for(const e of this.ents.values())
      if(!e.bot && e.id !== exceptId && e.ws.readyState === 1) e.ws.send(s);
  }

  /* --- места появления: как можно дальше от живых врагов --- */
  pickSpawn(self){
    const alive = [...this.ents.values()].filter(e => e !== self && e.alive);
    let best = null, bestScore = -1;
    const sp = this.maze.spawns;
    for(let k = 0; k < 14; k++){
      const s = sp[(Math.random()*sp.length)|0];
      let d = 1e9;
      for(const e of alive) d = Math.min(d, Math.hypot(e.x - s.x, e.z - s.z));
      if(d > bestScore){ bestScore = d; best = s; }
    }
    return best || { x: 0, z: 0 };
  }

  /* размещение без оповещения — нужно до отправки welcome, иначе новичок
     получит свой spawn раньше, чем узнает собственный id */
  placeAt(e){
    const s = this.pickSpawn(e);
    e.x = s.x; e.y = 0; e.z = s.z;
    e.yaw = Math.random()*Math.PI*2; e.pitch = 0;
    e.hp = HP_MAX; e.alive = true; e.respawnAt = 0;
    e.mag = 30; e.reloadAt = 0;
    e.path = null; e.pathAt = 0;
  }

  respawn(e){
    this.placeAt(e);
    this.broadcast({ t:'spawn', id:e.id, x:+e.x.toFixed(2), y:0, z:+e.z.toFixed(2), yaw:+e.yaw.toFixed(3) });
  }

  makeEntity(name, bot, ws){
    const e = {
      id: nextEntId++, name, bot: !!bot, ws: ws || null,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      hp: HP_MAX, alive: false, moving: false,
      kills: 0, deaths: 0, respawnAt: 0, noRespawn: false,
      god: false, fly: false,
      lastShot: 0, lastSeen: Date.now(),
      mag: 30, reloadAt: 0,
      /* поля ИИ */
      path: null, pathAt: 0, target: 0, aimAt: 0, burst: 0, strafe: 1, strafeAt: 0,
      stuck: 0, nadeAt: 0, lastNade: 0
    };
    this.ents.set(e.id, e);
    return e;
  }

  addBot(){
    const used = new Set([...this.ents.values()].map(e => e.name));
    const free = BOT_NAMES.filter(n => !used.has(n));
    const name = (free.length ? free : BOT_NAMES)[(Math.random()*(free.length||BOT_NAMES.length))|0];
    const e = this.makeEntity(name, true, null);
    this.respawn(e);
    this.broadcast({ t:'pjoin', p: pub(e) });
    return e;
  }

  fillBots(){
    while(this.ents.size < MAX_SLOTS) this.addBot();
  }

  removeOneBot(){
    const bots = this.botList();
    if(!bots.length) return false;
    const b = bots[bots.length-1];
    this.ents.delete(b.id);
    this.broadcast({ t:'pleave', id: b.id });
    return true;
  }

  join(ws, name){
    if(this.ents.size >= MAX_SLOTS && !this.removeOneBot()) return null;
    const e = this.makeEntity(name, false, ws);
    this.placeAt(e);          // в лобби можно свободно бегать по лабиринту (урона нет)

    send(ws, {
      t: 'welcome',
      id: e.id, room: this.id, server: SERVER_NAME,
      cfg: { hpMax: HP_MAX, slots: MAX_SLOTS, range: RANGE,
             dmgBody: DMG_BODY, dmgHead: DMG_HEAD, eye: EYE,
             respawnMs: RESPAWN_MS, moveRad: MOVE_RAD },
      maze: mazePayload(this.maze),
      phase: this.phase, matchNum: this.matchNum,
      endsAt: this.endsAt, lobbyEndsAt: this.lobbyEndsAt,
      you: { x:e.x, y:e.y, z:e.z, yaw:e.yaw, hp:e.hp, alive:e.alive },
      players: [...this.ents.values()].map(pub)
    });
    this.broadcast({ t:'pjoin', p: pub(e) }, e.id);

    if(this.phase === 'lobby'){
      if(!this.lobbyEndsAt) this.lobbyEndsAt = Date.now() + LOBBY_MS;
      if(this.humans().length >= MAX_SLOTS) this.startMatch();
      else this.broadcast({ t:'lobby', startsAt:this.lobbyEndsAt,
                            humans:this.humans().length, slots:MAX_SLOTS });
    }
    console.log(`[комната ${this.id}] + ${name} (${this.humans().length} живых, всего ${this.ents.size})`);
    return e;
  }

  leave(e){
    this.ents.delete(e.id);
    this.broadcast({ t:'pleave', id:e.id });
    console.log(`[комната ${this.id}] - ${e.name}`);
    if(this.humans().length === 0){
      const i = rooms.indexOf(this);
      if(i >= 0) rooms.splice(i,1);
      console.log(`[комната ${this.id}] пуста, закрыта`);
      return;
    }
    if(this.phase === 'match') this.fillBots();   // место выбывшего занимает бот
  }

  startMatch(){
    this.matchNum++;
    this.phase = 'match';
    this.endsAt = Date.now() + MATCH_MS;
    this.lobbyEndsAt = 0;
    this.maze = buildMaze((Math.random()*1e9)|0);   // новая карта каждый матч
    this.nades.clear();
    this.fillBots();
    for(const e of this.ents.values()){ e.kills = 0; e.deaths = 0; e.noRespawn = false; }
    for(const e of this.ents.values()) this.respawn(e);
    for(const e of this.ents.values()){
      if(e.bot) continue;
      send(e.ws, { t:'matchStart', num:this.matchNum, endsAt:this.endsAt,
        maze: mazePayload(this.maze),
        you: { x:e.x, y:e.y, z:e.z, yaw:e.yaw },
        players: [...this.ents.values()].map(pub) });
    }
    console.log(`[комната ${this.id}] матч #${this.matchNum}: ${this.humans().length} игроков + ${this.botList().length} ботов`);
  }

  endMatch(){
    this.phase = 'break';
    this.breakEndsAt = Date.now() + BREAK_MS;
    const standings = [...this.ents.values()]
      .sort((a,b) => b.kills - a.kills || a.deaths - b.deaths)
      .map(e => ({ name:e.name, kills:e.kills, deaths:e.deaths, bot:e.bot }));
    this.broadcast({ t:'matchEnd', standings, breakMs: BREAK_MS });
    console.log(`[комната ${this.id}] матч #${this.matchNum} окончен, лидер: ${standings[0]?.name || '—'}`);
  }

  /* --- урон --- */
  damage(victim, shooter, dmg, head, hx, hy, hz){
    if(!victim.alive || this.phase !== 'match') return;
    if(victim.god) return;
    victim.hp -= dmg;
    if(!shooter.bot && shooter !== victim)
      send(shooter.ws, { t:'hitmark', head, dmg, kill: victim.hp <= 0 });
    if(!victim.bot) send(victim.ws, { t:'hurt', hp: Math.max(0,victim.hp), by: shooter.id, dmg });
    this.broadcast({ t:'hp', id: victim.id, hp: Math.max(0, victim.hp) });
    if(victim.hp > 0) return;

    victim.alive = false; victim.hp = 0; victim.deaths++;
    victim.respawnAt = Date.now() + RESPAWN_MS;
    if(shooter !== victim) shooter.kills++;
    this.broadcast({ t:'kill', by: shooter.id, byName: shooter.name,
                     target: victim.id, targetName: victim.name, head,
                     x:+hx.toFixed(2), y:+hy.toFixed(2), z:+hz.toFixed(2) });

    /* награда за серию: каждые HEAL_EVERY фрагов — полное здоровье */
    if(shooter !== victim && shooter.alive && shooter.kills % HEAL_EVERY === 0){
      shooter.hp = HP_MAX;
      this.broadcast({ t:'hp', id: shooter.id, hp: HP_MAX });
      if(!shooter.bot) send(shooter.ws, { t:'heal', hp: HP_MAX, kills: shooter.kills });
    }
    this.broadcast({ t:'scores', s: [...this.ents.values()].map(e => [e.id, e.kills, e.deaths]) });
  }

  /* --- выстрел (общий для людей и ботов) --- */
  fire(shooter, ox, oy, oz, dx, dy, dz){
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const wallD = raySolids(this.maze.solids, ox, oy, oz, dx, dy, dz, RANGE);
    let best = null;
    for(const e of this.ents.values()){
      if(e === shooter || !e.alive) continue;
      const h = rayPlayer(ox, oy, oz, dx, dy, dz, e, P_RAD);
      if(h && h.t < wallD && (!best || h.t < best.t)) best = { t: h.t, head: h.head, e };
    }
    const d = best ? best.t : wallD;
    const hx = ox + dx*d, hy = oy + dy*d, hz = oz + dz*d;
    this.broadcast({ t:'shot', id: shooter.id,
      ox:+ox.toFixed(2), oy:+oy.toFixed(2), oz:+oz.toFixed(2),
      hx:+hx.toFixed(2), hy:+hy.toFixed(2), hz:+hz.toFixed(2),
      hit: best ? 1 : 0 }, shooter.bot ? 0 : shooter.id);
    if(best) this.damage(best.e, shooter, best.head ? DMG_HEAD : DMG_BODY, best.head, hx, hy, hz);
  }

  /* --- запуск гранаты --- */
  launch(shooter, dx, dy, dz){
    const len = Math.hypot(dx, dy, dz) || 1;
    const g = {
      id: nextNadeId++, owner: shooter.id,
      x: shooter.x, y: shooter.y + EYE - 0.1, z: shooter.z,
      vx: dx/len*NADE_SPEED, vy: dy/len*NADE_SPEED, vz: dz/len*NADE_SPEED,
      dieAt: Date.now() + NADE_FUSE
    };
    this.nades.set(g.id, g);
    this.broadcast({ t:'nade', id:g.id, owner:g.owner,
      x:+g.x.toFixed(2), y:+g.y.toFixed(2), z:+g.z.toFixed(2),
      vx:+g.vx.toFixed(2), vy:+g.vy.toFixed(2), vz:+g.vz.toFixed(2) });
  }

  /* --- полёт гранат (подшаги, чтобы не проскочить сквозь стену) --- */
  stepNades(dt, now){
    const SUB = 4, h = dt/SUB;
    for(const g of [...this.nades.values()]){
      let done = false;
      for(let k = 0; k < SUB && !done; k++){
        g.vy -= NADE_G*h;
        g.x += g.vx*h; g.y += g.vy*h; g.z += g.vz*h;
        if(g.y <= 0.12){ g.y = 0.12; done = true; break; }
        if(Math.hypot(g.x, g.z) > ARENA_R - 0.5){ done = true; break; }
        if(insideSolid(this.maze.solids, g.x, g.y, g.z, 0.18)){ done = true; break; }
        for(const e of this.ents.values()){
          if(!e.alive || e.id === g.owner) continue;
          if(Math.hypot(e.x-g.x, e.z-g.z) < 0.9 && g.y > e.y && g.y < e.y + BODY_TOP){ done = true; break; }
        }
      }
      if(done || now >= g.dieAt) this.boom(g);
    }
  }

  /* --- взрыв: урон по площади, стены закрывают --- */
  boom(g){
    this.nades.delete(g.id);
    this.broadcast({ t:'boom', id:g.id,
      x:+g.x.toFixed(2), y:+g.y.toFixed(2), z:+g.z.toFixed(2), r:BOOM_R });
    if(this.phase !== 'match') return;
    const shooter = this.ents.get(g.owner);
    for(const e of [...this.ents.values()]){
      if(!e.alive) continue;
      const cx = e.x, cy = e.y + 0.9, cz = e.z;
      const d = Math.hypot(cx-g.x, cy-g.y, cz-g.z);
      if(d > BOOM_R) continue;
      const len = d || 0.001;
      const cover = raySolids(this.maze.solids, g.x, g.y, g.z,
                              (cx-g.x)/len, (cy-g.y)/len, (cz-g.z)/len, len);
      if(cover < len - 0.35) continue;                 // боец за укрытием
      let dmg = BOOM_DMG * (1 - d/BOOM_R);
      if(e.id === g.owner) dmg *= SELF_MULT;           // сам себе — меньше, но ощутимо
      dmg = Math.round(dmg);
      if(dmg >= 1) this.damage(e, (e.id === g.owner || !shooter) ? e : shooter,
                               dmg, false, g.x, g.y, g.z);
    }
  }

  /* --- прямая видимость между двумя точками --- */
  los(a, b){
    const dx = b.x-a.x, dy = (b.y+EYE-0.2)-(a.y+EYE), dz = b.z-a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return raySolids(this.maze.solids, a.x, a.y+EYE, a.z,
                     dx/len, dy/len, dz/len, len) >= len - 0.1;
  }

  /* --- поиск пути по клеткам (BFS) --- */
  pathTo(from, to){
    const { nbrs } = this.maze;
    if(from < 0 || to < 0 || !nbrs[from] || !nbrs[to]) return null;
    if(from === to) return [to];
    const prev = new Map([[from, -1]]);
    const q = [from];
    for(let h = 0; h < q.length; h++){
      const cur = q[h];
      for(const n of nbrs[cur]){
        if(prev.has(n)) continue;
        prev.set(n, cur);
        if(n === to){
          const out = []; let c = n;
          while(c !== -1){ out.push(c); c = prev.get(c); }
          return out.reverse();
        }
        q.push(n);
      }
    }
    return null;
  }

  /* --- ИИ бота --- */
  botTick(b, dt, now){
    if(!b.alive) return;
    /* цель — ближайший живой противник */
    let target = null, bestD = 1e9;
    for(const e of this.ents.values()){
      if(e === b || !e.alive) continue;
      const d = Math.hypot(e.x-b.x, e.z-b.z);
      if(d < bestD){ bestD = d; target = e; }
    }

    const visible = target && bestD < RANGE && this.los(b, target);
    let wx = 0, wz = 0;                                   // желаемое направление движения

    if(visible && bestD < 42){
      /* бой: держим дистанцию и стрейфим */
      const ax = (target.x-b.x)/bestD, az = (target.z-b.z)/bestD;
      const approach = bestD > 22 ? 1 : (bestD < 11 ? -1 : 0);
      if(now > b.strafeAt){ b.strafe = Math.random() < 0.5 ? -1 : 1; b.strafeAt = now + 700 + Math.random()*1100; }
      wx = ax*approach - az*b.strafe*0.9;
      wz = az*approach + ax*b.strafe*0.9;
      b.path = null;
    } else if(target){
      /* поиск: идём по лабиринту к цели */
      const myCell = cellOf(b.x, b.z), tCell = cellOf(target.x, target.z);
      if(!b.path || now > b.pathAt || b.path.length === 0){
        b.path = this.pathTo(myCell, tCell) || null;
        b.pathAt = now + 900 + Math.random()*600;
        if(b.path && b.path.length > 1) b.path.shift();
      }
      if(b.path && b.path.length){
        const c = cellCenter(b.path[0]);
        const dx = c.x-b.x, dz = c.z-b.z, d = Math.hypot(dx,dz);
        if(d < 1.6) b.path.shift();
        else { wx = dx/d; wz = dz/d; }
      }
    }

    /* движение */
    const speed = visible ? 6.4 : 7.6;
    const wl = Math.hypot(wx, wz);
    if(wl > 0.01){
      const px = b.x, pz = b.z;
      b.x += (wx/wl) * speed * dt;
      b.z += (wz/wl) * speed * dt;
      b.moving = true;
      resolveSolids(this.maze.solids, b, MOVE_RAD);
      /* упёрся в вышку или угол — обходим вбок, иначе бот залипает навсегда */
      if(Math.hypot(b.x-px, b.z-pz) < speed*dt*0.25){
        if(++b.stuck > 8){
          b.stuck = 0; b.path = null; b.pathAt = 0;
          const s = Math.random() < 0.5 ? 1 : -1;
          b.x = px - (wz/wl)*speed*dt*s;
          b.z = pz + (wx/wl)*speed*dt*s;
          resolveSolids(this.maze.solids, b, MOVE_RAD);
        }
      } else b.stuck = 0;
    } else b.moving = false;
    b.y = groundAt(this.maze.solids, b.x, b.z, b.y);   // бот встаёт на ярус вышки

    /* прицеливание */
    if(target){
      const dx = target.x-b.x, dz = target.z-b.z;
      const dy = (target.y + (target.moving ? 1.15 : 1.25)) - (b.y + EYE);
      const dist = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, dist);
      let d = wantYaw - b.yaw;
      while(d > Math.PI) d -= Math.PI*2;
      while(d < -Math.PI) d += Math.PI*2;
      const rate = visible ? 6.5 : 3.0;
      b.yaw += d * Math.min(1, dt*rate);
      b.pitch += (wantPitch - b.pitch) * Math.min(1, dt*rate);

      /* граната по дальней цели: близко не стреляем, чтобы не подорваться самим */
      if(visible && Math.abs(d) < 0.12 && bestD > 20 && bestD < 55 && now >= b.nadeAt){
        b.nadeAt = now + 5000 + Math.random()*4000;
        const drop = bestD * 0.045;                    // поправка на навесную траекторию
        const pitch = b.pitch + drop + (Math.random()-0.5)*0.03;
        const yaw = b.yaw + (Math.random()-0.5)*0.04;
        this.launch(b, Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), Math.cos(yaw)*Math.cos(pitch));
        return;
      }

      /* стрельба короткими очередями */
      if(visible && Math.abs(d) < 0.09 && bestD < 55){
        if(b.mag <= 0){
          if(!b.reloadAt) b.reloadAt = now + 2200;
          if(now >= b.reloadAt){ b.mag = 30; b.reloadAt = 0; }
        } else if(now >= b.lastShot + 120 && now >= (b.aimAt || 0)){
          if(b.burst <= 0){ b.burst = 3 + (Math.random()*4|0); b.aimAt = now + 260 + Math.random()*260; return; }
          b.lastShot = now; b.mag--; b.burst--;
          if(b.burst <= 0) b.aimAt = now + 340 + Math.random()*420;
          const err = 0.026 + Math.min(0.05, bestD*0.0011);
          const ey = (Math.random()-0.5)*err*2, ep = (Math.random()-0.5)*err*2;
          const yaw = b.yaw + ey, pitch = b.pitch + ep;
          this.fire(b, b.x, b.y+EYE, b.z,
            Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), Math.cos(yaw)*Math.cos(pitch));
        }
      }
    }
  }

  tick(dt, now){
    if(this.phase === 'lobby'){
      if(this.lobbyEndsAt && now >= this.lobbyEndsAt) this.startMatch();
      return;
    }
    if(this.phase === 'break'){
      if(now >= this.breakEndsAt){
        if(this.humans().length) this.startMatch();
        else { this.phase = 'lobby'; this.lobbyEndsAt = 0; }
      }
      return;
    }
    /* матч */
    for(const e of this.ents.values()){
      if(!e.alive && e.respawnAt && now >= e.respawnAt && !e.noRespawn) this.respawn(e);
      if(e.bot) this.botTick(e, dt, now);
    }
    this.stepNades(dt, now);
    if(now >= this.endsAt) this.endMatch();
  }

  snapshot(){
    const p = [];
    for(const e of this.ents.values())
      p.push([ e.id, +e.x.toFixed(2), +e.y.toFixed(2), +e.z.toFixed(2),
               +e.yaw.toFixed(3), +e.pitch.toFixed(3),
               e.hp, (e.alive?1:0) | (e.moving?2:0) ]);
    this.broadcast({ t:'snap', p });
  }
}

function pub(e){
  return { id:e.id, name:e.name, bot:e.bot, x:e.x, y:e.y, z:e.z,
           yaw:e.yaw, pitch:e.pitch, hp:e.hp, alive:e.alive,
           kills:e.kills, deaths:e.deaths };
}
function mazePayload(m){
  return { walls: m.walls.map(w => [ +w.x.toFixed(2), +w.z.toFixed(2), +w.hw.toFixed(2), +w.hd.toFixed(2) ]),
           towers: m.towers.map(t => [ +t.x.toFixed(2), +t.z.toFixed(2) ]),
           tiers: TOWER_TIERS.map(t => [t.half, t.top]),
           step: STEP,
           cell: m.cell, cols: m.cols, rows: m.rows,
           originX: m.originX, originZ: m.originZ,
           arenaR: m.arenaR, wallH: m.wallH, seed: m.seed };
}

function findRoom(){
  let best = null;
  for(const r of rooms){
    if(r.phase === 'lobby' && r.humans().length < MAX_SLOTS){
      if(!best || r.humans().length > best.humans().length) best = r;
    }
  }
  if(best) return best;
  for(const r of rooms){
    if(r.humans().length < MAX_SLOTS){
      if(!best || r.humans().length > best.humans().length) best = r;
    }
  }
  if(best) return best;
  const r = new Room(); rooms.push(r); return r;
}

/* ============================================================
   HTTP + WebSocket
   ============================================================ */
const server = http.createServer((req,res) => {
  const url = (req.url || '/').split('?')[0];
  if(url === '/' || url === '/index.html'){
    fs.readFile(path.join(__dirname, 'client.html'), (err, buf) => {
      if(err){ res.writeHead(500); res.end('client.html не найден'); return; }
      /* без кеша: правки клиента должны подхватываться обычным обновлением страницы */
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'no-store, no-cache, must-revalidate',
        'Pragma':'no-cache', 'Expires':'0'});
      res.end(buf);
    });
  } else if(url === '/status'){
    let humans = 0, bots = 0;
    for(const r of rooms){ humans += r.humans().length; bots += r.botList().length; }
    const r0 = rooms.find(r => r.phase === 'match');
    res.writeHead(200, {'Content-Type':'application/json',
                        'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({
      name: SERVER_NAME, game: 'neon-labyrinth', slots: MAX_SLOTS,
      rooms: rooms.length, humans, bots,
      phase: r0 ? 'match' : (rooms[0] ? rooms[0].phase : 'idle'),
      endsAt: r0 ? r0.endsAt : 0
    }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let me = null, room = null;

  ws.on('message', raw => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.t === 'join' && !me){
      const name = String(m.name || 'Боец').slice(0,14).trim() || 'Боец';
      room = findRoom();
      me = room.join(ws, name);
      if(!me){ send(ws, { t:'full' }); ws.close(); }
      return;
    }
    if(!me) return;
    me.lastSeen = Date.now();

    switch(m.t){
      case 'state': {
        if(typeof m.x !== 'number' || typeof m.z !== 'number') break;
        if(!isFinite(m.x) || !isFinite(m.z)) break;
        if(Math.hypot(m.x, m.z) > ARENA_R + 4) break;
        me.x = m.x; me.z = m.z;
        me.y = Math.max(0, Math.min(me.fly ? 60 : 12, +m.y || 0));   // вышки + rocket jump
        me.yaw = +m.yaw || 0; me.pitch = Math.max(-1.55, Math.min(1.55, +m.pitch || 0));
        me.moving = !!m.mv;
        if(!me.fly) resolveSolids(room.maze.solids, me, MOVE_RAD*0.9);
        break;
      }
      case 'shoot': {
        const now = Date.now();
        if(!me.alive || room.phase !== 'match') break;
        const dx = +m.dx, dy = +m.dy, dz = +m.dz;
        if(!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) break;
        if(m.w === 2){                                     // гранатомёт
          if(now < me.lastNade + MIN_NADE_MS) break;
          me.lastNade = now;
          room.launch(me, dx, dy, dz);
        } else {                                           // винтовка
          if(now < me.lastShot + MIN_SHOT_MS) break;
          me.lastShot = now;
          room.fire(me, me.x, me.y + EYE, me.z, dx, dy, dz);
        }
        break;
      }
      case 'clr': {
        if(room.phase !== 'match') break;
        for(const e of [...room.ents.values()]){
          if(!e.bot) continue;
          e.noRespawn = true;                    // и тем, кто уже ждёт возрождения
          if(e.alive) room.damage(e, me, e.hp, false, e.x, e.y + 1, e.z);
        }
        break;
      }
      case 'opt': {
        if(m.k === 'god') me.god = !!m.v;
        if(m.k === 'fly'){ me.fly = !!m.v; if(!me.fly) me.y = Math.min(me.y, 12); }
        break;
      }
      case 'ping': send(ws, { t:'pong', ts: m.ts }); break;
    }
  });

  ws.on('close', () => { if(me && room) room.leave(me); });
  ws.on('error', () => {});
});

/* ---------- главные циклы ---------- */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last)/1000); last = now;
  for(const r of [...rooms]) r.tick(dt, now);
}, 1000/TICK_HZ);

setInterval(() => { for(const r of rooms) r.snapshot(); }, 1000/SNAP_HZ);

/* отсев зависших соединений */
setInterval(() => {
  const now = Date.now();
  for(const r of [...rooms]) for(const e of [...r.ents.values()]){
    if(e.bot) continue;
    if(now - e.lastSeen > 25000){ try{ e.ws.terminate(); }catch(x){} r.leave(e); }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`NEON LABYRINTH — сервер «${SERVER_NAME}»`);
  console.log(`http://localhost:${PORT}   ·   ws://localhost:${PORT}`);
  console.log(`Слотов в матче: ${MAX_SLOTS} (свободные занимают боты), HP: ${HP_MAX}`);
});
