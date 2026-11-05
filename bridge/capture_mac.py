#!/usr/bin/env python3
"""macOS counterpart of capture.ps1 / capture_x11.py: screen-captures the
top-left corner of the native WoW: Forever client and decodes the WoWAI pixel
strip (see Codec.lua in the addon). Prints one JSON line per new message to
stdout, with the same {info|warn|error|id,text} contract as the other capture
scripts. Started by bridge.js.

Uses only the Python stdlib plus the built-in macOS screencapture binary and
osascript. The first run will trigger System Settings permissions for
System Events (window discovery) and Screen Recording (screencapture).

  capture_mac.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_mac.py --probe out.png          save what the capture sees once and exit
  capture_mac.py --window-name NAME       match a window by title instead of process name
"""

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zlib

p = argparse.ArgumentParser()
p.add_argument("--cell", type=int, default=4)
p.add_argument("--cells", type=int, default=200)
p.add_argument("--max-rows", type=int, default=48)
p.add_argument("--interval-ms", type=int, default=250)
p.add_argument("--process-name", default="World of Warcraft")
p.add_argument("--window-name", default="")
p.add_argument("--test-image", default="")
p.add_argument("--test-windows", default="")   # a saved window list (JSON): print the window that would be captured
p.add_argument("--pids", default="")
p.add_argument("--probe", default="")
# macOS specific: how many pixels to search down for the strip (title bar + menu bar)
p.add_argument("--y-slack", type=int, default=80, help="vertical search margin in physical pixels")
# region to capture, in screen points (independent of Retina scale)
p.add_argument("--region-w", type=int, default=1000)
p.add_argument("--region-h", type=int, default=400)
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * CELL, MAXROWS * CELL
XSLACK = 8
YSLACK = args.y_slack


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Decoder: identical rules to capture.ps1 and capture_x11.py
# ---------------------------------------------------------------------------

# The addon draws cells in UI units and the game renders them at whatever scale the window has, so a
# cell is rarely 4 pixels square (4.5 wide and 2.8 tall on the first Forever login). The decoder measures
# the pitch (pixels per cell, across and down) from the picture: the strip's first cells are a known
# pattern, and every cell is one flat color, so the right pitch is the one where all samples agree.
PITCH_MIN, PITCH_MAX, PITCH_STEP = 2.0, 10.0, 0.005
PITCH_STEP_Y = 0.01
HEADER_BYTES = 6


def cell_at(px, width, height, x, y):
    xi = min(max(int(x), 0), width - 1)
    yi = min(max(int(y), 0), height - 1)
    rr, gg, bb = px(xi, yi)
    return (4 if rr >= 128 else 0) + (2 if gg >= 128 else 0) + (1 if bb >= 128 else 0)


def is_yellow(rgb):
    return rgb[0] >= 128 and rgb[1] >= 128 and rgb[2] < 128


def has_magic(px, width, height, ox, oy, pw):
    acc = 0
    for i in range(6):  # 18 bits cover the two magic bytes
        acc = (acc << 3) | cell_at(px, width, height, ox + (i + 0.5) * pw, oy + 1)
    return (acc >> 2) == 0xC71A


def decode(px, width, height, ox, oy, pw, ph):
    """Read the cells at pitch pw x ph from the strip's top-left corner (ox, oy)."""
    acc = 0
    nbits = 0
    out = bytearray()
    needed = HEADER_BYTES
    total = CELLS * MAXROWS
    for i in range(total):
        acc = (acc << 3) | cell_at(px, width, height, ox + (i % CELLS + 0.5) * pw, oy + (i // CELLS + 0.5) * ph)
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != 0xC7 or out[1] != 0x1A):
                return None
            if len(out) == HEADER_BYTES:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text}


def header_rows(px, width, height, ox, oy, pw):
    """Rows the strip spans, from the length in its first 6 bytes (None if that is not a plausible length)."""
    value = 0
    for i in range(16):  # 16 cells = 48 bits = the 6 header bytes
        value = (value << 3) | cell_at(px, width, height, ox + (i + 0.5) * pw, oy + 1)
    needed = 8 + (value & 0xFFFF)
    if needed > CELLS * MAXROWS * 3 // 8:
        return None
    cells = (needed * 8 + 2) // 3
    return (cells + CELLS - 1) // CELLS


