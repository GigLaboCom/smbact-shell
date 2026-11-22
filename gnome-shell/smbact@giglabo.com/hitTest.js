// SPDX-License-Identifier: GPL-2.0-or-later
// The hit-test of a window drag (PROTOCOL.md, `dragWatch`): pointer samples in, zone transitions out. A port of the
// reference in SMBAct (app-native/shared/drag-snap/hit-test.ts); every implementation runs the same fixtures
// (tests/fixtures/hit-test.json, a copy of SMBAct's app-native/shared/drag-snap/fixtures/hit-test.json).
// Pure: no gi:// imports, no clock of its own (every sample carries its time), no timers, so node runs its tests.

/** The modifier bits a sample carries (`flags`): the same numbers as SMBAct's MODIFIER_FLAG. */
export const MODIFIER_FLAG = Object.freeze({shift: 1, ctrl: 2, alt: 4, meta: 8});

const contains = (z, x, y) =>
  z.triggers.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

/** How far the point is from the zone's nearest trigger (0 inside). */
const distance = (z, x, y) =>
  Math.min(...z.triggers.map(r => {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
    return Math.hypot(dx, dy);
  }));

export class DragHitTest {
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
    if (z.when === 'modifier')
      return held;
    if (z.when === 'no-modifier')
      return !held && !this._latched;
    return true;
  }

  /** The zone the pointer is in, as far as the modifier allows. */
  zoneAt(x, y, flags) {
    return this._table.zones.find(z => this._allowed(z, flags) && contains(z, x, y));
  }

  /** The armed zone still holds a pointer that left its trigger by at most `stickPx` (and is in no other zone). */
  _sticks(s) {
    const stick = this._table.stickPx ?? 0;
    const z = this._armed ? this._table.zones.find(x => x.id === this._armed) : undefined;
    return z && stick > 0 && this._allowed(z, s.flags) && distance(z, s.x, s.y) <= stick ? z : undefined;
  }

  _delayOf(z) {
    // moving on to a neighbouring zone while armed re-arms at once
    if (this._armed)
      return 0;
    return z.shared ? this._table.sharedEdgeDelayMs : this._table.armDelayMs;
  }

  /** A pointer sample `{x, y, t, flags}`. Returns `{zone}` on a transition, null when the armed zone stays. */
  sample(s) {
    this._last = s;
    if (this._held(s.flags))
      this._latched = true;
    return this._evaluate(s);
  }

  /** Re-evaluates the last sample at time `t` (a pending pause may be over). */
  tick(t) {
    return this._last ? this._evaluate({...this._last, t}) : null;
  }

  /** When tick() should run next, or null when nothing waits. */
  nextDeadline() {
    if (!this._pending)
      return null;
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
        return {zone: null};
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
      return {zone: z.id};
    }
    if (this._pending?.zone.id !== z.id) {
      this._pending = {zone: z, since: s.t};
      return null;
    }
    if (s.t - this._pending.since >= delay) {
      this._pending = null;
      this._armed = z.id;
      return {zone: z.id};
    }
    return null;
  }

  /**
   * The button went up at `s`: the zone of the drop, or null. The armed zone if the release is still in it; a fast
   * throw into a zone that arms without a pause counts too; a zone that needs the modifier needs it held at the
   * release; a shared edge never counts unarmed (no drop on the way across).
   */
  release(s) {
    if (this._held(s.flags))
      this._latched = true;
    const z = this.zoneAt(s.x, s.y, s.flags);
    if (!z)
      return this._sticks(s)?.id ?? null;
    if (z.id === this._armed || !z.shared || this._armed !== null)
      return z.id;
    // a shared edge whose pause ran out between the last sample and the release
    return this._pending?.zone.id === z.id && s.t - this._pending.since >= this._table.sharedEdgeDelayMs ? z.id : null;
  }
}
