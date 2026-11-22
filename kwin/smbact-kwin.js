// SPDX-License-Identifier: GPL-2.0-or-later
// SMBAct shell plugin for KWin (Plasma 6): the operations of PROTOCOL.md (API 1) as a KWin script. A KWin script
// cannot own a D-Bus name, so the transport turns around (PROTOCOL.md "KWin transport"): SMBAct exports
// com.giglabo.SMBAct.KWin1 on its own connection, loads this script through org.kde.KWin /Scripting, and the script
// asks it for work: `Next(reply) -> request` (SMBAct holds the call until it has a request), `Event(event)`,
// `Hello(hello)`. Requests, replies and events are the same JSON as the GNOME Shell extension's, plus `seq` in a
// request and its reply (the transport pairs them by it).
// A thin executor, like the extension: no decisions, nothing on its own. When SMBAct goes away its calls fail and
// the loop ends; SMBAct unloads and loads the script again when it starts.
// Window drags (plugin 2.2.0, PROTOCOL.md "Window drags"): reported against SMBAct's zone table only while it set one
// (dragWatch); KWin's own screen-edge tiling is held off in memory only while SMBAct asks (nativeTiling) and given back
// when SMBAct asks, or by itself when SMBAct's name leaves the bus (a watchdog: a script's failed call has no callback).
const SERVICE = "com.giglabo.SMBAct";
const PATH = "/com/giglabo/SMBAct/KWin1";
const IFACE = "com.giglabo.SMBAct.KWin1";
const API = 1;
const VERSION = "2.2.0";
/** At most one windowsChanged event this often (a drag moves a window every frame); the end of a drag sends one too. */
const EVENT_MIN_INTERVAL_MS = 100;
/** The pointer must move this far from the start of a drag before a placed window gets its size back (MPOS-REST-1). */
const DRAG_RESTORE_THRESHOLD = 12;
/** How often the script checks that SMBAct is still on the bus while it holds something for it (watchdog). */
const WATCHDOG_MS = 2000;
/** KWin's options SMBAct may hold off (nativeTiling): the screen-edge tiling and maximize of a dragged window. */
const TILING_OPTIONS = ["electricBorderTiling", "electricBorderMaximize"];

class ShellError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const badRequest = (message) => new ShellError("BAD_REQUEST", message);

/**
 * A stable number for a window: the first 32 bits of KWin's UUID, the same across reloads. 32 bits like an X11 id
 * (SMBAct's CLI and native paths keep window ids in 32 bits); a clash among a session's windows is about 1 in a million.
 */
function idOf(w) {
  return parseInt(String(w.internalId).replace(/[{}-]/g, "").slice(0, 8), 16) >>> 0 || 1;
}

function rect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

function typeOf(w) {
  if (w.desktopWindow) return "desktop";
  if (w.dock) return "dock";
  if (w.splash) return "splashscreen";
  if (w.popupMenu || w.dropdownMenu || w.menu || w.comboBox || w.tooltip || w.notification || w.criticalNotification) return "menu";
  if (w.toolbar) return "toolbar";
  if (w.dialog) return w.modal ? "modal-dialog" : "dialog";
  if (w.utility) return "utility";
  if (w.normalWindow) return "normal";
  return "other";
}

function windows() {
  return workspace.windowList().filter((w) => w.managed !== false && !w.deleted);
}

function find(id) {
  if (typeof id !== "number" || !isFinite(id)) throw badRequest('"id" must be a number');
  const w = windows().find((x) => idOf(x) === id);
  if (!w) throw new ShellError("NO_WINDOW", "no window " + id);
  return w;
}

function number(req, key) {
  const v = req[key];
  if (typeof v !== "number" || !isFinite(v)) throw badRequest('"' + key + '" must be a number');
  return Math.round(v);
}

function screenIndex(output) {
  const screens = workspace.screens;
  for (let i = 0; i < screens.length; i++) if (screens[i] === output) return i;
  return 0;
}

