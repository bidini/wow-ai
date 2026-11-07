# Event feed

The addon tells the bridge what happens in the game: quests accepted, ready and turned in, new zones, level-ups, deaths, and where you walk. The bridge writes it to files and puts a short summary into the agent's system prompt, so the agent knows your recent history and path **without you typing it and without an agent run per event** (the reminder, [REMINDER.md](REMINDER.md), starts one check per few events and answers only when it has something to say). Nothing here moves, targets, casts or acts for you; it only reads game state and draws.

```
 game events ─▶ Feed.lua ─▶ pixel strip (flag "e") ─▶ capture ─▶ bridge/feed.js ─▶ <folder>/state/*.json[l]
 position (10 s)  batches,      about 200 bytes,         as for       cleans, dedupes,    + summary in the
                  snapshot      2 s, shown twice         messages     writes files        agent's system prompt
```

## What is reported

| Event (`E` line) | When | Arguments |
|---|---|---|
| `login` | login or `/reload` | `initial` or `reload` |
| `zone` | `ZONE_CHANGED_NEW_AREA` | map id, zone name |
| `sub` | `ZONE_CHANGED`, `ZONE_CHANGED_INDOORS`, sub-zone name changed | sub-zone name |
| `level` | `PLAYER_LEVEL_UP` | new level |
| `dead`, `alive` | `PLAYER_DEAD`; `PLAYER_ALIVE` / `PLAYER_UNGHOST` once no longer dead or a ghost | none |
| `qaccept`, `qready` | the quest log gained a quest / a quest became complete | quest id, title |
| `qdone` | `QUEST_TURNED_IN` | quest id, title |
| `qdrop` | a quest left the log without being turned in | quest id, title |
| `taxi` | a flight ended (10 s or longer) | seconds, from map and position, to map and position (see [DISTANCE.md](DISTANCE.md)) |
| `tick` | nothing else was sent for 5 minutes (a heartbeat) | none |

Quests are found by comparing the quest log with the last look (1.5 s after `QUEST_LOG_UPDATE` settles), so the same code works whatever arguments the client gives its quest events. The whole log goes out with a change as a `Q` line. The quest line carries each quest's name once per login (`id=name`); the bridge keeps the names (also from the accept and ready events, in `snapshot.json` under `quests.names`) and writes the summary as `Quest log: Name (id); …`. The agent is told to use the names when it writes to you and the numbers only to look things up.

Position is sampled every 10 s, **only when it changed** (more than 0.04 % of the map), and sent about once a minute while moving, or with the next event. No position is available in instances; the snapshot then has map `0` and empty coordinates.

## Wire format

One strip record per batch, in the layout of [ARCHITECTURE.md](ARCHITECTURE.md): `session ␟ chat ␟ id ␟ cwd ␟ flags ␟ name ␟ text`, with `chat`, `cwd` and `name` empty, **flags `e`**, and `id` a separate counter (`WoWAIDB.feedSeq`). It is not a message id on purpose: message ids select the 200 signal-file slots, and a stream of events would use them up and make acknowledgements for your real messages unreliable.

`text` is lines separated by `\n`, fields by `\t` (control characters in game text are replaced by spaces first):

```
v	1                                                    payload version; then the character name and realm (v 1 <name> <realm>)
S	t level map x10 y10 cur run zone subzone dead xp xpMax    state snapshot, in every batch
Q	176=Wolves Across the Border	33*	54       whole quest log; * = ready to turn in; =name once per session
E	t type args...                                       an event
P	t map x10 y10                                        a position sample
D	n                                                    n lines were dropped to fit
K / W  continent size / where a map lies on it       the distance atlas, see DISTANCE.md
H  race class faction                                the character, sent when it changes
I  slot=itemID ...                                   equipped items, sent when they change
R  skill=rank/max[/p|/s] ...                         skills; /p primary profession, /s secondary; sent when they change
A  gen i n spell=rank ...                            chunk i of n of the spells learned
Z  gen i n =first step step ...                      chunk i of n of the quests handed in (sorted, base 36, steps)
T  gen i n src id:k:map:x:y:name ...                  chunk i of n of the flight points of the continent (k 1 = known; x, y in tenths of a percent)
B  bind readyAt has [map x y]                        where the hearthstone is bound, when it can be used again (epoch s, 0 = now), whether one is carried, and where it was bound
```

The `S` line also ends with your **gold** in copper.

