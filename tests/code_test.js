// Agent-proposed addon code (docs/CODE.md): the pool that checks a reply's wowcode blocks and
// fills slot addons, and the in-game loader that runs one only when the player asks, inside an
// environment that holds only the allowed names. The addon runs in a Lua VM with a stub client.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');
const L = require('../bridge/lint');
const C = require('../bridge/code');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

const GOOD = `local f = CreateFrame("Frame")
f:SetSize(10, 10)
f:SetScript("OnEvent", function() print("level up", UnitLevel("player")) end)
f:RegisterEvent("PLAYER_LEVEL_UP")
print("ready")`;
const reply = (name, src, extra = '') => `Here is a small addon.\n\n\`\`\`wowcode ${name}\n${src}\n\`\`\`\n${extra}`;

function pool(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-test-'));
  const addonDir = path.join(dir, 'AddOns');
  if (opts.install !== false) {
    for (let i = 1; i <= (opts.slots || 20); i++) {
      fs.mkdirSync(path.join(addonDir, 'WoWAI_C' + String(i).padStart(2, '0')), { recursive: true });
      fs.writeFileSync(path.join(addonDir, 'WoWAI_C' + String(i).padStart(2, '0'), 'Code.lua'), 'WoWAI_CodeSlot = nil\n');
    }
  }
  const store = {};
  const p = C.createPool({ addonDir, auditDir: path.join(dir, 'audit'), store, slots: opts.slots || 20, now: () => 1700000000000 });
  return { dir, addonDir, audit: path.join(dir, 'audit'), store, p, slotFile: n => path.join(addonDir, 'WoWAI_C' + String(n).padStart(2, '0'), 'Code.lua') };
}

// ---------------------------------------------------------------- the pool (bridge side)

