// SPDX-License-Identifier: GPL-2.0-or-later
// The drag source for SMBAct's positioning with the mouse (PROTOCOL.md, `dragWatch`): tells SMBAct when the user drags a
// window with the pointer and which zone of SMBAct's table the pointer is in. SMBAct decides everything else (which
// windows, which layout, the drop); this file reports transitions and, when asked, gives a placed window its size back
// during the drag.
// - Drags come from global.display's grab-op-begin / grab-op-end (46-51; 51 adds a fourth argument, ignored here). A
//   pointer move is (op & ~UNCONSTRAINED) === MOVING: the title bar, a client-side drag, the top bar, Super+drag;
//   keyboard moves and resizes are not.
// - The pointer is sampled every 16 ms with global.get_pointer() while a drag runs (the window's position-changed stops
//   while the window is held back: the pointer in the top bar, edge resistance); the same call carries the modifiers.
// - Escape and the release both end with grab-op-end: a drag counts as cancelled when the button is still down at the
//   end, or when Mutter put the window back where it was.
// - Nothing runs while no table is set; every handler in try/catch; everything undone by stop().
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DragHitTest, MODIFIER_FLAG} from './hitTest.js';

const SAMPLE_MS = 16;
/** The pointer must move this far from the press before a placed window gets its size back (SMBAct's MPOS-REST-1). */
const RESTORE_THRESHOLD = 12;
/** Meta.GrabOp flags (unchanged 46-51). */
const GRAB_UNCONSTRAINED = 0x400;

const tryOr = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const rect = r => ({x: r.x, y: r.y, width: r.width, height: r.height});
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const nowMs = () => GLib.get_monotonic_time() / 1000;

const M = Clutter.ModifierType;
const SUPER_MASKS = (M.MOD4_MASK ?? 0) | (M.SUPER_MASK ?? 0);

/** Clutter modifier state -> SMBAct's flags (shift 1, ctrl 2, alt 4, meta 8). */
export const flagsOf = mods =>
  ((mods & M.SHIFT_MASK) ? MODIFIER_FLAG.shift : 0) |
  ((mods & M.CONTROL_MASK) ? MODIFIER_FLAG.ctrl : 0) |
  ((mods & M.MOD1_MASK) ? MODIFIER_FLAG.alt : 0) |
  ((mods & SUPER_MASKS) ? MODIFIER_FLAG.meta : 0);

const isMaximized = w => tryOr(() => w.maximized_horizontally || w.maximized_vertically, false);
const isFullyMaximized = w => tryOr(() => w.maximized_horizontally && w.maximized_vertically, false);

/** Leaves a one-axis maximize (a full-height half is a vertical maximize in Mutter), Mutter 46-48 and 49+. */
const unmaximizeAxes = w => {
  const flags = (w.maximized_horizontally ? Meta.MaximizeFlags.HORIZONTAL : 0) |
    (w.maximized_vertically ? Meta.MaximizeFlags.VERTICAL : 0);
  if (!flags)
    return;
  if (typeof w.set_unmaximize_flags === 'function')
    w.set_unmaximize_flags(flags);
  else
    w.unmaximize(flags);
};

/** A window the user may place by dragging: a normal, movable, resizable, not fullscreen window. */
const eligible = w =>
  !!w && w.get_window_type() === Meta.WindowType.NORMAL && tryOr(() => w.allows_move() && w.allows_resize(), false) &&
  !tryOr(() => w.is_fullscreen(), false);

const validTable = t =>
  t && typeof t === 'object' && Array.isArray(t.zones) && typeof t.seq === 'number' &&
  t.zones.every(z => z && typeof z.id === 'string' && Array.isArray(z.triggers));

export class DragSource {
  /**
   * @param {(event: object) => void} emit sends one DragEvent to the client (wrapped by the caller)
   * @param {(level: string, message: string) => void} log
   */
  constructor(emit, log) {
    this._emit = emit;
    this._log = log;
    this._table = null;
    this._signals = [];
    this._session = null;
    this._nextDrag = 0;
  }

