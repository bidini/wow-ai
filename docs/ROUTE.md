# Route step list

A leveling route, planned outside the game, is listed on the left of the screen: the current step is marked with `>`, with where to go and how to get there under it, and the steps are ticked off from the game's own quest state. A small **arrow** frame (top centre) points at the current step and shows the distance in yards. There is no agent in the loop; the addon only reads and draws.

```
 planner (wow-route/plan.mjs)  ──writes──▶  Interface/AddOns/WoWAI/RouteData.lua  ──/reload──▶  Route.lua draws the list
```

## What you see

```
Route 17/102  (to level 22)
   16. Turn in: Rot Hide Origins (Bethor Iceshard)
 > 17. Collect 6: Lake Skulker Moss from Lake Skulker for A Recipe For Death
       Silverpine Forest 71.5, 36.0  |  walk 1,923 yd
   18. Collect 6: Lake Creeper Moss ...
```

Twelve lines at most, starting from the step before the current one. Drag the frame to move it; it starts right of the Dock margin on a Mac.

**The arrow** points at the current step's stop and shows the distance ("150 yd"). When the way there goes through a flight master or a zeppelin tower, it points at that while you are nearer to it than to the stop, then at the stop. It says "on another continent", "no position here" (instances) or hides when the step has no coordinates or the route is done. It is a separate frame: drag to move, right-click to tick the current step.

## How steps are ticked

- **Accept** is done once the quest is in your log (or already handed in).
- **Kill, collect, use** are done once the quest is ready (or handed in).
- **Turn in** is done once the quest is handed in.
- A step with no quest (a flight, the hearthstone, a zeppelin, finding a flight point, setting the hearthstone) is shown in cyan until it is the current step. The game cannot confirm it, so it is ticked automatically once a later quest step is done, or by hand: right-click it (or the arrow), or `/wow-ai route skip`. Steps with no position (the hearthstone) show no arrow.
- A quest finished out of order ticks all its steps. The current step is always the first one not done.

## Commands

| Command | Does |
|---|---|
| `/wow-ai route` | Show the current step and where it is |
| `/wow-ai route skip [n]` | Tick step `n` (the current one when no number) |
| `/wow-ai route undo <n>` | Untick step `n` |
| `/wow-ai route reset` | Clear the hand-made ticks |
| `/wow-ai route on` / `off` | Show or hide the list |
| `/wow-ai route arrow on` / `off` | Show or hide the arrow |

## Installing a route

`node plan.mjs 22 350` (or `./run.sh`) writes `out/RouteData.lua` next to the route report; `INSTALL=1` also copies it into the game folder. `/reload` in game reads it. A new route (a new `stamp` in the file) forgets the hand-made ticks of the old one. `setup.js` never overwrites `RouteData.lua` once it exists. Adding `Route.lua` and `RouteData.lua` to the addon needs one full relaunch of the game; after that a `/reload` is enough.

## On the world map

The current step and the next ones (up to 14 with a position) are drawn on the world map as numbered diamonds joined by a thin line: violet for quest steps (accept, kill, collect, turn in), cyan for travel (flight, zeppelin, flight point, inn). The current step is larger. They are square and numbered, unlike the round game icons and the round pins the agent's layers use. Steps at one place share a marker; hover shows the steps there. Steps with no position (using the hearthstone) are left out. `/wow-ai route map off` hides them, `on` shows them.

Markers never overlap: each one is moved to the nearest free place around its real spot (at least 20 pixels away, because the game draws its own quest icon there), clear of the other markers and of the agent's round pins, and a thin white line joins it to the spot. The numbers use a bold, outlined font.
