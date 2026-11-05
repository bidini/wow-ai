// capture_mac.py reads a strip whose cells are not 4 pixels square. The game draws cells in UI
// units, and the window it renders to can be scaled by any factor (a Retina capture, a window that
// was resized), so the capture must measure the cell size from the picture. Strips here are
// drawn by the real Codec.lua at fractional pitches with blurred cell edges, a title bar above and
// noise around; a real capture of the first Forever login is the last case.
'use strict';
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
catch { console.log('SKIP scaled capture: python3 is required.'); process.exit(0); }

const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const CAPTURE_MAC = path.join(__dirname, '..', 'bridge', 'capture_mac.py');
const TMP = path.join(__dirname, 'tmp');
const CELLS = 200;
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
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Cells (and the black rest of their rows) drawn at pitch pw x ph from (ox, oy): each pixel takes the
// area-weighted mix of the cells it overlaps, as a scaled render does. Above is a title bar, the rest is
// a dark noisy scene.
function render(cells, { pw, ph, ox, oy, hide = 0, cover = null, width = 1100, height = 400, noise = 30 }) {
  const rows = Math.ceil(cells.length / CELLS);
  const cellRgb = i => {
    const v = i < cells.length ? cells[i] : 0;
    return [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(l => l * 255);
  };
  const under = (pos, origin, pitch, n) => {      // [index, weight] of the cells under the pixel [pos, pos + 1)
    const a = (pos - origin) / pitch, b = (pos + 1 - origin) / pitch, out = [];
    for (let k = Math.floor(a); k <= Math.floor(b - 1e-9); k++) {
      const w = (Math.min(b, k + 1) - Math.max(a, k)) / (b - a);
      if (k >= 0 && k < n && w > 0) out.push([k, w]);
    }
    return out;
  };
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 3;
    let px, scene = false;
    if (y < oy - 1) px = [46, 45, 45];                                           // title bar
    else if (y < oy + hide && x < pw * CELLS) px = [0, 0, 0];                    // black line above the strip (and over its top `hide` px)
    else {
      const cx = under(x, ox, pw, CELLS), cy = under(y, oy, ph, rows);
      px = null;
      if (cx.length && cy.length) {
        const acc = [0, 0, 0]; let wsum = 0;
        for (const [c, wx] of cx) for (const [r, wy] of cy) {
          const rgbc = cellRgb(r * CELLS + c);
          for (let k = 0; k < 3; k++) acc[k] += rgbc[k] * wx * wy;
          wsum += wx * wy;
        }
        px = acc.map(v => v / wsum);
      }
      if (!px) { px = [22, 26, 20]; scene = true; }                                // scene
    }
    if (cover && x < cover.w && y >= cover.fromY) { px = [60, 70, 55]; scene = true; }   // something on top of the corner, like the Dock
    for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, Math.round(px[k] + (Math.random() * 2 - 1) * noise * (scene ? 1 : 0.3))));
  }
  return png(width, height, rgb);
}

