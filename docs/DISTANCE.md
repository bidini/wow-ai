# Distance index

Routing is accounting for time: **seconds = yards ÷ speed**, plus any shortcut (flight path, boat, portal). Run speed is the same on every map, so the one missing piece is turning a place (a map and an x, y in percent, as Wowhead lists it) into **yards**. This feature gives the agent that, as files it can read. Nothing here moves, targets or acts for you.

The agent has Read, Grep and Glob and the Wowhead tools; it cannot run a script. So the bridge does not offer a calculator. It writes down the numbers, and the agent does the few sums a route needs (a reasoning model's job; there is no brute-force search).

```
 game client ──▶ Feed.lua ──▶ strip (lines K, W) ──▶ bridge/feed.js ──▶ bridge/atlas.js ──▶ <state>/maps.json
 map rectangles   once per map,    same channel as       parsePayload       merge, validate,     <state>/maps.txt  (the agent reads this)
 continent size   8 maps a batch   the event feed                           write                 + position in yards in summary.txt
```

## What the addon sends

Two more line types in an event-feed batch ([EVENTS.md](EVENTS.md)):

| Line | Meaning |
|---|---|
| `K cont w h` | continent `cont` is `w` by `h` yards (integers). Measured by the engine's own map-to-world transform, the same call the map navigator uses. |
| `W map cont minX maxX minY maxY name` | map `map` lies inside continent `cont`. The four numbers are where its edges fall on the continent map, in **ten-thousandths** of the continent (0 to 10000). `name` is cleaned and cut at 30 bytes. |

When: on entering the world and on a new zone, the addon queues the current map and every zone map of the current continent. Each map is sent once per game session (a `/reload` or a new login sends them again, so a batch the capture missed is made up later), at most 8 per batch and only as many as fit beside the other lines, so a continent of 40 zones takes about 5 batches (30 seconds). `/wow-ai feed atlas` queues everything again, for example after the bridge's `maps.json` was deleted. A map the client cannot place (instances, no continent) is skipped without error.

## What the bridge writes (in the feed's `state/` folder, mode 0644)

| File | Content |
|---|---|
| `maps.json` | `{ continents: { "<cont>": { w, h } }, maps: { "<map>": { cont, minX, maxX, minY, maxY, name } } }`, the learned atlas. Survives restarts and grows as you play. |
| `maps.txt` | the same as a table the agent reads, with the method written at the top (below). |

The "Now:" line of `summary.txt` gains your position in continent yards when the map is known, so the agent can measure from where you stand.

### Method (also at the top of `maps.txt`)

For a point at `x%`, `y%` on map `M` (a row has `originX originY width height`, all in yards):

```
X = originX + x/100 * width
Y = originY + y/100 * height
yards  = sqrt((X2-X1)^2 + (Y2-Y1)^2)        both points on the same continent
seconds = yards / speed                      7 yards/s on foot at level 1 (see snapshot.json "speed")
```

Straight lines are a lower bound: real walking paths bend around hills, water and cliffs. The game offers no path finder, so treat the figure as a floor and add margin on rough ground. Tuning the margin from your own trajectory log (`trajectory.jsonl`) is not done yet.

## Shortcuts: `data/transport.json`

```json
{ "links": [ { "kind": "boat", "name": "Auberdine to Darnassus",
               "from": { "map": 1439, "x": 32.4, "y": 43.9 },
               "to":   { "map": 1438, "x": 54.9, "y": 97.3 },
               "seconds": 240, "source": "wowhead.com/..." } ] }
```

Links are one-way; list both directions. `maps.txt` prints the loaded links in yards next to the atlas so the agent can compare "walk" and "walk to the dock, ride, walk from the dock". A link is loaded only if its numbers are sane (`seconds` 1 to 3600, percent 0 to 100, a whole map number); one whose maps are not in the atlas yet is listed without yards and cannot be used by the arithmetic until they are. **This file ships empty.** Every figure in it must come from a source we checked; nothing here is guessed. Fill it zone by zone, with the source in `source`, starting with the zones you actually level in.

`bridge/atlas.js` also implements the arithmetic (`toContinent`, `distance`, `seconds` with at most one link) so a later feature can annotate routes automatically; it is tested here but the agent does not call it.

## Limits

- Different continents: no distance. Only a link joins them.
- Phased or instanced areas (dungeons, scenarios) have no continent and are left out.
- A zone's rectangle comes from the client you play on. If the Forever build changes map ids, the atlas follows because it is learned from the client, not typed in.

## Testing without the game

- `tests/atlas_test.js`: parsing the new lines, merging, restart, the arithmetic with exact numbers, links, sanitising of names, the files and their permissions, the summary line.
- `tests/feed_addon_test.js`: the real `Feed.lua` in a Lua VM with a stub map API: lines sent once, at most 8 per batch and inside the size budget, `feed atlas` resends, a client without the map functions (or an instance) sends nothing, and the strip decoded into the bridge's atlas (addon to yards).
- A live client confirms: that `GetMapRectOnMap` returns fractions of the continent for Forever zones, and the continent sizes it reports.
