// The event feed on the addon side (addon/WoWAI/Feed.lua): the real addon runs in a Lua
// VM with a stub client. Game events are fired, time is advanced, and the strip is
// read back exactly as the bridge's capture would. The last tests hand the decoded
// strip to the bridge's own parser and feed, so the whole path
// addon -> pixels -> bridge -> files is checked without a game.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');
const Feed = require('../bridge/feed');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');
const CELLS_PER_ROW = 200;

// Quest, speed and death APIs the base stub doesn't have.
const EXTRA_STUB = `
STUB.quests = {}
C_QuestLog = {
  GetNumQuestLogEntries = function() return #STUB.quests end,
  GetInfo = function(i) local q = STUB.quests[i]; if q then return { questID = q.id, isHeader = q.header or false, title = q.title } end end,
  IsComplete = function(id) for _, q in ipairs(STUB.quests) do if q.id == id then return q.ready end end end,
}
function GetUnitSpeed(unit) return STUB.curSpeed or 7, 7, 14, 4.7 end
function UnitIsDeadOrGhost(unit) return STUB.isDead or false end
`;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(EXTRA_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua', 'Feed.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

// The strip, decoded like the capture scripts do. Returns { id, text } or null.
function decodeStrip(vm) {
  if (vm.evaluate('WoWAIStrip and WoWAIStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(WoWAIStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
  assert.equal(bytes[6 + len], s1, 'fletcher s1'); assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

// What the bridge sees on the strip, record by record.
function stripRecords(vm) {
  const frame = decodeStrip(vm);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    return { session: p[0], chat: p[1], id: Number(p[2]), flags: p[4], text: p.slice(6).join('\x1F') };
  });
}
const eventRecord = vm => stripRecords(vm).find(r => r.flags === 'e') || null;

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// The bridge has answered the hello, so the addon counts as connected.
function connect(vm) {
  vm.run('STUB.RunTimers()');
  vm.run('STUB.onLoadAddOn = function(name) WoWAI_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
}

// Let n seconds pass, one tick (the feed's ticker runs every second) at a time.
function advance(vm, seconds) {
  for (let i = 0; i < seconds; i++) vm.run('STUB.now = STUB.now + 1; STUB.Tick()');
}

// A connected addon that has entered the world and let the login batch go out and finish.
function ready(opts = {}) {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  if (opts.settle !== false) advance(vm, 14); // debounce, two shows with the gap between
  return vm;
}

// Run until the next feed batch is on the strip; returns its record (or null).
function nextBatch(vm, max = 20) {
  for (let i = 0; i < max; i++) {
    advance(vm, 1);
    const r = eventRecord(vm);
    if (r) return r;
  }
  return null;
}
const linesOf = rec => rec.text.split('\n');

test('login: the first batch carries the version, a snapshot and a login event', () => {
  const vm = ready({ settle: false });
  const rec = nextBatch(vm);
  assert.ok(rec, 'a batch is shown on the strip');
  assert.equal(rec.flags, 'e');
  assert.equal(rec.chat, '');
  const lines = linesOf(rec);
  assert.equal(lines[0], 'v\t1\tTestchar\tTest Realm');
  const s = lines[1].split('\t');
  assert.equal(s[0], 'S');
  assert.equal(s[2], '23', 'level');
  assert.equal(s[3], '1431', 'map id');
  assert.equal(s[4], '452'); assert.equal(s[5], '678'); // tenths of a percent
  assert.equal(s[6], '7.0'); assert.equal(s[7], '7.0'); // speeds
  assert.equal(s[8], 'Duskwood'); assert.equal(s[9], 'Darkshire');
  assert.ok(lines.some(l => /^E\t\d+\tlogin\tinitial$/.test(l)), lines.join(' | '));
  assert.equal(vm.num('WoWAIDB.feedSeq'), 1);
  assert.equal(rec.id, 1, 'batches have their own numbers, apart from message ids');
});

test('a batch is shown twice and then leaves the strip; no ack files are involved', () => {
  const vm = ready({ settle: false });
  const first = nextBatch(vm);
  assert.ok(first);
  advance(vm, 1); advance(vm, 1); // the 2 s hold ends
  assert.equal(eventRecord(vm), null, 'gone between shows');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  let second = null;
  for (let i = 0; i < 6 && !second; i++) { advance(vm, 1); second = eventRecord(vm); }
  assert.ok(second, 'shown again');
  assert.equal(second.text, first.text, 'the same content, so the bridge can drop the repeat');
  advance(vm, 4);
  assert.equal(eventRecord(vm), null);
  assert.equal(vm.num('WoWAIFeed.Status().sent'), 1);
  assert.equal(vm.evaluate('WoWAI.FeedRecord()'), null);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('nothing is shown while the bridge has not been heard from', () => {
  const vm = newVM();
  login(vm); // never connect()
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  advance(vm, 10);
  assert.equal(eventRecord(vm), null);
  assert.equal(vm.evaluate('WoWAIFeed.Status().waiting'), 'true', 'the batch waits');
  advance(vm, 130);
  assert.equal(vm.evaluate('WoWAIFeed.Status().waiting'), 'false', 'and is dropped when it goes stale');
  assert.ok(vm.num('WoWAIFeed.Status().dropped') >= 1);
});

test('quests: accepted, ready, turned in and abandoned are told apart', () => {
  const vm = ready();
  const quests = js => vm.run(`STUB.quests = ${js}; STUB.FireEvent("QUEST_LOG_UPDATE")`);
  quests('{ { id = 33, title = "Wolves Across the Border", ready = false } }');
  let rec = nextBatch(vm);
  assert.ok(rec, 'baseline taken at login; a new quest is an event');
  let lines = linesOf(rec);
  assert.ok(lines.includes('E\t' + lines.find(l => l.includes('qaccept')).split('\t')[1] + '\tqaccept\t33\tWolves Across the Border'));
  assert.ok(lines.includes('Q\t33=Wolves Across the Border'), 'the whole quest log rides with a change, with the name the first time: ' + lines.join(' | '));
  advance(vm, 12);

  quests('{ { id = 33, title = "Wolves Across the Border", ready = true } }');
  lines = linesOf(nextBatch(vm));
  assert.ok(lines.some(l => /\tqready\t33\tWolves/.test(l)));
  assert.ok(lines.includes('Q\t33*'), 'the name is sent once per session, not with every quest line');
  advance(vm, 12);

  // Turn it in: the dedicated event arrives and the log entry disappears.
  vm.run('STUB.quests = {}; STUB.FireEvent("QUEST_TURNED_IN", 33, 100, 50); STUB.FireEvent("QUEST_LOG_UPDATE")');
  lines = linesOf(nextBatch(vm));
  assert.ok(lines.some(l => /\tqdone\t33\tWolves/.test(l)), lines.join(' | '));
  assert.ok(!lines.some(l => /\tqdrop\t/.test(l)), 'a turn-in is not reported as an abandon');
  advance(vm, 12);

  // Abandon another quest.
  quests('{ { id = 54, title = "Report to Goldshire", ready = false } }');
  advance(vm, 12);
  quests('{}');
  lines = linesOf(nextBatch(vm));
  assert.ok(lines.some(l => /\tqdrop\t54\tReport to Goldshire/.test(l)), lines.join(' | '));
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('zones, sub-zones, level-ups and death are reported once each', () => {
  const vm = ready();
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = "Goldshire"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.run('STUB.FireEvent("ZONE_CHANGED_NEW_AREA")'); // a repeat of the same zone
  vm.run('STUB.subzone = "Lion\'s Pride Inn"; STUB.FireEvent("ZONE_CHANGED_INDOORS")');
  vm.run('STUB.FireEvent("ZONE_CHANGED_INDOORS")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  vm.run('STUB.isDead = true; STUB.FireEvent("PLAYER_DEAD")');
  const lines = linesOf(nextBatch(vm));
  const types = lines.filter(l => l.startsWith('E\t')).map(l => l.split('\t').slice(2).join('|'));
  assert.deepEqual(types, ['zone|1431|Elwynn Forest', "sub|Lion's Pride Inn", 'level|24', 'dead']);
  assert.equal(lines.find(l => l.startsWith('S\t')).split('\t')[10], '1', 'the snapshot says dead');
  advance(vm, 12);
  vm.run('STUB.isDead = false; STUB.FireEvent("PLAYER_ALIVE")');
  assert.ok(linesOf(nextBatch(vm)).some(l => /\talive$/.test(l)));
});

test('"alive" is not reported while still a ghost', () => {
  const vm = ready();
  vm.run('STUB.isDead = true; STUB.FireEvent("PLAYER_DEAD")');
  advance(vm, 12);
  vm.run('STUB.FireEvent("PLAYER_ALIVE")'); // released: alive as a ghost
  advance(vm, 10);
  assert.ok(!/\talive/.test((eventRecord(vm) || { text: '' }).text));
  assert.equal(vm.num('WoWAIFeed.Status().pending'), 0);
});

test('position: new samples only when moving, batched about once a minute', () => {
  const vm = ready();
  // Standing still produces nothing but the heartbeat.
  advance(vm, 60);
  assert.equal(vm.num('WoWAIFeed.Status().samples'), 0);
  assert.equal(eventRecord(vm), null);
  // Walk: a new spot every 10 s.
  for (let i = 0; i < 6; i++) {
    vm.run(`STUB.posX = 0.45 + ${i} * 0.01; STUB.posY = 0.68`);
    advance(vm, 10);
  }
  const rec = nextBatch(vm);
  assert.ok(rec, 'six samples fill a batch');
  const ps = linesOf(rec).filter(l => l.startsWith('P\t')).map(l => l.split('\t'));
  assert.ok(ps.length >= 5 && ps.length <= 6, 'got ' + ps.length);
  assert.equal(ps[0][2], '1431');
  assert.deepEqual(ps.map(p => Number(p[3])), ps.map((_, i) => 450 + i * 10 + (ps.length === 5 ? 10 : 0)), 'x moves by one percent per sample');
  assert.equal(ps[0][4], '680');
});

test('a heartbeat batch goes out when nothing else happens', () => {
  const vm = ready();
  advance(vm, 280); // the last batch was built just after login; the heartbeat is due 300 s later
  assert.equal(eventRecord(vm), null, 'quiet so far');
  const rec = nextBatch(vm, 40);
  assert.ok(rec, 'five quiet minutes still produce a batch');
  assert.ok(linesOf(rec).some(l => /\ttick$/.test(l)));
});

test('a user message keeps priority: it shares the strip, and the feed gives way when full', () => {
  const vm = ready();
  vm.run('WoWAI.Send("where is Marshal Dughan")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  const both = nextBatch(vm);
  const recs = stripRecords(vm);
  assert.ok(both && recs.length >= 2, 'both records are in one frame');
  assert.ok(recs[0].flags !== 'e' && recs[0].text.includes('Marshal Dughan'), 'the message comes first');
  assert.equal(recs[recs.length - 1].flags, 'e');

  // Watch every frame for 20 s with a pending message of this many characters.
  const watch = (chars) => {
    const v = ready();
    v.run(`WoWAI.Send(string.rep("x", ${chars}))`);
    for (let i = 0; i < 30; i++) v.run(`STUB.FireEvent("PLAYER_LEVEL_UP", ${i})`); // a batch of about 800 bytes
    let message = false, feedSeen = false;
    for (let i = 0; i < 20; i++) {
      advance(v, 1);
      const recs = stripRecords(v);
      if (recs.some(r => r.flags !== 'e' && r.text.length >= chars)) message = true;
      if (recs.some(r => r.flags === 'e')) feedSeen = true;
    }
    return { message, feedSeen };
  };
  assert.deepEqual(watch(1500), { message: true, feedSeen: true }, 'control: a moderate message and the feed share the strip');
  assert.deepEqual(watch(2900), { message: true, feedSeen: false }, 'a maximum-size message is never displaced by a large batch');
});

test('/wow-ai feed off stops everything; on resumes; status and tuning commands work', () => {
  const vm = ready();
  vm.run('SlashCmdList.WOWAI("feed off")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 30)');
  advance(vm, 10);
  assert.equal(eventRecord(vm), null);
  assert.equal(vm.num('WoWAIFeed.Status().pending'), 0);
  vm.run('SlashCmdList.WOWAI("feed on")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 31)');
  assert.ok(nextBatch(vm));
  vm.run('SlashCmdList.WOWAI("feed hold 4")');
  vm.run('SlashCmdList.WOWAI("feed shows 3")');
  assert.equal(vm.num('WoWAIFeed.Status().hold'), 4);
  assert.equal(vm.num('WoWAIFeed.Status().shows'), 3);
  vm.run('SlashCmdList.WOWAI("feed")');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('/wow-ai feed on|off'));
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('3 x 4.0 s'));
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints - 1]').includes('event feed ON'));
});

test('a burst of events is capped: oldest lines dropped, the batch stays within its size', () => {
  const vm = ready();
  for (let i = 0; i < 200; i++) vm.run(`STUB.FireEvent("PLAYER_LEVEL_UP", ${i})`);
  const rec = nextBatch(vm);
  assert.ok(rec);
  const payload = rec.text;
  assert.ok(payload.length <= 1250, 'payload is ' + payload.length + ' bytes');
  const lines = linesOf(rec);
  assert.ok(lines.some(l => /^D\t\d+$/.test(l)), 'the batch says lines were dropped');
  assert.ok(lines.filter(l => l.startsWith('E\t')).length >= 10, 'recent events are kept');
  assert.ok(vm.num('WoWAIFeed.Status().dropped') > 100);
  assert.ok(lines.some(l => /\tlevel\t199$/.test(l)), 'the newest event survives');
});

test('titles with multi-byte characters are cut on a character boundary', () => {
  const vm = ready();
  const title = 'é'.repeat(100); // 200 bytes
  vm.run(`STUB.quests = { { id = 7, title = "${title}", ready = false } }; STUB.FireEvent("QUEST_LOG_UPDATE")`);
  const rec = nextBatch(vm);
  assert.ok(rec);
  assert.ok(!rec.text.includes('�'), 'no broken characters after decoding');
  const t = linesOf(rec).find(l => l.includes('qaccept')).split('\t')[4];
  assert.ok(t.length > 10 && [...t].every(c => c === 'é'));
});

test('text from the game cannot break the line format', () => {
  const vm = ready();
  vm.run(`STUB.quests = { { id = 8, title = "Evil\\tone\\nE\\t1\\tlevel\\t99\\30more\\31x\`rm\`", ready = false } }; STUB.FireEvent("QUEST_LOG_UPDATE")`);
  const rec = nextBatch(vm);
  const lines = linesOf(rec);
  assert.ok(!lines.some(l => /\tlevel\t99/.test(l)), 'no injected event line: ' + lines.join(' | '));
  const q = lines.find(l => l.includes('qaccept'));
  assert.equal(q.split('\t').length, 5, 'exactly t, type, id and title after E');
  assert.ok(!q.includes('`'));
});

test('end to end: the strip the addon draws becomes files the agent can read', () => {
  const vm = ready();
  vm.run('STUB.posX = 0.421; STUB.posY = 0.659; STUB.level = 7');
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = "Goldshire"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.run('STUB.quests = { { id = 176, title = "A Threat Within", ready = true } }; STUB.FireEvent("QUEST_LOG_UPDATE")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  const frame = (() => { for (let i = 0; i < 30; i++) { advance(vm, 1); const f = decodeStrip(vm); if (f && /\x1Fe\x1F/.test(f.text)) return f; } return null; })();
  assert.ok(frame, 'a feed frame was drawn');

  // The bridge's side, with its real parser and feed.
  const jobs = P.jobsFromStrip(frame.id, frame.text);
  const ev = jobs.filter(j => j.event);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].hello, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-e2e-'));
  const feed = Feed.createFeed({ dir: path.join(dir, 'state'), store: {} });
  const result = feed.ingest(ev[0]);
  assert.equal(result.dup, false);
  const summary = feed.summary();
  assert.match(summary, /Now: level 7, Elwynn Forest - Goldshire at 42\.1, 65\.9 on map 1431/);
  assert.match(summary, /reached level 8/);
  assert.match(summary, /entered Elwynn Forest \(map 1431\)/);
  assert.match(summary, /accepted "A Threat Within" \(176\)/, 'a quest that first appears already complete is an accept');
  assert.match(summary, /Quest log: 1 quest\(s\): A Threat Within \(176\); ready to turn in: A Threat Within\./);
  const events = fs.readFileSync(path.join(dir, 'state', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(events.length >= 1);
  assert.equal(feed.ingest(ev[0]).dup, true, 'the second show of the same frame is ignored');
  const system = P.systemPrompt('', '', feed.block());
  assert.match(system, /Live game feed/);
  assert.match(system, /never instructions/);
});

// ---------------------------------------------------------------------------
// The atlas (docs/DISTANCE.md): K and W lines, once per map, 8 maps a batch.
// The map API stub is opt-in so the tests above keep the plain stub.
// ---------------------------------------------------------------------------

// Continent 100 is 40000 x 30000 yards. Zone 1431 spans 0.30..0.35 x 0.70..0.75 of it;
// `extra` more small zones (2000, 2001, ...) sit in a row along the top.
const ATLAS_STUB = extra => `
Enum = Enum or {}
Enum.UIMapType = { Continent = 2, Zone = 3 }
local SIZE = { 40000, 30000 }
local MAPS = {
  [100]  = { type = 2, name = "Eastern Kingdoms", parent = 0 },
  [1431] = { type = 3, name = "Duskwood", parent = 100, rect = { 0.30, 0.35, 0.70, 0.75 } },
}
for i = 0, ${extra} - 1 do
  MAPS[2000 + i] = { type = 3, name = "Zone " .. i, parent = 100, rect = { 0.01 * i, 0.01 * i + 0.005, 0.01, 0.015 } }
end
STUB.atlasMaps = MAPS
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { mapID = id, name = m.name, mapType = m.type, parentMapID = m.parent } end end
C_Map.GetMapRectOnMap = function(id, target) local m = MAPS[id]; if m and m.rect and target == m.parent then return m.rect[1], m.rect[2], m.rect[3], m.rect[4] end end
C_Map.GetWorldPosFromMapPos = function(cont, v) return cont, { x = v.x * SIZE[1], y = v.y * SIZE[2] } end
C_Map.GetMapChildrenInfo = function(id, t, all)
  local out = {}
  for mid, m in pairs(MAPS) do if m.parent == id and m.type == t then out[#out + 1] = { mapID = mid, name = m.name, mapType = m.type } end end
  table.sort(out, function(a, b) return a.mapID < b.mapID end)
  return out
end
`;

function atlasVM(extra = 20) {
  const vm = newVM();
  vm.run(ATLAS_STUB(extra));
  login(vm);
  connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  return vm;
}

// Every different batch shown during `seconds` seconds, oldest first (a batch shown twice counts once).
function collect(vm, seconds) {
  const seen = new Map();
  for (let i = 0; i < seconds; i++) {
    advance(vm, 1);
    const r = eventRecord(vm);
    if (r && !seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()];
}
const atlasOf = batches => batches.flatMap(b => linesOf(b).filter(l => /^[KW]\t/.test(l)));

test('atlas: entering the world sends the continent size and each zone map once, 8 a batch', () => {
  const vm = atlasVM(20);
  const batches = collect(vm, 90);
  const lines = atlasOf(batches);
  const ks = lines.filter(l => l.startsWith('K\t'));
  const ws = lines.filter(l => l.startsWith('W\t'));
  assert.deepEqual(ks, ['K\t100\t40000\t30000'], 'continent size, once');
  assert.equal(ws.length, 21, 'the 20 generated zones and Duskwood');
  assert.equal(new Set(ws.map(l => l.split('\t')[1])).size, 21, 'no map twice');
  for (const b of batches) assert.ok(linesOf(b).filter(l => l.startsWith('W\t')).length <= 8);
  assert.ok(batches.filter(b => /\nW\t/.test(b.text)).length >= 3, 'spread over several batches');
  assert.ok(ws.includes('W\t1431\t100\t3000\t3500\t7000\t7500\tDuskwood'), ws.join(' | '));
  assert.ok(linesOf(batches[0]).some(l => /^E\t\d+\tlogin\t/.test(l)), 'the login event is not pushed out by the atlas');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
  assert.equal(vm.num('WoWAIFeed.Status().atlasQueued'), 0);
});

test('atlas: the first batches stay inside the payload budget', () => {
  const vm = atlasVM(40);
  vm.run('STUB.quests = {}; for i = 1, 25 do STUB.quests[i] = { id = 1000 + i, title = "Quest " .. i, ready = false } end; STUB.FireEvent("QUEST_LOG_UPDATE")');
  const batches = collect(vm, 120);
  assert.ok(atlasOf(batches).length > 0, 'atlas lines were sent');
  for (const b of batches) assert.ok(b.text.length <= 1250, `batch of ${b.text.length} bytes`);
});

test('atlas: later batches carry none until a new continent shows up or you ask again', () => {
  const vm = atlasVM(5);
  collect(vm, 40);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  const later = collect(vm, 12);
  assert.ok(later.length >= 1);
  assert.deepEqual(atlasOf(later), []);
  vm.run('SlashCmdList.WOWAI("feed atlas")');
  assert.ok(vm.num('WoWAIFeed.Status().atlasQueued') >= 6, 'everything is queued again');
  const again = atlasOf(collect(vm, 40));
  assert.equal(again.filter(l => l.startsWith('W\t')).length, 6);
  assert.equal(again.filter(l => l.startsWith('K\t')).length, 1);
});

test('atlas: a client without the map functions (or an instance) sends nothing and raises no error', () => {
  const vm = ready();
  vm.run('STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  assert.deepEqual(atlasOf(collect(vm, 20)), []);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
  const vm2 = atlasVM(0);
  vm2.run('C_Map.GetMapRectOnMap = function() return 0, 0, 0, 0 end'); // an instance: no place on the continent
  assert.deepEqual(atlasOf(collect(vm2, 20)).filter(l => l.startsWith('W\t')), []);
  assert.equal(vm2.num('WoWAIFeed.Status().errors'), 0);
  const vm3 = atlasVM(0);
  vm3.run('C_Map.GetMapChildrenInfo = function() error("not in this client") end');
  assert.ok(atlasOf(collect(vm3, 20)).some(l => l.startsWith('W\t1431\t')), 'the current map still goes out');
});

test('atlas: end to end, the strip becomes yards in the bridge', () => {
  const vm = atlasVM(3);
  vm.run('STUB.posX = 0.5; STUB.posY = 0.5');
  const batches = collect(vm, 50);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-'));
  const feed = Feed.createFeed({ dir: path.join(dir, 'state'), store: {} });
  let n = 0;
  for (const b of batches) {
    const [j] = P.jobsFromStrip(b.id, ['s', '', b.id, '', 'e', '', b.text].join('\x1F')).filter(x => x.event);
    assert.ok(j);
    feed.ingest(j);
    n++;
  }
  assert.ok(n >= 1);
  const a = feed.atlas;
  const p = a.toContinent(1431, 50, 50);
  assert.equal(p.cont, 100);
  assert.ok(Math.abs(p.x - 0.325 * 40000) < 1 && Math.abs(p.y - 0.725 * 30000) < 1, `${p.x}, ${p.y}`);
  assert.match(feed.summary(), /on map 1431 \(continent 100, 13000,21750 yards\)/);
  assert.match(fs.readFileSync(path.join(dir, 'state', 'maps.txt'), 'utf8'), /^1431 \| Duskwood \| 100 \| 12000 \| 21000 \| 2000 \| 1500$/m);
});

// ---------------------------------------------------------------------------
// Learned shortcuts: the addon times flights (UnitOnTaxi) and reports one `taxi`
// event per ride: seconds, then where it started and ended.
// ---------------------------------------------------------------------------

const TAXI_STUB = `
function UnitOnTaxi(unit) return STUB.onTaxi or false end
C_Map.GetPlayerMapPosition = function(mapId, unit) if STUB.noPos then return nil end return { x = STUB.posX or 0.452, y = STUB.posY or 0.678 } end
`;
function taxiVM() {
  const vm = ready();
  vm.run(TAXI_STUB);
  vm.run('STUB.posX = 0.4; STUB.posY = 0.5');
  advance(vm, 3);
  return vm;
}
const taxiEvents = batches => batches.flatMap(b => linesOf(b).filter(l => /^E\t\d+\ttaxi\t/.test(l)));

test('taxi: a flight is timed and reported once, from where you boarded to where you landed', () => {
  const vm = taxiVM();
  vm.run('STUB.onTaxi = true; STUB.posX = 0.5');
  advance(vm, 40);
  vm.run('STUB.posX = 0.7; STUB.onTaxi = false');
  const events = taxiEvents(collect(vm, 25));
  assert.equal(events.length, 1, events.join(' | '));
  const f = events[0].split('\t').slice(3).map(Number);   // seconds, fromMap, fx, fy, toMap, tx, ty
  assert.ok(f[0] >= 39 && f[0] <= 42, `seconds ${f[0]}`);
  assert.deepEqual(f.slice(1), [1431, 400, 500, 1431, 700, 500]);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('taxi: a ride under ten seconds, one that began before you were in the world, or one that ends nowhere is not reported', () => {
  const short = taxiVM();
  short.run('STUB.onTaxi = true'); advance(short, 4); short.run('STUB.onTaxi = false');
  assert.deepEqual(taxiEvents(collect(short, 25)), []);

  const midflight = ready({ settle: false });
  midflight.run(TAXI_STUB);
  midflight.run('STUB.onTaxi = true');
  advance(midflight, 30); midflight.run('STUB.onTaxi = false');
  assert.deepEqual(taxiEvents(collect(midflight, 25)), [], 'no known start, so no ride');

  const lost = taxiVM();
  lost.run('STUB.onTaxi = true'); advance(lost, 30);
  lost.run('STUB.noPos = true; STUB.onTaxi = false'); advance(lost, 8);
  lost.run('STUB.noPos = false');
  assert.deepEqual(taxiEvents(collect(lost, 25)), [], 'the landing spot never came');
});

test('taxi: a landing spot that arrives a moment late still counts', () => {
  const vm = taxiVM();
  vm.run('STUB.onTaxi = true'); advance(vm, 30);
  vm.run('STUB.noPos = true; STUB.onTaxi = false'); advance(vm, 2);
  vm.run('STUB.noPos = false; STUB.posX = 0.8');
  const events = taxiEvents(collect(vm, 25));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].split('\t').slice(7).map(Number), [1431, 800, 500]);
});

test('taxi: a client without UnitOnTaxi sends nothing and raises no error', () => {
  const vm = ready();
  vm.run('UnitOnTaxi = nil');
  advance(vm, 30);
  assert.deepEqual(taxiEvents(collect(vm, 20)), []);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('taxi: end to end, a ride the addon timed becomes a learned shortcut in the bridge', () => {
  const vm = taxiVM();
  vm.run('STUB.onTaxi = true; STUB.posX = 0.5'); advance(vm, 60);
  vm.run('STUB.posX = 0.9; STUB.onTaxi = false');
  const batches = collect(vm, 25);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxi-e2e-'));
  const feed = Feed.createFeed({ dir: path.join(dir, 'state'), store: {} });
  for (const b of batches) {
    const [j] = P.jobsFromStrip(b.id, ['s', '', b.id, '', 'e', '', b.text].join('\x1F')).filter(x => x.event);
    feed.ingest(j);
  }
  assert.equal(feed.atlas.learned.length, 1);
  const l = feed.atlas.learned[0];
  assert.equal(l.kind, 'flight');
  assert.ok(l.seconds >= 59 && l.seconds <= 62, `seconds ${l.seconds}`);
  assert.deepEqual([l.from.x, l.from.y, l.to.x, l.to.y], [40, 50, 90, 50]);
  assert.match(feed.summary(), /flew 6\d s from map 1431 \(40\.0, 50\.0\) to map 1431 \(90\.0, 50\.0\)/);
});

// ---------------------------------------------------------------------------
// The character (docs/EVENTS.md): gold in every snapshot; race, class, gear, skills and spells
// when they change. Spells travel in chunks of 12, two chunks to a batch.
// ---------------------------------------------------------------------------

const CHAR_STUB = `
STUB.gear = { [1] = 1234, [5] = 2345, [16] = 3456 }
function GetInventoryItemID(unit, slot) return STUB.gear[slot] end
STUB.spells = { { "Heroic Strike", "Rank 1" }, { "Heroic Strike", "Rank 2" }, { "Battle Shout", "Rank 1" }, { "Charge", "Rank 1" } }
function GetNumSpellTabs() return 1 end
function GetSpellTabInfo(t) return "General", "tex", 0, #STUB.spells end
function GetSpellBookItemName(i, book) local s = STUB.spells[i]; if s then return s[1], s[2] end end
function GetSpellBookItemInfo(i, book) local s = STUB.spells[i]; if s then return s[3] or "SPELL", 1 end end
`;
function charVM() {
  const vm = newVM();
  vm.run(CHAR_STUB);
  login(vm);
  connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  return vm;
}
const linesStarting = (batches, letter) => batches.flatMap(b => linesOf(b).filter(l => l.startsWith(letter + '\t') || l === letter));

test('character: the first batches carry race and class, gear, skills and the spells, once', () => {
  const vm = charVM();
  vm.run('STUB.money = 123456');
  const batches = collect(vm, 70);
  assert.deepEqual(linesStarting(batches, 'H'), ['H\tNight Elf\tHunter\tAlliance']);
  assert.deepEqual(linesStarting(batches, 'I'), ['I\t1=1234\t5=2345\t16=3456']);
  assert.deepEqual(linesStarting(batches, 'R'), ['R\tBows=46/115\tSkinning=75/75/p\tFirst Aid=40/75/s\tSwords=10/115'], 'professions are marked /p, secondary skills /s');
  const a = linesStarting(batches, 'A');
  assert.equal(a.length, 1);
  assert.match(a[0], /^A\t\d+\t1\t1\tHeroic Strike=2\tBattle Shout=1\tCharge=1$/, 'highest rank per spell, once each');
  const s = linesStarting(batches, 'S');
  assert.equal(s[s.length - 1].split('\t')[13], '123456', 'gold rides in every snapshot');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('character: nothing is sent again while nothing changes; changed gear is sent alone', () => {
  const vm = charVM();
  collect(vm, 70);
  assert.deepEqual(linesStarting(collect(vm, 40), 'I'), [], 'quiet');
  vm.run('STUB.gear[5] = 9999; STUB.FireEvent("PLAYER_EQUIPMENT_CHANGED")');
  const batches = collect(vm, 30);
  assert.deepEqual(linesStarting(batches, 'I'), ['I\t1=1234\t5=9999\t16=3456']);
  for (const k of ['H', 'R', 'A']) assert.deepEqual(linesStarting(batches, k), [], k + ' unchanged');
  vm.run('STUB.gear = {}; STUB.FireEvent("PLAYER_EQUIPMENT_CHANGED")');
  assert.deepEqual(linesStarting(collect(vm, 30), 'I'), ['I'], 'everything taken off is reported as an empty line');
});

test('character: a new spell sends the whole set again under a newer number', () => {
  const vm = charVM();
  const first = linesStarting(collect(vm, 70), 'A');
  vm.run('table.insert(STUB.spells, { "Rend", "Rank 1" }); STUB.FireEvent("SPELLS_CHANGED")');
  const second = linesStarting(collect(vm, 30), 'A');
  assert.equal(second.length, 1);
  assert.ok(Number(second[0].split('\t')[1]) > Number(first[0].split('\t')[1]), 'a newer set number');
  assert.match(second[0], /Heroic Strike=2\tBattle Shout=1\tCharge=1\tRend=1$/);
});

test('character: a big spellbook goes out in chunks of 12, two to a batch, each batch inside the size cap', () => {
  const vm = newVM();
  vm.run(CHAR_STUB);
  vm.run('STUB.spells = {}; for i = 1, 61 do STUB.spells[i] = { "Spell number " .. i, "Rank " .. (i % 3 + 1) } end');
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  const batches = collect(vm, 150);
  const a = linesStarting(batches, 'A').map(l => l.split('\t'));
  assert.equal(a.length, 6, '61 spells make six chunks');
  assert.equal(new Set(a.map(x => x[1])).size, 1, 'one set number');
  assert.deepEqual(a.map(x => Number(x[2])).sort(), [1, 2, 3, 4, 5, 6]);
  assert.ok(a.every(x => x[3] === '6'));
  assert.equal(a.reduce((n, x) => n + x.length - 4, 0), 61);
  for (const b of batches) {
    assert.ok(b.text.length <= 1250, `batch of ${b.text.length}`);
    assert.ok(linesOf(b).filter(l => l.startsWith('A\t')).length <= 2);
  }
});

test('character: a client without the gear or spellbook functions sends no such lines and raises no error', () => {
  const vm = ready({ settle: false });
  const batches = collect(vm, 70);
  assert.deepEqual(linesStarting(batches, 'I'), []);
  assert.deepEqual(linesStarting(batches, 'A'), []);
  assert.equal(linesStarting(batches, 'H').length, 1, 'race and class still go out');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('character: /wow-ai feed info sends everything again', () => {
  const vm = charVM();
  collect(vm, 70);
  vm.run('SlashCmdList.WOWAI("feed info")');
  const batches = collect(vm, 40);
  assert.equal(linesStarting(batches, 'H').length, 1);
  assert.equal(linesStarting(batches, 'I').length, 1);
  assert.equal(linesStarting(batches, 'A').length, 1);
});

test('character: end to end, the strip becomes the character record in the bridge', () => {
  const vm = charVM();
  vm.run('STUB.money = 123456');
  const batches = collect(vm, 70);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-e2e-'));
  const feed = Feed.createFeed({ dir: path.join(dir, 'state'), store: {} });
  for (const b of batches) {
    const [j] = P.jobsFromStrip(b.id, ['s', '', b.id, '', 'e', '', b.text].join('\x1F')).filter(x => x.event);
    feed.ingest(j);
  }
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'snapshot.json'), 'utf8')).character;
  assert.deepEqual([c.race, c.class, c.faction, c.gold], ['Night Elf', 'Hunter', 'Alliance', 123456]);
  assert.deepEqual(c.equipped, { 1: 1234, 5: 2345, 16: 3456 });
  assert.deepEqual(c.spells.map(s => s.name), ['Battle Shout', 'Charge', 'Heroic Strike']);
  assert.deepEqual(c.professions, [{ name: 'Skinning', rank: 75, max: 75, secondary: false }, { name: 'First Aid', rank: 40, max: 75, secondary: true }]);
  assert.deepEqual(c.skills.map(s => s.name), ['Bows', 'Swords']);
  assert.match(feed.summary(), /Character: Night Elf Hunter \(Alliance\), 12g 34s 56c, 3 items equipped, 3 spells, professions: Skinning 75\/75; secondary: First Aid 40\/75, 2 other skills\./);
});

// ---------------------------------------------------------------------------
// Several characters: every batch names the character (and realm) that is playing.
// ---------------------------------------------------------------------------

test('characters: every batch starts with the version, the character name and the realm', () => {
  const vm = ready({ settle: false });
  const first = nextBatch(vm);
  assert.equal(linesOf(first)[0], 'v\t1\tTestchar\tTest Realm');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  const later = nextBatch(vm, 40);
  assert.equal(linesOf(later)[0], 'v\t1\tTestchar\tTest Realm');
});

test('characters: a name with odd characters cannot break the line, and a missing name leaves the old form', () => {
  const vm = ready({ settle: false });
  vm.run('function UnitName(unit) return "Evil\\tname\\nE\\t1\\tlevel\\t99`x" end; function GetRealmName() return "Real\\tm" end');
  const b = nextBatch(vm);
  const head = linesOf(b)[0].split('\t');
  assert.deepEqual(head.slice(0, 2), ['v', '1']);
  assert.equal(head.length, 4);
  assert.ok(!linesOf(b).some(l => /^E\t1\tlevel\t99/.test(l)), 'no injected line');
  assert.ok(!linesOf(b)[0].includes('`'));
  const vm2 = ready({ settle: false });
  vm2.run('function UnitName(unit) return nil end');
  assert.equal(linesOf(nextBatch(vm2))[0], 'v\t1');
});

test('characters: end to end, two characters of one install end up in separate folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-chars-'));
  const hub = Feed.createFeedHub({ dir: path.join(dir, 'state'), store: {} });
  for (const [name, level] of [['Aria', 12], ['Borin', 30]]) {
    const vm = ready({ settle: false });
    vm.run(`function UnitName(unit) return "${name}" end; STUB.level = ${level}`);
    for (const b of collect(vm, 12)) {
      const [j] = P.jobsFromStrip(b.id, ['s', '', b.id, '', 'e', '', b.text].join('\x1F')).filter(x => x.event);
      hub.ingest(j);
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'state', 'characters')).sort(), ['aria-test_realm', 'borin-test_realm']);
  const level = k => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'characters', k, 'snapshot.json'), 'utf8')).now.level;
  assert.deepEqual([level('aria-test_realm'), level('borin-test_realm')], [12, 30]);
  assert.match(hub.block(), /Active character: Borin of Test Realm/);
  assert.match(hub.block(), /Other characters on this install: Aria of Test Realm \(level 12/);
});

test('professions: a client without the section names sends the skills unmarked', () => {
  const vm = newVM();
  vm.run(CHAR_STUB);
  vm.run('TRADE_SKILLS = nil; SECONDARY_SKILLS = nil');
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  const r = linesStarting(collect(vm, 40), 'R');
  assert.deepEqual(r, ['R\tBows=46/115\tSkinning=75/75\tFirst Aid=40/75\tSwords=10/115']);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('professions: learning one (a new skill line) is sent as a changed R line', () => {
  const vm = charVM();
  collect(vm, 70);
  vm.run('SKILL_CHANGED = true');
  vm.run('local old = GetNumSkillLines; function GetNumSkillLines() return old() + 1 end; local oldInfo = GetSkillLineInfo; function GetSkillLineInfo(i) if i == old() + 1 then return "Fishing", nil, false, 1, 0, 0, 75 end return oldInfo(i) end; STUB.FireEvent("SKILL_LINES_CHANGED")');
  const r = linesStarting(collect(vm, 30), 'R');
  assert.equal(r.length, 1);
  assert.match(r[0], /Fishing=1\/75$/);
});

// ---------------------------------------------------------------------------
// A client with only the modern spellbook (C_SpellBook), and the completed quests
// ---------------------------------------------------------------------------

const MODERN_STUB = `
STUB.gear = {}
function GetInventoryItemID(unit, slot) return STUB.gear[slot] end
STUB.book = { { "Holy Light", "Rank 2" }, { "Holy Light", "Rank 1" }, { "Seal of Righteousness", "Rank 1" }, { "Redemption", "" }, { "Hidden Future Spell", "", 2 } }
Enum = Enum or {}
Enum.SpellBookSpellBank = { Player = 0 }
Enum.SpellBookItemType = { None = 0, Spell = 1, FutureSpell = 2, PetAction = 3, Flyout = 4 }
C_SpellBook = {
  GetNumSpellBookSkillLines = function() return 1 end,
  GetSpellBookSkillLineInfo = function(i) return { name = "General", itemIndexOffset = 0, numSpellBookItems = #STUB.book } end,
  GetSpellBookItemInfo = function(i, bank) local s = STUB.book[i]; if s then return { itemType = s[3] or 1, spellID = 1000 + i } end end,
  GetSpellBookItemName = function(i, bank) local s = STUB.book[i]; if s then return s[1], s[2] end end,
}
`;
function modernVM() {
  const vm = newVM();
  vm.run(MODERN_STUB);
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  return vm;
}

test('spells: a client that only has C_SpellBook reports the spellbook, without future spells', () => {
  const vm = modernVM();
  const a = linesStarting(collect(vm, 70), 'A');
  assert.equal(a.length, 1);
  assert.match(a[0], /^A\t\d+\t1\t1\tHoly Light=2\tSeal of Righteousness=1\tRedemption$/, 'highest rank once, a spell with no rank by name, future spells left out');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('spells: a new spell on the modern client is sent again under a newer number', () => {
  const vm = modernVM();
  const first = linesStarting(collect(vm, 70), 'A');
  vm.run('table.insert(STUB.book, 1, { "Devotion Aura", "Rank 1" }); STUB.FireEvent("SPELLS_CHANGED")');
  const second = linesStarting(collect(vm, 30), 'A');
  assert.equal(second.length, 1);
  assert.ok(Number(second[0].split('\t')[1]) > Number(first[0].split('\t')[1]));
  assert.match(second[0], /Devotion Aura=1/);
});

const DONE_STUB = `
STUB.doneIds = { 357, 405, 421, 91209, 96627, 96628, 96898, 96899, 97951, 358, 374 }
C_QuestLog = C_QuestLog or {}
C_QuestLog.GetAllCompletedQuestIDs = function() local t = {}; for i, v in ipairs(STUB.doneIds) do t[i] = v end; return t end
`;
// What the bridge makes of the Z lines: the ids, in order.
function doneIds(batches) {
  const chunks = linesStarting(batches, 'Z').map(l => l.split('\t'));
  if (!chunks.length) return null;
  assert.equal(new Set(chunks.map(c => c[1])).size, 1, 'one set number');
  const n = Number(chunks[0][3]);
  assert.equal(chunks.length, n, 'every chunk of the set arrived');
  const ids = [];
  for (const c of chunks.sort((a, b) => Number(a[2]) - Number(b[2]))) {
    let last = Number(c[2]) === 1 ? 0 : null;
    for (const tok of c.slice(4)) {
      const [abs, d] = tok.startsWith('=') ? [true, parseInt(tok.slice(1), 36)] : [false, parseInt(tok, 36)];
      last = abs ? d : last + d;
      ids.push(last);
    }
  }
  return ids;
}
function doneVM() {
  const vm = newVM();
  vm.run(DONE_STUB);
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  return vm;
}

test('completed quests: the whole list goes out once, sorted and delta-coded, and survives a round trip', () => {
  const vm = doneVM();
  const batches = collect(vm, 70);
  const ids = doneIds(batches);
  assert.deepEqual(ids, [357, 358, 374, 405, 421, 91209, 96627, 96628, 96898, 96899, 97951]);
  assert.deepEqual(doneIds(collect(vm, 40)), null, 'nothing is sent again while nothing changes');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('completed quests: handing in a quest sends the list again under a newer number', () => {
  const vm = doneVM();
  const first = linesStarting(collect(vm, 70), 'Z');
  vm.run('table.insert(STUB.doneIds, 440); STUB.FireEvent("QUEST_TURNED_IN", 440, 100, 50)');
  const batches = collect(vm, 40);
  const second = linesStarting(batches, 'Z');
  assert.ok(Number(second[0].split('\t')[1]) > Number(first[0].split('\t')[1]));
  assert.ok(doneIds(batches).includes(440));
});

test('completed quests: a long list goes out in chunks, two to a batch, each batch inside the size cap', () => {
  const vm = newVM();
  vm.run(DONE_STUB);
  vm.run('STUB.doneIds = {}; for i = 1, 700 do STUB.doneIds[i] = i * 7 + (i % 3) end');
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  const batches = collect(vm, 300);
  const ids = doneIds(batches);
  assert.equal(ids.length, 700);
  assert.deepEqual(ids, Array.from({ length: 700 }, (_, i) => (i + 1) * 7 + ((i + 1) % 3)).sort((a, b) => a - b));
  for (const b of batches) {
    assert.ok(b.text.length <= 1250, `batch of ${b.text.length}`);
    assert.ok(linesOf(b).filter(l => l.startsWith('Z\t')).length <= 2);
  }
});

test('completed quests: a client without the call sends no Z lines and raises no error', () => {
  const vm = ready({ settle: false });
  const batches = collect(vm, 70);
  assert.deepEqual(linesStarting(batches, 'Z'), []);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

// ---------------------------------------------------------------------------
// Flight points, the bind location and the hearthstone
// ---------------------------------------------------------------------------

const FLIGHT_STUB = `
STUB.taxi = {
  { nodeID = 11, name = "The Sepulcher, Silverpine Forest", position = { x = 0.4262, y = 0.2184 }, state = 1 },
  { nodeID = 12, name = "Tarren Mill, Hillsbrad Foothills", position = { x = 0.4713, y = 0.3441 }, state = 2 },
  { nodeID = 13, name = "Undercity, Tirisfal", position = { x = 0.4471, y = 0.2557 }, state = 0 },
}
Enum = Enum or {}
Enum.FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 }
C_TaxiMap = { GetTaxiNodesForMap = function(map) if map == 1415 then return STUB.taxi end return {} end }
STUB.bind = "Brill"
function GetBindLocation() return STUB.bind end
STUB.hearthStart, STUB.hearthDuration = 0, 0
function GetItemCooldown(id) if id == 6948 then return STUB.hearthStart, STUB.hearthDuration, 1 end end
function GetItemCount(id) if id == 6948 then return 1 end return 0 end
`;
function flightVM(extra) {
  const vm = newVM();
  vm.run(`C_Map.GetBestMapForUnit = function() return STUB.playerMap or 1458 end
    C_Map.GetMapInfo = function(id) local t = { [1458] = { name = "Undercity", mapType = 5, parentMapID = 1420 }, [1420] = { name = "Tirisfal", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 } }; local m = t[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
    Enum = Enum or {}; Enum.UIMapType = { Continent = 2, Zone = 3 }`);
  vm.run(FLIGHT_STUB);
  if (extra) vm.run(extra);
  login(vm); connect(vm);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  return vm;
}
// What the bridge reads out of the T lines: the nodes, and where they came from.
function flightPoints(batches) {
  const chunks = linesStarting(batches, 'T').map(l => l.split('\t'));
  if (!chunks.length) return null;
  const n = Number(chunks[0][3]);
  assert.equal(chunks.length, n);
  const nodes = [];
  for (const c of chunks.sort((a, b) => Number(a[2]) - Number(b[2]))) {
    for (const tok of c.slice(5)) {
      const m = /^(\d+):(\d):(\d+):(\d+):(\d+):(.*)$/.exec(tok);
      nodes.push({ id: +m[1], state: +m[2], map: +m[3], x: +m[4] / 10, y: +m[5] / 10, name: m[6] });
    }
  }
  return { src: chunks[0][4].split('~')[0], note: chunks[0][4].split('~')[1] || '', nodes };
}

test('flight points: the nodes the client lists for the continent go out with their place and name', () => {
  const vm = flightVM();
  const fp = flightPoints(collect(vm, 70));
  assert.equal(fp.src, 'forMap');
  assert.deepEqual(fp.nodes.map(n => [n.id, n.state, n.map, n.x, n.y, n.name]), [
    [11, 1, 1415, 42.6, 21.8, 'The Sepulcher, Silverpine Forest'],
    [12, 2, 1415, 47.1, 34.4, 'Tarren Mill, Hillsbrad Foothills'],
    [13, 0, 1415, 44.7, 25.6, 'Undercity, Tirisfal'],
  ], 'each node goes out with the state the client gives it (0 here now, 1 reachable, 2 unreachable, 9 none)');
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('flight points: only changes are sent again, and visiting a flight master reads them again', () => {
  const vm = flightVM();
  collect(vm, 70);
  assert.equal(flightPoints(collect(vm, 40)), null, 'quiet');
  vm.run('table.insert(STUB.taxi, { nodeID = 14, name = "Hammerfall, Arathi Highlands", position = { x = 0.5, y = 0.4 }, state = 2 }); STUB.FireEvent("TAXIMAP_OPENED")');
  const fp = flightPoints(collect(vm, 40));
  assert.equal(fp.nodes.length, 4);
});

test('flight points: a client without the call says so, with no nodes and no error', () => {
  const vm = flightVM('C_TaxiMap = nil');
  const fp = flightPoints(collect(vm, 70));
  assert.equal(fp.src, 'none');
  assert.deepEqual(fp.nodes, []);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('flight points: GetAllTaxiNodes is used when it is the only call, and a node with no state says so', () => {
  const vm = flightVM('local f = C_TaxiMap.GetTaxiNodesForMap; C_TaxiMap = { GetAllTaxiNodes = f }; STUB.taxi[2].state = nil');
  const fp = flightPoints(collect(vm, 70));
  assert.equal(fp.src, 'all');
  assert.deepEqual(fp.nodes.map(n => [n.id, n.state]), [[11, 1], [12, 9], [13, 0]]);
});

test('hearthstone: the bind place, when it is ready again, and that you carry one', () => {
  const vm = flightVM('STUB.hearthStart = GetTime() - 600; STUB.hearthDuration = 3600');
  const b = linesStarting(collect(vm, 70), 'B');
  assert.equal(b.length, 1);
  const f = b[0].split('\t');
  assert.equal(f[1], 'Brill');
  const ready = Number(f[2]) - vm.num('time()');
  assert.ok(ready > 2900 && ready < 3100, `ready in ${ready} s`);
  assert.equal(f[3], '1');
  assert.equal(f[4], '', 'the first read does not know where the bind was made');
});

test('hearthstone: ready now is 0; using it sends the new time; binding somewhere else sends where', () => {
  const vm = flightVM();
  const first = linesStarting(collect(vm, 70), 'B');
  assert.equal(first[0].split('\t')[2], '0');
  vm.run('STUB.hearthStart = GetTime(); STUB.hearthDuration = 3600; STUB.FireEvent("BAG_UPDATE_COOLDOWN")');
  const second = linesStarting(collect(vm, 40), 'B');
  assert.equal(second.length, 1);
  assert.ok(Number(second[0].split('\t')[2]) > vm.num('time()') + 3500);
  vm.run('STUB.bind = "The Sepulcher"; STUB.posX, STUB.posY = 0.43, 0.41; STUB.FireEvent("PLAYER_ENTERING_WORLD", false, false)');
  const third = linesStarting(collect(vm, 40), 'B')[0].split('\t');
  assert.equal(third[1], 'The Sepulcher');
  assert.ok(third[4] !== '' && third[5] !== '' && third[6] !== '', 'a changed bind carries the spot where it was made');
});

test('hearthstone: a client without the calls sends no B line and raises no error', () => {
  const vm = ready({ settle: false });
  assert.deepEqual(linesStarting(collect(vm, 70), 'B'), []);
  assert.equal(vm.num('WoWAIFeed.Status().errors'), 0);
});

test('flight points: nodes with no state in the list take it from GetAllTaxiNodes when a flight master is opened', () => {
  const vm = flightVM(`
    local all = {}
    for i, n in ipairs(STUB.taxi) do all[i] = { nodeID = n.nodeID, state = n.state } end
    local f = C_TaxiMap.GetTaxiNodesForMap
    C_TaxiMap.GetTaxiNodesForMap = function(m) local l = {}; for i, n in ipairs(f(m)) do l[i] = { nodeID = n.nodeID, name = n.name, position = n.position } end return l end
    C_TaxiMap.GetAllTaxiNodes = function(m) return all end`);
  assert.deepEqual(flightPoints(collect(vm, 70)).nodes.map(n => n.state), [9, 9, 9], 'no state before a flight master is opened');
  vm.run('STUB.FireEvent("TAXIMAP_OPENED")');
  assert.deepEqual(flightPoints(collect(vm, 40)).nodes.map(n => [n.id, n.state]), [[11, 1], [12, 2], [13, 0]]);
});

test('flight points: with the old flight master calls, the node types become states while the window is open', () => {
  const vm = flightVM(`
    local f = C_TaxiMap.GetTaxiNodesForMap
    C_TaxiMap.GetTaxiNodesForMap = function(m) local l = {}; for i, n in ipairs(f(m)) do l[i] = { nodeID = n.nodeID, name = n.name, position = n.position } end return l end
    STUB.types = { "REACHABLE", "NONE", "CURRENT" }
    function NumTaxiNodes() return 3 end
    function TaxiNodeName(i) return STUB.taxi[i].name end
    function TaxiNodeGetType(i) return STUB.types[i] end`);
  collect(vm, 70);
  vm.run('STUB.FireEvent("TAXIMAP_OPENED")');
  assert.deepEqual(flightPoints(collect(vm, 40)).nodes.map(n => [n.id, n.state]), [[11, 1], [12, 2], [13, 0]], 'NONE (not discovered) is unreachable');
  vm.run('function NumTaxiNodes() return 0 end; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  assert.equal(flightPoints(collect(vm, 40)), null, 'what the window said is remembered after it closes, nothing is sent again');
});

test('flight points: the first line says which fields and calls this client has, so a missing state can be seen', () => {
  const vm = flightVM();
  const line = linesStarting(collect(vm, 70), 'T')[0].split('\t')[4];
  assert.match(line, /^forMap~fields=[^;]*nodeID[^;]*;api=.*CT\.GetTaxiNodesForMap/);
});

test('flight points: a client with many taxi calls and long node names still gets its list through, inside the batch cap', () => {
  const vm = flightVM(`
    STUB.taxi = {}
    for i = 1, 36 do STUB.taxi[i] = { nodeID = i, name = "A Very Long Flight Point Name Number " .. i .. ", Some Zone", position = { x = 0.3 + i / 1000, y = 0.4 }, state = 9, extraFieldNumber1 = 1, extraFieldNumber2 = 2, extraFieldNumber3 = 3, extraFieldNumber4 = 4 } end
    for _, name in ipairs({ "GetTaxiNodeInfoForSomethingLong", "GetAllTaxiNodePathsForThisMap", "GetTaxiMapIDForNode", "GetFlightPathDiscoveryState", "GetTaxiNodeConnectionsList", "IsTaxiNodeDiscovered", "GetNumTaxiNodes", "GetTaxiNodeCost" }) do C_TaxiMap[name] = function() return {} end end`);
  const batches = collect(vm, 200);
  const fp = flightPoints(batches);
  assert.ok(fp, 'the flight points were sent');
  assert.equal(fp.nodes.length, 36);
  assert.ok(fp.note.length <= 110, `the note is short (${fp.note.length})`);
  for (const b of batches) assert.ok(b.text.length <= 1250, `batch of ${b.text.length}`);
});