function decode(file) {
  const out = execFileSync('python3', ['-I', CAPTURE_MAC, '--test-image', file], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const feed = n => 'sess1\x1F\x1F5\x1F\x1Fe\x1F\x1F' + ['v\t1', 'S\t1700000000\t7\t1429\t421\t659\t7.0\t7.0\tForêt d\'Elwynn\tGoldshire\t0\t10\t100']
  .concat(Array.from({ length: n }, (_, i) => 'E\t' + (1700000000 + i) + '\tqaccept\t' + i + '\tQuest number ' + i)).join('\n');

const cases = [
  // The shape measured on the first Forever login: about 4.5 px wide and 2.8 px tall, one row.
  { name: 'one row, 4.5 x 2.8 (the Forever window)', pw: 4.5, ph: 2.8, ox: 0, oy: 57, id: 11, payload: feed(0) },
  { name: 'several rows, 4.5 x 2.8', pw: 4.5, ph: 2.8, ox: 0, oy: 57, id: 12, payload: feed(25) },
  { name: 'full-size batch, 4.5 x 2.8', pw: 4.5, ph: 2.8, ox: 0, oy: 57, id: 13, payload: feed(60) },
  { name: 'exact Retina, 8 x 8', pw: 8, ph: 8, ox: 0, oy: 56, id: 14, payload: feed(18), width: 1700 },
  { name: 'small cells, 3.1 x 3.1, long message', pw: 3.1, ph: 3.1, ox: 2, oy: 40, id: 15, payload: feed(60) },
  { name: 'offset and odd scale, 5.37 x 4.0', pw: 5.37, ph: 4.0, ox: 3, oy: 30, id: 16, payload: feed(33), width: 1200 },
  // The first live capture with several rows: columns 4.5 wide, rows 4 tall, and the window border hiding the top pixel of row 0.
  { name: 'one row, 4.5 x 4.0, top pixel hidden', pw: 4.5, ph: 4.0, ox: 0, oy: 56, hide: 1, id: 21, payload: feed(0) },
  { name: 'several rows, 4.5 x 4.0, top pixel hidden', pw: 4.5, ph: 4.0, ox: 0, oy: 56, hide: 1, id: 22, payload: feed(25) },
  { name: 'full-size batch, 4.5 x 4.0, top pixel hidden', pw: 4.5, ph: 4.0, ox: 0, oy: 56, hide: 1, id: 23, payload: feed(60) },
  { name: 'exact 4 x 4, top pixel hidden', pw: 4, ph: 4, ox: 0, oy: 56, hide: 1, id: 24, payload: feed(25) },
  // The addon starts the strip 96 px right of the corner on a Mac, and the Dock covers the window's left edge below row 3.
  { name: 'strip 96 px from the left, Dock over the edge', pw: 4.5, ph: 4.0, ox: 96, oy: 56, hide: 1, cover: { w: 80, fromY: 70 }, id: 25, payload: feed(60), width: 1200 },
  { name: 'strip 40 px from the left, 4 x 4, Dock over the edge', pw: 4, ph: 4, ox: 40, oy: 56, hide: 1, cover: { w: 34, fromY: 70 }, id: 26, payload: feed(25), width: 1100 },
  { name: 'exact 4 x 4 still works', pw: 4, ph: 4, ox: 0, oy: 10, id: 17, payload: feed(25) },
];

let pass = 0, total = 0;
const check = (name, ok, extra) => { total++; if (ok) pass++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n   ' + extra}`); };

for (const t of cases) {
  const cells = encodeWithLua(t.id, t.payload);
  const file = path.join(TMP, `scaled_${t.id}.png`);
  fs.writeFileSync(file, render(cells, t));
  const res = decode(file);
  check(`${t.name}  rows=${Math.ceil(cells.length / CELLS)}`, res.id === t.id && res.text === t.payload, `got ${JSON.stringify(res).slice(0, 200)}`);
}

// A real capture (cropped to the strip): it must pass the strip's own checksum and carry the message fields.
const real = decode(path.join(__dirname, 'fixtures', 'mac_scaled_strip.png'));
check('real capture of the Forever window', typeof real.id === 'number' && typeof real.text === 'string' && real.text.split('\x1F').length >= 7, `got ${JSON.stringify(real).slice(0, 200)}`);

// Part of the strip hidden (the macOS Dock over the left edge): rejected, never read as a different message.
{
  const cells = encodeWithLua(31, feed(25));
  const f = path.join(TMP, 'scaled_covered.png');
  fs.writeFileSync(f, render(cells, { pw: 4.5, ph: 4.0, ox: 0, oy: 56, hide: 1, cover: { w: 34, fromY: 70 } }));
  const res = decode(f);
  check('left edge covered is rejected', !!res.error && !res.id, `got ${JSON.stringify(res).slice(0, 200)}`);
}

// Nothing drawn: no strip, and not a false one.
const empty = path.join(TMP, 'scaled_none.png');
fs.writeFileSync(empty, render([], { pw: 4.5, ph: 2.8, ox: 0, oy: 57 }));
const none = decode(empty);
check('no strip is reported as none', !!none.error && !none.id, `got ${JSON.stringify(none).slice(0, 200)}`);

console.log(pass === total ? '>>> SCALED CAPTURE PASS' : '>>> SCALED CAPTURE FAIL');
process.exit(pass === total ? 0 : 1);