function desktopIndex(w) {
  const all = workspace.desktops;
  const mine = w.desktops;
  if (!mine || mine.length !== 1) return -1;
  for (let i = 0; i < all.length; i++) if (all[i] === mine[0]) return i;
  return -1;
}

function describe(w, stack) {
  if (!w) return null;
  const mode = w.maximizeMode || 0; // 1 vertical, 2 horizontal, 3 both
  return {
    id: idOf(w),
    title: w.caption || "",
    wmClass: w.resourceClass || null,
    wmClassInstance: w.resourceName || null,
    appId: w.desktopFileName || null,
    sandboxedAppId: null,
    app: w.desktopFileName ? w.desktopFileName + ".desktop" : null,
    pid: w.pid || -1,
    // KWin's scripting API does not tell X11 from Wayland: SMBAct fills these from the X server's own list
    client: null,
    x11Window: null,
    type: typeOf(w),
    frame: rect(w.frameGeometry),
    clientRect: rect(w.clientGeometry),
    focus: !!w.active,
    minimized: !!w.minimized,
    maximized: mode === 3,
    maximizedHorizontally: (mode & 2) !== 0,
    maximizedVertically: (mode & 1) !== 0,
    tiled: !!w.tile, // a quick tile or a custom tile: KWin keeps maximizeMode 0 for it
    fullscreen: !!w.fullScreen,
    above: !!w.keepAbove,
    skipTaskbar: !!w.skipTaskbar,
    monitor: screenIndex(w.output),
    workspace: desktopIndex(w),
    onAllWorkspaces: !!w.onAllDesktops,
    onActiveWorkspace: !!w.onAllDesktops || (w.desktops || []).indexOf(workspace.currentDesktop) >= 0,
    stack: stack === undefined ? null : stack,
    icon: null, // a QIcon, not a file: SMBAct looks the app's icon up by its desktop file
    desktopFile: w.desktopFileName || null,
  };
}

function listWindows() {
  const order = workspace.stackingOrder; // bottom to top
  const listed = windows();
  const out = [];
  for (let i = 0; i < order.length; i++) if (listed.indexOf(order[i]) >= 0) out.push(describe(order[i], i));
  for (const w of listed) if (order.indexOf(w) < 0) out.push(describe(w, null));
  return { windows: out };
}

function moveResize(req) {
  const w = find(req.id);
  let x = number(req, "x");
  let y = number(req, "y");
  let width = number(req, "width");
  let height = number(req, "height");
  if (width <= 0 || height <= 0) throw badRequest('"width" and "height" must be positive');
  if (req.space === "client") {
    // the rect is the client area: add this window's decoration around it
    const f = w.frameGeometry;
    const c = w.clientGeometry;
    x -= Math.round(c.x - f.x);
    y -= Math.round(c.y - f.y);
    width += Math.round(f.width - c.width);
    height += Math.round(f.height - c.height);
  } else if (req.space !== undefined && req.space !== "frame") {
    throw badRequest('"space" is "frame" or "client"');
  }
  if (w.fullScreen) w.fullScreen = false;
  if (w.maximizeMode) w.setMaximize(false, false);
  w.frameGeometry = { x: x, y: y, width: width, height: height };
  return { window: describe(w) };
}

function setState(req) {
  const w = find(req.id);
  if (typeof req.on !== "boolean") throw badRequest('"on" must be true or false');
  const on = req.on;
  const mode = w.maximizeMode || 0;
  switch (req.state) {
    case "minimized":
      w.minimized = on;
      break;
    case "maximized":
      w.setMaximize(on, on);
      break;
    case "maximizedHorizontally":
      w.setMaximize((mode & 1) !== 0, on);
      break;
    case "maximizedVertically":
      w.setMaximize(on, (mode & 2) !== 0);
      break;
    case "fullscreen":
      w.fullScreen = on;
      break;
    case "above":
      w.keepAbove = on;
      break;
    default:
      throw badRequest('unknown state "' + req.state + '"');
  }
  return { window: describe(w) };
}

let shownDesktop = [];

