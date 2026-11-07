// Runs the real Map.lua (with WoWAI.lua) in a Lua VM: syncing layers from the
// bridge, drawing pins on the world map (zone and continent), the navigator's
// distance/bearing and arrival, herb/ore nodes filtered by skill, and /wow-ai map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

// Map-specific client stubs: Loch Modan (1432) sits at x .5-.6, y .4-.5 of
// Eastern Kingdoms (1415), which is 10000 x 15000 yards.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = { [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 }, [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return STUB.playerMap or 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return STUB.facing or 0 end
function Methods_CreateLine() end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.shown = true
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return STUB.shownMap or 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
local T = getmetatable(canvas).__index
MINING, HERBALISM = "Mining", "Herbalism"
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
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  let stub = fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8');
  // Lines are frames too (Frame:CreateLine), and textures can rotate.
  stub += `
function Methods.CreateLine(self, name, layer) local l = NewObjectPublic("Line", name, self); table.insert(self.textures, l); return l end
function Methods.SetRotation(self, r) self.rotation = r end
function Methods.GetFont(self) return "Fonts\\\\FRIZQT__.TTF", 10, "" end
function Methods.SetFont(self, f, s, flags) self.font, self.fontSize, self.fontFlags = f, s, flags end
function Methods.SetVertexColor(self, r, g, b, a) self.vcolor = { r, g, b, a } end
function Methods.SetScale(self, s) self.scale = s end
function Methods.SetAllPoints(self, rel) if rel then self.width, self.height = rel.width, rel.height end end
function Methods.GetFrameLevel(self) return self.level or 1 end
function Methods.SetFrameLevel(self, l) self.level = l end
`;
  stub = stub.replace('local function NewObject(', 'function NewObjectPublic(').replace(/NewObject\(/g, 'NewObjectPublic(');
  run(stub);
  run(MAP_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

// Shown pins on the world map overlay: "x,y,label" (label = the numbered text).
function shownPins(vm) {
  vm.run(`
    local out = {}
    local canvas = WorldMapFrame:GetCanvas()
    local overlay = canvas.children[#canvas.children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown and not c.fill then
        local label = c.num and c.num.text or ""
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x, -c.y, label, c.info and c.info.title or "")
      end
    end
    RESULT = table.concat(out, ";")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split(';') : [];
}

const LAYER = `{ epoch = "e1", version = 1, layers = { { name = "mining", title = "Copper loop", ordered = true, loop = true, points = {
  { 1432, 50, 40, "1. Copper Vein", "ore" }, { 1432, 60, 50, "2. Copper Vein", "ore" }, { 1432, 55, 70, "3. Tin Vein", "ore" } } } } }`;

test('Sync applies a new version once, ignores stale versions, and there is no arrow', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WoWAIMapDB.map.version'), '1');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null, 'no navigation is started');
  assert.equal(vm.evaluate('WoWAINavigator'), null, 'and no arrow frame exists');
  const prints = () => vm.num('#STUB.prints');
  const before = prints();
  vm.run(`WoWAIMap.Sync(${LAYER})`); // same version: nothing
  assert.equal(prints(), before);
  vm.run(`WoWAIMap.Sync({ epoch = "e1", version = 0, layers = {} })`); // older: ignored
  assert.equal(vm.num('#WoWAIMapDB.map.layers'), 1);
  // A new epoch (bridge state reset) replaces, even with a lower version; same content stays quiet.
  vm.run(`local m = ${LAYER}; m.epoch = "e2"; WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.map.epoch'), 'e2');
  assert.equal(prints(), before);
  vm.run(`WoWAIMap.Sync({ epoch = "e2", version = 5, layers = {} })`);
  assert.equal(vm.num('#WoWAIMapDB.map.layers'), 0);
});

test('pins land where the points are, on the zone map and on the continent', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('WoWAIMap.Refresh()');
  let pins = shownPins(vm);
  assert.deepEqual(pins, ['500,280,1,Copper loop', '600,350,2,Copper loop', '550,490,3,Copper loop']);
  vm.run('STUB.shownMap = 1415; WoWAIMap.Refresh()');
  pins = shownPins(vm);
  // 1432 (50,40) -> 1415 (0.55, 0.44) on a 1000x700 canvas.
  assert.equal(pins[0], '550,308,1,Copper loop');
  vm.run('STUB.shownMap = 947; WoWAIMap.Refresh()'); // no rect: nothing drawn
  assert.deepEqual(shownPins(vm), []);
});

test('herb/ore nodes toggle and follow the gathering skill', () => {
  const vm = newVM();
  vm.run(`WoWAINodes = { kinds = { { "Copper Vein", "mining", 1 }, { "Tin Vein", "mining", 65 }, { "Peacebloom", "herbalism", 1 } },
    maps = { [1432] = { [1] = "100200300400", [2] = "500500", [3] = "999999" } } }`);
  vm.run('WoWAIMap.Refresh()');
  assert.equal(shownPins(vm).length, 0, 'off by default');
  vm.run('SlashCmdList.WOWAIMAP("ore on")');
  // No Mining skill line in the stub: every ore shows, flagged as not learned.
  assert.deepEqual(shownPins(vm).map(p => p.split(',').slice(0, 2).join(',') + ',' + p.split(',')[3]), ['100,140,Copper Vein', '300,280,Copper Vein', '500,350,Tin Vein']);
  // With Mining 50 (Forever's C_SkillInfo: one table per line), Tin (65) is filtered out until "filter all".
  // Forever also lists child lines (parentSkillLineID ~= 0) that repeat the parent.
  vm.run(`C_SkillInfo = { GetNumSkillLines = function() return 3 end, GetSkillLineInfo = function(i)
    if i == 1 then return { name = "Professions", isHeader = true, rank = 0, maxRank = 0, skillID = 0, parentSkillLineID = 0 } end
    if i == 3 then return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 2572, parentSkillLineID = 186 } end
    return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 186, parentSkillLineID = 0 } end }
    WoWAIMap.Refresh()`);
  assert.equal(shownPins(vm).length, 2);
  vm.run('SlashCmdList.WOWAIMAP("filter all")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.WOWAIMAP("herb on")');
  assert.equal(shownPins(vm).length, 4);
  vm.run('SlashCmdList.WOWAIMAP("ore off"); SlashCmdList.WOWAIMAP("herb off")');
  assert.equal(shownPins(vm).length, 0);
  // The game context reads professions from the same API.
  assert.match(vm.evaluate('WoWAI.GameContext()'), /Professions: Bergbau 50\/75(\n|$)/);
});

test('/wow-ai map hide and show; the old navigation commands do nothing', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.WOWAIMAP("hide mining")');
  assert.equal(shownPins(vm).length, 0);
  vm.run('SlashCmdList.WOWAIMAP("show mining")');
  assert.equal(shownPins(vm).length, 3);
  for (const old of ['nav mining 3', 'next', 'prev', 'stop']) vm.run(`SlashCmdList.WOWAIMAP("${old}")`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('WoWAINavigator'), null);
  vm.run('SlashCmdList.WOWAIMAP("")'); // status never errors
});

