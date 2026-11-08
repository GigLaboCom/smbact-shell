// SPDX-License-Identifier: GPL-2.0-or-later
// Window snapshots for SMBAct's switcher previews (PROTOCOL.md, `snapshots`). A snapshot costs the compositor about one
// frame (paint_to_content + a GPU readback; ~40 ms per window on a software-rendered VM, measured in SMBAct's W2), so:
// - snapshots are cached per window and taken again only when the window was damaged or resized since;
// - a request answers at once with what is cached, and the stale or missing ones are taken one at a time when the
//   shell is idle, each announced with an `snapshot` event;
// - the window that just lost the focus is taken quietly a moment later (it is the likeliest next pick), when stale;
// - minimized windows are not painted: their last snapshot stays.
// The frame rect is cut out of the buffer (no client-side shadow), scaled to fit `maxSize` and encoded as JPEG over
// `background` (JPEG has no alpha; GdkPixbuf on GNOME 50 encodes through glycin, which refuses RGBA for JPEG).
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const DEFAULT_MAX_SIZE = 480;
const MAX_MAX_SIZE = 1024;
const DEFAULT_BACKGROUND = 0xffffffff;
const JPEG_QUALITY = '85';
/** Without a damage signal (an older Mutter), a snapshot counts as stale after this. */
const MAX_AGE_WITHOUT_DAMAGE_MS = 5000;
const FOCUS_PREWARM_DELAY_MS = 300;

const tryOr = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const compositeToStream = (texture, scale, stream) => new Promise((resolve, reject) => {
  Shell.Screenshot.composite_to_stream(texture, 0, 0, -1, -1, scale, null, 0, 0, 1, stream, (_o, res) => {
    try {
      resolve(Shell.Screenshot.composite_to_stream_finish(res));
    } catch (e) {
      reject(e);
    }
  });
});

/** '#rrggbb' as GdkPixbuf's fill value (0xRRGGBBAA). */
export const parseBackground = value => {
  const m = typeof value === 'string' ? /^#([0-9a-f]{6})$/i.exec(value) : null;
  return m ? ((Number.parseInt(m[1], 16) << 8) | 0xff) >>> 0 : DEFAULT_BACKGROUND;
};