function showDesktop(req) {
  if (typeof req.show !== "boolean") throw badRequest('"show" must be true or false');
  if (req.show) {
    const visible = windows().filter((w) => !w.minimized && !w.skipTaskbar && w.normalWindow && (w.onAllDesktops || w.desktops.indexOf(workspace.currentDesktop) >= 0));
    for (const w of visible) w.minimized = true;
    shownDesktop = visible.map(idOf);
    return { windows: visible.length };
  }
  const ids = shownDesktop;
  shownDesktop = [];
  const restore = windows().filter((w) => ids.indexOf(idOf(w)) >= 0 && w.minimized);
  for (const w of restore) w.minimized = false;
  return { windows: restore.length };
}

function displays() {
  const screens = workspace.screens;
  const monitors = [];
  for (let i = 0; i < screens.length; i++) {
    const o = screens[i];
    monitors.push({
      index: i,
      geometry: rect(o.geometry),
      workArea: rect(workspace.clientArea(KWin.MaximizeArea, o, workspace.currentDesktop)),
      scale: o.devicePixelRatio || 1,
      primary: i === 0, // KWin has no primary output; the first one is the one Plasma treats as such
      connector: o.name || null, // the connector ("DP-1", "Virtual-1")
    });
  }
  return { monitors: monitors };
}

// ---- the drag hit-test: pointer samples in, zone transitions out (PROTOCOL.md "Window drags"). A port of SMBAct's
// reference (app-native/shared/drag-snap/hit-test.ts), the same as the GNOME extension's hitTest.js; every
// implementation runs the same fixtures (tests/fixtures/hit-test.json). Pure: no KWin objects, no clock of its own.
// Written without `?.`, `??` and object spread, as the rest of this file. tests/kwin.test.mjs runs it.

/** The modifier bits a sample carries (`flags`): the same numbers as SMBAct's MODIFIER_FLAG (always 0 from KWin). */
const MODIFIER_FLAG = { shift: 1, ctrl: 2, alt: 4, meta: 8 };

function zoneContains(z, x, y) {
  return z.triggers.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}

/** How far the point is from the zone's nearest trigger (0 inside). */
function zoneDistance(z, x, y) {
  return z.triggers.reduce((best, r) => {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
    return Math.min(best, Math.hypot(dx, dy));
  }, Infinity);
}

class DragHitTest {
  /** @param {object} table the zone table (`dragWatch`'s `table`) */
  constructor(table) {
    this._table = table;
    this._armed = null;
    /** a zone waiting for its pause (a shared edge, or armDelayMs): {zone, since} */
    this._pending = null;
    /** the modifier was pressed during this drag: `no-modifier` zones are off for the rest of it */
    this._latched = false;
    this._last = null;
  }

  get armedZone() {
    return this._armed;
  }

  _held(flags) {
    const m = this._table.modifier;
    return !!m && (flags & MODIFIER_FLAG[m]) !== 0;
  }

  /** The zone counts with these modifier flags. */
  _allowed(z, flags) {
    const held = this._held(flags);
    if (z.when === "modifier") return held;
    if (z.when === "no-modifier") return !held && !this._latched;
    return true;
  }

  /** The zone the pointer is in, as far as the modifier allows. */
  zoneAt(x, y, flags) {
    return this._table.zones.find((z) => this._allowed(z, flags) && zoneContains(z, x, y));
  }

  /** The armed zone still holds a pointer that left its trigger by at most `stickPx` (and is in no other zone). */
  _sticks(s) {
    const stick = this._table.stickPx || 0;
    const armed = this._armed;
    const z = armed ? this._table.zones.find((x) => x.id === armed) : undefined;
    return z && stick > 0 && this._allowed(z, s.flags) && zoneDistance(z, s.x, s.y) <= stick ? z : undefined;
  }

  _delayOf(z) {
    // moving on to a neighbouring zone while armed re-arms at once
    if (this._armed) return 0;
    return z.shared ? this._table.sharedEdgeDelayMs : this._table.armDelayMs;
  }

