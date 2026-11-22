// SPDX-License-Identifier: GPL-2.0-or-later
// node --test tests/*.test.mjs: the KWin script (kwin/smbact-kwin.js) in a fake KWin. The script runs unchanged in a
// node `vm` context with stand-ins for what KWin gives a script (workspace, options, callDBus, QTimer, KWin), so these
// tests cover its drag hit-test against SMBAct's shared fixtures (tests/fixtures/hit-test.json, the same cases as the
// GNOME extension's hitTest.js), the drag source (begin / zone / end, Escape, KWin's own tile, a keyboard move, the
// pause of a shared edge, restore on drag away), the hold of KWin's screen-edge tiling and the watchdog. KWin's real
// behaviour behind these fakes was measured in SMBAct's KDE VM (smbact-app scripts/dev/linux/drag-snap/kde/).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, '..', 'kwin', 'smbact-kwin.js'), 'utf8');
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'hit-test.json'), 'utf8'));

class Signal {
  constructor() {
    this.handlers = [];
  }
  connect(f) {
    this.handlers.push(f);
  }
  disconnect(f) {
    const i = this.handlers.indexOf(f);
    if (i < 0) throw new Error('not connected');
    this.handlers.splice(i, 1);
  }
  emit(...a) {
    for (const f of [...this.handlers]) f(...a);
  }
}

let uuid = 0;
const fakeWindow = (o = {}) => {
  const w = {
    internalId: `{${(0x10000000 + ++uuid).toString(16)}-0000-0000-0000-000000000000}`,
    caption: 'Drag W',
    resourceClass: 'drag-probe',
    pid: 4242,
    normalWindow: true,
    moveable: true,
    resizeable: true,
    fullScreen: false,
    minimized: false,
    maximizeMode: 0,
    tile: null,
    move: false,
    onAllDesktops: false,
    desktops: ['d1'],
    output: 'out0',
    _frame: {x: 300, y: 150, width: 640, height: 467},
    frameGeometryChanged: new Signal(),
    minimizedChanged: new Signal(),
    captionChanged: new Signal(),
    maximizedChanged: new Signal(),
    fullScreenChanged: new Signal(),
    interactiveMoveResizeStarted: new Signal(),
    interactiveMoveResizeFinished: new Signal(),
    writes: [],
    setMaximize(v, h) {
      this.maximizeMode = (v ? 1 : 0) | (h ? 2 : 0);
    },
    ...o,
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() {
      return {...this._frame};
    },
    set(g) {
      this.writes.push({...g});
      this._frame = {...g};
    },
  });
  w.clientGeometry = w._frame;
  return w;
};

/** The script in a fresh fake KWin; returns the handles a test drives it with. */
const loadScript = ({nameHasOwner = true} = {}) => {
  let now = 1000;
  const timers = [];
  class QTimer {
    constructor() {
      this.interval = 0;
      this.singleShot = false;
      this.timeout = new Signal();
      this.due = null;
      timers.push(this);
    }
    start(ms) {
      if (ms !== undefined) this.interval = ms;
      this.due = now + this.interval;
    }
    stop() {
      this.due = null;
    }
  }
  const events = [];
  const calls = [];
  let next = null;
  let lastReply = null;
  const owner = {has: nameHasOwner};
  const callDBus = (service, objPath, iface, method, ...rest) => {
    const cb = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    calls.push({method, args: rest});
    if (method === 'Hello') cb && cb();
    else if (method === 'Next') {
      lastReply = rest[0] ? JSON.parse(rest[0]) : null;
      next = cb;
    } else if (method === 'Event') events.push(JSON.parse(rest[0]));
    else if (method === 'NameHasOwner') cb && cb(owner.has);
  };
  const win = fakeWindow();
  const workspace = {
    _windows: [win],
    windowList() {
      return this._windows;
    },
    get stackingOrder() {
      return this._windows;
    },
    screens: [{name: 'out0', geometry: {x: 0, y: 0, width: 1280, height: 800}, devicePixelRatio: 1}],
    cursorPos: {x: 620, y: 164},
    currentDesktop: 'd1',
    desktops: ['d1', 'd2'],
    activeWindow: win,
    windowAdded: new Signal(),
    windowRemoved: new Signal(),
    windowActivated: new Signal(),
    screensChanged: new Signal(),
    currentDesktopChanged: new Signal(),
    cursorPosChanged: new Signal(),
    screenAt() {
      return 'out0';
    },
    clientArea() {
      return {x: 0, y: 0, width: 1280, height: 746};
    },
    raiseWindow() {},
  };
  const options = {
    electricBorderTiling: true,
    electricBorderMaximize: true,
    configChanged: new Signal(),
  };
  const ctx = vm.createContext({
    workspace,
    options,
    callDBus,
    QTimer,
    KWin: {MaximizeArea: 2},
    console: {log() {}, info() {}, warn() {}},
    Date: {now: () => now},
  });
  vm.runInContext(`${SOURCE}\n;globalThis.__kwin = { DragHitTest: DragHitTest };`, ctx, {filename: 'smbact-kwin.js'});
  const request = (op, args = {}) => {
    const cb = next;
    assert.ok(cb, 'the script waits for a request');
    next = null;
    cb(JSON.stringify({...args, op, seq: calls.length}));
    assert.ok(lastReply && lastReply.ok, `${op}: ${JSON.stringify(lastReply)}`);
    return lastReply.result;
  };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.due !== null && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      now = due.due;
      due.due = due.singleShot ? null : now + due.interval;
      due.timeout.emit();
    }
    now = until;
  };
  const pointer = (x, y) => {
    workspace.cursorPos = {x, y};
    workspace.cursorPosChanged.emit();
  };
  const drags = () => events.filter((e) => e.type === 'drag').map((e) => e.event);
  return {ctx, workspace, options, win, events, drags, calls, request, advance, pointer, owner, hitTest: ctx.__kwin.DragHitTest};
};

