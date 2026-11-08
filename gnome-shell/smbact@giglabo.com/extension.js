// SPDX-License-Identifier: GPL-2.0-or-later
// SMBAct shell plugin for GNOME Shell 46-51: the D-Bus service com.giglabo.SMBAct.Shell1, API 1 (PROTOCOL.md).
// A thin executor for the SMBAct app: it lists windows and carries out window operations; every decision stays in
// the app. Rules it follows (all seen on GNOME 50):
// - windows come from display.list_all_windows(), not global.get_window_actors() (other extensions patch that one);
// - activation uses the server's current time (time 0 may not get the focus);
// - global hotkeys are Mutter accelerator grabs owned by the current client: released when it goes away;
// - window snapshots cost a frame each: cached, retaken only when stale, one per idle turn (snapshots.js);
// - no synchronous work beyond one frame, every request in try/catch, everything undone in disable(): a hang
//   freezes the desktop and a crash ends the session.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Snapshots} from './snapshots.js';

const API = 1;
const BUS_NAME = 'com.giglabo.SMBAct.Shell';
const OBJECT_PATH = '/com/giglabo/SMBAct/Shell1';
/** Only the current owner of this name may call (the SMBAct app requests it). */
const CLIENT_NAME = 'com.giglabo.SMBAct';
const EVENT_COALESCE_MS = 100;
/**
 * Where SMBAct's hotkeys fire: the desktop and the overview, like GNOME's custom shortcuts; never on the lock or
 * login screen or behind a system dialog.
 */
const HOTKEY_ACTION_MODE = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

const IFACE_XML = `
<node>
  <interface name="com.giglabo.SMBAct.Shell1">
    <method name="Call">
      <arg type="s" direction="in" name="request"/>
      <arg type="s" direction="out" name="reply"/>
    </method>
    <signal name="Event">
      <arg type="s" name="event"/>
    </signal>
  </interface>
</node>`;

class ShellError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const badRequest = message => new ShellError('BAD_REQUEST', message);

// ---- Mutter 46-50 differences (49 reworked maximizing, 50 dropped the X11 backend)

const isWayland = () => typeof Meta.is_wayland_compositor !== 'function' || Meta.is_wayland_compositor();

const maximizeFlags = w => {
  if (typeof w.get_maximize_flags === 'function')
    return w.get_maximize_flags();
  return w.get_maximized(); // Mutter <= 48: the flags themselves
};

const setMaximized = (w, flags, on) => {
  const both = flags === Meta.MaximizeFlags.BOTH;
  if (typeof w.set_maximize_flags === 'function') { // Mutter 49+
    if (on)
      both ? w.maximize() : w.set_maximize_flags(flags);
    else
      both ? w.unmaximize() : w.set_unmaximize_flags(flags);
  } else if (on) {
    w.maximize(flags);
  } else {
    w.unmaximize(flags);
  }
};

const WINDOW_TYPES = new Map([
  [Meta.WindowType.NORMAL, 'normal'],
  [Meta.WindowType.DIALOG, 'dialog'],
  [Meta.WindowType.MODAL_DIALOG, 'modal-dialog'],
  [Meta.WindowType.UTILITY, 'utility'],
  [Meta.WindowType.SPLASHSCREEN, 'splashscreen'],
  [Meta.WindowType.MENU, 'menu'],
  [Meta.WindowType.DROPDOWN_MENU, 'menu'],
  [Meta.WindowType.POPUP_MENU, 'menu'],
  [Meta.WindowType.TOOLBAR, 'toolbar'],
  [Meta.WindowType.DESKTOP, 'desktop'],
  [Meta.WindowType.DOCK, 'dock'],
]);

const rect = r => ({x: r.x, y: r.y, width: r.width, height: r.height});

const tryOr = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** The X11 window id of an XWayland window: the first word of its description ("0xc00020 (title)"). */
const x11WindowId = w => {
  if (w.get_client_type() !== Meta.WindowClientType.X11)
    return null;
  const m = /^0x[0-9a-f]+/i.exec(tryOr(() => w.get_description(), '') ?? '');
  return m ? Number.parseInt(m[0], 16) : null;
};

const allWindows = () =>
  typeof global.display.list_all_windows === 'function'
    ? global.display.list_all_windows()
    : global.get_window_actors().map(a => a.meta_window).filter(Boolean);