  /** A pointer sample `{x, y, t, flags}`. Returns `{zone}` on a transition, null when the armed zone stays. */
  sample(s) {
    this._last = s;
    if (this._held(s.flags)) this._latched = true;
    return this._evaluate(s);
  }

  /** Re-evaluates the last sample at time `t` (a pending pause may be over). */
  tick(t) {
    return this._last ? this._evaluate({ x: this._last.x, y: this._last.y, t: t, flags: this._last.flags }) : null;
  }

  /** When tick() should run next, or null when nothing waits. */
  nextDeadline() {
    if (!this._pending) return null;
    return this._pending.since + (this._pending.zone.shared ? this._table.sharedEdgeDelayMs : this._table.armDelayMs);
  }

  _evaluate(s) {
    const z = this.zoneAt(s.x, s.y, s.flags);
    if (!z && this._sticks(s)) {
      this._pending = null;
      return null;
    }
    if (!z) {
      this._pending = null;
      if (this._armed !== null) {
        this._armed = null;
        return { zone: null };
      }
      return null;
    }
    if (z.id === this._armed) {
      this._pending = null;
      return null;
    }
    const delay = this._delayOf(z);
    if (delay <= 0) {
      this._pending = null;
      this._armed = z.id;
      return { zone: z.id };
    }
    if (!this._pending || this._pending.zone.id !== z.id) {
      this._pending = { zone: z, since: s.t };
      return null;
    }
    if (s.t - this._pending.since >= delay) {
      this._pending = null;
      this._armed = z.id;
      return { zone: z.id };
    }
    return null;
  }

  /**
   * The button went up at `s`: the zone of the drop, or null. The armed zone if the release is still in it; a fast
   * throw into a zone that arms without a pause counts too; a zone that needs the modifier needs it held at the
   * release; a shared edge never counts unarmed (no drop on the way across).
   */
  release(s) {
    if (this._held(s.flags)) this._latched = true;
    const z = this.zoneAt(s.x, s.y, s.flags);
    if (!z) {
      const stuck = this._sticks(s);
      return stuck ? stuck.id : null;
    }
    if (z.id === this._armed || !z.shared || this._armed !== null) return z.id;
    // a shared edge whose pause ran out between the last sample and the release
    return this._pending && this._pending.zone.id === z.id && s.t - this._pending.since >= this._table.sharedEdgeDelayMs ? z.id : null;
  }
}

// ---- window drags (dragWatch): KWin's interactive move of a window, the pointer from workspace.cursorPos
// - A drag is interactiveMoveResizeStarted with `move` (the same signal starts resizes) of a normal, movable, resizable
//   window that is not fullscreen. A move started from the keyboard (the window menu's Move, a shortcut) is not one:
//   KWin puts the pointer on the window's centre for it, which a title-bar drag past KWin's threshold never is.
// - KWin tells a script nothing about buttons or modifiers: the table may hold only `plain` zones (`modifier: false`).
//   Shift during a drag drops the window into KWin's custom tile under the pointer, whatever its options say.
// - interactiveMoveResizeFinished comes after KWin applied its own result: a cancel (Escape) has put the window back
//   where it began (`end` cancelled, reason `escape`); a KWin tile or maximize (Shift's custom tile, KWin's own edge
//   tiling) ends the drag with no zone (reason `tiled` / `maximized`).
// - A placed window's size comes back during the move when SMBAct asks (dragRestoreSize): a frameGeometry write, which
//   KWin keeps for the rest of the move with the pointer at the same share of the window where it grabbed it.

let dragTable = null;
let dragSession = null;
let nextDragId = 0;

function validTable(t) {
  return (
    !!t &&
    typeof t === "object" &&
    Array.isArray(t.zones) &&
    typeof t.seq === "number" &&
    t.zones.every((z) => z && typeof z.id === "string" && Array.isArray(z.triggers))
  );
}

