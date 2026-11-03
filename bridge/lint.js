// Checks addon code the agent proposes before it can reach the game (docs/CODE.md).
//
// The rule is an allowlist: code may name only the read-and-draw functions below. Anything else
// (chat, casting, targeting, trading, macros, loading more code, the global table) is a global
// that is not on the list, so it is refused. The addon rebuilds the same list as the runtime
// environment (addon/WoWAI/Code.lua; tests/code_test.js checks that the two agree).
//
// This is a review aid for code written by a model, not a defence against a determined
// attacker: a program that cannot be proven to stop is refused as far as is practical (no
// while/repeat/goto, bounded for loops, no direct recursion), but termination cannot be proven
// in general. The other walls are the runtime environment, the player reading and loading the
// code by hand each session, and the game's own protection of secure actions.
'use strict';

const LIMITS = { maxBytes: 12000, maxLines: 400, maxErrors: 12, maxLoop: 100000, maxWork: 2000000 };

const CORE = [
  'assert', 'error', 'ipairs', 'next', 'pairs', 'pcall', 'select', 'tonumber', 'tostring', 'type', 'unpack',
  'print', 'time', 'date', 'GetTime',
];
// Read-only questions about the game.
const GAME = [
  'UnitName', 'UnitLevel', 'UnitClass', 'UnitRace', 'UnitHealth', 'UnitHealthMax', 'UnitPower', 'UnitPowerMax',
  'UnitXP', 'UnitXPMax', 'UnitIsDead', 'UnitIsDeadOrGhost', 'UnitOnTaxi', 'UnitExists',
  'GetZoneText', 'GetSubZoneText', 'GetRealZoneText', 'GetMinimapZoneText', 'GetUnitSpeed', 'GetMoney',
  'GetFramerate', 'GetNetStats', 'IsMounted', 'IsResting', 'GetNumQuestLogEntries', 'GetQuestLogTitle',
  'GetItemInfo', 'GetSpellInfo', 'GetCoinTextureString',
];
// Drawing: frames come from CreateFrame, which the addon wraps (frame types and templates are checked again there).
const DRAW = ['CreateFrame', 'UIParent'];

const NAMESPACES = {
  string: ['format', 'sub', 'find', 'match', 'gmatch', 'gsub', 'len', 'lower', 'upper', 'byte', 'char'],
  table: ['insert', 'remove', 'sort', 'concat', 'wipe', 'getn'],
  math: ['abs', 'ceil', 'floor', 'max', 'min', 'sqrt', 'pi', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'log10', 'fmod', 'modf', 'huge', 'random'],
  C_Timer: ['After', 'NewTicker'],
  C_Map: ['GetBestMapForUnit', 'GetPlayerMapPosition', 'GetMapInfo', 'GetMapRectOnMap', 'GetMapWorldSize'],
  C_QuestLog: ['GetInfo', 'GetNumQuestLogEntries', 'IsComplete'],
};
const GLOBALS = [...CORE, ...GAME, ...DRAW];

const EVENTS = [
  'PLAYER_ENTERING_WORLD', 'PLAYER_LEVEL_UP', 'PLAYER_XP_UPDATE', 'PLAYER_DEAD', 'PLAYER_ALIVE', 'PLAYER_UNGHOST',
  'PLAYER_MONEY', 'PLAYER_REGEN_ENABLED', 'PLAYER_REGEN_DISABLED', 'PLAYER_CONTROL_LOST', 'PLAYER_CONTROL_GAINED',
  'ZONE_CHANGED', 'ZONE_CHANGED_NEW_AREA', 'ZONE_CHANGED_INDOORS', 'QUEST_LOG_UPDATE', 'QUEST_ACCEPTED',
  'QUEST_TURNED_IN', 'QUEST_REMOVED', 'UNIT_HEALTH', 'UNIT_POWER_UPDATE', 'BAG_UPDATE', 'UPDATE_FACTION',
  'SKILL_LINES_CHANGED',
];
const FRAME_TYPES = ['Frame', 'Button', 'StatusBar'];
const TEMPLATES = ['BackdropTemplate'];
// Methods that act on secure frames, climb the UI to reach other addons' frames, or exhaust memory.
const BANNED_MEMBERS = ['SetAttribute', 'GetAttribute', 'Click', 'GetChildren', 'GetRegions', 'rep', 'dump', 'RegisterForClicks'];

