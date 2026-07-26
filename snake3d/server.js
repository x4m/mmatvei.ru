/* ============================================================
   SNAKE.IO 3D — сервер мультиплеера
   Запуск:  npm install  →  node server.js  (порт 8080)
   Матчи по 5 минут, профили и скины сохраняются в data.json
   ============================================================ */
"use strict";
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ARENA_R = 130;
const FOOD_MAX = 380;
const MATCH_MS = 5 * 60 * 1000;      // соревновательный матч: 5 минут
const BREAK_MS = 15 * 1000;          // перерыв между матчами
const SNAP_HZ = 15;                  // частота рассылки состояний

/* ---------- скины: базовые бесплатны, наградные — за победы ---------- */
const BASE_SKINS = ['aqua','pink','gold_y','violet','sky','orange','lime','red'];
const REWARD_SKINS = [
  { id:'gold',   wins:1, title:'Золото'   },
  { id:'plasma', wins:3, title:'Плазма'   },
  { id:'galaxy', wins:5, title:'Галактика'},
  { id:'dragon', wins:10,title:'Дракон'   },
];

/* ---------- профили игроков (по имени) ---------- */
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { players: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
function saveDB(){ fs.writeFile(DATA_FILE, JSON.stringify(db, null, 1), ()=>{}); }
function profile(name){
  if(!db.players[name]) db.players[name] = { wins:0, matches:0 };
  const p = db.players[name];
  const skins = [...BASE_SKINS, ...REWARD_SKINS.filter(s=>p.wins>=s.wins).map(s=>s.id)];
  return { wins:p.wins, matches:p.matches, skins };
}

/* ---------- HTTP: раздаём клиент + статус ---------- */
const server = http.createServer((req,res)=>{
  if(req.url==='/' || req.url==='/index.html'){
    fs.readFile(path.join(__dirname,'client.html'), (err,buf)=>{
      if(err){ res.writeHead(500); res.end('client.html не найден'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(buf);
    });
  } else if(req.url==='/status'){
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ online: players.size, matchEndsAt, inBreak }));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });

/* ---------- состояние мира ---------- */
let nextId = 1;
const players = new Map();   // id -> {ws,name,skin,x,z,h,segs,boost,alive,score,lastSeen}
let food = new Map();        // id -> {x,z,size,color}
let nextFoodId = 1;
let matchNum = 1;
let matchEndsAt = Date.now() + MATCH_MS;
let inBreak = false;

const FOOD_COLORS = [0x39ffd0,0xff3d81,0xffe14d,0x7a5cff,0x4dc3ff,0xff8a3d];
function spawnFood(x, z, big){
  if(food.size >= FOOD_MAX + 200) return;
  if(x===undefined){
    const r = Math.sqrt(Math.random())*(ARENA_R-6), a = Math.random()*Math.PI*2;
    x = Math.cos(a)*r; z = Math.sin(a)*r;
  }
  const f = { id:nextFoodId++, x, z,
    size: big ? 1.6 : 0.7+Math.random()*0.6,
    color: FOOD_COLORS[Math.random()*FOOD_COLORS.length|0] };
  food.set(f.id, f);
  return f;
}
for(let i=0;i<FOOD_MAX*0.8;i++) spawnFood();

function spawnPos(){
  const a = Math.random()*Math.PI*2, r = Math.random()*(ARENA_R*0.6);
  return { x: Math.cos(a)*r, z: Math.sin(a)*r, h: Math.random()*Math.PI*2 };
}

function send(ws, obj){ if(ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId){
  const s = JSON.stringify(obj);
  for(const [id,p] of players) if(id!==exceptId && p.ws.readyState===1) p.ws.send(s);
}

/* ---------- подключения ---------- */
wss.on('connection', ws=>{
  let me = null;

  ws.on('message', raw=>{
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.t==='join' && !me){
      const name = String(m.name||'Змей').slice(0,14).trim() || 'Змей';
      const prof = profile(name);
      const skin = prof.skins.includes(m.skin) ? m.skin : BASE_SKINS[0];
      const sp = spawnPos();
      me = { id:nextId++, ws, name, skin, x:sp.x, z:sp.z, h:sp.h,
             segs:6, boost:false, alive:true, score:0, lastSeen:Date.now() };
      players.set(me.id, me);
      send(ws, { t:'welcome', id:me.id, arenaR:ARENA_R, profile:prof,
        spawn:sp,
        match:{ num:matchNum, endsAt:matchEndsAt, inBreak },
        food:[...food.values()],
        players:[...players.values()].filter(p=>p!==me).map(pub) });
      broadcast({ t:'pjoin', p:pub(me) }, me.id);
      console.log(`+ ${name} (id ${me.id}), онлайн: ${players.size}`);
      return;
    }
    if(!me) return;
    me.lastSeen = Date.now();

    switch(m.t){
      case 'state':   // позиция от клиента, ~15 Гц
        if(typeof m.x==='number' && Math.hypot(m.x,m.z)<ARENA_R+5){
          me.x=m.x; me.z=m.z; me.h=m.h;
          me.segs=Math.min(900, m.segs|0); me.boost=!!m.boost;
        }
        break;

      case 'ate': {   // съел еду — сервер проверяет и подтверждает
        const f = food.get(m.id);
        if(f && me.alive && Math.hypot(f.x-me.x, f.z-me.z) < 12){
          food.delete(f.id);
          const pts = f.size>1.4 ? 40 : 10;
          if(!inBreak) me.score += pts;
          broadcast({ t:'foodDel', id:f.id });
          send(ws, { t:'score', score:me.score });
        }
        break;
      }

      case 'died': {  // клиент сообщил о своей смерти
        if(!me.alive) break;
        me.alive = false;
        const drops = Array.isArray(m.drops) ? m.drops.slice(0,120) : [];
        const added = [];
        for(const d of drops){
          if(Array.isArray(d) && Math.hypot(d[0],d[1])<ARENA_R){
            const f = spawnFood(d[0], d[1], Math.random()<0.15);
            if(f) added.push(f);
          }
        }
        if(added.length) broadcast({ t:'foodAdd', food:added });
        const killer = players.get(m.by);
        if(killer && killer.alive && !inBreak){
          killer.score += 50;
          send(killer.ws, { t:'score', score:killer.score });
        }
        broadcast({ t:'pdied', id:me.id, by:m.by||0 });
        break;
      }

      case 'respawn': {
        if(me.alive) break;
        const sp = spawnPos();
        me.alive = true; me.segs = 6;
        me.x=sp.x; me.z=sp.z; me.h=sp.h;
        me.score = Math.floor(me.score*0.5);   // штраф за смерть в матче
        send(ws, { t:'respawn', spawn:sp, score:me.score });
        broadcast({ t:'palive', id:me.id, x:sp.x, z:sp.z }, me.id);
        break;
      }

      case 'skin': {
        const prof = profile(me.name);
        if(prof.skins.includes(m.skin)){
          me.skin = m.skin;
          broadcast({ t:'pskin', id:me.id, skin:m.skin });
        }
        break;
      }
    }
  });

  ws.on('close', ()=>{
    if(me){
      players.delete(me.id);
      broadcast({ t:'pleave', id:me.id });
      console.log(`- ${me.name}, онлайн: ${players.size}`);
    }
  });
});

function pub(p){
  return { id:p.id, name:p.name, skin:p.skin, x:p.x, z:p.z, h:p.h,
           segs:p.segs, boost:p.boost, alive:p.alive, score:p.score };
}

/* ---------- рассылка снапшотов ---------- */
setInterval(()=>{
  if(players.size===0) return;
  const snap = [...players.values()].map(p=>
    [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.h.toFixed(3), p.segs, p.boost?1:0, p.alive?1:0, p.score]);
  broadcast({ t:'snap', p:snap });
}, 1000/SNAP_HZ);

/* ---------- пополнение еды ---------- */
setInterval(()=>{
  if(food.size < FOOD_MAX){
    const added = [];
    for(let i=0;i<4 && food.size<FOOD_MAX;i++) added.push(spawnFood());
    if(players.size) broadcast({ t:'foodAdd', food:added });
  }
}, 700);

/* ---------- цикл соревновательных матчей (5 минут) ---------- */
setInterval(()=>{
  const now = Date.now();
  if(!inBreak && now >= matchEndsAt){
    // финал матча
    inBreak = true;
    const standings = [...players.values()]
      .sort((a,b)=>b.score-a.score)
      .map(p=>({ name:p.name, score:p.score }));
    let rewardMsg = null;
    if(standings.length && standings[0].score > 0){
      const winner = [...players.values()].find(p=>p.name===standings[0].name);
      const before = profile(winner.name).skins.length;
      db.players[winner.name] = db.players[winner.name] || { wins:0, matches:0 };
      db.players[winner.name].wins++;
      const prof = profile(winner.name);
      const unlocked = REWARD_SKINS.find(s=>prof.wins===s.wins);
      if(unlocked) rewardMsg = { name:winner.name, skin:unlocked.id, title:unlocked.title };
      send(winner.ws, { t:'profile', profile:prof });
    }
    for(const p of players.values()){
      db.players[p.name] = db.players[p.name] || { wins:0, matches:0 };
      db.players[p.name].matches++;
    }
    saveDB();
    broadcast({ t:'matchEnd', standings, reward:rewardMsg, breakMs:BREAK_MS });
    console.log(`Матч #${matchNum} завершён. Победитель: ${standings[0]?.name||'—'}`);

    setTimeout(()=>{
      // новый матч: сбрасываем счёт и всех респавним
      matchNum++; inBreak = false;
      matchEndsAt = Date.now() + MATCH_MS;
      food.clear(); nextFoodId = 1;
      for(let i=0;i<FOOD_MAX*0.8;i++) spawnFood();
      for(const p of players.values()){
        const sp = spawnPos();
        p.score=0; p.segs=6; p.alive=true; p.x=sp.x; p.z=sp.z; p.h=sp.h;
        send(p.ws, { t:'matchStart', num:matchNum, endsAt:matchEndsAt,
          spawn:sp, food:[...food.values()] });
      }
    }, BREAK_MS);
  }
}, 500);

/* ---------- чистка зависших ---------- */
setInterval(()=>{
  const now = Date.now();
  for(const [id,p] of players){
    if(now - p.lastSeen > 20000){ p.ws.terminate(); players.delete(id); broadcast({t:'pleave', id}); }
  }
}, 5000);

server.listen(PORT, ()=>{
  console.log(`SNAKE.IO 3D сервер: http://localhost:${PORT}`);
  console.log(`Матч #${matchNum} до ${new Date(matchEndsAt).toLocaleTimeString()}`);
});
