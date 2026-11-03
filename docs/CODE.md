# Agent-written addon code

The agent can offer a small addon (an XP bar, a quest tracker, a zone label) as code. The bridge checks it, puts it where the game can reach it, and **you** load it with one command after reading it. It is off by default.

The rule that does not bend: **addons may read the game and draw; they may not act for you.** The checker enforces that with an allowlist, not a list of banned names: code may name only the functions listed below, so chat, casting, targeting, trading, mail, macros, loading more code and the global table are all simply unavailable.

```
 reply with ```wowcode name ──▶ bridge/lint.js ──▶ pass ──▶ WoWAI_C01..C20/Code.lua (data) ──▶ you: /wow-ai code load 3 ──▶ Code.lua runs it
 (the code stays visible)       allowlist check    fail ──▶ note with the lines            in an environment that holds only the allowed names
```

## Turning it on

In `bridge/config.json`:

```json
"code": { "enabled": true, "slots": 20, "maxBytes": 12000 }
```

Then run `node setup.js` once (it creates the 20 slot addons, `WoWAI_C01` to `WoWAI_C20`, inert and load-on-demand) and restart WoW, since the game only discovers new addon folders at launch. With `enabled: false` (the default) the agent is not told the feature exists and `wowcode` blocks are ignored.

## What the player sees

The agent writes a fenced block:

````
```wowcode xp-note
local f = CreateFrame("Frame")
...
```
````

The reply keeps the code so you can read it, and the bridge adds a note: `code "xp-note" accepted: 18 lines, check 9f3a1c20. Read it above, then load it in the game with /wow-ai code load 3`, or `code "xp-note" was NOT accepted: line 4: "SendChatMessage" is not allowed`. In the game:

| Command | |
|---|---|
| `/wow-ai code load <slot>` | run the code in that slot (the number is in the note) |
| `/wow-ai code stop <name\|all>` | hide its frames, drop its scripts and timers |
| `/wow-ai code off` / `on` | stop everything and refuse to load until `on` |
| `/wow-ai code` | what is running |

Loading prints the name, slot, lines and the **check number**; it must equal the one in the bridge's note (and in `state/code/code-log.jsonl`), so you know the code you read is the code that runs. Nothing loads at login or `/reload`, and code is gone after either.

## What the checker allows (`bridge/lint.js`)

- Lua 5.1, at most 400 lines and 12000 bytes, plain text.
- Names: `print`, `pairs`/`ipairs`/`next`/`select`/`type`/`tostring`/`tonumber`/`unpack`/`pcall`/`assert`/`error`, `time`/`date`/`GetTime`, read-only game questions (`UnitName`, `UnitLevel`, `UnitXP`, `GetZoneText`, `GetItemInfo`, ...), `string`, `table`, `math` (listed members only), `C_Timer.After`/`NewTicker`, `C_Map` and `C_QuestLog` reads, `UIParent`, and `CreateFrame`. The full list is in `lint.js` and is sent to the agent in the prompt.
- Frames: types `Frame`, `Button`, `StatusBar`; template left out or `BackdropTemplate`; a frame name is ignored (it would create a global). Not `EditBox`, not secure templates.
- Events: `frame:RegisterEvent("NAME")` with a plain quoted name from a short list of player, zone and quest events. No chat events.
- Not allowed: setting a global, `_G`, `loadstring`, `getmetatable`, `Click`, `SetAttribute`, `GetChildren`, `string.rep`, `while`, `repeat`, `goto`, recursion, a `for` loop that does not end at a literal (up to 100000), `#t` or the quest log count, nested loops whose product could pass about two million runs, and any computed key `t[k]` unless `k` is provably a number. That last rule is what stops a method name being built from pieces (`f["Set".."Attribute"]`).

## Layers, and what they do not do

1. **The checker** (bridge, before anything is written). A review aid for model-written code: it rejects everything off the list and code that looks like it might never stop. It cannot prove that a program stops, and it is not a defence against a determined attacker.
2. **The runtime environment** (`addon/WoWAI/Code.lua`). The code runs with a table that holds only the allowed names, global writes raise an error, `CreateFrame` is wrapped, and `C_Timer` callbacks stop when you stop the code. A checker bug does not make `SendChatMessage` appear. `tests/code_test.js` runs 16 forbidden calls through it and checks the two lists agree.
3. **You.** The code is shown before it can be loaded, and loading is your command, every session.
4. **The game's own protection** of secure actions for addon code.

Not covered: frame methods can't be intercepted (they live on game objects), so the checker bans the dangerous ones by name; code can still waste memory (for example by doubling a string in a loop) or time (a long chain of calls), which can freeze or crash the game until you close it, though it cannot act for you; and the Lua error text from running code goes to the game's chat, unfiltered.

## Files

The bridge keeps every proposal, accepted or refused, in `<feed folder>/code/` (`code-log.jsonl` with reasons and hashes, plus `<name>.<n>.lua` for accepted code), readable by the agent's account and writable only by the bridge's.

Slots are used round robin. A slot the game has already loaded this session is not read again until `/reload`, and the addon says so instead of running stale code; the number in the note is the slot to load.

## Testing without the game

`tests/lint_test.js` (accepts good programs; every bypass attempt is refused with its line), `tests/code_test.js` (the pool, the slot files byte for byte, the loader and its environment in a Lua VM, the two lists agreeing, a reply to a running frame, the prompt hint, the banner). Checking against a live client: that the stubbed API names exist on the Forever build, and that `LoadAddOn` of a fresh slot behaves like the reply slots do.