const globalSet = new Set(GLOBALS);
const EVENT_METHODS = new Set(['RegisterEvent', 'RegisterUnitEvent']);

// Adler-32 of the source bytes, as eight hex digits. The addon computes the same number from the
// text it loads and shows it, so the player can tell the code they read from the code they run.
function hash(source) {
  let a = 1, b = 0;
  for (const byte of Buffer.from(String(source), 'utf8')) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return (b * 65536 + a).toString(16).padStart(8, '0');
}

// The text of a plain string literal (no escapes), or null.
function literal(node) {
  if (!node || node.type !== 'StringLiteral' || typeof node.raw !== 'string') return null;
  const raw = node.raw;
  const q = raw[0];
  if ((q === '"' || q === "'") && raw.length >= 2 && raw[raw.length - 1] === q) {
    const inner = raw.slice(1, -1);
    return inner.includes('\\') ? null : inner;
  }
  const m = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw);
  return m ? m[2] : null;
}

function lint(source, options = {}) {
  const limits = { ...LIMITS, ...options };
  const errors = [];
  const fail = (line, message) => { if (errors.length < limits.maxErrors) errors.push({ line: line || 0, message }); };
  source = String(source ?? '');
  const bytes = Buffer.byteLength(source, 'utf8');
  const lines = source.split('\n').length;
  const stats = { bytes, lines, hash: hash(source) };
  const result = () => ({ ok: errors.length === 0, errors, stats });

  if (!source.trim()) { fail(0, 'the code is empty'); return result(); }
  if (bytes > limits.maxBytes) { fail(0, `the code is ${bytes} bytes; the limit is ${limits.maxBytes}`); return result(); }
  if (lines > limits.maxLines) { fail(0, `the code has ${lines} lines; the limit is ${limits.maxLines}`); return result(); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) { fail(0, 'the code contains control characters'); return result(); }

  let luaparse;
  try { luaparse = require('luaparse'); } catch {
    fail(0, 'the checker is not installed (npm ci in the wow-ai folder installs luaparse)');
    return result();
  }
  let ast;
  try { ast = luaparse.parse(source, { luaVersion: '5.1', scope: true, locations: true, comments: false }); } catch (e) {
    fail(e.line, 'syntax error: ' + String(e.message).replace(/^\[\d+:\d+\]\s*/, ''));
    return result();
  }
  const line = n => (n && n.loc ? n.loc.start.line : 0);

  // ---- Pass 1: resolve every local to its declaration, and note what is assigned to it ----
  let nextId = 1;
  const bindings = new Map();                   // id -> { id, num: bool, assigns: [expr], func: node|null }
  const scopes = [new Map()];
  const lookup = name => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return null; };
  const declare = (name, num, fn) => { const b = { id: nextId++, name, num, assigns: [], func: fn || null }; bindings.set(b.id, b); scopes[scopes.length - 1].set(name, b); return b; };
  const bindingOf = new WeakMap();              // Identifier node -> binding
  const children = n => {
    const out = [];
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'globals' || k === 'comments') continue;
      if (k === 'identifier' && n.type === 'MemberExpression') continue;   // a field name, not a variable
      if (k === 'key' && n.type === 'TableKeyString') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); } else if (v && typeof v.type === 'string') out.push(v);
    }
    return out;
  };

  function resolve(n) {
    switch (n.type) {
      case 'Identifier': { const b = lookup(n.name); if (b && n.isLocal !== false) bindingOf.set(n, b); return; }
      case 'LocalStatement': {
        n.init.forEach(resolve);
        n.variables.forEach((v, i) => {
          const b = declare(v.name, true);
          bindingOf.set(v, b);
          if (n.init[i] && !(i === n.init.length - 1 && /Call|Vararg/.test(n.init[i].type) && false)) b.assigns.push(n.init[i]);
          else b.assigns.push({ type: 'Unknown' });
        });
        return;
      }
      case 'AssignmentStatement':
        n.init.forEach(resolve);
        n.variables.forEach((v, i) => {
          resolve(v);
          const b = v.type === 'Identifier' ? bindingOf.get(v) : null;
          if (b) b.assigns.push(n.init[i] || { type: 'Unknown' });
        });
        return;
      case 'FunctionDeclaration': {
        let own = null;
        if (n.identifier && n.identifier.type === 'Identifier') {
          if (n.isLocal) { own = declare(n.identifier.name, false, n); bindingOf.set(n.identifier, own); } else resolve(n.identifier);
        } else if (n.identifier) resolve(n.identifier);
        scopes.push(new Map());
        for (const p of n.parameters) { if (p.type === 'Identifier') { const b = declare(p.name, false); bindingOf.set(p, b); } }
        n.body.forEach(resolve);
        scopes.pop();
        return;
      }
      case 'ForNumericStatement': {
        [n.start, n.end, n.step].forEach(e => e && resolve(e));
        scopes.push(new Map());
        bindingOf.set(n.variable, declare(n.variable.name, true));
        n.body.forEach(resolve);
        scopes.pop();
        return;
      }
      case 'ForGenericStatement': {
        n.iterators.forEach(resolve);
        const it = n.iterators[0];
        const isIpairs = n.iterators.length === 1 && it.type === 'CallExpression' && it.base.type === 'Identifier' && it.base.name === 'ipairs' && !lookup('ipairs');
        scopes.push(new Map());
        n.variables.forEach((v, i) => bindingOf.set(v, declare(v.name, isIpairs && i === 0)));
        n.body.forEach(resolve);
        scopes.pop();
        return;
      }
      case 'DoStatement': scopes.push(new Map()); n.body.forEach(resolve); scopes.pop(); return;
      case 'IfClause': case 'ElseifClause': case 'ElseClause':
        if (n.condition) resolve(n.condition);
        scopes.push(new Map()); n.body.forEach(resolve); scopes.pop();
        return;
      case 'WhileStatement': case 'RepeatStatement':
        children(n).forEach(resolve);
        return;
      default: children(n).forEach(resolve);
    }
  }
  ast.body.forEach(resolve);

  // ---- A "number" local is one whose every assigned value is a plain number expression ----
  const isNumberExpr = e => {
    if (!e) return false;
    switch (e.type) {
      case 'NumericLiteral': return true;
      case 'Identifier': { const b = bindingOf.get(e); return !!(b && b.num); }
      case 'UnaryExpression': return e.operator === '#' || (e.operator === '-' && isNumberExpr(e.argument));
      case 'BinaryExpression': return ['+', '-', '*', '/', '%'].includes(e.operator) && isNumberExpr(e.left) && isNumberExpr(e.right);
      case 'CallExpression': {
        const b = e.base;
        return b.type === 'MemberExpression' && b.indexer === '.' && b.base.type === 'Identifier' && b.base.name === 'math'
          && !bindingOf.has(b.base) && NAMESPACES.math.includes(b.identifier.name) && b.identifier.name !== 'pi' && b.identifier.name !== 'huge';
      }
      default: return false;
    }
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const b of bindings.values()) {
      if (b.num && b.assigns.some(a => !isNumberExpr(a))) { b.num = false; changed = true; }
    }
  }

  // ---- Pass 2: the rules ----
  const isCallBase = (parent, node) => parent && (parent.type === 'CallExpression' || parent.type === 'StringCallExpression' || parent.type === 'TableCallExpression') && parent.base === node;

  function check(n, parent, ctx) {
    switch (n.type) {
      case 'WhileStatement': fail(line(n), 'while loops are not allowed (they cannot be proven to stop); use a for loop or a timer'); break;
      case 'RepeatStatement': fail(line(n), 'repeat loops are not allowed (they cannot be proven to stop); use a for loop or a timer'); break;
      case 'GotoStatement': case 'LabelStatement': fail(line(n), 'goto is not allowed'); break;
      case 'ForNumericStatement': {
        const counts = e => e.type === 'CallExpression' && e.arguments.length === 0 && (
          (e.base.type === 'Identifier' && e.base.name === 'GetNumQuestLogEntries' && !bindingOf.has(e.base)) ||
          (e.base.type === 'MemberExpression' && e.base.base.type === 'Identifier' && e.base.base.name === 'C_QuestLog' && !bindingOf.has(e.base.base) && e.base.identifier.name === 'GetNumQuestLogEntries'));
        const bound = e => e && (counts(e) || (e.type === 'NumericLiteral' && Math.abs(e.value) <= limits.maxLoop) ||
          (e.type === 'UnaryExpression' && e.operator === '#') ||
          (e.type === 'UnaryExpression' && e.operator === '-' && e.argument.type === 'NumericLiteral' && e.argument.value <= limits.maxLoop));
        if (n.step && n.step.type === 'NumericLiteral' && n.step.value === 0) fail(line(n), 'a for loop step of 0 never ends');
        if (!bound(n.end) || (n.step && !bound(n.step))) fail(line(n), `a for loop must end at a number up to ${limits.maxLoop}, at #something or at the quest log count`);
        break;
      }
      case 'Identifier': {
        if (n.isLocal === false || (!bindingOf.has(n) && n.isLocal !== true)) {
          const name = n.name;
          if (ctx.assignTarget === n) { fail(line(n), `sets the global "${name}"; use a local variable`); break; }
          if (NAMESPACES[name]) {
            const okUse = parent && (parent.type === 'MemberExpression' || parent.type === 'IndexExpression') && parent.base === n;
            if (!okUse) fail(line(n), `"${name}" can only be used as ${name}.something`);
          } else if (!globalSet.has(name)) {
            fail(line(n), `"${name}" is not allowed (code may use only the functions listed in the code reference)`);
          } else if (name === 'CreateFrame' && !isCallBase(parent, n)) {
            fail(line(n), 'CreateFrame can only be called directly');
          }
        } else {
          const b = bindingOf.get(n);
          if (b && b.func && ctx.fn && ctx.fn === b.func && !(ctx.declaring === n)) fail(line(n), `"${n.name}" calls itself; recursion is not allowed (it cannot be proven to stop)`);
        }
        break;
      }
      case 'MemberExpression': {
        const name = n.identifier.name;
        if (BANNED_MEMBERS.includes(name)) fail(line(n), `".${name}" is not allowed`);
        const base = n.base;
        if (base.type === 'Identifier' && NAMESPACES[base.name] && !bindingOf.has(base) && !NAMESPACES[base.name].includes(name)) {
          fail(line(n), `${base.name}.${name} is not allowed`);
        }
        if (EVENT_METHODS.has(name)) {
          if (!(isCallBase(parent, n))) fail(line(n), `${name} can only be called directly`);
          else if (parent.type !== 'CallExpression') fail(line(n), `${name} needs a quoted event name`);
          else {
            const ev = literal(parent.arguments[0]);
            if (ev === null || !EVENTS.includes(ev)) fail(line(n), `${name}: ${ev === null ? 'the event must be a plain quoted name' : `event ${ev} is not allowed`}`);
          }
        }
        break;
      }
      case 'IndexExpression': {
        const key = n.index;
        const lit = literal(key);
        if (key.type === 'NumericLiteral') break;
        if (lit !== null) {
          if (BANNED_MEMBERS.includes(lit)) fail(line(n), `["${lit}"] is not allowed`);
          if (EVENT_METHODS.has(lit)) fail(line(n), `write ${lit} with a dot or colon so it can be checked`);
          if (n.base.type === 'Identifier' && NAMESPACES[n.base.name] && !bindingOf.has(n.base) && !NAMESPACES[n.base.name].includes(lit)) fail(line(n), `${n.base.name}["${lit}"] is not allowed`);
          break;
        }
        if (!isNumberExpr(key)) fail(line(n), 'a computed key must be a number (a loop counter, #t or arithmetic on them); name the field instead');
        break;
      }
      case 'TableKeyString': break;
      case 'TableKey':
        if (!(n.key.type === 'NumericLiteral' || literal(n.key) !== null || isNumberExpr(n.key))) fail(line(n), 'a table key written with [ ] must be a number or a plain quoted name');
        if (literal(n.key) !== null && (BANNED_MEMBERS.includes(literal(n.key)) || EVENT_METHODS.has(literal(n.key)))) fail(line(n), `key "${literal(n.key)}" is not allowed`);
        break;
      case 'CallExpression': case 'StringCallExpression': case 'TableCallExpression': {
        const b = n.base;
        if (b.type === 'Identifier' && b.name === 'CreateFrame' && n.type === 'CallExpression' && !bindingOf.has(b)) {
          const a = n.arguments;
          const type = literal(a[0]);
          if (type === null || !FRAME_TYPES.includes(type)) fail(line(n), `CreateFrame: the type must be one of ${FRAME_TYPES.join(', ')}`);
          const tpl = a[3];
          if (tpl && tpl.type !== 'NilLiteral') {
            const t = literal(tpl);
            if (t === null || !TEMPLATES.includes(t)) fail(line(n), `CreateFrame: the template must be left out or be one of ${TEMPLATES.join(', ')}`);
          }
          if (a.length > 4) fail(line(n), 'CreateFrame: too many arguments');
        }
        break;
      }
      default: break;
    }
  }

  function walk(n, parent, ctx) {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    let next = ctx;
    if (n.type === 'AssignmentStatement') {
      n.init.forEach(c => walk(c, n, ctx));
      for (const v of n.variables) {
        if (v.type === 'Identifier') { check(v, n, { ...ctx, assignTarget: v }); } else walk(v, n, ctx);
      }
      return;
    }
    if (n.type === 'FunctionDeclaration') {
      if (n.identifier && n.identifier.type === 'Identifier' && !bindingOf.has(n.identifier) && n.identifier.isLocal === false) {
        fail(line(n), `sets the global "${n.identifier.name}"; use a local function`);
      } else if (n.identifier && n.identifier.type === 'MemberExpression') {
        walk(n.identifier, n, ctx);
      }
      next = { ...ctx, fn: n, declaring: n.identifier };
      n.parameters.forEach(p => { if (p.type !== 'VarargLiteral') { /* parameters are locals */ } });
      n.body.forEach(c => walk(c, n, next));
      return;
    }
    check(n, parent, ctx);
    if (n.type === 'ForNumericStatement' || n.type === 'ForGenericStatement') {
      // Loops multiply: a rough count of how often the innermost body can run.
      let times = 1000;                                   // a loop over data or #t: assume a thousand
      if (n.type === 'ForNumericStatement') {
        const e = n.end;
        if (e && e.type === 'NumericLiteral') times = Math.max(1, Math.abs(e.value));
        else if (e && e.type === 'CallExpression') times = 100;     // the quest log count
      }
      const work = (ctx.work || 1) * times;
      if (work > limits.maxWork && !ctx.workReported) { fail(line(n), `nested loops could run about ${Math.round(work).toLocaleString('en-US')} times; keep the product under ${limits.maxWork.toLocaleString('en-US')}`); next = { ...ctx, work, workReported: true }; }
      else next = { ...ctx, work };
    }
    for (const c of children(n)) walk(c, n, next);
  }
  walk(ast, null, {});

  return result();
}