  get watching() {
    return this._table !== null;
  }

  /** `dragWatch`: the table to hit-test against, null stops. */
  watch(table) {
    if (table === null) {
      this._cancel('stopped');
      this._disconnect();
      this._table = null;
      return {watching: false, reason: 'stopped'};
    }
    if (!validTable(table))
      throw new Error('"table" must be a zone table ({seq, zones: [{id, triggers}], ...}) or null');
    this._table = table;
    if (!this._signals.length) {
      const d = global.display;
      this._signals = [
        [d, d.connect('grab-op-begin', (_d, window, op) => this._safe(() => this._begin(window, op)))],
        [d, d.connect('grab-op-end', (_d, window) => this._safe(() => this._end(window)))],
        [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._safe(() => this._cancel('displays-changed')))],
        [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._safe(() => this._workspaceChanged()))],
      ];
    }
    return {watching: true, draws: false, restoreDuringMove: true};
  }

  /** `dragAnswer`: SMBAct's answer to `begin`; `allow: false` keeps this drag's window as it is (no restore). */
  answer(drag, allow) {
    const s = this._session;
    if (!s || s.drag !== drag)
      return {ok: false};
    s.allowed = !!allow;
    return {ok: true};
  }

  /**
   * `dragRestoreSize`: once the pointer is RESTORE_THRESHOLD px off the press, the window of drag `drag` gets this size
   * during the move, the pointer kept at the share of its width where it grabbed it (SMBAct's MPOS-REST-1, -2). Once
   * per drag. A maximized window is Mutter's to restore (it un-maximizes it under the pointer itself): `{ok: false}`;
   * a one-axis maximize (how a full-height half is held) is left first.
   */
  restoreSize(drag, width, height) {
    const s = this._session;
    if (!s || s.drag !== drag || !s.hit)
      return {ok: false};
    if (s.maximizedAtBegin || !(width > 0 && height > 0))
      return {ok: false};
    s.restore = {width: Math.round(width), height: Math.round(height)};
    this._restoreStep();
    return {ok: true};
  }

  /** Everything off (disable(), the client left the bus): no events go out any more. */
  stop() {
    this._stopSession();
    this._disconnect();
    this._table = null;
  }

  _safe(fn) {
    try {
      fn();
    } catch (e) {
      this._log('warn', `drag source: ${e?.message ?? e}`);
    }
  }

  _disconnect() {
    for (const [obj, id] of this._signals)
      tryOr(() => obj.disconnect(id));
    this._signals = [];
  }

  _stopSession() {
    const s = this._session;
    if (!s)
      return;
    this._session = null;
    if (s.timer)
      GLib.source_remove(s.timer);
    for (const id of s.windowSignals)
      tryOr(() => s.window.disconnect(id));
  }

  _begin(window, op) {
    if (!this._table || this._session)
      return; // one drag at a time
    if ((op & ~GRAB_UNCONSTRAINED) !== Meta.GrabOp.MOVING || !eligible(window))
      return;
    const [x, y, mods] = global.get_pointer();
    if (!(mods & M.BUTTON1_MASK))
      return; // the primary button only (a touch drag, another button: no session)
    const frame = rect(window.get_frame_rect());
    const drag = ++this._nextDrag;
    const s = {
      drag,
      window,
      frame,
      press: {x, y},
      hit: new DragHitTest(this._table),
      table: this._table.seq,
      maximizedAtBegin: isFullyMaximized(window),
      allowed: null,
      restore: null,
      restored: false,
      timer: 0,
      windowSignals: [],
    };
    s.windowSignals.push(window.connect('unmanaged', () => this._safe(() => this._cancel('window-closed'))));
    this._session = s;
    this._emit({
      type: 'begin',
      drag,
      window: {OwnerHandle: tryOr(() => window.get_pid(), -1), Handle: window.get_id()},
      frame,
      pointer: {x, y},
      press: {x, y},
      table: s.table,
      time: nowMs(),
      owner: tryOr(() => window.get_wm_class(), '') ?? '',
    });
    this._sample(x, y, mods);
    s.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_MS, () => {
      this._safe(() => {
        if (this._session === s && s.hit) {
          const [px, py, pm] = global.get_pointer();
          this._sample(px, py, pm);
          this._restoreStep();
        }
      });
      if (this._session === s)
        return GLib.SOURCE_CONTINUE;
      s.timer = 0;
      return GLib.SOURCE_REMOVE;
    });
  }

  _sample(x, y, mods) {
    const s = this._session;
    if (!s?.hit)
      return;
    const tr = s.hit.sample({x, y, t: nowMs(), flags: flagsOf(mods)});
    if (!tr)
      return;
    if (tr.zone !== null) {
      const reason = this._guard(x, y);
      if (reason) {
        this._cancel(reason, {x, y});
        return;
      }
    }
    this._emit({type: 'zone', drag: s.drag, zone: tr.zone, pointer: {x, y}});
  }

  /** Why no zone may arm now: the overview is open, the monitor under the pointer shows a fullscreen window. */
  _guard(x, y) {
    if (Main.overview.visible)
      return 'overview';
    const monitor = tryOr(() => global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x, y, width: 1, height: 1})), -1);
    if (monitor >= 0 && tryOr(() => global.display.get_monitor_in_fullscreen(monitor), false))
      return 'fullscreen';
    return null;
  }

  /** The restored size, once the pointer is off the press (see restoreSize()). */
  _restoreStep() {
    const s = this._session;
    if (!s?.hit || !s.restore || s.restored || s.allowed === false)
      return;
    const [x, y] = global.get_pointer();
    if (Math.hypot(x - s.press.x, y - s.press.y) <= RESTORE_THRESHOLD)
      return;
    const w = s.window;
    if (isFullyMaximized(w))
      return;
    s.restored = true;
    const {width, height} = s.restore;
    const share = s.frame.width > 0 ? Math.min(1, Math.max(0, (s.press.x - s.frame.x) / s.frame.width)) : 0.5;
    const grabY = Math.min(Math.max(0, s.press.y - s.frame.y), Math.max(0, height - 1));
    // a resize during Mutter's move grab, as Tiling Assistant does when it untiles a dragged window: a one-axis
    // maximize first, else the constraints keep the full height
    if (isMaximized(w))
      unmaximizeAxes(w);
    w.move_resize_frame(true, Math.round(x - share * width), Math.round(y - grabY), width, height);
  }

  _workspaceChanged() {
    const s = this._session;
    if (s && !tryOr(() => s.window.located_on_workspace(global.workspace_manager.get_active_workspace()), true))
      this._cancel('workspace-changed');
  }

  /** Ends the running drag without a drop (`end` with `cancelled`); the rest of the grab is ignored. */
  _cancel(reason, at = null) {
    const s = this._session;
    if (!s?.hit)
      return;
    s.hit = null;
    const [x, y] = at ? [at.x, at.y] : global.get_pointer();
    this._emit({type: 'end', drag: s.drag, zone: null, cancelled: true, reason, frame: null, pointer: {x, y}});
    if (reason === 'window-closed' || reason === 'stopped')
      this._stopSession();
  }

  _end(window) {
    const s = this._session;
    if (!s || s.window !== window)
      return;
    const hit = s.hit;
    this._stopSession();
    if (!hit)
      return; // cancelled earlier
    const [x, y, mods] = global.get_pointer();
    const frame = rect(window.get_frame_rect());
    // Escape ends the grab with the button still down and the window back where it was
    const buttonDown = (mods & M.BUTTON1_MASK) !== 0;
    const cancelled = buttonDown || sameRect(frame, s.frame);
    const zone = cancelled ? null : hit.release({x, y, t: nowMs(), flags: flagsOf(mods)});
    this._emit({
      type: 'end',
      drag: s.drag,
      zone,
      cancelled,
      ...(cancelled ? {reason: buttonDown ? 'escape' : 'put-back'} : {}),
      frame,
      pointer: {x, y},
    });
  }
}
