// The code checker (bridge/lint.js, docs/CODE.md): code that only reads and draws passes,
// and every way to reach something else is refused with the line it happens on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lint, hash } = require('../bridge/lint');

const ok = src => { const r = lint(src); assert.deepEqual(r.errors, [], 'should pass:\n' + src); assert.equal(r.ok, true); return r; };
const bad = (src, match) => {
  const r = lint(src);
  assert.equal(r.ok, false, 'should be refused:\n' + src);
  if (match) assert.ok(r.errors.some(e => match.test(e.message)), `expected ${match} in ${JSON.stringify(r.errors)}\n${src}`);
  return r;
};

const XP_BAR = `
local bar = CreateFrame("StatusBar", nil, UIParent)
bar:SetSize(200, 12)
bar:SetPoint("TOP", UIParent, "TOP", 0, -40)
bar:SetStatusBarTexture("Interface\\\\TargetingFrame\\\\UI-StatusBar")
local text = bar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
text:SetPoint("CENTER")
local function refresh()
  local xp, max = UnitXP("player"), UnitXPMax("player")
  bar:SetMinMaxValues(0, max)
  bar:SetValue(xp)
  text:SetText(string.format("%d / %d (%d%%)", xp, max, math.floor(xp / max * 100)))
end
bar:RegisterEvent("PLAYER_XP_UPDATE")
bar:RegisterEvent("PLAYER_LEVEL_UP")
bar:SetScript("OnEvent", refresh)
refresh()
`;

test('a small read-and-draw addon passes, and the result carries a hash of the source', () => {
  const r = ok(XP_BAR);
  assert.match(r.stats.hash, /^[0-9a-f]{8}$/);
  assert.equal(r.stats.hash, hash(XP_BAR));
  assert.notEqual(hash(XP_BAR), hash(XP_BAR + ' '));
  assert.equal(hash('Wikipedia'), '11e60398', 'Adler-32 of the classic example');
});

test('loops over data, timers, quest and map reads pass', () => {
  ok(`
    local t = {}
    for i = 1, 10 do t[i] = i * 2 end
    for i = 1, #t do t[i] = t[i] + 1 end
    for i, v in ipairs(t) do local n = i + 1; t[n] = v end
    for k, v in pairs(t) do print(k, v) end
    local f = CreateFrame("Frame")
    local elapsed = 0
    f:SetScript("OnUpdate", function(self, dt) elapsed = elapsed + dt end)
    C_Timer.After(1, function() print(GetZoneText(), GetSubZoneText()) end)
    local ticker = C_Timer.NewTicker(5, function()
      local m = C_Map.GetBestMapForUnit("player")
      local p = m and C_Map.GetPlayerMapPosition(m, "player")
      if p then print(string.format("%.1f %.1f", p.x * 100, p.y * 100)) end
    end)
    for i = 1, C_QuestLog.GetNumQuestLogEntries() do local q = C_QuestLog.GetInfo(i) end
    local frames = {}
    frames[#frames + 1] = f
    local d = CreateFrame("Frame", "MyFrame", UIParent, "BackdropTemplate")
    local e = CreateFrame("Button", nil, d, nil)
  `);
});

test('a local that shadows a banned name is only a local', () => {
  ok('local SendChatMessage = print\nSendChatMessage("hello")');
  ok('local string = { format = function() return "x" end }\nprint(string.format())');
});

test('chat, casting, targeting and other actions are not on the list', () => {
  for (const name of ['SendChatMessage', 'CastSpellByName', 'CastSpell', 'UseAction', 'UseContainerItem', 'TargetUnit', 'AcceptTrade',
    'RunMacro', 'RunMacroText', 'JumpOrAscendStart', 'MoveForwardStart', 'AcceptQuest', 'CompleteQuest', 'TakeTaxiNode', 'SetBinding',
    'DoEmote', 'InviteUnit', 'SendMail', 'BuyMerchantItem', 'PlaceAuctionBid', 'ReloadUI', 'Logout', 'ConsoleExec', 'RunScript',
    'hooksecurefunc', 'securecall', 'SecureCmdOptionParse', 'C_ChatInfo', 'EnumerateFrames', 'LoadAddOn', 'EnableAddOn']) {
    bad(`${name}("x")`, new RegExp(`"${name}" is not allowed`));
  }
});

test('the ways to reach the global table or load more code are refused', () => {
  for (const src of ['_G.SendChatMessage("x")', 'local g = _G', 'x = _G["Send" .. "ChatMessage"]', 'local e = _ENV', 'getfenv(0)', 'setfenv(1, {})',
    'loadstring("x")()', 'load("x")', 'dofile("x")', 'require("x")', 'rawget(_G, "x")', 'rawset(_G, "x", 1)', 'getmetatable("").__index.rep("x", 9)',
    'setmetatable({}, {})', 'debug.sethook()', 'os.time()', 'io.open("x")', 'collectgarbage()', 'newproxy()', 'string.dump(print)', 'coroutine.wrap(print)']) {
    bad(src);
  }
});

