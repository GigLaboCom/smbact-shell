// SPDX-License-Identifier: GPL-2.0-or-later
// SMBAct shell plugin for KWin (Plasma 6): the operations of PROTOCOL.md (API 1) as a KWin script. A KWin script
// cannot own a D-Bus name, so the transport turns around (PROTOCOL.md "KWin transport"): SMBAct exports
// com.giglabo.SMBAct.KWin1 on its own connection, loads this script through org.kde.KWin /Scripting, and the script
// asks it for work: `Next(reply) -> request` (SMBAct holds the call until it has a request), `Event(event)`,
// `Hello(hello)`. Requests, replies and events are the same JSON as the GNOME Shell extension's, plus `seq` in a
// request and its reply (the transport pairs them by it).
// A thin executor, like the extension: no decisions, nothing on its own. When SMBAct goes away its calls fail and
// the loop ends; SMBAct unloads and loads the script again when it starts.
const SERVICE = "com.giglabo.SMBAct";
const PATH = "/com/giglabo/SMBAct/KWin1";
const IFACE = "com.giglabo.SMBAct.KWin1";
const API = 1;
const VERSION = "1.0.0-alpha.3";
/** At most one windowsChanged event this often (a drag moves a window every frame); the end of a drag sends one too. */
const EVENT_MIN_INTERVAL_MS = 100;

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
    fullscreen: !!w.fullScreen,
    above: !!w.keepAbove,
    skipTaskbar: !!w.skipTaskbar,
    monitor: screenIndex(w.output),
    workspace: desktopIndex(w),
    onAllWorkspaces: !!w.onAllDesktops,
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
    });
  }
  return { monitors: monitors };
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
}

workspace.windowAdded.connect((w) => {
  watch(w);
  windowsChanged(true);
});
workspace.windowRemoved.connect(() => windowsChanged(true));
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
