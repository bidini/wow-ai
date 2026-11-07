# Router

The bridge keeps a **complete route** for the next hour or two on your map and in a list of steps on the left of your screen, and keeps it up to date as you play. Think of a Questie that plans for you. **Nothing is written to the chat.** You do not type anything.

```
 game ──▶ event feed ──▶ bridge: finished stops removed at once
                            │
                            └─ every event: one agent run ──▶ build (first time) or patch (after)
                                                                   │  wowmap block, no other text
 map pins + arrow + step list ◀── slot read ◀── reminder/NNNN.wav turns valid ◀── "route" layer ◀┘
```

## What you see

- **Step list** on the left of the screen (below the player frame; right of the Dock on a Mac): the route being followed with the current stop marked `>`, twelve rows, the stop before the current one kept visible. Drag it to move it. `/wow-ai map list on|off` shows or hides it.
- **World map** (M): numbered pins joined by lines; hover for the label.
- **Navigator**: an arrow and the distance to the current stop; it moves to the next stop within about 12 yards. Right-click skips a stop.

## What the route holds

One ordered route, up to 80 stops, with:

- quests to pick up (those you can take now, in the zones on the way),
- turn-ins (every quest that is ready, and those that will be on the way),
- objective areas of the quests in your log (one stop at the middle of each area),
- spell training, when you have reached a level with spells you have not learned,
- profession training, only for the professions your character has and only when a new rank can be trained,
- vendor upgrades: something a vendor sells that clearly improves a worn item and that you can pay for.

It is ordered for the least travel time: quest chains are followed (the next part is picked up at the turn-in), a place is finished before it is left, zones are visited in the cheapest order, a main city is visited once when several things are due there, and flight paths and boats are used only when `maps.txt` lists them. Coordinates come from the Wowhead tools; a stop whose position cannot be found is left out. Labels say where each stop is, for example `Turn in: The Engraved Ring (Magistrate Sevren, Brill)`.

## How it stays fast

- **Build** (the first time, and when fewer than 6 stops are left): one long agent run writes the whole route for the next 1 to 2 hours of play. This is the expensive part (minutes; `buildTimeoutMs`).
- **Finished stops leave at once, without the agent.** The bridge knows which quest a stop belongs to (`q`): a quest handed in or abandoned removes all its stops, an accepted quest removes its pick-up, a quest that becomes ready removes its objective stops, and standing at a trainer, vendor or flight stop (about 20 yards, same map) removes it. The step list and the arrow update straight away.
- **Revise** (after every event, at least 45 seconds apart, 60 an hour): the agent gets the current route with an id for every stop, the live state (where you are, level, gold, quests, what just happened) and answers with a small **patch**: `{"op":"patch","remove":[ids],"add":[{"after":id,...stop}]}`, or NOTHING when the route still fits. Short output, so it is quick. If the route cannot be repaired with a patch it answers with a whole new one.

A reply that is not a usable route or patch, or an update that fails, is logged and changes nothing; the old route stays. A route that did not change is not sent again. Whenever the route changes the arrow and the list start at the first stop.

## Files and settings

Every update is written to `state/characters/<name>-<realm>/log/<date>/route.jsonl` (`{t, id, mode, events, stops, route}`).

`router` in `bridge/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the router off |
| `everyEvents` | `1` | events per agent update |
| `minSeconds` | `45` | at least this long between two agent updates |
| `maxPerHour` | `60` | agent updates per hour, a cost limit (builds count) |
| `timeoutMs` | `300000` | a revision that takes longer is stopped |
| `buildTimeoutMs` | `900000` | the same for a full build |
| `minStops` | `6` | build again when fewer stops are left |

Needs the feed. The reminders ([REMINDER.md](REMINDER.md)) do not speak about quests or routes; that is this job, in silence.

## Limits

The route is only as good as the data the agent can find. Wowhead's Forever database pages are not open yet, so it works from the Classic pages, the quest numbers and names in your log, and the game state; quests that exist only in Forever may be missing or placed from their names alone. A stop is only removed by an event or by you standing at a trainer, vendor or flight stop, so a skipped stop stays until the agent's next revision removes it. Check the first stop before you trust a long route.