test('pins show the label only, and a click does nothing', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('WoWAIMap.Refresh()');
  vm.run(`
    local overlay = WorldMapFrame:GetCanvas().children[#WorldMapFrame:GetCanvas().children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown then FIRST = c; break end
    end
    HINT = FIRST.info.hint
    if FIRST.scripts.OnClick then FIRST.scripts.OnClick(FIRST) end`);
  assert.equal(vm.evaluate('HINT'), null);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
});

test('navigation left in the saved variables by an older version is dropped at login', () => {
  const vm = newVM();
  vm.run('WoWAIMapDB.nav = { layer = "mining", index = 2 }; WoWAIMapDB.navPos = { "TOP", 0, -120 }');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('WoWAIMapDB.navPos'), null);
});

// ---- the planner's route on the world map: numbered diamonds, apart from the layers' round pins --------------------------------------
function routeOnMap() {
  const vm = newVM();
  vm.run(`
    STUB.log, STUB.done = {}, {}
    C_QuestLog = C_QuestLog or {}
    C_QuestLog.IsOnQuest = function(id) return STUB.log[id] ~= nil end
    C_QuestLog.IsComplete = function(id) return STUB.log[id] ~= nil and STUB.log[id].ready == true end
    C_QuestLog.IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end
    WoWAIRouteData = { stamp = "r1", steps = {
      { i = 1, k = "accept", q = 100, t = "Accept: A (Giver)", z = "Loch Modan 50, 40", w = "-", m = 1432, x = 50, y = 40 },
      { i = 2, k = "fly", t = "Fly: X to Y", z = "Loch Modan 60, 50", w = "-", m = 1432, x = 60, y = 50 },
      { i = 3, k = "turnin", q = 100, t = "Turn in: A (Giver)", z = "Loch Modan 60, 50", w = "-", m = 1432, x = 60, y = 50 },
      { i = 4, k = "hearth", t = "Use the hearthstone", z = "Inn", w = "-" },
      { i = 5, k = "kill", q = 200, t = "Kill 8: B for C", z = "Loch Modan 55, 70", w = "-", m = 1432, x = 55, y = 70 },
    } }`);
  vm.run(fs.readFileSync(path.join(ADDON, 'Route.lua'), 'utf8'), 'WoWAI');
  vm.run('WoWAIRoute.Reload(); WoWAIMap.Refresh()');
  return vm;
}
function routePins(vm) {
  vm.run(`
    local out = {}
    local canvas = WorldMapFrame:GetCanvas()
    local overlay = canvas.children[#canvas.children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown and c.fill then
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x * (c.scale or 1), -c.y * (c.scale or 1), c.num.text, (c.info.label or ""):gsub("\\n", "|"))
      end
    end
    RESULT = table.concat(out, ";")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split(';') : [];
}

const SPOTS = [[500, 280], [600, 350], [550, 490]]; // the real places of steps 1, 2-3 and 5 on the 1000x700 canvas
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const xy = s => s.split(',').slice(0, 2).map(Number);

test('route steps are numbered markers; steps at one place share one, and a step with no position is left out', () => {
  const vm = routeOnMap();
  const pins = routePins(vm);
  assert.deepEqual(pins.map(p => p.split(',').slice(2).join(',')), ['1,1. Accept: A (Giver)', '2,2. Fly: X to Y|3. Turn in: A (Giver)', '5,5. Kill 8: B for C']);
});

test('a marker is never on its real spot, on another marker, or on a layer pin', () => {
  const vm = routeOnMap();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.Refresh()`); // the layer's round pins sit exactly on the route's real spots
  const markers = routePins(vm).map(xy);
  assert.equal(markers.length, 3);
  const layerPins = shownPins(vm).map(xy);
  assert.equal(layerPins.length, 3);
  markers.forEach((m, i) => {
    assert.ok(dist(m, SPOTS[i]) >= 20, `marker ${i + 1} keeps clear of its real spot (the game's icon): ${dist(m, SPOTS[i]).toFixed(1)}`);
    SPOTS.forEach((s, j) => { if (j !== i) assert.ok(dist(m, s) >= 14, `marker ${i + 1} is not on the real spot of marker ${j + 1}`); });
    layerPins.forEach(lp => assert.ok(dist(m, lp) >= 22, `marker ${i + 1} is not on a layer pin: ${dist(m, lp).toFixed(1)}`));
    markers.forEach((o, j) => { if (j > i) assert.ok(dist(m, o) >= 26, `markers ${i + 1} and ${j + 1} do not overlap: ${dist(m, o).toFixed(1)}`); });
  });
});

