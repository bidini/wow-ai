// Round-trip test: the addon's real Codec.lua (run in a Lua VM) -> PNG -> the capture decoders.
// capture.ps1 on Windows; elsewhere both Python decoders (capture_x11.py for Linux,
// capture_mac.py for macOS: their --test-image mode needs only the stdlib). Simulates game
// rendering with noise and gamma.
'use strict';
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

// Windows decodes with capture.ps1; elsewhere the Python decoder stands in, if python3 is there.
if (process.platform !== 'win32') {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
  catch { console.log('SKIP Codec.lua round-trip: python3 is required off Windows.'); process.exit(0); }
}

const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const CAPTURE = path.join(__dirname, '..', 'bridge', 'capture.ps1');
const CAPTURE_X11 = path.join(__dirname, '..', 'bridge', 'capture_x11.py');
const CAPTURE_MAC = path.join(__dirname, '..', 'bridge', 'capture_mac.py');
const TMP = path.join(__dirname, 'tmp');
const CELL = 4, CELLS = 200, MAXROWS = 48;
fs.mkdirSync(TMP, { recursive: true });

function encodeWithLua(id, payload) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    `\nlocal cells, n = WoWAI_Codec.Encode(${id}, ${lit})\n` +
    `local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\n` +
    `RESULT = table.concat(t, ",")\n`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) {
    throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pure-primary cells, random noise, and a gamma curve like the in-game sliders.
function render(cells, jitter, gamma) {
  const W = CELLS * CELL, H = MAXROWS * CELL;
  const rgb = Buffer.alloc(W * H * 3, 0x30);
  cells.forEach((v, i) => {
    const c = i % CELLS, r = Math.floor(i / CELLS);
    const lv = [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(l => l * 178);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const o = ((r * CELL + y) * W + (c * CELL + x)) * 3;
      for (let k = 0; k < 3; k++) {
        let val = lv[k];
        if (gamma) val = 255 * Math.pow(val / 255, gamma);
        const n = jitter ? Math.round((Math.random() * 2 - 1) * jitter) : 0;
        rgb[o + k] = Math.max(0, Math.min(255, Math.round(val + n)));
      }
    }
  });
  return png(W, H, rgb);
}

// [name, decoded JSON] per decoder that runs on this platform.
function decode(file) {
  const last = out => JSON.parse(out.trim().split('\n').pop());
  if (process.platform === 'win32') {
    return [['capture.ps1', last(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE, '-TestImage', file], { encoding: 'utf8' }))]];
  }
  return [['capture_x11.py', CAPTURE_X11], ['capture_mac.py', CAPTURE_MAC]]
    .map(([name, script]) => [name, last(execFileSync('python3', [script, '--test-image', file], { encoding: 'utf8' }))]);
}

const cases = [
  { id: 7, payload: 'sess1\x1Fchat1\x1F7\x1FC:\\Users\\me\\proj\x1F\x1Fname\x1Fhéllo wörld ✓ — "quotes" & \\backslash\\ end', jitter: 0, gamma: 1 },
  { id: 4242, payload: 'sess1\x1Fchat1\x1F4242\x1FC:\\x\x1Fn\x1F\x1F' + 'Refactor the player controller so jumping feels less floaty. '.repeat(40), jitter: 60, gamma: 0.6 },
  { id: 9, payload: 'sess1\x1Fchat1\x1F9\x1FC:\\x\x1F\x1F\x1F' + 'a fairly long paste: '.repeat(140), jitter: 40, gamma: 1.8 },
  { id: 65000, payload: '\x1F\x1F\x1F\x1F\x1F\x1Fx', jitter: 85, gamma: 1 },
  // Event-feed batches (docs/EVENTS.md): tabs, newlines, accents, and a typical and a full-size payload.
  { id: 12, payload: 'sess1\x1F\x1F12\x1F\x1Fe\x1F\x1F' + ['v\t1', 'S\t1700000000\t7\t1429\t421\t659\t7.0\t7.0\tForêt d\'Elwynn\tGoldshire\t0\t10\t100', 'Q\t176*\t33', 'E\t1700000001\tqaccept\t33\tLoups à la frontière', 'P\t1700000002\t1429\t421\t659'].join('\n'), jitter: 40, gamma: 1.3 },
  { id: 13, payload: 'sess1\x1F\x1F13\x1F\x1Fe\x1F\x1F' + ['v\t1', 'S\t1700000000\t7\t1429\t421\t659\t7.0\t7.0\tElwynn Forest\tGoldshire\t0\t10\t100'].concat(Array.from({ length: 40 }, (_, i) => 'E\t' + (1700000000 + i) + '\tqaccept\t' + i + '\tQuest number ' + i)).concat(Array.from({ length: 20 }, (_, i) => 'P\t' + (1700000100 + i) + '\t1429\t' + (400 + i) + '\t' + (600 + i))).join('\n'), jitter: 80, gamma: 0.8 },
  // A batch with the atlas lines of docs/DISTANCE.md (a continent size and 8 zone maps).
  { id: 14, payload: 'sess1\x1F\x1F14\x1F\x1Fe\x1F\x1F' + ['v\t1', 'S\t1700000000\t7\t1429\t421\t659\t7.0\t7.0\tElwynn Forest\tGoldshire\t0\t10\t100', 'K\t0\t40000\t30000'].concat(Array.from({ length: 8 }, (_, i) => 'W\t' + (1429 + i) + '\t0\t' + (3000 + i * 10) + '\t' + (3500 + i * 10) + '\t7000\t7500\tZone ' + i + ' Forêt')).join('\n'), jitter: 70, gamma: 1.2 },
  // A login batch with the character lines (docs/EVENTS.md): race and class, gear, skills and two spell chunks.
  { id: 15, payload: 'sess1\x1F\x1F15\x1F\x1Fe\x1F\x1F' + ['v\t1', 'S\t1700000000\t12\t1429\t421\t659\t7.0\t7.0\tElwynn Forest\tGoldshire\t0\t10\t100\t123456', 'H\tNight Elf\tHunter\tAlliance', 'I\t1=1234\t2=2345\t3=3456\t5=4567\t6=5678\t7=6789\t8=7890\t10=8901\t16=9012', 'R\tBows=46/115\tSkinning=75/75\tFirst Aid=40/75\tSwords=10/115'].concat(Array.from({ length: 2 }, (_, c) => 'A\t1700000001\t' + (c + 1) + '\t6\t' + Array.from({ length: 12 }, (_, i) => 'Spell number ' + (c * 12 + i) + '=' + (i % 4 + 1)).join('\t'))).join('\n'), jitter: 70, gamma: 1.2 },
];

let pass = 0, total = 0;
for (const t of cases) {
  const cells = encodeWithLua(t.id, t.payload);
  const file = path.join(TMP, `strip_${t.id}.png`);
  fs.writeFileSync(file, render(cells, t.jitter, t.gamma));
  for (const [name, res] of decode(file)) {
    total++;
    const ok = res.id === t.id && res.text === t.payload;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  id=${t.id}  bytes=${Buffer.byteLength(t.payload)}  cells=${cells.length}  rows=${Math.ceil(cells.length / CELLS)}  noise=±${t.jitter} gamma=${t.gamma}` + (ok ? '' : `\n   got ${JSON.stringify(res).slice(0, 200)}`));
  }
}
console.log(pass === total ? '>>> CODEC ROUND-TRIP PASS' : '>>> CODEC ROUND-TRIP FAIL');
process.exit(pass === total ? 0 : 1);