/** A table with the left edge, the top edge (maximize) and a shared right edge on one 1280 x 800 output. */
const TABLE = {
  seq: 7,
  space: 'logical',
  armDelayMs: 0,
  sharedEdgeDelayMs: 400,
  stickPx: 24,
  modifier: null,
  zones: [
    {id: 'd0/left', display: 'd0', area: 'left', action: 'left-half', triggers: [{x: 0, y: 96, width: 30, height: 608}], when: 'plain', shared: false},
    {id: 'd0/top', display: 'd0', area: 'top', action: 'maximize', triggers: [{x: 96, y: 0, width: 1088, height: 30}], when: 'plain', shared: false},
    {id: 'd0/right', display: 'd0', area: 'right', action: 'right-half', triggers: [{x: 1250, y: 96, width: 30, height: 608}], when: 'plain', shared: true},
  ],
};

/** KWin starts a move of `w`: `move` set, the pointer a little past the press (its drag threshold). */
const startMove = (k, w = k.win, at = {x: 630, y: 170}) => {
  k.workspace.cursorPos = at;
  w.move = true;
  w.interactiveMoveResizeStarted.emit();
};
/** KWin moves the window with the pointer (the grab offset kept), as each motion does. */
const moveTo = (k, x, y, w = k.win, grab = {x: 330, y: 20}) => {
  w._frame = {...w._frame, x: x - grab.x, y: y - grab.y};
  k.pointer(x, y);
};
const finish = (k, w = k.win) => {
  w.move = false;
  w.interactiveMoveResizeFinished.emit();
};

for (const c of fixtures.cases) {
  test(`kwin hit-test: ${c.name}`, () => {
    const {hitTest} = loadScript();
    const h = new hitTest(fixtures.tables[c.table]);
    c.steps.forEach((s, i) => {
      const where = `step ${i} (${s.op} ${s.x ?? ''},${s.y ?? ''} t=${s.t})`;
      if (s.op === 'release') {
        assert.equal(h.release({x: s.x, y: s.y, t: s.t, flags: s.flags ?? 0}), s.expect, where);
        return;
      }
      const tr = s.op === 'tick' ? h.tick(s.t) : h.sample({x: s.x, y: s.y, t: s.t, flags: s.flags ?? 0});
      if (s.expect === 'none') assert.equal(tr, null, where);
      else assert.deepEqual({...tr}, {zone: s.expect}, where);
    });
  });
}

test('kwin: hello lists the drag operations', () => {
  const k = loadScript();
  const hello = JSON.parse(k.calls.find((c) => c.method === 'Hello').args[0]);
  for (const op of ['dragWatch', 'dragAnswer', 'dragRestoreSize', 'nativeTiling']) assert.ok(hello.ops.includes(op), op);
  assert.equal(hello.version, '2.2.0');
});

test('kwin: no table, no drag events; dragWatch answers draws false, restore true, no modifier', () => {
  const k = loadScript();
  startMove(k);
  moveTo(k, 5, 400);
  finish(k);
  assert.equal(k.drags().length, 0);
  assert.deepEqual(k.request('dragWatch', {table: TABLE}), {watching: true, draws: false, restoreDuringMove: true, modifier: false});
  assert.deepEqual(k.request('dragWatch', {table: null}), {watching: false, reason: 'stopped'});
});

