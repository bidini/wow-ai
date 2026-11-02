# Event feed

The addon tells the bridge what happens in the game: quests accepted, ready and turned in, new zones, level-ups, deaths, and where you walk. The bridge writes it to files and puts a short summary into the agent's system prompt, so the agent knows your recent history and path **without you typing it and without an agent run per event**. Nothing here moves, targets, casts or acts for you; it only reads game state and draws.

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
| `tick` | nothing else was sent for 5 minutes (a heartbeat) | none |

Quests are found by comparing the quest log with the last look (1.5 s after `QUEST_LOG_UPDATE` settles), so the same code works whatever arguments the client gives its quest events. The whole log goes out with a change as a `Q` line.

Position is sampled every 10 s, **only when it changed** (more than 0.04 % of the map), and sent about once a minute while moving, or with the next event. No position is available in instances; the snapshot then has map `0` and empty coordinates.

## Wire format

One strip record per batch, in the layout of [ARCHITECTURE.md](ARCHITECTURE.md): `session ␟ chat ␟ id ␟ cwd ␟ flags ␟ name ␟ text`, with `chat`, `cwd` and `name` empty, **flags `e`**, and `id` a separate counter (`WoWAIDB.feedSeq`). It is not a message id on purpose: message ids select the 200 signal-file slots, and a stream of events would use them up and make acknowledgements for your real messages unreliable.

`text` is lines separated by `\n`, fields by `\t` (control characters in game text are replaced by spaces first):

```
v	1                                                    payload version
S	t level map x10 y10 cur run zone subzone dead xp xpMax    state snapshot, in every batch
Q	176	33*	54                                       whole quest log; * = ready to turn in
E	t type args...                                       an event
P	t map x10 y10                                        a position sample
D	n                                                    n lines were dropped to fit
```

`t` is the game clock's Unix time; `x10`/`y10` are tenths of a percent of the map (0 to 1000); `cur` and `run` are yards per second (`GetUnitSpeed`). A batch is capped at 1200 bytes of payload; over that, the oldest position samples and then the oldest events are dropped and a `D` line says how many. Typical batches are 150 to 400 bytes: 3 to 6 rows of the strip, a sliver about 12 to 24 pixels tall.

## No acknowledgement files

Messages leave the strip when the bridge raises an `ack/NNN.wav` file. Events do not use that channel. The addon shows a batch for 2 seconds, hides it for 3, and shows it once more; the bridge ignores a repeat by remembering the last 64 `(number, content)` pairs per addon session (in `state.json`). Two chances at the configured capture rate (4 a second by default) should make a miss unlikely; the real rate on macOS is measured on a live client, and `feed hold` / `feed shows` are the dials if batches get missed. **Every batch carries a full snapshot**, so a missed batch costs history, never the current state. Gaps in the numbering are counted (`missedBatches` in `snapshot.json`).

A batch is only shown while the bridge is known to be alive (the same test the Send button uses), and one that has waited 2 minutes without that is dropped. It shares the strip with your messages: a message is always drawn first, and the batch is left out when the two do not fit together.

Tune it in game: `/wow-ai feed hold <seconds>` (default 2) and `/wow-ai feed shows <n>` (default 2), `/wow-ai feed off`, and `/wow-ai feed` for counts and the last error.

## Files the agent reads

The bridge writes them to `<default folder>/state/` (`feed.dir` in `config.json` moves them), mode 0644 in a folder only the bridge can write, so an agent running as another user can read them and not change them:

| File | Content |
|---|---|
| `summary.txt` | the same text that goes into the system prompt, under 1800 characters |
| `snapshot.json` | latest state: level, zone, map position, speeds, dead, XP, quest ids (active and ready), missed batches |
| `events.jsonl` | one JSON object per event: `{rx, t, type, args, session}`; rotated to `.1` at 2 MB |
| `trajectory.jsonl` | one `{t, m, x, y}` per position sample, x and y in map percent; rotated at 2 MB |

The system prompt block names these files by absolute path, so an agent whose only file tools are Read, Grep and Glob can open the full history when the summary is not enough. It is labelled as data about the game, never instructions: quest and zone names come from the game client and are cleaned (control characters, backticks and quotes removed, 50 characters per title) before they reach a prompt or a file.

## Configuration

```json
"feed": { "enabled": true, "dir": "", "maxFileBytes": 2000000 }
```

`enabled: false` makes the bridge ignore event records. `dir` is where the files go (default: `state` inside the bridge's default folder). The addon side is `/wow-ai feed on|off`.

## Testing without the game

- `tests/feed_test.js`: payload parsing, files and permissions, repeats, restarts, size limits, prompt wording.
- `tests/feed_addon_test.js`: the real `Feed.lua` and `WoWAI.lua` in a Lua VM: events, quests, position, priority over messages, then the decoded strip through the bridge's parser and feed (addon to files).
- `tests/feed_bridge_test.js`: the real `bridge.js` in a scratch folder.
- `tests/codec_test.js`: feed batches drawn to a PNG and read back by the Python capture decoders with noise and gamma.
- `node bridge/bridge.js --inject-feed payload.txt [--feed-id 5]` feeds a saved payload through the bridge's intake and exits, for trying the files and the summary by hand.

## Not covered yet

Whether the macOS capture reads a 3-row strip reliably at your capture interval, and how long it must stay up (`feed hold`), are measured on a live client. Real game events and argument orders (`QUEST_TURNED_IN`, `PLAYER_ALIVE`) follow the Classic API as documented and are guarded with `pcall`, but only a live client confirms them.
