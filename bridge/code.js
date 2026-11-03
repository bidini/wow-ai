// The code pool: addon code the agent proposes in a reply, checked by lint.js and put into a
// numbered slot addon (WoWAI_C01..) for the player to load by hand (docs/CODE.md).
//
// Nothing here runs code and nothing runs without the player: the bridge only writes a data file
// into a load-on-demand addon that stays unloaded until the player types /wow-ai code load <slot>.
// Every proposal, accepted or refused, is kept under <audit dir>/ so it can be read afterwards.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lint');

const NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const BLOCK_RE = /```wowcode[ \t]*([^\n]*)\n([\s\S]*?)```/g;
const MAX_PER_REPLY = 3;
const DEFAULT_SLOTS = 20;

const pad2 = n => String(n).padStart(2, '0');
const slotName = n => 'WoWAI_C' + pad2(n);

// A Lua string literal that reads back byte for byte: quotes, backslashes and every
// control or non-ASCII byte are written as decimal escapes.
function luaString(text) {
  let out = '"';
  for (const b of Buffer.from(String(text), 'utf8')) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else if (b === 0x0a) out += '\\n';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += '\\' + String(b).padStart(3, '0');
  }
  return out + '"';
}

function slotFile({ name, seq, slot, source, hash, lines }) {
  return [
    `-- WoW AI code slot ${pad2(slot)}. Written by the bridge after the checker accepted the code.`,
    '-- It is only data: the addon runs it when the player types /wow-ai code load ' + slot + '.',
    `WoWAI_CodeSlot = { name = ${luaString(name)}, seq = ${seq}, slot = ${slot}, hash = ${luaString(hash)}, lines = ${lines}, source = ${luaString(source)} }`,
    '',
  ].join('\n');
}

function createPool({ addonDir, auditDir, store, slots = DEFAULT_SLOTS, maxBytes = L.LIMITS.maxBytes, log = () => {}, now = () => Date.now() }) {
  store.seq = Number.isInteger(store.seq) ? store.seq : 0;

  function atomic(file, text) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }
  const installed = () => fs.existsSync(path.join(addonDir, slotName(1), 'Code.lua'));

  function audit(entry, source) {
    try {
      fs.mkdirSync(auditDir, { recursive: true, mode: 0o755 });
      if (source !== null && entry.seq) atomic(path.join(auditDir, `${entry.name}.${entry.seq}.lua`), source + '\n');
      fs.appendFileSync(path.join(auditDir, 'code-log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o644 });
    } catch (e) { log(`code: cannot write the audit trail (${e.code || e.message})`); }
  }

  // Take the wowcode blocks out of a reply's text. The code stays visible in the reply (the player
  // is meant to read it); a note follows each block. Returns { text, notes, results }.
  function process(text) {
    const notes = [], results = [];
    let count = 0;
    const out = String(text ?? '').replace(BLOCK_RE, (whole, header, body) => {
      count++;
      const name = String(header).trim().split(/\s+/)[0] || '';
      const source = String(body).replace(/\r/g, '').replace(/\s+$/, '');
      const at = new Date(now()).toISOString();
      const refuse = (reasons, stats) => {
        results.push({ name, ok: false, reasons });
        notes.push(`code "${name || '?'}" was NOT accepted: ${reasons.slice(0, 5).join('; ')}${reasons.length > 5 ? `; and ${reasons.length - 5} more` : ''}`);
        audit({ at, name: name || '?', ok: false, reasons, hash: stats && stats.hash, bytes: stats && stats.bytes }, null);
        return whole;
      };
      if (count > MAX_PER_REPLY) return refuse([`only the first ${MAX_PER_REPLY} code blocks of a reply are looked at`]);
      if (!NAME_RE.test(name)) return refuse(['the name must be 1 to 24 lowercase letters, digits, - or _, starting with a letter']);
      const r = L.lint(source, { maxBytes });
      if (!r.ok) return refuse(r.errors.map(e => (e.line ? `line ${e.line}: ` : '') + e.message), r.stats);
      if (!installed()) return refuse(['the code slots are not installed (run node setup.js in the wow-ai folder, then restart WoW)'], r.stats);
      const seq = ++store.seq;
      const slot = ((seq - 1) % slots) + 1;
      try {
        atomic(path.join(addonDir, slotName(slot), 'Code.lua'), slotFile({ name, seq, slot, source, hash: r.stats.hash, lines: r.stats.lines }));
      } catch (e) {
        store.seq--;
        return refuse([`cannot write slot ${slot} (${e.code || e.message})`], r.stats);
      }
      results.push({ name, ok: true, slot, seq, hash: r.stats.hash, lines: r.stats.lines });
      notes.push(`code "${name}" accepted: ${r.stats.lines} lines, check ${r.stats.hash}. Read it above, then load it in the game with /wow-ai code load ${slot} (it stops with /wow-ai code stop ${name}, and never starts by itself).`);
      audit({ at, name, ok: true, seq, slot, hash: r.stats.hash, lines: r.stats.lines, bytes: r.stats.bytes }, source);
      log(`code: "${name}" accepted into slot ${slot} (#${seq}, ${r.stats.lines} lines)`);
      return whole;
    });
    return { text: out, notes, results };
  }

  return { process, installed, slots };
}

module.exports = { createPool, slotFile, luaString, slotName, NAME_RE };