test('pool: a block that passes lands in a slot, with an audit copy and a note naming the command', () => {
  const t = pool();
  const r = t.p.process(reply('level-ping', GOOD));
  assert.equal(r.results.length, 1);
  assert.deepEqual([r.results[0].ok, r.results[0].slot, r.results[0].seq], [true, 1, 1]);
  assert.ok(r.text.includes(GOOD), 'the code stays in the reply for the player to read');
  assert.match(r.notes[0], /code "level-ping" accepted: 5 lines, check [0-9a-f]{8}\. Read it above, then load it in the game with \/wow-ai code load 1/);
  assert.match(r.notes[0], /never starts by itself/);
  const slot = fs.readFileSync(t.slotFile(1), 'utf8');
  assert.match(slot, /^WoWAI_CodeSlot = \{ name = "level-ping", seq = 1, slot = 1, hash = "[0-9a-f]{8}", lines = 5, source = "/m);
  assert.equal(fs.readFileSync(path.join(t.audit, 'level-ping.1.lua'), 'utf8'), GOOD + '\n');
  const log = fs.readFileSync(path.join(t.audit, 'code-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([log[0].name, log[0].ok, log[0].seq, log[0].hash], ['level-ping', true, 1, L.hash(GOOD)]);
  assert.equal(t.store.seq, 1);
  for (const f of [t.slotFile(1), path.join(t.audit, 'code-log.jsonl')]) assert.equal(fs.statSync(f).mode & 0o022, 0, 'not writable by the group or others');
});

test('pool: a block the checker refuses writes nothing to the game and says why', () => {
  const t = pool();
  const r = t.p.process(reply('spammer', 'print(1)\nSendChatMessage("buy gold", "SAY")'));
  assert.equal(r.results[0].ok, false);
  assert.match(r.notes[0], /code "spammer" was NOT accepted: line 2: "SendChatMessage" is not allowed/);
  assert.equal(fs.readFileSync(t.slotFile(1), 'utf8'), 'WoWAI_CodeSlot = nil\n', 'the slot is untouched');
  assert.equal(t.store.seq, 0, 'a refused block uses no number');
  const log = fs.readFileSync(path.join(t.audit, 'code-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].ok, false);
  assert.match(log[0].reasons[0], /SendChatMessage/);
  assert.ok(!fs.existsSync(path.join(t.audit, 'spammer.1.lua')), 'refused code is kept in the log text only, not as a file');
});

test('pool: names, limits, and a client without the slots', () => {
  const t = pool();
  for (const bad of ['', 'Bad Name', 'UPPER', '1abc', 'a'.repeat(25), '../x', 'x;rm']) {
    const r = t.p.process(reply(bad, GOOD));
    assert.equal(r.results[0].ok, false, JSON.stringify(bad));
  }
  const four = t.p.process([1, 2, 3, 4].map(i => reply('n' + i, GOOD)).join('\n'));
  assert.deepEqual(four.results.map(x => x.ok), [true, true, true, false]);
  assert.match(four.notes[3], /only the first 3 code blocks/);
  const none = pool({ install: false });
  const r = none.p.process(reply('ok-name', GOOD));
  assert.equal(r.results[0].ok, false);
  assert.match(r.notes[0], /not installed.*node setup\.js/);
});

test('pool: other fenced blocks and plain text are left alone, and slots are reused round robin', () => {
  const t = pool({ slots: 2 });
  const text = 'Use this macro:\n```wowmacro Hi\n/wave\n```\nand ```lua\nprint(1)\n``` fine.';
  const r = t.p.process(text);
  assert.equal(r.text, text);
  assert.deepEqual([r.notes, r.results], [[], []]);
  const slots = [1, 2, 3].map(i => t.p.process(reply('r' + i, GOOD)).results[0].slot);
  assert.deepEqual(slots, [1, 2, 1], 'the third version goes back to slot 1');
});

function runLua(code) {
  const Ls = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(Ls);
  const status = lauxlib.luaL_loadstring(Ls, to_luastring(code)) || lua.lua_pcall(Ls, 0, 1, 0);
  assert.equal(status, lua.LUA_OK, to_jsstring(lua.lua_tostring(Ls, -1) || to_luastring('?')));
  const out = lua.lua_tolstring(Ls, -1);
  return Buffer.from(out);
}

test('slot files read back byte for byte: quotes, backslashes, newlines, tabs, accents and control bytes', () => {
  const src = 'print("a\\"b")\r\n\tlocal s = [[x]]\n-- é ✓ \u0001 \\ \\n "\' ]] ]=] end';
  const lit = C.luaString(src);
  assert.ok(!/[\n\r]/.test(lit) && /^[\x20-\x7e]*$/.test(lit), 'one printable ASCII line');
  const out = runLua(`return ${lit}`);
  assert.deepEqual(out, Buffer.from(src, 'utf8'));
  assert.deepEqual(runLua(`return ${C.luaString('\u0000\u007fÿ')}`), Buffer.from('\u0000\u007fÿ', 'utf8'));
});

// ---------------------------------------------------------------- the loader (in the game)

const EXTRA_STUB = `
STUB.chatSent = 0
function SendChatMessage() STUB.chatSent = STUB.chatSent + 1 end
STUB.slotFiles = {}
STUB.executed = {}
STUB.onLoadAddOn = function(name)
  local text = STUB.slotFiles[name]
  if text and not STUB.executed[name] then
    STUB.executed[name] = true            -- like the game: a loaded file is not read again until /reload
    assert(load(text, "=slot"))()
  end
end
`;

function newVM() {
  const Ls = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(Ls);
  const run = code => {
    if (lauxlib.luaL_loadstring(Ls, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(Ls, -1)));
    if (lua.lua_pcall(Ls, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(Ls, -1)));
  };
  const runWithArg = (code, arg) => {
    if (lauxlib.luaL_loadstring(Ls, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(Ls, -1)));
    lua.lua_pushstring(Ls, to_luastring(arg));
    if (lua.lua_pcall(Ls, 1, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(Ls, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(Ls, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(Ls, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(Ls, -1));
    lua.lua_pop(Ls, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(EXTRA_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua', 'Feed.lua', 'Code.lua']) runWithArg(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  run('STUB.FireEvent("PLAYER_LOGIN")');
  const setSlot = (n, text) => {
    runWithArg(`STUB.slotFiles[ "WoWAI_C" .. string.format("%02d", ${n}) ] = ...`, text);
  };
  const prints = () => { run('RESULT_P = table.concat(STUB.prints, "\\n")'); return evaluate('RESULT_P') || ''; };
  return { run, evaluate, setSlot, prints, cmd: s => runWithArg('SlashCmdList.WOWAI(...)', s) };
}

// Offer `src` as slot 1 the way the bridge would, through the real pool.
function offer(vm, src, name = 'demo') {
  const t = pool();
  const r = t.p.process(reply(name, src));
  const res = r.results[0];
  assert.ok(res.ok, JSON.stringify(r.notes));
  vm.setSlot(res.slot, fs.readFileSync(t.slotFile(res.slot), 'utf8'));
  return { ...res, t };
}
const printsSince = (vm, n) => vm.prints().split('\n').slice(n);

test('loader: nothing runs until the player loads the slot, and then the code runs and draws', () => {
  const vm = newVM();
  offer(vm, GOOD);
  assert.equal(vm.evaluate('#STUB.frames'), vm.evaluate('#STUB.frames'));
  const framesBefore = Number(vm.evaluate('#STUB.frames'));
  assert.equal(vm.evaluate('WoWAICode.Status().running[1]'), null, 'offering it started nothing');
  vm.cmd('code load 1');
  assert.match(vm.prints(), /ready/);
  assert.match(vm.prints(), /demo is running \(slot 1, #1, 5 lines, check [0-9a-f]{8}\)/);
  assert.equal(Number(vm.evaluate('#STUB.frames')), framesBefore + 1);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  assert.match(vm.prints(), /level up/);
  assert.equal(vm.evaluate('WoWAICode.Status().running[1].name'), 'demo');
});

test('loader: the check number shown by the bridge is the one the game computes', () => {
  const vm = newVM();
  const o = offer(vm, GOOD);
  assert.equal(vm.evaluate(`WoWAICode.Check(${C.luaString(GOOD)})`), o.hash);
  assert.equal(o.hash, L.hash(GOOD));
});

test('loader: stop hides the frames, drops the scripts and cancels timers; a stopped timer callback does nothing', () => {
  const vm = newVM();
  offer(vm, 'local f = CreateFrame("Frame")\nf:SetScript("OnEvent", function() print("fired") end)\nf:RegisterEvent("PLAYER_DEAD")\nC_Timer.After(1, function() print("late") end)');
  vm.cmd('code load 1');
  vm.run('STUB.mine = STUB.frames[#STUB.frames]');
  assert.equal(vm.evaluate('STUB.mine.shown'), 'true');
  assert.equal(vm.evaluate('STUB.mine.events.PLAYER_DEAD'), 'true', 'it did register the event');
  vm.cmd('code stop demo');
  vm.run('STUB.FireEvent("PLAYER_DEAD"); STUB.RunTimers()');
  const out = vm.prints();
  assert.ok(!out.includes('fired') && !out.includes('late'), out);
  assert.match(out, /demo stopped/);
  assert.equal(vm.evaluate('WoWAICode.Status().running[1]'), null);
  assert.equal(vm.evaluate('STUB.mine.shown'), 'false');
  assert.equal(vm.evaluate('STUB.mine.scripts.OnEvent'), null);
});

test('loader: even if the checker were fooled, the environment has none of the dangerous names', () => {
  const vm = newVM();
  const probes = ['SendChatMessage("hi", "SAY")', 'local g = _G\ng.x = 1', 'loadstring("x")', 'load("x")', 'getmetatable("")', 'CastSpellByName("x")', 'os.time()', 'io.open("x")', 'debug.sethook()', 'rawset(_G, "a", 1)', 'string.rep("x", 9)', 'C_Map.RequestLoadMapArt()', 'LoadAddOn("x")', 'RunScript("x")', 'setmetatable({}, {})', 'require("x")'];
  for (const [i, code] of probes.entries()) {
    const t = pool();
    // Put it in a slot without the checker, the way a bridge bug or a hand-edited file might.
    const text = require('../bridge/code').slotFile({ name: 'probe', seq: i + 1, slot: i + 1, source: code, hash: L.hash(code), lines: 1 });
    vm.setSlot(i + 1, text);
    vm.cmd(`code load ${i + 1}`);
    vm.cmd('code stop probe');
  }
  assert.equal(Number(vm.evaluate('STUB.chatSent')), 0, 'SendChatMessage was never reached');
  const out = vm.prints();
  assert.equal((out.match(/stopped with an error/g) || []).length, probes.length, out);
});

test('loader: globals cannot be set, frames are plain, secure templates and EditBox are refused, names are ignored', () => {
  const vm = newVM();
  const tries = [
    'x = 1', 'CreateFrame("Button", nil, UIParent, "SecureActionButtonTemplate")', 'CreateFrame("EditBox")',
    'CreateFrame("Frame", "UIParent")',
  ];
  tries.forEach((src, i) => {
    const text = C.slotFile({ name: 'probe', seq: i + 1, slot: i + 1, source: src, hash: L.hash(src), lines: 1 });
    vm.setSlot(i + 1, text);
    vm.cmd(`code load ${i + 1}`);
    vm.cmd('code stop probe');
  });
  const out = vm.prints();
  assert.match(out, /global variables are not allowed \(x\)/);
  assert.match(out, /template not allowed/);
  assert.match(out, /type not allowed/);
  assert.equal(vm.evaluate('UIParent.name'), 'UIParent', 'the real UIParent was not replaced');
  assert.equal(vm.evaluate('STUB.frames[#STUB.frames].name'), null, 'a name passed to CreateFrame is ignored');
});

test('loader: a slot that was tampered with, is empty, was already loaded, or is missing is not run', () => {
  const vm = newVM();
  const o = offer(vm, GOOD);
  const text = fs.readFileSync(o.t.slotFile(1), 'utf8').replace('print(\\"ready\\")', 'print(\\"EVIL\\")');
  assert.notEqual(text, fs.readFileSync(o.t.slotFile(1), 'utf8'));
  vm.setSlot(1, text);
  vm.cmd('code load 1');
  assert.match(vm.prints(), /the check number does not match the code/);
  assert.ok(!vm.prints().includes('EVIL'));
  vm.cmd('code load 2');
  assert.match(vm.prints(), /slot 2 has nothing in it, or it was already loaded this session/);
  vm.cmd('code load 1');
  assert.match(vm.prints(), /already loaded this session \(\/reload makes slots readable again\)/, 'a second read of a loaded slot is reported, not run');
  vm.run('LoadAddOn = nil; C_AddOns.LoadAddOn = function() return false, "MISSING" end');
  vm.cmd('code load 3');
  assert.match(vm.prints(), /slot 3 is not installed/);
});

test('loader: bad arguments, the off switch, and stop all', () => {
  const vm = newVM();
  offer(vm, GOOD);
  vm.cmd('code load 0'); vm.cmd('code load 21');
  assert.equal((vm.prints().match(/usage: \/wow-ai code load/g) || []).length, 2);
  vm.cmd('code load 1');
  vm.cmd('code off');
  assert.match(vm.prints(), /code is switched off \(1 stopped\)/);
  vm.cmd('code load 1');
  assert.match(vm.prints(), /code is switched off \(\/wow-ai code on\)/);
  vm.cmd('code on');
  assert.equal(vm.evaluate('WoWAIDB.settings.codeOff'), null);
  vm.cmd('code');
  assert.match(vm.prints(), /no code is running/);
  assert.equal(vm.evaluate('WoWAICode.StopAll()'), '0');
});

test('loader: slash commands that are not code commands still reach the agent', () => {
  const vm = newVM();
  const send = text => { vm.run('STUB.sent = nil'); vm.cmd(text); };
  send('code review my addon please');
  assert.ok(!/no code is running|usage/.test(vm.prints()), 'the words after "code" were not taken as a code command');
});

test('the two lists agree: what the checker allows is what the game environment contains', () => {
  const vm = newVM();
  const sorted = a => [...a].sort();
  const luaList = expr => vm.evaluate(`(function() local t = {} for k in pairs(${expr}) do t[#t + 1] = tostring(k) end table.sort(t) return table.concat(t, ",") end)()`).split(',').filter(Boolean);
  const globals = vm.evaluate('table.concat(WoWAICode.Allowed().globals, ",")').split(',');
  assert.deepEqual(sorted(globals), sorted(L.GLOBALS.filter(n => n !== 'print' && n !== 'CreateFrame')));
  assert.deepEqual(luaList('WoWAICode.Allowed().namespaces'), sorted(Object.keys(L.NAMESPACES)));
  for (const [ns, members] of Object.entries(L.NAMESPACES)) {
    const got = vm.evaluate(`table.concat(WoWAICode.Allowed().namespaces.${ns}, ",")`).split(',');
    assert.deepEqual(sorted(got), sorted(members), ns);
  }
  assert.deepEqual(luaList('WoWAICode.Allowed().frameTypes'), sorted(L.FRAME_TYPES));
  assert.deepEqual(luaList('WoWAICode.Allowed().templates'), sorted(L.TEMPLATES));
  assert.equal(vm.evaluate('WoWAICode.Allowed().slots'), '20');
});

// ---------------------------------------------------------------- end to end and plumbing

test('end to end: a reply with a wowcode block becomes a running addon only after the player loads it', () => {
  const t = pool();
  const agentReply = reply('xp-note', 'local f = CreateFrame("Frame")\nf:SetScript("OnEvent", function() print("xp", UnitXP("player")) end)\nf:RegisterEvent("PLAYER_XP_UPDATE")');
  const r = t.p.process(agentReply);
  assert.ok(r.results[0].ok);
  const vm = newVM();
  vm.setSlot(r.results[0].slot, fs.readFileSync(t.slotFile(r.results[0].slot), 'utf8'));
  vm.run('STUB.FireEvent("PLAYER_XP_UPDATE")');
  assert.ok(!vm.prints().includes('xp '), 'not running before the player loads it');
  vm.cmd(`code load ${r.results[0].slot}`);
  vm.run('STUB.FireEvent("PLAYER_XP_UPDATE")');
  assert.match(vm.prints(), /xp 1234/);
});

test('protocol: the agent is told about wowcode only when the pool is on and there is a game context', () => {
  const hint = P.codeHint(L.describe());
  assert.match(hint, /wowcode/);
  assert.match(hint, /Allowed names:/);
  assert.match(hint, /never to act for the player/);
  const on = P.systemPrompt('Character: X', '', '', hint);
  assert.ok(on.includes('wowcode'));
  assert.equal(P.systemPrompt('Character: X', '', ''), P.systemPrompt('Character: X', '', '', ''), 'off means no change');
  assert.ok(!P.systemPrompt('', '', '', hint).includes('wowcode'), 'no game context, no hint');
});

test('bridge: the banner says whether the code pool is on', () => {
  const SRC = path.join(__dirname, '..', 'bridge');
  const run = code => {
    const S = fs.mkdtempSync(path.join(os.tmpdir(), 'code-bridge-'));
    for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'feed.js', 'atlas.js', 'code.js', 'lint.js', 'coach.js']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
    fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(S, 'node_modules'));
    fs.mkdirSync(path.join(S, 'addons', 'WoWAI'), { recursive: true });
    fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
    Object.assign(cfg, { addonDir: path.join(S, 'addons'), inboxFile: path.join(S, 'addons', 'WoWAI', 'Inbox.lua'), savedVariablesFile: path.join(S, 'nope.lua'), defaultCwd: path.join(S, 'proj') });
    if (code) cfg.code = code;
    fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(S, 'p.txt'), 'v\t1\n');
    const env = { ...process.env }; delete env.CLAUDECODE;
    const r = spawnSync(process.execPath, ['bridge.js', '--project', path.join(S, 'proj'), '--inject-feed', path.join(S, 'p.txt'), '--feed-id', '1'], { cwd: S, encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.match(run(null), /code\s+: off \(code\.enabled in config\.json\)/);
  assert.match(run({ enabled: true }), /code\s+: on, 20 slots/);
});