function point(p) {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function dragEligible(w) {
  return !!w && !!w.move && !!w.normalWindow && w.moveable !== false && w.resizeable !== false && !w.fullScreen && !w.minimized;
}

function onCurrentDesktop(w) {
  return !!w.onAllDesktops || (w.desktops || []).indexOf(workspace.currentDesktop) >= 0;
}

function dragWatch(req) {
  if (req.table === null) {
    dragCancel("stopped");
    dragTable = null;
    watchdogUpdate();
    return { watching: false, reason: "stopped" };
  }
  if (!validTable(req.table)) throw badRequest('"table" must be a zone table ({seq, zones: [{id, triggers}], ...}) or null');
  dragTable = req.table;
  watchdogUpdate();
  return { watching: true, draws: false, restoreDuringMove: true, modifier: false };
}

function dragAnswer(req) {
  if (typeof req.allow !== "boolean") throw badRequest('"allow" must be true or false');
  const s = dragSession;
  if (!s || s.drag !== number(req, "drag")) return { ok: false };
  s.allowed = req.allow;
  return { ok: true };
}

function dragRestoreSize(req) {
  const drag = number(req, "drag");
  const width = number(req, "width");
  const height = number(req, "height");
  const s = dragSession;
  if (!s || s.drag !== drag || !s.hit || s.maximizedAtBegin || s.tiledAtBegin || !(width > 0 && height > 0)) return { ok: false };
  s.restore = { width: width, height: height, writes: 0, done: false };
  dragRestoreStep();
  return { ok: true };
}

function dragStarted(w) {
  if (!dragTable || dragSession || !dragEligible(w)) return;
  const frame = rect(w.frameGeometry);
  const p = point(workspace.cursorPos);
  // a keyboard move: KWin has put the pointer on the window's centre
  if (Math.abs(p.x - (frame.x + frame.width / 2)) <= 1 && Math.abs(p.y - (frame.y + frame.height / 2)) <= 1) return;
  const s = {
    drag: ++nextDragId,
    window: w,
    frame: frame,
    press: p,
    hit: new DragHitTest(dragTable),
    table: dragTable.seq,
    maximizedAtBegin: (w.maximizeMode || 0) === 3,
    tiledAtBegin: !!w.tile,
    left: false,
    allowed: null,
    restore: null,
    timer: null,
  };
  dragSession = s;
  emit({
    type: "drag",
    event: {
      type: "begin",
      drag: s.drag,
      window: { OwnerHandle: w.pid || -1, Handle: idOf(w) },
      frame: frame,
      pointer: p,
      press: p,
      table: s.table,
      time: Date.now(),
      owner: w.resourceClass ? String(w.resourceClass) : "",
    },
  });
  workspace.cursorPosChanged.connect(dragPointer);
  dragSample();
}

function dragPointer() {
  guarded(() => {
    const s = dragSession;
    // the window left its first place (Escape puts it back there; a window KWin holds in place never left it)
    if (s && !s.left && !sameRect(rect(s.window.frameGeometry), s.frame)) s.left = true;
    dragSample();
    dragRestoreStep();
  });
}

function dragSample() {
  const s = dragSession;
  if (!s || !s.hit) return;
  const p = point(workspace.cursorPos);
  dragTransition(s, s.hit.sample({ x: p.x, y: p.y, t: Date.now(), flags: 0 }), p);
}

/** A transition of the hit-test goes out; a pause still running gets a timer for its end. */
function dragTransition(s, tr, p) {
  if (tr) {
    if (tr.zone !== null) {
      const reason = dragGuard(p);
      if (reason) {
        dragCancel(reason, p);
        return;
      }
    }
    emit({ type: "drag", event: { type: "zone", drag: s.drag, zone: tr.zone, pointer: p } });
  }
  const deadline = s.hit ? s.hit.nextDeadline() : null;
  if (deadline === null) {
    if (s.timer) s.timer.stop();
    return;
  }
  if (!s.timer) {
    s.timer = new QTimer();
    s.timer.singleShot = true;
    s.timer.timeout.connect(() =>
      guarded(() => {
        if (dragSession === s && s.hit) dragTransition(s, s.hit.tick(Date.now()), point(workspace.cursorPos));
      })
    );
  }
  s.timer.stop();
  s.timer.start(Math.max(1, Math.ceil(deadline - Date.now())));
}

/** Why no zone may arm now: the output under the pointer shows a fullscreen window (MPOS-WIN-7). */
function dragGuard(p) {
  const output = workspace.screenAt ? workspace.screenAt(p) : null;
  const full = windows().some((w) => w.fullScreen && !w.minimized && (!output || w.output === output) && onCurrentDesktop(w));
  return full ? "fullscreen" : null;
}

/** The restored size, once the pointer is off the start of the drag (see dragRestoreSize). */
function dragRestoreStep() {
  const s = dragSession;
  if (!s || !s.hit || !s.restore || s.allowed === false) return;
  const r = s.restore;
  const w = s.window;
  if (r.writes > 0 && Math.round(w.frameGeometry.width) === r.width && Math.round(w.frameGeometry.height) === r.height) r.done = true;
  // checked on the later samples, written again (at most 3 times) when KWin did not keep it
  if (r.done || r.writes >= 3) return;
  const p = point(workspace.cursorPos);
  if (Math.hypot(p.x - s.press.x, p.y - s.press.y) <= DRAG_RESTORE_THRESHOLD) return;
  if ((w.maximizeMode || 0) === 3) return; // KWin restores a maximized window itself when it moves
  const share = s.frame.width > 0 ? Math.min(1, Math.max(0, (s.press.x - s.frame.x) / s.frame.width)) : 0.5;
  const grabY = Math.min(Math.max(0, s.press.y - s.frame.y), Math.max(0, r.height - 1));
  // a one-axis maximize (SMBAct's halves are vertically maximized windows) first, else KWin keeps the full height
  if (w.maximizeMode) w.setMaximize(false, false);
  r.writes++;
  w.frameGeometry = { x: Math.round(p.x - share * r.width), y: Math.round(p.y - grabY), width: r.width, height: r.height };
}

/** Ends the running drag without a drop (`end` cancelled); the rest of KWin's move is ignored. */
function dragCancel(reason, at) {
  const s = dragSession;
  if (!s || !s.hit) return;
  s.hit = null;
  if (s.timer) s.timer.stop();
  emit({ type: "drag", event: { type: "end", drag: s.drag, zone: null, cancelled: true, reason: reason, frame: null, pointer: at || point(workspace.cursorPos) } });
  if (reason === "window-closed" || reason === "stopped") dragStop();
}

function dragStop() {
  const s = dragSession;
  if (!s) return;
  dragSession = null;
  if (s.timer) s.timer.stop();
  try {
    workspace.cursorPosChanged.disconnect(dragPointer);
  } catch (e) {
    // not connected
  }
}

function dragFinished(w) {
  const s = dragSession;
  if (!s || s.window !== w) return;
  const hit = s.hit;
  dragStop();
  if (!hit) return; // cancelled earlier
  const p = point(workspace.cursorPos);
  const frame = rect(w.frameGeometry);
  // Escape: KWin has put the window back where it began after it had left that place, and the pointer is elsewhere
  const escaped = !!s.left && sameRect(frame, s.frame) && Math.hypot(p.x - s.press.x, p.y - s.press.y) > 4;
  // KWin placed the window itself: a custom tile (Shift held), or its own edge tiling / maximize
  const tiled = !!w.tile;
  const maximized = (w.maximizeMode || 0) === 3 && !s.maximizedAtBegin;
  const cancelled = escaped || tiled || maximized;
  const zone = cancelled ? null : hit.release({ x: p.x, y: p.y, t: Date.now(), flags: 0 });
  const event = { type: "end", drag: s.drag, zone: zone, cancelled: cancelled, frame: frame, pointer: p };
  if (cancelled) event.reason = escaped ? "escape" : tiled ? "tiled" : "maximized";
  emit({ type: "drag", event: event });
}

function dragDesktopChanged() {
  const s = dragSession;
  // KWin's "Switch desktop on edge" carries the dragged window along: the drag goes on there (MPOS-KDE-10)
  if (s && s.hit && !onCurrentDesktop(s.window)) dragCancel("workspace-changed");
}

// ---- KWin's own screen-edge tiling (nativeTiling): held off in memory for SMBAct, never written to kwinrc
// The script's `options` is KWin's live options object: its setters change the running value only. KWin re-reads
// kwinrc on every reconfigure (any "Apply" in System Settings): the hold saves what it brings (the user's choice now)
// and holds it off again. Given back when SMBAct asks, or when SMBAct's name leaves the bus (the watchdog).

/** What the hold found, per option it holds ({ electricBorderTiling: true, ... }); null while nothing is held. */
let tilingHold = null;

function tilingState() {
  const saved = {};
  if (tilingHold) for (const k in tilingHold) saved[k] = tilingHold[k];
  return {
    electricBorderTiling: !!options.electricBorderTiling,
    electricBorderMaximize: !!options.electricBorderMaximize,
    held: !!tilingHold,
    saved: saved,
  };
}

function nativeTiling(req) {
  if (req.suppress !== undefined && typeof req.suppress !== "boolean") throw badRequest('"suppress" must be true or false, or absent to read');
  let which = TILING_OPTIONS;
  if (req.options !== undefined) {
    if (!Array.isArray(req.options) || !req.options.every((o) => TILING_OPTIONS.indexOf(o) >= 0)) {
      throw badRequest('"options" must list ' + TILING_OPTIONS.join(" and/or "));
    }
    which = req.options;
  }
  if (req.suppress === true) {
    tilingHold = tilingHold || {};
    for (const k of which) {
      if (!(k in tilingHold)) tilingHold[k] = !!options[k];
      if (options[k]) options[k] = false;
    }
  } else if (req.suppress === false) {
    tilingRelease(req.options === undefined ? null : which);
  }
  watchdogUpdate();
  return tilingState();
}

/** Puts back what the hold found (`which`: those options only; null: all of them). */
function tilingRelease(which) {
  if (!tilingHold) return;
  for (const k of TILING_OPTIONS) {
    if (!(k in tilingHold) || (which && which.indexOf(k) < 0)) continue;
    if (!!options[k] !== tilingHold[k]) options[k] = tilingHold[k];
    delete tilingHold[k];
  }
  if (Object.keys(tilingHold).length === 0) tilingHold = null;
}

options.configChanged.connect(() =>
  guarded(() => {
    if (!tilingHold) return;
    // KWin re-read kwinrc: what it brings is the user's choice now, held off again
    for (const k in tilingHold) {
      tilingHold[k] = !!options[k];
      if (options[k]) options[k] = false;
    }
  })
);

// ---- the watchdog: a failed call to SMBAct reaches no callback, so while the script holds something for SMBAct (the
// tiling hold, the drag watch) it asks the bus every WATCHDOG_MS whether SMBAct is still there; gone: all given back

let watchdog = null;

function watchdogUpdate() {
  const needed = !!tilingHold || !!dragTable;
  if (needed && !watchdog) {
    watchdog = new QTimer();
    watchdog.interval = WATCHDOG_MS;
    watchdog.timeout.connect(() =>
      callDBus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", SERVICE, (has) => {
        if (has === false) guarded(clientGone);
      })
    );
    watchdog.start();
  } else if (!needed && watchdog) {
    watchdog.stop();
    watchdog = null;
  }
}