export const fitTo = (w, h, maxSize) => {
  const k = Math.min(1, maxSize / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
};

export class Snapshots {
  /**
   * @param {(event: object) => void} emit the plugin's Event signal
   * @param {(id: number) => Meta.Window | null} find a window by its id
   */
  constructor(emit, find) {
    this._emit = emit;
    this._find = find;
    /** window id -> { data, width, height, maxSize, background, at, dirty } */
    this._cache = new Map();
    /** window id -> { window, actor, ids: [window signal ids], actorIds: [actor signal ids] } */
    this._watched = new Map();
    /** pending captures: window id -> { maxSize, background, notify } */
    this._queue = new Map();
    this._busy = false;
    this._idleId = 0;
    this._prewarmId = 0;
    this._last = {maxSize: DEFAULT_MAX_SIZE, background: DEFAULT_BACKGROUND};
    this._stopped = false;
  }

  stop() {
    this._stopped = true;
    if (this._idleId)
      GLib.source_remove(this._idleId);
    if (this._prewarmId)
      GLib.source_remove(this._prewarmId);
    this._idleId = this._prewarmId = 0;
    for (const id of [...this._watched.keys()])
      this._unwatch(id);
    this._cache.clear();
    this._queue.clear();
  }

  /** `snapshots {ids, maxSize?, background?}`: the cached ones now, the stale ones queued. */
  request(ids, maxSize, background) {
    const size = typeof maxSize === 'number' && maxSize > 0 ? Math.min(Math.round(maxSize), MAX_MAX_SIZE) : DEFAULT_MAX_SIZE;
    const bg = parseBackground(background);
    this._last = {maxSize: size, background: bg};
    const out = [];
    for (const requested of ids) {
      const w = this._find(requested);
      if (!w)
        continue;
      const id = w.get_id();
      const entry = this._cache.get(id);
      const stale = !entry || this._isStale(entry) || entry.maxSize !== size || entry.background !== bg;
      if (entry)
        out.push(this._describe(id, entry, !stale));
      if (stale)
        this._enqueue(id, size, bg, true);
    }
    return out;
  }

  /** `snapshot {id}`: the cached one, or null. */
  get(requested) {
    const w = this._find(requested);
    const entry = w ? this._cache.get(w.get_id()) : null;
    return entry ? this._describe(w.get_id(), entry, !this._isStale(entry)) : null;
  }

  /** The focus moved away from `w`: take it again quietly a moment later, if it is stale. */
  focusLeft(w) {
    if (!w || this._stopped)
      return;
    const id = w.get_id();
    if (this._prewarmId)
      GLib.source_remove(this._prewarmId);
    this._prewarmId = GLib.timeout_add(GLib.PRIORITY_LOW, FOCUS_PREWARM_DELAY_MS, () => {
      this._prewarmId = 0;
      const entry = this._cache.get(id);
      if (!entry || this._isStale(entry))
        this._enqueue(id, this._last.maxSize, this._last.background, false);
      return GLib.SOURCE_REMOVE;
    });
  }

  /** The window is gone. */
  forget(id) {
    this._cache.delete(id);
    this._queue.delete(id);
    this._unwatch(id);
  }

  _describe(id, entry, fresh) {
    return {id, mime: 'image/jpeg', data: entry.data, width: entry.width, height: entry.height, fresh};
  }

  _isStale(entry) {
    return entry.dirty || (!entry.damageSignal && Date.now() - entry.at > MAX_AGE_WITHOUT_DAMAGE_MS);
  }

  _enqueue(id, maxSize, background, notify) {
    const pending = this._queue.get(id);
    this._queue.set(id, {maxSize, background, notify: notify || (pending?.notify ?? false)});
    this._schedule();
  }

  _schedule() {
    if (this._idleId || this._busy || this._stopped || this._queue.size === 0)
      return;
    this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
      this._idleId = 0;
      this._next();
      return GLib.SOURCE_REMOVE;
    });
  }

  async _next() {
    const first = this._queue.entries().next();
    if (first.done)
      return;
    const [id, job] = first.value;
    this._queue.delete(id);
    this._busy = true;
    try {
      const w = this._find(id);
      const shot = w ? await this._capture(w, job.maxSize, job.background) : null;
      if (shot && !this._stopped) {
        const watch = this._watch(w);
        this._cache.set(id, {...shot, maxSize: job.maxSize, background: job.background, at: Date.now(), dirty: false,
          damageSignal: watch.damageSignal});
        if (job.notify)
          this._emit({type: 'snapshot', id});
      }
    } catch (e) {
      console.warn(`smbact: snapshot of window ${id} failed: ${e?.message ?? e}`);
    } finally {
      this._busy = false;
      this._schedule();
    }
  }

  async _capture(w, maxSize, background) {
    if (w.minimized)
      return null;
    const actor = w.get_compositor_private();
    if (!actor)
      return null;
    // The whole buffer, the way GNOME's own window screenshot takes it (paint_to_content's clip is not in logical
    // actor coordinates on GNOME 50). The visible window is the frame rect inside the buffer rect (a client-side
    // shadow lies outside it): cut it out of the image in proportion, whatever the buffer scale is.
    const frame = w.get_frame_rect();
    const buffer = w.get_buffer_rect();
    const texture = actor.paint_to_content(null)?.get_texture();
    if (!texture || buffer.width <= 0 || buffer.height <= 0)
      return null;
    const stream = Gio.MemoryOutputStream.new_resizable();
    const full = await compositeToStream(texture, actor.get_resource_scale(), stream);
    tryOr(() => stream.close(null));
    const kx = full.get_width() / buffer.width;
    const ky = full.get_height() / buffer.height;
    const cx = Math.max(0, Math.round((frame.x - buffer.x) * kx));
    const cy = Math.max(0, Math.round((frame.y - buffer.y) * ky));
    const cw = Math.max(1, Math.min(full.get_width() - cx, Math.round(frame.width * kx)));
    const ch = Math.max(1, Math.min(full.get_height() - cy, Math.round(frame.height * ky)));
    const pixbuf = cw < full.get_width() || ch < full.get_height() ? full.new_subpixbuf(cx, cy, cw, ch) : full;
    const [sw, sh] = fitTo(cw, ch, maxSize);
    const small = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, sw, sh);
    small.fill(background);
    pixbuf.composite(small, 0, 0, sw, sh, 0, 0, sw / cw, sh / ch, GdkPixbuf.InterpType.BILINEAR, 255);
    const [, bytes] = small.save_to_bufferv('jpeg', ['quality'], [JPEG_QUALITY]);
    return {data: GLib.base64_encode(bytes), width: sw, height: sh};
  }

  /** Marks the window's snapshot stale on damage or a new size; returns whether damage is reported at all. */
  _watch(w) {
    const id = w.get_id();
    const existing = this._watched.get(id);
    if (existing)
      return existing;
    const stale = () => {
      const entry = this._cache.get(id);
      if (entry)
        entry.dirty = true;
    };
    const actor = w.get_compositor_private();
    const actorIds = [];
    let damageSignal = false;
    if (actor) {
      const damageId = tryOr(() => actor.connect('damaged', stale));
      if (damageId) {
        actorIds.push(damageId);
        damageSignal = true;
      }
    }
    const ids = [w.connect('size-changed', stale), w.connect('unmanaged', () => this.forget(id))];
    const watch = {window: w, actor, ids, actorIds, damageSignal};
    this._watched.set(id, watch);
    return watch;
  }

  _unwatch(id) {
    const watch = this._watched.get(id);
    if (!watch)
      return;
    for (const sid of watch.ids)
      tryOr(() => watch.window.disconnect(sid));
    for (const sid of watch.actorIds)
      tryOr(() => watch.actor.disconnect(sid));
    this._watched.delete(id);
  }
}
