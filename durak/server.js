"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8082);
const MAX_PLAYERS = 4;
const SUITS = ["♠", "♣", "♦", "♥"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "В", "Д", "К", "Т"];
const rankValue = Object.fromEntries(RANKS.map((r, i) => [r, i]));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(path.join(__dirname, "client.html"), (error, data) => {
      if (error) return void res.writeHead(500).end("client.html не найден");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(data);
    });
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ online: [...players.values()].filter(p => p.online).length, phase: game.phase }));
    return;
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server });

const players = new Map();
const spectators = new Set();
let game = freshGame();

function freshGame() {
  return {
    phase: "lobby", order: [], deck: [], trump: null, trumpCard: null,
    attacker: null, defender: null, table: [], passed: [], maxAttack: 0, taking: false,
    result: null, log: "Собираем игроков"
  };
}

function returnToLobby(reason = "Собираем игроков") {
  game = freshGame();
  game.log = reason;
  for (const [pid, p] of players) {
    p.hand = [];
    p.ready = false;
    if (!p.online) players.delete(pid);
  }
  broadcast();
}

function onlinePlayingCount() {
  return game.order.filter(pid => players.get(pid)?.online).length;
}

function id() { return crypto.randomBytes(10).toString("hex"); }
function send(ws, value) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(value)); }
function shuffle(items) {
  for (let i = items.length - 1; i; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function makeDeck() {
  return [
    ...SUITS.flatMap(suit => RANKS.map(rank => ({ id: `${rank}${suit}`, rank, suit }))),
    { id: "joker-black", rank: "ДЖ", suit: "🃏", joker: 1, color: "black" },
    { id: "joker-red", rank: "ДЖ", suit: "🃏", joker: 2, color: "red" }
  ];
}
function playerList() {
  return [...players.values()].map(p => ({
    id: p.id, name: p.name, ready: p.ready, online: p.online,
    playing: game.order.includes(p.id), cards: p.hand.length,
    out: game.phase === "playing" && game.order.includes(p.id) && p.hand.length === 0 && game.deck.length === 0
  }));
}
function publicState() {
  return {
    phase: game.phase, players: playerList(), order: game.order,
    deck: game.deck.length, trump: game.trump, trumpCard: game.trumpCard,
    attacker: game.attacker, defender: game.defender, table: game.table,
    passed: game.passed, maxAttack: game.maxAttack, taking: game.taking, result: game.result, log: game.log
  };
}
function stateFor(p) {
  return { t: "state", you: p ? p.id : null, hand: p ? p.hand : [], ...publicState() };
}
function broadcast() {
  for (const p of players.values()) if (p.online) send(p.ws, stateFor(p));
  for (const ws of spectators) send(ws, stateFor(null));
}
function activeIds() {
  return game.order.filter(pid => {
    const p = players.get(pid);
    return p && (p.hand.length > 0 || game.deck.length > 0);
  });
}
function nextActive(afterId) {
  const active = activeIds();
  if (!active.length) return null;
  const start = game.order.indexOf(afterId);
  for (let n = 1; n <= game.order.length; n++) {
    const candidate = game.order[(start + n) % game.order.length];
    if (active.includes(candidate)) return candidate;
  }
  return null;
}
function beats(card, attack) {
  if (card.joker) return true;
  if (attack.joker) return false;
  if (card.suit === attack.suit) return rankValue[card.rank] > rankValue[attack.rank];
  return card.suit === game.trump && attack.suit !== game.trump;
}
function tableRanks() {
  return new Set(game.table.flatMap(pair => [pair.attack.rank, pair.defense?.rank].filter(Boolean)));
}
function canAttack(p, card) {
  if (game.phase !== "playing" || p.id === game.defender || game.passed.includes(p.id)) return false;
  if (game.table.length >= game.maxAttack) return false;
  return game.table.length === 0 ? p.id === game.attacker : tableRanks().has(card.rank);
}
function removeCard(p, cardId) {
  const index = p.hand.findIndex(c => c.id === cardId);
  return index < 0 ? null : p.hand.splice(index, 1)[0];
}
function allCovered() { return game.table.length > 0 && game.table.every(pair => pair.defense); }
function allAttackersDone() {
  const eligible = activeIds().filter(pid => pid !== game.defender);
  return eligible.every(pid => game.passed.includes(pid));
}
function fillHands(startId) {
  let index = game.order.indexOf(startId);
  for (let n = 0; n < game.order.length; n++) {
    const p = players.get(game.order[(index + n) % game.order.length]);
    while (p && p.hand.length < 6 && game.deck.length) p.hand.push(game.deck.shift());
  }
}
function finishIfNeeded() {
  if (game.deck.length) return false;
  const remaining = game.order.filter(pid => players.get(pid)?.hand.length);
  if (remaining.length > 1) return false;
  game.phase = "finished";
  game.result = remaining.length
    ? { loser: remaining[0], text: `${players.get(remaining[0]).name} — дурак!` }
    : { loser: null, text: "Ничья — все вышли!" };
  game.log = game.result.text;
  for (const p of players.values()) p.ready = false;
  setTimeout(() => {
    if (game.phase !== "finished") return;
    game = freshGame();
    for (const [pid, p] of players) {
      p.hand = [];
      if (!p.online) players.delete(pid);
    }
    broadcast();
  }, 12000);
  return true;
}
function endRound(defenderTakes) {
  const oldAttacker = game.attacker;
  const oldDefender = game.defender;
  if (defenderTakes) {
    const defender = players.get(oldDefender);
    for (const pair of game.table) {
      defender.hand.push(pair.attack);
      if (pair.defense) defender.hand.push(pair.defense);
    }
    game.log = `${defender.name} забирает карты`;
  } else {
    game.log = `${players.get(oldDefender).name} отбился`;
  }
  fillHands(oldAttacker);
  game.table = [];
  game.passed = [];
  game.taking = false;
  if (finishIfNeeded()) return;
  const next = defenderTakes ? nextActive(oldDefender) : oldDefender;
  game.attacker = next;
  game.defender = nextActive(next);
  if (!game.attacker || !game.defender || game.attacker === game.defender) {
    finishIfNeeded();
    return;
  }
  game.maxAttack = Math.min(6, players.get(game.defender).hand.length);
}
function maybeEndRound() {
  if (allCovered() && allAttackersDone()) endRound(false);
}
function startGame() {
  const joined = [...players.values()].filter(p => p.online);
  if (joined.length < 2 || joined.length > MAX_PLAYERS || joined.some(p => !p.ready)) return;
  game = freshGame();
  game.phase = "playing";
  game.order = shuffle(joined.map(p => p.id));
  game.deck = shuffle(makeDeck());
  // Козырь всегда обычной масти: переносим случайную не-джокерную карту вниз.
  const trumpIndex = game.deck.findIndex(card => !card.joker);
  const [bottom] = game.deck.splice(trumpIndex, 1);
  game.deck.push(bottom);
  game.trump = bottom.suit;
  game.trumpCard = bottom;
  for (const p of joined) {
    p.hand = [];
    for (let i = 0; i < 6; i++) p.hand.push(game.deck.shift());
  }
  let starter = game.order[0];
  let best = 99;
  for (const pid of game.order) {
    for (const card of players.get(pid).hand) {
      if (card.suit === game.trump && rankValue[card.rank] < best) {
        best = rankValue[card.rank];
        starter = pid;
      }
    }
  }
  game.attacker = starter;
  game.defender = nextActive(starter);
  game.maxAttack = Math.min(6, players.get(game.defender).hand.length);
  game.log = `${players.get(starter).name} ходит первым`;
}
function handle(p, m) {
  if (m.t === "ready" && game.phase === "lobby") {
    p.ready = !!m.ready;
    startGame();
    return broadcast();
  }
  if (m.t === "reset" && game.phase === "playing" && onlinePlayingCount() < 2) {
    return returnToLobby("Предыдущая партия завершена");
  }
  if (game.phase !== "playing" || !game.order.includes(p.id)) return;
  if (m.t === "attack") {
    const card = p.hand.find(c => c.id === m.card);
    if (!card || !canAttack(p, card)) return;
    removeCard(p, card.id);
    game.table.push({ attack: card, defense: null, by: p.id });
    game.passed = game.passed.filter(pid => pid !== p.id);
    game.log = `${p.name} подкинул ${card.rank}${card.suit}`;
    if (game.taking && game.table.length >= game.maxAttack) endRound(true);
    return broadcast();
  }
  if (m.t === "defend" && p.id === game.defender) {
    const pair = game.table[Number(m.pair)];
    const card = p.hand.find(c => c.id === m.card);
    if (!pair || pair.defense || !card || !beats(card, pair.attack)) return;
    removeCard(p, card.id);
    pair.defense = card;
    game.log = `${p.name} отбивается`;
    maybeEndRound();
    return broadcast();
  }
  if (m.t === "pass" && p.id !== game.defender && game.table.length) {
    if (!game.passed.includes(p.id)) game.passed.push(p.id);
    game.log = `${p.name}: бито`;
    if (game.taking && allAttackersDone()) endRound(true);
    else maybeEndRound();
    return broadcast();
  }
  if (m.t === "take" && p.id === game.defender && game.table.length) {
    // После решения забрать остальные могут подкинуть до лимита.
    game.taking = true;
    game.log = `${p.name} решил забрать — можно подкинуть`;
    const attackers = activeIds().filter(pid => pid !== p.id);
    if (attackers.every(pid => game.passed.includes(pid)) || game.table.length >= game.maxAttack) endRound(true);
    return broadcast();
  }
}

wss.on("connection", ws => {
  let me = null;
  let spectator = false;
  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!me && !spectator && m.t === "watch") {
      spectator = true;
      spectators.add(ws);
      return send(ws, stateFor(null));
    }
    if (!me && !spectator && m.t === "join") {
      const token = String(m.token || "");
      let p = [...players.values()].find(candidate => candidate.token === token);
      if (!p) {
        if (game.phase !== "lobby" || [...players.values()].filter(x => x.online).length >= MAX_PLAYERS) {
          return send(ws, { t: "error", message: game.phase === "lobby" ? "В комнате уже 4 игрока" : "Партия уже идёт. Пока можно смотреть на экране ТВ." });
        }
        p = {
          id: id(), token: id(), name: String(m.name || "Игрок").trim().slice(0, 18) || "Игрок",
          ready: false, online: true, ws, hand: []
        };
        players.set(p.id, p);
      } else {
        if (p.ws && p.ws !== ws) p.ws.close();
        p.online = true;
        p.ws = ws;
      }
      me = p;
      send(ws, { t: "welcome", id: p.id, token: p.token });
      broadcast();
      return;
    }
    if (me) handle(me, m);
  });
  ws.on("close", () => {
    spectators.delete(ws);
    if (!me || me.ws !== ws) return;
    me.online = false;
    me.ready = false;
    if (game.phase === "lobby") {
      players.delete(me.id);
    } else if (game.phase === "playing" && game.order.includes(me.id)) {
      if (me.id === game.defender && game.table.length) endRound(true);
      else if (me.id !== game.defender && !game.passed.includes(me.id)) {
        game.passed.push(me.id);
        if (game.taking && allAttackersDone()) endRound(true);
        else maybeEndRound();
      }
      // Короткий обрыв связи не ломает партию, но брошенная игра не висит вечно.
      setTimeout(() => {
        if (game.phase === "playing" && onlinePlayingCount() < 2) {
          returnToLobby("Партия завершена: игроки отключились");
        }
      }, 20000);
    }
    broadcast();
  });
});

server.listen(PORT, () => console.log(`Дурак: http://localhost:${PORT}`));

module.exports = { makeDeck, beats };