class Service {
  constructor(extension) {
    this._extension = extension;
    this._clientOwner = null;
    this._iconTheme = null;
    this._iconCache = new Map();
    this._shownDesktop = [];
    this._windowSignals = new Map();
    this._displaySignals = [];
    this._eventTimer = 0;
    /** accelerator (as the client sent it) -> Mutter action id; action id -> accelerator */
    this._grabs = new Map();
    this._grabActions = new Map();
    this._snapshots = null;
    this._focus = null;
    this._ops = {
      hello: () => this._hello(),
      listWindows: req => this._listWindows(req),
      getWindow: req => ({window: this._describe(this._window(req), null, req.icons === true, this._iconSize(req))}),
      activeWindow: req => ({window: this._describe(global.display.focus_window, null, req.icons === true, this._iconSize(req))}),
      moveResize: req => this._moveResize(req),
      activate: req => this._activate(req),
      raise: req => {
        const w = this._window(req);
        w.raise();
        return {window: this._describe(w)};
      },
      setState: req => this._setState(req),
      close: req => this._close(req),
      showDesktop: req => this._showDesktop(req),
      displays: () => this._displays(),
      iconPng: req => this._iconPng(req),
      pointer: () => {
        const [x, y] = global.get_pointer();
        return {x, y};
      },
      grabAccelerator: req => this._grabAccelerator(req),
      ungrabAccelerator: req => this._ungrabAccelerator(req),
      snapshots: req => {
        if (!Array.isArray(req.ids))
          throw badRequest('"ids" must be an array of window ids');
        const ids = req.ids.filter(id => typeof id === 'number' && Number.isFinite(id));
        return {snapshots: this._snapshots.request(ids, req.maxSize, req.background)};
      },
      snapshot: req => {
        const snapshot = this._snapshots.get(this._number(req, 'id'));
        if (!snapshot)
          throw new ShellError('NO_SNAPSHOT', `no snapshot of window ${req.id} yet`);
        return {snapshot};
      },
    };
  }