def row_agreement(px, width, height, ox, oy, pw):
    """How many of the 200 cells of row 0 are one color at three places across the cell."""
    hit = 0
    for c in range(CELLS):
        x = ox + (c + 0.5) * pw
        a = cell_at(px, width, height, x - 0.25 * pw, oy + 1)
        if a == cell_at(px, width, height, x, oy + 1) == cell_at(px, width, height, x + 0.25 * pw, oy + 1):
            hit += 1
    return hit


def best_pitch(candidates, score):
    """The middle of the largest group of neighbouring pitches that score best. Neighbours read alike,
    so the best score is a plateau; a half or a third of the true pitch scores as well (cells cut in
    pieces are still one color), so the largest plateau is the cell itself."""
    scored = [score(v) for v in candidates]
    top = max(scored)
    group = []
    for i, sc in enumerate(scored):
        if sc == top:
            if group and group[-1] != i - 1:
                group = []
            group.append(i)
    return candidates[group[len(group) // 2]]


def row_boundaries(px, width, height, ox, oy, pw, rows):
    """y of each row boundary below the strip's first row, found where the colors of many columns change at
    once. The top of the first row can be clipped by the window border, so the boundaries, not the
    top edge, say where the rows are."""
    xs = [min(width - 1, int(ox + (c + 0.5) * pw)) for c in range(0, CELLS, 2)]
    ymax = min(height - 1, oy + int(rows * PITCH_MAX) + 2)
    counts = {}
    prev = [cell_at(px, width, height, x, oy) for x in xs]
    for y in range(oy + 1, ymax + 1):
        cur = [cell_at(px, width, height, x, y) for x in xs]
        n = sum(1 for p, q in zip(prev, cur) if p != q)
        if n:
            counts[y] = n
        prev = cur
    if not counts:
        return []
    strong = sorted(y for y, n in counts.items() if n >= 0.4 * max(counts.values()))
    clusters, group = [], []
    for y in strong:
        if group and y - group[-1] > 1:
            clusters.append(group)
            group = []
        group.append(y)
    if group:
        clusters.append(group)
    return [sum(y * counts[y] for y in g) / sum(counts[y] for y in g) for g in clusters][:rows - 1]


def fit_rows(bounds):
    """(top of row 0, row height) from the boundaries, by a line through (row number, y)."""
    if len(bounds) < 2:
        return None
    gaps = sorted(b - a for a, b in zip(bounds, bounds[1:]))
    step = gaps[len(gaps) // 2]
    if step < PITCH_MIN:
        return None
    ks = [1]  # one boundary after another; a gap of about two steps means one boundary showed no change
    for a, b in zip(bounds, bounds[1:]):
        ks.append(ks[-1] + max(1, round((b - a) / step)))
    n = len(ks)
    mk, my = sum(ks) / n, sum(bounds) / n
    var = sum((k - mk) ** 2 for k in ks)
    if var == 0:
        return None
    ph = sum((k - mk) * (y - my) for k, y in zip(ks, bounds)) / var
    return my - ph * mk, ph


def row_geometries(px, width, height, ox, oy, pw, rows):
    """(top, row height) guesses for a strip of `rows` rows, best first; the checksum picks the right one."""
    bounds = row_boundaries(px, width, height, ox, oy, pw, rows)
    out = []
    fit = fit_rows(bounds)
    if fit:
        out.append(fit)
    if bounds:
        for ph in (bounds[0] - oy, pw, 0.9 * pw):
            if ph >= PITCH_MIN:
                out += [(oy, ph), (bounds[0] - ph, ph)]
    return out


def find_and_decode(px, width, height, hint):
    """Decode at the last good geometry (ox, oy, pw, ph), else search the top-left corner for the strip.
    The first cell is always yellow, so the search starts at yellow pixels; the vertical window is larger
    because the macOS title bar pushes the UIParent top-left down. ph is None until a strip of two rows
    or more has shown the row height (a single row never needs it)."""
    if hint:
        msg = decode(px, width, height, hint[0], hint[1], hint[2], hint[3] or 2.0)
        if msg and not msg.get("error"):
            return msg, hint
    seen = None
    steps = int((PITCH_MAX - PITCH_MIN) / PITCH_STEP) + 1
    for oy in range(YSLACK + 1):
        for ox in range(XSLACK + 1):
            if oy + 1 >= height or ox + 1 >= width:
                continue
            if not (is_yellow(px(ox + 1, oy)) and is_yellow(px(ox + 1, oy + 1))):
                continue
            if oy > 0 and is_yellow(px(ox + 1, oy - 1)):  # the strip's top row, not one below it
                continue
            pitches = [PITCH_MIN + i * PITCH_STEP for i in range(steps)
                       if has_magic(px, width, height, ox, oy, PITCH_MIN + i * PITCH_STEP)]
            if not pitches:
                continue
            pw = best_pitch(pitches, lambda v: row_agreement(px, width, height, ox, oy, v))
            rows = header_rows(px, width, height, ox, oy, pw)
            if not rows:
                seen = seen or {"error": "length"}
                continue
            if rows == 1:
                msg = decode(px, width, height, ox, oy, pw, 2.0)
                if msg and not msg.get("error"):
                    return msg, (ox, oy, pw, None)
                seen = seen or msg
                continue
            for top, ph in row_geometries(px, width, height, ox, oy, pw, rows):
                msg = decode(px, width, height, ox, top, pw, ph)
                if msg and not msg.get("error"):
                    return msg, (ox, top, pw, ph)
                seen = seen or msg
    return seen, hint


# ---------------------------------------------------------------------------
# PNG in/out (tests, --probe, and screencapture output)
# ---------------------------------------------------------------------------

def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x, y):
        o = x * bpp
        row = rows[y]
        return row[o], row[o + 1], row[o + 2]
    return px, width, height


def write_png(path, px, width, height):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(px(x, y))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


if args.test_image:
    px, w, h = read_png(args.test_image)
    msg, _ = find_and_decode(px, w, h, None)
    emit(msg if msg else {"error": "no valid strip in image"})
    sys.exit(0)


# ---------------------------------------------------------------------------
# macOS window discovery and screen capture
# ---------------------------------------------------------------------------

def run_osascript(script, javascript=False):
    """Write the script to a temp file and run it; multi-line AppleScript is
    unreliable when passed inline to osascript -e."""
    fd, path = tempfile.mkstemp(suffix=".js" if javascript else ".scpt")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(script)
        cmd = ["osascript", "-l", "JavaScript", path] if javascript else ["osascript", path]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "osascript failed")
    return proc.stdout.strip()


# The window list the window server keeps (CoreGraphics) gives every on-screen window's owner and
# frame without the Accessibility permission that System Events needs: that permission belongs to the
# app that started the bridge and macOS drops it now and then. The owner is the executable's name
# ("Wow"), not the app's, so the game is found by process id.
CG_WINDOWS = """ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw));
JSON.stringify(list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowBounds).map(w => ({
  pid: w.kCGWindowOwnerPID, owner: w.kCGWindowOwnerName || '', name: w.kCGWindowName || '',
  x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height })));"""


def process_ids(name):
    """Ids of the processes whose command path contains `name` (case-insensitive)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return set()
    ids = set()
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit() and name.lower() in parts[1].lower():
            ids.add(int(parts[0]))
    return ids


def pick_window(windows, pids, name, title=""):
    """(x, y, w, h) of the largest layer-0 window of the game, by process id or else by owner name."""
    best = None
    for win in windows:
        mine = win.get("pid") in pids or (name and name.lower() in str(win.get("owner", "")).lower())
        if not mine or (title and title not in str(win.get("name", ""))):
            continue
        if win.get("w", 0) < 100 or win.get("h", 0) < 100:
            continue
        if best is None or win["w"] * win["h"] > best["w"] * best["h"]:
            best = win
    return (int(best["x"]), int(best["y"]), int(best["w"]), int(best["h"])) if best else None


def find_window_bounds_cg():
    return pick_window(json.loads(run_osascript(CG_WINDOWS, javascript=True) or "[]"),
                       process_ids(args.process_name), args.process_name, args.window_name)


def find_window_bounds():
    """Return (x, y, w, h) in screen points for the best matching window."""
    try:
        return find_window_bounds_cg()
    except Exception as err:  # the window list is unavailable: ask System Events (needs Accessibility)
        sys.stderr.write("window list failed (%s); trying System Events\n" % str(err).strip()[:120])
    return find_window_bounds_system_events()


def find_window_bounds_system_events():
    want = args.process_name
    title = args.window_name

    if title:
        script = '''tell application "System Events"
    set allProcs to every process
    repeat with p in allProcs
        try
            set wins to every window of p whose name contains "%s"
            if (count wins) > 0 then
                set w to item 1 of wins
                tell w
                    set {x, y} to position
                    set {ww, hh} to size
                end tell
                return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
            end if
        end try
    end repeat
end tell
return ""''' % title.replace('"', '\\"')
    else:
        script = '''tell application "System Events"
    set pList to every process whose name contains "%s"
    if (count pList) = 0 then
        return ""
    end if
    set p to item 1 of pList
    tell p
        if not (exists front window) then
            return ""
        end if
        set w to front window
        tell w
            set {x, y} to position
            set {ww, hh} to size
        end tell
        return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
    end tell
end tell
return ""''' % want.replace('"', '\\"')

    out = run_osascript(script)
    if not out:
        return None
    parts = out.split(",")
    if len(parts) != 4:
        return None
    return tuple(int(float(p.strip())) for p in parts)


def capture_region(x, y, w, h, out_path):
    """Use screencapture to grab a region of the screen into a PNG.
    Coordinates are in screen points (macOS logical coordinates); the resulting
    PNG is in device pixels, which is what the decoder expects."""
    cmd = [
        "screencapture",
        "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)),
        "-x",  # no sound
        out_path,
    ]
    subprocess.run(cmd, check=True, timeout=5)


def grab(out_path):
    """Find the WoW window, capture the top-left region, and return a pixel accessor."""
    bounds = find_window_bounds()
    if not bounds:
        return None
    x, y, ww, wh = bounds
    rw = min(args.region_w, ww)
    rh = min(args.region_h, wh)
    if rw <= 0 or rh <= 0:
        return None
    try:
        capture_region(x, y, rw, rh, out_path)
    except Exception as e:
        return {"error": "screencapture failed: %s" % e}
    return read_png(out_path)


if args.test_windows:
    pids = {int(x) for x in args.pids.split(",") if x.strip()}
    emit({"bounds": pick_window(json.load(open(args.test_windows)), pids, args.process_name, args.window_name)})
    sys.exit(0)

def run():
    if args.probe:
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            g = grab(tmp)
            if g is None:
                emit({"error": "no game window found"})
                sys.exit(1)
            if isinstance(g, dict):
                emit(g)
                sys.exit(1)
            px, width, height = g
            write_png(args.probe, px, width, height)
            msg, off = find_and_decode(px, width, height, None)
            emit({"info": "saved %dx%d to %s" % (width, height, args.probe), "strip": msg, "offset": off})
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return

    last_key = None
    last_warn = 0.0
    bounds = None
    bounds_at = 0
    hint = None
    while True:
        start = time.time()
        # Refresh window bounds every 5 s so moving/resizing the window is picked up.
        if bounds is None or start - bounds_at > 5:
            bounds = find_window_bounds()
            bounds_at = start
        if not bounds:
            emit({"info": "waiting for %s window" % (args.window_name or args.process_name)})
            time.sleep(3)
            continue
        x, y, ww, wh = bounds
        rw = min(args.region_w, ww)
        rh = min(args.region_h, wh)
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            try:
                capture_region(x, y, rw, rh, tmp)
            except Exception as e:
                emit({"warn": "screencapture failed: %s" % e})
                time.sleep(1)
                continue
            px, width, height = read_png(tmp)
            msg, hint = find_and_decode(px, width, height, hint)
            if msg and msg.get("error"):
                if time.time() - last_warn >= 5:
                    last_warn = time.time()
                    emit({"warn": "strip seen but rejected: " + msg["error"]
                          + " (part of the strip may be hidden: check the top-left corner of the game window for the Dock or another window)"})
            elif msg:
                key = "%d:%s" % (msg["id"], msg["text"])
                if key != last_key:
                    last_key = key
                    emit(msg)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        elapsed = time.time() - start
        sleep = max(0, args.interval_ms / 1000.0 - elapsed)
        if sleep:
            time.sleep(sleep)


try:
    run()
except KeyboardInterrupt:
    pass