test('kwin: a drag to the left edge: begin, zone, end in the zone', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  moveTo(k, 400, 300);
  moveTo(k, 5, 400);
  finish(k);
  const [begin, zone, end] = k.drags();
  assert.equal(begin.type, 'begin');
  assert.equal(begin.table, 7);
  assert.deepEqual(begin.frame, {x: 300, y: 150, width: 640, height: 467});
  assert.equal(begin.window.OwnerHandle, 4242);
  // the window's id in the protocol: the first 32 bits of KWin's UUID
  assert.equal(begin.window.Handle, parseInt(k.win.internalId.slice(1, 9), 16));
  assert.deepEqual(zone, {type: 'zone', drag: begin.drag, zone: 'd0/left', pointer: {x: 5, y: 400}});
  assert.equal(end.type, 'end');
  assert.equal(end.zone, 'd0/left');
  assert.equal(end.cancelled, false);
  // the pointer listener goes with the drag
  assert.equal(k.workspace.cursorPosChanged.handlers.length, 0);
});

test('kwin: Escape (the window back where it began) ends cancelled, no zone', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  moveTo(k, 400, 300);
  moveTo(k, 5, 400);
  k.win._frame = {x: 300, y: 150, width: 640, height: 467}; // KWin's cancel restores the first geometry
  finish(k);
  const end = k.drags().at(-1);
  assert.deepEqual([end.zone, end.cancelled, end.reason], [null, true, 'escape']);
});

test("kwin: KWin's custom tile (Shift) or its own maximize at the end: no zone", () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  moveTo(k, 5, 400);
  k.win.tile = {};
  finish(k);
  assert.deepEqual([k.drags().at(-1).zone, k.drags().at(-1).reason], [null, 'tiled']);
  k.win.tile = null;
  startMove(k);
  moveTo(k, 600, 5);
  k.win.maximizeMode = 3;
  finish(k);
  assert.deepEqual([k.drags().at(-1).zone, k.drags().at(-1).reason], [null, 'maximized']);
});

test('kwin: a resize, a keyboard move and a window that cannot be resized get no drag', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  k.win.interactiveMoveResizeStarted.emit(); // move false: a resize
  k.win.interactiveMoveResizeFinished.emit();
  // the window menu's Move: KWin puts the pointer on the window's centre
  startMove(k, k.win, {x: 620, y: 384});
  finish(k);
  k.win.resizeable = false;
  startMove(k);
  finish(k);
  assert.equal(k.drags().length, 0);
});

test('kwin: a shared edge arms after its pause (a timer, no pointer motion needed)', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  moveTo(k, 1265, 400);
  assert.equal(k.drags().length, 1);
  k.advance(399);
  assert.equal(k.drags().length, 1);
  k.advance(2);
  assert.deepEqual(k.drags().at(-1), {type: 'zone', drag: 1, zone: 'd0/right', pointer: {x: 1265, y: 400}});
  finish(k);
  assert.equal(k.drags().at(-1).zone, 'd0/right');
});

test('kwin: a zone does not arm over a fullscreen window: the drag ends cancelled', () => {
  const k = loadScript();
  const full = fakeWindow({fullScreen: true});
  k.workspace._windows.push(full);
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  moveTo(k, 5, 400);
  const end = k.drags().at(-1);
  assert.deepEqual([end.type, end.cancelled, end.reason], ['end', true, 'fullscreen']);
  finish(k);
  assert.equal(k.drags().length, 2);
});

test('kwin: the window closed, the outputs changed, the desktop changed without the window: cancelled', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  startMove(k);
  k.workspace.windowRemoved.emit(k.win);
  assert.equal(k.drags().at(-1).reason, 'window-closed');
  startMove(k);
  k.workspace.screensChanged.emit();
  assert.equal(k.drags().at(-1).reason, 'displays-changed');
  finish(k);
  // "Switch desktop on edge" carried the window along: the drag goes on (MPOS-KDE-10)
  startMove(k);
  k.win.desktops = ['d2'];
  k.workspace.currentDesktop = 'd2';
  k.workspace.currentDesktopChanged.emit();
  assert.equal(k.drags().at(-1).type, 'begin');
  // the window stayed behind: ends cancelled
  k.workspace.currentDesktop = 'd1';
  k.workspace.currentDesktopChanged.emit();
  assert.equal(k.drags().at(-1).reason, 'workspace-changed');
});