/** SMBAct left the bus (killed, crashed): its hold and its drag watch end here, as GNOME's extension does. */
function clientGone() {
  tilingRelease(null);
  dragCancel("stopped");
  dragTable = null;
  watchdogUpdate();
}

const OPS = {
  hello: () => hello(),
  listWindows: () => listWindows(),
  getWindow: (req) => ({ window: describe(find(req.id)) }),
  activeWindow: () => ({ window: describe(workspace.activeWindow) }),
  moveResize: (req) => moveResize(req),
  activate: (req) => {
    const w = find(req.id);
    if (w.minimized) w.minimized = false;
    workspace.activeWindow = w;
    return { window: describe(w) };
  },
  raise: (req) => {
    const w = find(req.id);
    workspace.raiseWindow(w);
    return { window: describe(w) };
  },
  setState: (req) => setState(req),
  close: (req) => {
    find(req.id).closeWindow();
    return { closed: true };
  },
  showDesktop: (req) => showDesktop(req),
  displays: () => displays(),
  pointer: () => ({ x: Math.round(workspace.cursorPos.x), y: Math.round(workspace.cursorPos.y) }),
  dragWatch: (req) => dragWatch(req),
  dragAnswer: (req) => dragAnswer(req),
  dragRestoreSize: (req) => dragRestoreSize(req),
  nativeTiling: (req) => nativeTiling(req),
};