test('crowded steps are spread apart', () => {
  const vm = routeOnMap();
  vm.run(`WoWAIRouteData.steps = {}
    for i = 1, 6 do WoWAIRouteData.steps[i] = { i = i, k = "kill", q = 300 + i, t = "Kill " .. i, z = "x", w = "-", m = 1432, x = 50 + i * 2, y = 40 } end
    WoWAIRoute.Reload(); WoWAIMap.Refresh()`);
  const markers = routePins(vm).map(xy);
  assert.equal(markers.length, 6, 'steps 20 px apart each get a marker');
  markers.forEach((m, i) => markers.forEach((o, j) => { if (j > i) assert.ok(dist(m, o) >= 26, `markers ${i + 1} and ${j + 1}: ${dist(m, o).toFixed(1)}`); }));
});

test('the numbers on route markers use a bold outline font', () => {
  const vm = routeOnMap();
  vm.run('local b; local c = WorldMapFrame:GetCanvas(); local o = c.children[#c.children]; for _, f in ipairs(o.children) do if f.fill and f.shown then b = f; break end end; RES_FONT = b.num.fontFlags');
  assert.equal(vm.evaluate('RES_FONT'), 'THICKOUTLINE');
});

test('route markers are not the layers\' round pins and do not count as them', () => {
  const vm = routeOnMap();
  assert.deepEqual(shownPins(vm), [], 'the round pins of the layers are untouched');
});

test('route markers start at the current step, follow it, and appear on the continent map too', () => {
  const vm = routeOnMap();
  vm.run('STUB.log[100] = { ready = false }; WoWAIRoute.Refresh()');
  assert.match(routePins(vm)[0], /,2,2\. Fly: X to Y\|3\. Turn in/, 'the accepted quest ticks step 1: markers start at the flight');
  vm.run('STUB.shownMap = 1415; WoWAIMap.Refresh()');
  const p = routePins(vm)[0];
  assert.match(p, /,2,2\. Fly/);
  // 1432 (60, 50) -> 1415 (0.56, 0.45) on a 1000x700 canvas = (560, 315): the marker is beside it, not on it.
  assert.ok(dist(xy(p), [560, 315]) >= 20);
});

test('/wow-ai route map off hides the markers and on shows them', () => {
  const vm = routeOnMap();
  vm.run('WoWAIRoute.Command("map off")');
  assert.deepEqual(routePins(vm), []);
  vm.run('WoWAIRoute.Command("map on")');
  assert.equal(routePins(vm).length, 3);
});