test('namespaces only expose their listed members, and cannot be passed around', () => {
  bad('C_Map.RequestLoadMapArt()', /C_Map\.RequestLoadMapArt is not allowed/);
  bad('string.rep("x", 1e9)', /string\.rep is not allowed/);
  bad('local s = string\nprint(s.rep)', /can only be used as string\.something/);
  bad('local t = C_Timer', /can only be used as C_Timer\.something/);
  bad('print(string["rep"])', /not allowed/);
  bad('print(C_Map["SetUserWaypoint"])', /not allowed/);
  bad('("x"):rep(99999)', /"\.rep" is not allowed/);
  ok('print(string.format("%d", 3), ("abc"):upper(), table.concat({ "a" }, ","))');
});

test('methods that act on secure frames or climb the UI are refused, by name, quoted name or computed name', () => {
  bad('local f = CreateFrame("Frame")\nf:SetAttribute("type", "spell")', /"\.SetAttribute" is not allowed/);
  bad('local f = CreateFrame("Frame")\nf.SetAttribute(f, "type", "spell")', /SetAttribute/);
  bad('local f = CreateFrame("Frame")\nf["SetAttribute"](f, "type")', /SetAttribute/);
  bad('local f = CreateFrame("Frame")\nlocal k = "Set" .. "Attribute"\nf[k](f, "type")', /computed key/);
  bad('local f = CreateFrame("Frame")\nlocal k = "SetAttribute"\nf[k](f, "type")', /computed key/);
  bad('local f = CreateFrame("Frame")\nfor k, v in pairs({ a = 1 }) do f[k](f) end', /computed key/);
  bad('local f = CreateFrame("Frame")\nlocal function g(k) return f[k] end', /computed key/);
  bad('local f = CreateFrame("Frame")\nf:Click()', /Click/);
  bad('UIParent:GetChildren()', /GetChildren/);
  bad('local t = { ["SetAttribute"] = 1 }', /key "SetAttribute"/);
  bad('local k = "x"\nlocal t = { [k] = 1 }', /table key/);
  ok('local t = { a = 1, [2] = 3, ["name"] = 4 }\nlocal i = 2\nprint(t[i], t.a, t["name"])');
});

test('events must be plain quoted names from the list', () => {
  const f = 'local f = CreateFrame("Frame")\n';
  bad(f + 'f:RegisterEvent("CHAT_MSG_WHISPER")', /CHAT_MSG_WHISPER is not allowed/);
  bad(f + 'f:RegisterEvent("PLAYER_" .. "DEAD")', /plain quoted name/);
  bad(f + 'local ev = "PLAYER_DEAD"\nf:RegisterEvent(ev)', /plain quoted name/);
  bad(f + 'f:RegisterEvent("PLAYER\\68EAD")', /plain quoted name/);
  bad(f + 'local r = f.RegisterEvent\nr(f, "PLAYER_DEAD")', /can only be called directly/);
  bad(f + 'f["RegisterEvent"](f, "PLAYER_DEAD")', /RegisterEvent/);
  bad(f + 'f:RegisterEvent()', /plain quoted name/);
  bad(f + 'f:RegisterUnitEvent("UNIT_SPELLCAST_START", "player")', /not allowed/);
  ok(f + 'f:RegisterEvent("PLAYER_DEAD")\nf:RegisterUnitEvent("UNIT_HEALTH", "player")\nf:RegisterEvent([[ZONE_CHANGED]])');
});

test('only plain frames: no secure templates, no text input, nothing built from a variable', () => {
  bad('CreateFrame("Button", nil, UIParent, "SecureActionButtonTemplate")', /template/);
  bad('CreateFrame("Button", nil, UIParent, "SecureHandlerBaseTemplate")', /template/);
  bad('CreateFrame("Frame", nil, UIParent, "BackdropTemplate,SecureHandlerBaseTemplate")', /template/);
  bad('local t = "Secure"\nCreateFrame("Button", nil, UIParent, t)', /template/);
  bad('CreateFrame("EditBox")', /the type must be/);
  bad('CreateFrame("SimpleHTML")', /the type must be/);
  bad('local ty = "Frame"\nCreateFrame(ty)', /the type must be/);
  bad('local c = CreateFrame\nc("Frame")', /CreateFrame can only be called directly/);
  bad('CreateFrame("Frame", nil, UIParent, nil, 1, 2)', /too many/);
  ok('CreateFrame("StatusBar", "MyBar", UIParent, "BackdropTemplate")');
});

