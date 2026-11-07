# Router

The route on your map keeps itself up to date. After every game event the bridge asks the agent, on its own, for your next route, and draws the answer as the `route` layer of the map: numbered pins, lines between them, and the navigator arrow. **Nothing is written to the chat.** You do not type anything.

```
 game ──▶ event feed ──▶ bridge counts events ──▶ every event: one agent run
                                                        │  "[route update] 1 new game event…"
                                                        │  + live state in the system prompt
 map pins + arrow ◀── slot read ◀── reminder/NNNN.wav turns valid ◀── "route" layer ◀── wowmap block ┘
```

## What the route holds

The agent is told to build one ordered route with:

- quests to pick up (those you can take now, in the zones on the way),
- turn-ins (every quest that is ready, and those that will be on the way),
- objective areas of the quests in your log (one stop at the middle of each area),
- spell training, when you have reached a level with spells you have not learned,
- profession training, only for the professions your character has and only when a new rank can be trained,
- vendor upgrades: something a vendor sells that clearly improves a worn item and that you can pay for.

It is ordered for the least travel time: quest chains are followed (the next part is picked up at the turn-in), a place is finished before it is left, zones are visited in the cheapest order, a main city is visited once when several things are due there, and flight paths and boats are used only when `maps.txt` lists them. Coordinates come from the Wowhead tools; a stop whose position cannot be found is left out.

## What happens

1. The bridge counts the events of each feed batch (not the heartbeat, not a strip shown twice) per character.
2. When an event has come in, the last update was at least 45 seconds ago, fewer than 60 ran in the past hour and no other update is running, it starts one fresh agent run (no old session). The question is `[route update] N new game events…` plus the stops of the current route, so the agent keeps what is still right; the game state is in the system prompt.
3. The agent answers with a `wowmap` block and no other text. The bridge takes the last `set` in it, always as the layer `route` (ordered, with the first stop as the next one, at most 15 stops), and ignores any text around it.
4. If the route is the same as before, nothing happens. Otherwise the layer replaces the old one, a silent record carries the new map to the game, and the `reminder/NNNN.wav` signal tells the game to look. The addon draws it without printing anything and starts the navigator at the first stop. (A route you are already following on another layer is not taken over.)
5. Every update is written to `state/characters/<name>-<realm>/log/<date>/route.jsonl` (`{t, id, events, stops, route}`).

An update that fails (the agent is down, a timeout) or has no usable route is logged and changes nothing; the old route stays.

## Settings (`router` in `bridge/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the router off |
| `everyEvents` | `1` | events per update |
| `minSeconds` | `45` | at least this long between two updates |
| `maxPerHour` | `60` | updates per hour, a cost limit |
| `timeoutMs` | `300000` | an update that takes longer is stopped |

Needs the feed. The reminders ([REMINDER.md](REMINDER.md)) no longer speak about quests or routes; that is this job, in silence.

## Limits

The route is only as good as the data the agent can find. Wowhead's Forever database pages are not open yet, so it works from the Classic pages and the game state; quests that exist only in Forever may be missing or placed from their names alone. Check the first stop before you trust a long route.