function hello() {
  return { api: API, plugin: "smbact-kwin", version: VERSION, shell: "KWin", session: "wayland", ops: Object.keys(OPS) };
}

function handle(request) {
  let req;
  try {
    req = JSON.parse(request);
  } catch (e) {
    return { seq: null, ok: false, error: { code: "BAD_REQUEST", message: "the request is not JSON" } };
  }
  try {
    if (!req || typeof req.op !== "string") throw badRequest('the request needs an "op"');
    const op = OPS[req.op];
    if (!op) throw new ShellError("UNKNOWN_OP", 'unknown op "' + req.op + '"');
    return { seq: req.seq, ok: true, result: op(req) };
  } catch (e) {
    return { seq: req && req.seq, ok: false, error: { code: e && e.code ? e.code : "FAILED", message: String(e && e.message ? e.message : e) } };
  }
}

// ---- events (fire and forget; SMBAct coalesces them)

let lastWindowsEvent = 0;

function emit(event) {
  callDBus(SERVICE, PATH, IFACE, "Event", JSON.stringify(event));
}

function windowsChanged(force) {
  const now = Date.now();
  if (!force && now - lastWindowsEvent < EVENT_MIN_INTERVAL_MS) return;
  lastWindowsEvent = now;
  emit({ type: "windowsChanged" });
}