test('code that might never stop is refused', () => {
  bad('while true do end', /while loops/);
  bad('repeat until false', /repeat loops/);
  bad('::top:: goto top', /goto|syntax/);
  bad('for i = 1, 1e9 do end', /for loop must end/);
  bad('local n = 5\nfor i = 1, n do end', /for loop must end/);
  bad('for i = 1, 10, 0 do end', /step of 0/);
});

test('recursion is refused', () => {
  bad('local function f() return f() end', /calls itself/);
  bad('local function g(n)\n  if n > 0 then g(n - 1) end\nend', /calls itself/);
  ok('local function a() return 1 end\nlocal function b() return a() end');
});

test('global variables cannot be set or declared', () => {
  bad('x = 1', /sets the global "x"/);
  bad('function foo() end', /sets the global "foo"/);
  bad('MyAddon = {}', /MyAddon/);
  bad('UIParent.x = 1\nUIParent = nil', /UIParent/);
  ok('local x = 1\nx = 2\nlocal function foo() end');
});

test('size, syntax and character limits', () => {
  bad('', /empty/);
  bad('   \n  ', /empty/);
  bad('print("x"', /syntax error/);
  bad('x = = 1', /syntax error/);
  bad('print(1)\nprint(2)\nlocal = 3', /syntax error/);
  assert.equal(lint('print(1)\nprint(2)\nlocal = 3').errors[0].line, 3);
  bad('print("' + 'a'.repeat(13000) + '")', /bytes/);
  bad('print(1)\n'.repeat(500), /lines/);
  bad('print("a\u0001b")', /control characters/);
  bad('print("a\u0000b")', /control characters/);
  ok('print("héllo ✓")');
});

test('errors name the line and stop at a sensible number', () => {
  const r = lint('print(1)\nSendChatMessage("a")\nprint(2)\nCastSpellByName("b")');
  assert.deepEqual(r.errors.map(e => e.line), [2, 4]);
  const many = lint(Array.from({ length: 100 }, (_, i) => `Bad${i}()`).join('\n'));
  assert.ok(many.errors.length <= 12);
});

test('nothing the checker is given can crash it', () => {
  for (const v of [null, undefined, 42, {}, [], '\uD800', 'a'.repeat(5), '--[[', '"\\', 'local a <const> = 1', '#!/bin/lua\nprint(1)']) {
    const r = lint(v);
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('nested loops are counted together, so three small loops cannot freeze the game', () => {
  bad('for i = 1, 100000 do for j = 1, 100000 do print(i) end end', /nested loops could run/);
  bad('local t = {}\nfor i = 1, #t do for j = 1, #t do for k = 1, #t do print(k) end end end', /nested loops could run/);
  bad('for a, b in pairs({}) do for c, d in pairs({}) do for e, f in pairs({}) do print(e) end end end', /nested loops could run/);
  ok('local t = {}\nfor i = 1, #t do for j = 1, #t do print(j) end end');
  ok('for i = 1, 100 do for j = 1, 100 do for k = 1, 100 do print(k) end end end');
  assert.equal(lint('for i = 1, 100000 do for j = 1, 100000 do for k = 1, 5 do end end end').errors.filter(e => /nested/.test(e.message)).length, 1, 'reported once');
});

test('more attempts to get around the list', () => {
  bad('local f = CreateFrame("Frame")\nlocal m = f.SetAttribute\nprint(m)', /SetAttribute/);
  bad('local f = CreateFrame("Frame")\npcall(f.Click, f)', /Click/);
  bad('SendChatMessage"hello"', /not allowed/);
  bad('SendChatMessage{ 1 }', /not allowed/);
  bad('local t = { f = SendChatMessage }', /not allowed/);
  bad('print(select(1, SendChatMessage))', /not allowed/);
  bad('local f = function() return _G end', /"_G" is not allowed/);
  bad('local x = ("a"):rep(5)', /\.rep/);
  bad('local s = string\nlocal r = s["re" .. "p"]', /can only be used as string/);
  bad('local ns = { string = 1 }\nlocal k = "string"\nprint(ns[k])', /computed key/);
  bad('for i = 1, 5 do local f = CreateFrame("Frame"); f[i .. ""]() end', /computed key/);
  bad('C_Timer.After(1, SendChatMessage)', /not allowed/);
  bad('local a, b = UnitName, SendChatMessage', /not allowed/);
  bad('local t = setmetatable', /not allowed/);
  bad('UIParent.SetAttribute(UIParent, "x", 1)', /SetAttribute/);
  bad('print(#_G)', /not allowed/);
});