  start() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    this._watchId = Gio.bus_watch_name_on_connection(Gio.DBus.session, CLIENT_NAME, Gio.BusNameWatcherFlags.NONE,
      (_c, _name, owner) => {
        // grabs belong to the client that made them: a new owner starts without any
        if (this._clientOwner !== owner)
          this._releaseGrabs();
        this._clientOwner = owner;
      },
      () => {
        this._releaseGrabs();
        this._clientOwner = null;
      });
    const d = global.display;
    this._snapshots = new Snapshots(event => this._emit(event), id => this._findWindow(id));
    this._focus = d.focus_window;
    this._displaySignals = [
      d.connect('window-created', (_d, w) => {
        this._watchWindow(w);
        this._windowsChanged();
      }),
      d.connect('restacked', () => this._windowsChanged()),
      d.connect('notify::focus-window', () => {
        const left = this._focus;
        this._focus = d.focus_window;
        this._snapshots?.focusLeft(left);
        this._emit({type: 'focusChanged', id: d.focus_window?.get_id() ?? null});
      }),
      d.connect('accelerator-activated', (_d, action, ...rest) => this._acceleratorActivated(action, rest[rest.length - 1])),
    ];
    for (const w of allWindows())
      this._watchWindow(w);
  }

  stop() {
    this._releaseGrabs();
    this._snapshots?.stop();
    this._snapshots = null;
    this._focus = null;
    for (const id of this._displaySignals)
      global.display.disconnect(id);
    this._displaySignals = [];
    for (const [w, ids] of this._windowSignals) {
      for (const id of ids)
        tryOr(() => w.disconnect(id));
    }
    this._windowSignals.clear();
    if (this._eventTimer) {
      GLib.source_remove(this._eventTimer);
      this._eventTimer = 0;
    }
    if (this._watchId) {
      Gio.bus_unwatch_name(this._watchId);
      this._watchId = 0;
    }
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = 0;
    }
    this._dbus?.unexport();
    this._dbus = null;
    this._iconCache.clear();
    this._iconTheme = null;
  }

  // ---- D-Bus

  CallAsync([request], invocation) {
    if (this._clientOwner) {
      this._answer(request, invocation);
      return;
    }
    // Just enabled (GNOME re-enables extensions after every unlock): the name watcher may not have reported the
    // client yet, and SMBAct grabs its hotkeys again right away. Ask the bus instead of refusing.
    Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
      new GLib.Variant('(s)', [CLIENT_NAME]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 1000, null,
      (connection, result) => {
        let owner = null;
        try {
          [owner] = connection.call_finish(result).deepUnpack();
        } catch {
          // no owner
        }
        this._clientOwner ??= owner;
        this._answer(request, invocation);
      });
  }

  _answer(request, invocation) {
    if (!this._clientOwner || invocation.get_sender() !== this._clientOwner) {
      invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'Call is not allowed');
      return;
    }
    let reply;
    try {
      let req;
      try {
        req = JSON.parse(request);
      } catch {
        throw badRequest('the request is not JSON');
      }
      if (!req || typeof req !== 'object' || typeof req.op !== 'string')
        throw badRequest('the request needs an "op"');
      const op = this._ops[req.op];
      if (!op)
        throw new ShellError('UNKNOWN_OP', `unknown op "${req.op}"`);
      reply = {ok: true, result: op(req)};
    } catch (e) {
      reply = {ok: false, error: {code: e instanceof ShellError ? e.code : 'FAILED', message: `${e?.message ?? e}`}};
    }
    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(reply)]));
  }

  _emit(event) {
    tryOr(() => this._dbus?.emit_signal('Event', new GLib.Variant('(s)', [JSON.stringify(event)])));
  }

  _windowsChanged() {
    if (this._eventTimer)
      return;
    this._eventTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EVENT_COALESCE_MS, () => {
      this._eventTimer = 0;
      this._emit({type: 'windowsChanged'});
      return GLib.SOURCE_REMOVE;
    });
  }

  _watchWindow(w) {
    if (this._windowSignals.has(w))
      return;
    const changed = () => this._windowsChanged();
    const ids = [
      w.connect('position-changed', changed),
      w.connect('size-changed', changed),
      w.connect('notify::minimized', changed),
      w.connect('notify::title', changed),
      w.connect('unmanaged', () => {
        for (const id of this._windowSignals.get(w) ?? [])
          tryOr(() => w.disconnect(id));
        this._windowSignals.delete(w);
        changed();
      }),
    ];
    this._windowSignals.set(w, ids);
  }

  // ---- hotkeys (Mutter accelerator grabs, the way GNOME grabs custom shortcuts for gnome-settings-daemon)

  _acceleratorActivated(action, time) {
    const accelerator = this._grabActions.get(action);
    if (accelerator === undefined)
      return; // another grab (gnome-settings-daemon's)
    this._emit({type: 'accelerator', accelerator, time: typeof time === 'number' ? time : 0});
  }

  _grabAccelerator(req) {
    const accelerator = req.accelerator;
    if (typeof accelerator !== 'string' || !accelerator)
      throw badRequest('"accelerator" must be a GTK accelerator such as "<Control><Alt>x"');
    const existing = this._grabs.get(accelerator);
    if (existing !== undefined)
      return {accelerator, action: existing};
    const action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.NONE);
    if (action === Meta.KeyBindingAction.NONE) {
      throw new ShellError('GRAB_FAILED',
        `GNOME Shell did not grab "${accelerator}": another shortcut has it, or it is not a valid accelerator`);
    }
    Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), HOTKEY_ACTION_MODE);
    this._grabs.set(accelerator, action);
    this._grabActions.set(action, accelerator);
    return {accelerator, action};
  }

  _ungrabAccelerator(req) {
    const accelerator = req.accelerator;
    if (typeof accelerator !== 'string' || !accelerator)
      throw badRequest('"accelerator" must be a string');
    const action = this._grabs.get(accelerator);
    if (action === undefined)
      return {released: false};
    this._ungrab(accelerator, action);
    return {released: true};
  }

  _ungrab(accelerator, action) {
    this._grabs.delete(accelerator);
    this._grabActions.delete(action);
    tryOr(() => Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE));
    tryOr(() => global.display.ungrab_accelerator(action));
  }

  _releaseGrabs() {
    for (const [accelerator, action] of [...this._grabs])
      this._ungrab(accelerator, action);
  }

  // ---- operations

  _hello() {
    return {
      api: API,
      plugin: this._extension.metadata.uuid,
      version: this._extension.metadata['version-name'] ?? String(this._extension.metadata.version ?? ''),
      shell: Config.PACKAGE_VERSION,
      session: isWayland() ? 'wayland' : 'x11',
      ops: Object.keys(this._ops),
    };
  }

  _window(req) {
    const id = req.id;
    if (typeof id !== 'number' || !Number.isFinite(id))
      throw badRequest('"id" must be a number');
    const w = this._findWindow(id);
    if (!w)
      throw new ShellError('NO_WINDOW', `no window ${id}`);
    return w;
  }

  /** The compositor's id, or the X11 id of an XWayland window (SMBAct knows its own windows by that). */
  _findWindow(id) {
    const windows = allWindows();
    return windows.find(x => x.get_id() === id) ?? windows.find(x => x11WindowId(x) === id) ?? null;
  }

  _number(req, key) {
    const v = req[key];
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw badRequest(`"${key}" must be a number`);
    return Math.round(v);
  }

  _icon(w, size) {
    const app = tryOr(() => Shell.WindowTracker.get_default().get_window_app(w));
    const wmClass = tryOr(() => w.get_wm_class(), '') ?? '';
    const key = `${tryOr(() => app?.get_id(), '')}|${wmClass}|${size}`;
    if (this._iconCache.has(key))
      return this._iconCache.get(key);
    this._iconTheme ??= new St.IconTheme();
    // A PNG first (SMBAct stores icons as PNG), any format after that.
    const lookup = gicon => (gicon
      ? tryOr(() => this._iconTheme.lookup_by_gicon(gicon, size, St.IconLookupFlags.NO_SVG)?.get_filename()) ??
        tryOr(() => this._iconTheme.lookup_by_gicon(gicon, size, 0)?.get_filename())
      : null);
    let file = lookup(tryOr(() => app?.get_icon()));
    // Apps without a .desktop file get a generic icon from the shell: try the icon theme by WM class instead.
    if ((!file || file.includes('application-x-executable')) && wmClass) {
      const byClass = lookup(new Gio.ThemedIcon({name: wmClass.toLowerCase()}));
      file = byClass ?? file;
    }
    this._iconCache.set(key, file ?? null);
    return file ?? null;
  }

  _describe(w, stack = null, icons = false, iconSize = 48) {
    if (!w)
      return null;
    const frame = w.get_frame_rect();
    const flags = tryOr(() => maximizeFlags(w), 0) ?? 0;
    const workspace = tryOr(() => w.get_workspace());
    return {
      id: w.get_id(),
      title: w.get_title() ?? '',
      wmClass: tryOr(() => w.get_wm_class()),
      wmClassInstance: tryOr(() => w.get_wm_class_instance()),
      appId: tryOr(() => w.get_gtk_application_id()),
      sandboxedAppId: tryOr(() => w.get_sandboxed_app_id()),
      app: tryOr(() => Shell.WindowTracker.get_default().get_window_app(w)?.get_id()),
      pid: tryOr(() => w.get_pid(), -1),
      client: w.get_client_type() === Meta.WindowClientType.WAYLAND ? 'wayland' : 'x11',
      x11Window: x11WindowId(w),
      type: WINDOW_TYPES.get(w.get_window_type()) ?? 'other',
      frame: rect(frame),
      clientRect: rect(tryOr(() => w.frame_rect_to_client_rect(frame), frame)),
      focus: w.has_focus(),
      minimized: w.minimized,
      maximized: flags === Meta.MaximizeFlags.BOTH,
      maximizedHorizontally: (flags & Meta.MaximizeFlags.HORIZONTAL) !== 0,
      maximizedVertically: (flags & Meta.MaximizeFlags.VERTICAL) !== 0,
      fullscreen: tryOr(() => w.is_fullscreen(), false),
      above: tryOr(() => w.is_above(), false),
      skipTaskbar: w.is_skip_taskbar(),
      monitor: w.get_monitor(),
      workspace: workspace ? workspace.index() : -1,
      onAllWorkspaces: tryOr(() => w.is_on_all_workspaces(), false),
      stack,
      icon: icons ? this._icon(w, iconSize) : null,
    };
  }

  _iconSize(req) {
    return typeof req.iconSize === 'number' && req.iconSize > 0 ? Math.min(Math.round(req.iconSize), 512) : 48;
  }

  _listWindows(req) {
    const icons = req.icons === true;
    const size = this._iconSize(req);
    const stacked = global.display.sort_windows_by_stacking(allWindows());
    return {windows: stacked.map((w, i) => this._describe(w, i, icons, size))};
  }

  _moveResize(req) {
    const w = this._window(req);
    let [x, y, width, height] = ['x', 'y', 'width', 'height'].map(k => this._number(req, k));
    if (width <= 0 || height <= 0)
      throw badRequest('"width" and "height" must be positive');
    if (req.space === 'client') {
      // The rect is the client area: Mutter knows this window's decorations and shadow.
      const r = new Mtk.Rectangle({x, y, width, height});
      const f = w.client_rect_to_frame_rect(r);
      [x, y, width, height] = [f.x, f.y, f.width, f.height];
    } else if (req.space !== undefined && req.space !== 'frame') {
      throw badRequest('"space" is "frame" or "client"');
    }
    if (tryOr(() => w.is_fullscreen(), false))
      w.unmake_fullscreen();
    if (maximizeFlags(w))
      setMaximized(w, Meta.MaximizeFlags.BOTH, false);
    // Two steps: a window with resize increments (a terminal) ignores the position of a combined move-resize
    // whose size it has to round.
    w.move_frame(true, x, y);
    w.move_resize_frame(true, x, y, width, height);
    return {window: this._describe(w)};
  }

  _activate(req) {
    const w = this._window(req);
    const time = typeof req.time === 'number' && req.time > 0 ? req.time : global.display.get_current_time_roundtrip();
    Main.activateWindow(w, time);
    return {window: this._describe(w)};
  }

  _setState(req) {
    const w = this._window(req);
    if (typeof req.on !== 'boolean')
      throw badRequest('"on" must be true or false');
    const on = req.on;
    switch (req.state) {
    case 'minimized':
      on ? w.minimize() : w.unminimize();
      break;
    case 'maximized':
      setMaximized(w, Meta.MaximizeFlags.BOTH, on);
      break;
    case 'maximizedHorizontally':
      setMaximized(w, Meta.MaximizeFlags.HORIZONTAL, on);
      break;
    case 'maximizedVertically':
      setMaximized(w, Meta.MaximizeFlags.VERTICAL, on);
      break;
    case 'fullscreen':
      on ? w.make_fullscreen() : w.unmake_fullscreen();
      break;
    case 'above':
      on ? w.make_above() : w.unmake_above();
      break;
    default:
      throw badRequest(`unknown state "${req.state}"`);
    }
    return {window: this._describe(w)};
  }

  _close(req) {
    const w = this._window(req);
    if (req.force === true)
      w.kill();
    else
      w.delete(global.display.get_current_time_roundtrip());
    return {closed: true};
  }

  // An icon file as PNG bytes (base64), for icons the theme has as SVG only. Small and rare: the client caches by path.
  _iconPng(req) {
    if (typeof req.path !== 'string' || !req.path.startsWith('/'))
      throw badRequest('"path" must be an absolute file path');
    const size = typeof req.size === 'number' && req.size > 0 ? Math.min(Math.round(req.size), 256) : 48;
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(req.path, size, size);
    const [, bytes] = pixbuf.save_to_bufferv('png', [], []);
    return {png: GLib.base64_encode(bytes), width: pixbuf.get_width(), height: pixbuf.get_height()};
  }

  _showDesktop(req) {
    if (typeof req.show !== 'boolean')
      throw badRequest('"show" must be true or false');
    if (req.show) {
      const ws = global.workspace_manager.get_active_workspace();
      const visible = allWindows().filter(w =>
        !w.minimized && !w.is_skip_taskbar() && w.get_window_type() === Meta.WindowType.NORMAL &&
        tryOr(() => w.located_on_workspace(ws), false));
      for (const w of visible)
        w.minimize();
      this._shownDesktop = visible.map(w => w.get_id());
      return {windows: visible.length};
    }
    const ids = new Set(this._shownDesktop);
    this._shownDesktop = [];
    const restore = allWindows().filter(w => ids.has(w.get_id()) && w.minimized);
    for (const w of restore)
      w.unminimize();
    return {windows: restore.length};
  }

  _displays() {
    const d = global.display;
    const ws = global.workspace_manager.get_active_workspace();
    const monitors = [];
    for (let i = 0; i < d.get_n_monitors(); i++) {
      monitors.push({
        index: i,
        geometry: rect(d.get_monitor_geometry(i)),
        workArea: rect(ws.get_work_area_for_monitor(i)),
        scale: d.get_monitor_scale(i),
        primary: i === d.get_primary_monitor(),
      });
    }
    return {monitors};
  }
}

export default class SMBActShellExtension extends Extension {
  enable() {
    this._service = new Service(this);
    this._service.start();
  }

  disable() {
    this._service?.stop();
    this._service = null;
  }
}