function watch(w) {
  const changed = () => windowsChanged(false);
  w.frameGeometryChanged.connect(changed);
  w.minimizedChanged.connect(() => windowsChanged(true));
  w.captionChanged.connect(changed);
  w.maximizedChanged.connect(() => windowsChanged(true));
  w.fullScreenChanged.connect(() => windowsChanged(true));
  w.interactiveMoveResizeFinished.connect(() => windowsChanged(true));
  w.interactiveMoveResizeStarted.connect(() => guarded(() => dragStarted(w)));
  w.interactiveMoveResizeFinished.connect(() => guarded(() => dragFinished(w)));
}

/** Signal handlers never throw into KWin. */
function guarded(fn) {
  try {
    fn();
  } catch (e) {
    console.warn("smbact-kwin: " + e);
  }
}

workspace.windowAdded.connect((w) => {
  watch(w);
  windowsChanged(true);
});
workspace.windowRemoved.connect((w) => {
  windowsChanged(true);
  guarded(() => {
    if (dragSession && dragSession.window === w) dragCancel("window-closed");
  });
});
workspace.screensChanged.connect(() => guarded(() => dragCancel("displays-changed")));
workspace.currentDesktopChanged.connect(() => guarded(() => dragDesktopChanged()));
workspace.windowActivated.connect((w) => emit({ type: "focusChanged", id: w ? idOf(w) : null }));
for (const w of workspace.windowList()) watch(w);

// ---- the request loop: each Next carries the previous reply and brings the next request

function loop(reply) {
  callDBus(SERVICE, PATH, IFACE, "Next", reply, (request) => {
    const req = String(request || "");
    loop(req === "" || req === '{"op":"noop"}' ? "" : JSON.stringify(handle(req)));
  });
}

callDBus(SERVICE, PATH, IFACE, "Hello", JSON.stringify(hello()), () => loop(""));