test('kwin: dragRestoreSize: the size once the pointer is 12 px off, the grab share kept, a vertical maximize left', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  k.win._frame = {x: 0, y: 0, width: 640, height: 746};
  k.win.maximizeMode = 1;
  startMove(k, k.win, {x: 211, y: 14});
  const drag = k.drags()[0].drag;
  assert.deepEqual(k.request('dragRestoreSize', {drag, width: 400, height: 300}), {ok: true});
  assert.equal(k.win.writes.length, 0, 'not before the threshold');
  k.pointer(216, 18);
  assert.equal(k.win.writes.length, 0);
  k.pointer(300, 60);
  assert.equal(k.win.maximizeMode, 0);
  // the pointer at 211 / 640 of the width and 14 px down, as at the start
  assert.deepEqual(k.win.writes, [{x: Math.round(300 - (211 / 640) * 400), y: 60 - 14, width: 400, height: 300}]);
  k.pointer(320, 70);
  assert.equal(k.win.writes.length, 1, 'kept: not written again');
  assert.deepEqual(k.request('dragRestoreSize', {drag: drag + 1, width: 400, height: 300}), {ok: false});
});

test('kwin: dragRestoreSize is refused for a maximized or tiled window and for a refused drag', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  k.win.maximizeMode = 3;
  startMove(k);
  assert.deepEqual(k.request('dragRestoreSize', {drag: k.drags().at(-1).drag, width: 400, height: 300}), {ok: false});
  finish(k);
  k.win.maximizeMode = 0;
  startMove(k);
  const drag = k.drags().at(-1).drag;
  assert.deepEqual(k.request('dragAnswer', {drag, allow: false}), {ok: true});
  k.request('dragRestoreSize', {drag, width: 400, height: 300});
  k.pointer(800, 500);
  assert.equal(k.win.writes.length, 0);
});

test("kwin: nativeTiling holds KWin's options off in memory, again after a reconfigure, and gives them back", () => {
  const k = loadScript();
  assert.deepEqual(k.request('nativeTiling', {}), {electricBorderTiling: true, electricBorderMaximize: true, held: false, saved: {}});
  const held = k.request('nativeTiling', {suppress: true});
  assert.deepEqual(held, {
    electricBorderTiling: false,
    electricBorderMaximize: false,
    held: true,
    saved: {electricBorderTiling: true, electricBorderMaximize: true},
  });
  // "Apply" in System Settings: KWin re-reads kwinrc (the user unticked "Maximize" meanwhile)
  k.options.electricBorderTiling = true;
  k.options.electricBorderMaximize = false;
  k.options.configChanged.emit();
  assert.deepEqual([k.options.electricBorderTiling, k.options.electricBorderMaximize], [false, false]);
  const back = k.request('nativeTiling', {suppress: false});
  assert.deepEqual(back, {electricBorderTiling: true, electricBorderMaximize: false, held: false, saved: {}});
});

test('kwin: nativeTiling holds only the options asked for (MPOS-SYS-8)', () => {
  const k = loadScript();
  const r = k.request('nativeTiling', {suppress: true, options: ['electricBorderTiling']});
  assert.deepEqual([r.electricBorderTiling, r.electricBorderMaximize, r.saved], [false, true, {electricBorderTiling: true}]);
  k.request('nativeTiling', {suppress: true, options: ['electricBorderMaximize']});
  assert.equal(k.options.electricBorderMaximize, false);
  k.request('nativeTiling', {suppress: false, options: ['electricBorderMaximize']});
  assert.deepEqual([k.options.electricBorderTiling, k.options.electricBorderMaximize], [false, true]);
  k.request('nativeTiling', {suppress: false});
  assert.equal(k.options.electricBorderTiling, true);
});

test('kwin: the watchdog gives the hold back and stops the watch when SMBAct leaves the bus', () => {
  const k = loadScript();
  k.request('dragWatch', {table: TABLE});
  k.request('nativeTiling', {suppress: true});
  startMove(k);
  k.advance(2000);
  assert.equal(k.options.electricBorderTiling, false, 'SMBAct still there');
  k.owner.has = false;
  k.advance(2000);
  assert.deepEqual([k.options.electricBorderTiling, k.options.electricBorderMaximize], [true, true]);
  assert.deepEqual([k.drags().at(-1).type, k.drags().at(-1).reason], ['end', 'stopped']);
  // no watch any more: the next drag reports nothing
  const n = k.drags().length;
  startMove(k);
  moveTo(k, 5, 400);
  finish(k);
  assert.equal(k.drags().length, n);
});