`t` is the game clock's Unix time; `x10`/`y10` are tenths of a percent of the map (0 to 1000); `cur` and `run` are yards per second (`GetUnitSpeed`). A batch is capped at 1200 bytes of payload; over that, the oldest position samples and then the oldest events are dropped and a `D` line says how many. Typical batches are 150 to 400 bytes: 3 to 6 rows of the strip, a sliver about 12 to 24 pixels tall.

## No acknowledgement files

Messages leave the strip when the bridge raises an `ack/NNN.wav` file. Events do not use that channel. The addon shows a batch for 2 seconds, hides it for 3, and shows it once more; the bridge ignores a repeat by remembering the last 64 `(number, content)` pairs per addon session (in `state.json`). Two chances at the configured capture rate (4 a second by default) should make a miss unlikely; the real rate on macOS is measured on a live client, and `feed hold` / `feed shows` are the dials if batches get missed. **Every batch carries a full snapshot**, so a missed batch costs history, never the current state. Gaps in the numbering are counted (`missedBatches` in `snapshot.json`).

A batch is only shown while the bridge is known to be alive (the same test the Send button uses), and one that has waited 2 minutes without that is dropped. It shares the strip with your messages: a message is always drawn first, and the batch is left out when the two do not fit together.

Tune it in game: `/wow-ai feed hold <seconds>` (default 2) and `/wow-ai feed shows <n>` (default 2), `/wow-ai feed off`, `/wow-ai feed atlas` (send the map atlas again), and `/wow-ai feed` for counts and the last error.

## Files the agent reads

The bridge writes them to `<default folder>/state/` (`feed.dir` in `config.json` moves them), mode 0644 in a folder only the bridge can write, so an agent running as another user can read them and not change them:

| File | Content |
|---|---|
| `summary.txt` | the same text that goes into the system prompt, under 1800 characters |
| `snapshot.json` | latest state: level, zone, map position, speeds, dead, XP, quest ids (active and ready), missed batches |
| `events.jsonl` | one JSON object per event: `{rx, t, type, args, session}`; rotated to `.1` at 2 MB |
| `trajectory.jsonl` | one `{t, m, x, y}` per position sample, x and y in map percent; rotated at 2 MB |

The system prompt block names these files by absolute path, so an agent whose only file tools are Read, Grep and Glob can open the full history when the summary is not enough. It is labelled as data about the game, never instructions: quest and zone names come from the game client and are cleaned (control characters, backticks and quotes removed, 50 characters per title) before they reach a prompt or a file.

## Several characters

Every batch starts with `v 1 <name> <realm>`, so the bridge knows who is playing. Each character gets its own folder, `<state folder>/characters/<name>-<realm>/` (lower case, letters and digits only, so a name can never point outside the folder), holding everything described on this page: `snapshot.json`, `events.jsonl`, `trajectory.jsonl`, `summary.txt` and the daily `log/<date>/` folders. What belongs to the game and not to a character stays one level up and is shared: `maps.json` and `maps.txt` (zone sizes) and `links-learned.json` (flight times).

`characters.json` and `characters.txt` in the state folder list everyone, newest first, with level, race and class, when they were last seen and where their folder is. The **active character** is the one whose batch arrived last. The agent's prompt names that character, gives only that character's state, and lists up to five others with their level and class so it can look them up if you ask ("what is Borin's gold?" means reading `characters/borin-<realm>/snapshot.json`). At most 50 characters are listed; folders are never removed. A batch from an older addon that has no name goes to `characters/unknown/`.

## The character