// The allowed vocabulary as prompt text, so the agent writes code that passes.
function describe() {
  return [
    `Lua 5.1. At most ${LIMITS.maxLines} lines and ${LIMITS.maxBytes} bytes. Code may only read the game and draw. Allowed names: ${[...CORE, ...GAME].join(', ')}; ` +
      Object.entries(NAMESPACES).map(([k, v]) => `${k}.{${v.join(',')}}`).join('; ') + '; UIParent; CreateFrame(type, name, parent, template) with type one of ' + FRAME_TYPES.join('/') + ' and template left out or BackdropTemplate.',
    `Frames take the usual methods (SetPoint, SetSize, CreateTexture, CreateFontString, SetScript, Show, Hide, ...) except ${BANNED_MEMBERS.join(', ')}. Register events with frame:RegisterEvent("NAME") using a plain quoted name from: ${EVENTS.join(', ')}.`,
    'No global variables (use local), no while/repeat/goto, no recursion, nested loops must stay small (a thousand times a thousand at most), for loops must end at a literal up to ' + LIMITS.maxLoop + ', at #t or at GetNumQuestLogEntries(), computed keys t[k] only when k is a number, no strings or fields built to name a function. The checker rejects anything else with the line number.',
  ].join('\n');
}

module.exports = { lint, hash, describe, literal, LIMITS, GLOBALS, NAMESPACES, EVENTS, FRAME_TYPES, TEMPLATES, BANNED_MEMBERS };