Besides what happens, the batches say who you are and what you have: **race, class and faction** (`H`), **gold** (the last field of every `S` line), **equipped items** by slot as item ids (`I`, 19 slots), **professions** (primary: mining, herbalism, skinning, the crafts; secondary: first aid, fishing, cooking) and **other skills** (weapons, class, languages) with rank and maximum (`R`; the addon marks a line `/p` or `/s` from the section it sits under in the skills list). A profession going up, or a new one appearing, is recorded at once; a weapon skill going up only updates the current value. Recipes are not read, because the game only gives them while a profession window is open, and **every spell learned**, highest rank of each (`A`). Gear, skills and spells are read when the game says they changed (equipment, spellbook and skill events, a level-up) and sent only if different from what was sent before; a new session sends them all again, 1 second after entering the world so they ride in the login batch. The spellbook is read through `C_SpellBook` where the client has it (the Forever client does not have the old global functions) and through the old ones otherwise. The **quests you have handed in** (`Z`) are read with `C_QuestLog.GetAllCompletedQuestIDs` (or `GetQuestsCompleted`), sorted, and sent as numbers in base 36, each chunk starting with an absolute number and then the steps from the one before; the list is sent again, 3 seconds later, when you hand a quest in. **Flight points** (`T`) are the nodes `C_TaxiMap.GetTaxiNodesForMap` lists for the continent you are on (the ones you have discovered; `src` says which call answered, or `none`), re-read when you open a flight master and when you change continent; the bridge keeps them in `character.flightPoints` with `flightSrc`. The **hearthstone** (`B`) is the bind place (`GetBindLocation`), when the item's cooldown ends and whether you carry one; when the bind place changes while you play, the spot where you stood is sent too, so the bridge knows which inn it is. A spellbook is sent as a numbered set in chunks of 12 spells (the quests in chunks of 80 numbers), two chunks to a batch; the bridge publishes a set only when every chunk of it has arrived, so a missed batch leaves the old list in place, and `/wow-ai feed info` sends everything again.

The bridge keeps the whole picture in `snapshot.json` under `character` (race, class, faction, gold in copper, `equipped` by slot, `professions`, other `skills`, `spells`, `completed` quest numbers, `flightPoints`, `hearth`) and puts one line in the prompt, for example: `Character: Night Elf Hunter (Alliance), 12g 34s 56c, 9 items equipped, 61 spells, professions: Mining 30/75, Skinning 75/75; secondary: First Aid 40/75, 2 other skills`. Item ids are numbers; the agent looks them up on Wowhead.

## The permanent daily log

Next to the live files, the bridge keeps a log that is **never rotated and never removed**: one folder per calendar day (the Mac's local date), in each character's folder, `<state folder>/characters/<name>-<realm>/log/`:

```
log/2026-11-04/events.jsonl      every event that day, appended (one JSON object per line)
log/2026-11-04/trajectory.jsonl  the path that day: t, map, x, y
log/2026-11-04/state.jsonl       the character over the day: level, zone, gold, equipped items (and skills and spells when new)
log/2026-11-04/day.txt           a short overview: active hours, level range, zones, quests turned in, deaths, flights
log/2026-11-04/day.json          the counts behind day.txt (the bridge's own bookkeeping)
```

Several sessions on the same date append to the same files, even across bridge restarts; a new date starts a new folder. A batch that crosses midnight is split between the two days by each line's own time. The live files at the top of the folder keep their 2 MB rotation (they are what the current state is built from); the daily files are the history.

`state.jsonl` gets a record for the first update of the day, then one every five minutes, and one at once when gear, skills, spells or the character change; the spell list is written only when it is new, so a record is about 450 bytes and a two-hour session about 11 KB. The agent's prompt names this folder and lists the newest seven dates that have a log, so it knows it can look back: it reads a day's `day.txt` first (about 1 KB) and the `.jsonl` files only when the detail matters. About 100 KB a day, so a year is well under 50 MB. Turn it off with `"feed": { "dailyLog": false }`.

## Configuration

```json
"feed": { "enabled": true, "dir": "", "maxFileBytes": 2000000, "dailyLog": true }
```

`enabled: false` makes the bridge ignore event records. `dir` is where the files go (default: `state` inside the bridge's default folder). The addon side is `/wow-ai feed on|off`.

## Testing without the game

- `tests/feed_test.js`: payload parsing, files and permissions, repeats, restarts, size limits, prompt wording.
- `tests/feed_addon_test.js`: the real `Feed.lua` and `WoWAI.lua` in a Lua VM: events, quests, position, priority over messages, then the decoded strip through the bridge's parser and feed (addon to files).
- `tests/feed_bridge_test.js`: the real `bridge.js` in a scratch folder.
- `tests/atlas_test.js`: the distance atlas ([DISTANCE.md](DISTANCE.md)).
- `tests/codec_test.js`: feed batches drawn to a PNG and read back by the Python capture decoders with noise and gamma.
- `node bridge/bridge.js --inject-feed payload.txt [--feed-id 5]` feeds a saved payload through the bridge's intake and exits, for trying the files and the summary by hand.

## Not covered yet

Whether the macOS capture reads a 3-row strip reliably at your capture interval, and how long it must stay up (`feed hold`), are measured on a live client. Real game events and argument orders (`QUEST_TURNED_IN`, `PLAYER_ALIVE`) follow the Classic API as documented and are guarded with `pcall`, but only a live client confirms them.
