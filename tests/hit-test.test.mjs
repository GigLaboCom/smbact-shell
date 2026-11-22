// SPDX-License-Identifier: GPL-2.0-or-later
// node --test tests/*.test.mjs: the GNOME Shell extension's hit-test (gnome-shell/smbact@giglabo.com/hitTest.js) against the
// shared fixtures in tests/fixtures/hit-test.json, a byte-for-byte copy of SMBAct's
// app-native/shared/drag-snap/fixtures/hit-test.json (see tests/fixtures/README.md). SMBAct's TypeScript reference
// and smbact-helper's Rust copy run the same file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'gnome-shell', 'smbact@giglabo.com', 'hitTest.js');
// the extension's files are ES modules named .js (GNOME Shell's rule); node needs .mjs to read one as a module
const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smbact-shell-')), 'hitTest.mjs');
fs.copyFileSync(source, copy);
const {DragHitTest} = await import(pathToFileURL(copy).href);

const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'hit-test.json'), 'utf8'));

for (const c of fixtures.cases) {
  test(`hit-test: ${c.name}`, () => {
    const h = new DragHitTest(fixtures.tables[c.table]);
    c.steps.forEach((s, i) => {
      const where = `step ${i} (${s.op} ${s.x ?? ''},${s.y ?? ''} t=${s.t})`;
      if (s.op === 'release') {
        assert.equal(h.release({x: s.x, y: s.y, t: s.t, flags: s.flags ?? 0}), s.expect, where);
        return;
      }
      const tr = s.op === 'tick' ? h.tick(s.t) : h.sample({x: s.x, y: s.y, t: s.t, flags: s.flags ?? 0});
      if (s.expect === 'none')
        assert.equal(tr, null, where);
      else
        assert.deepEqual(tr, {zone: s.expect}, where);
    });
  });
}

test('hit-test: nextDeadline is the pending pause', () => {
  const h = new DragHitTest(fixtures.tables.edge);
  assert.equal(h.nextDeadline(), null);
  h.sample({x: 996, y: 400, t: 1000, flags: 0});
  assert.equal(h.nextDeadline(), 1400);
  h.sample({x: 500, y: 400, t: 1100, flags: 0});
  assert.equal(h.nextDeadline(), null);
});

test('hit-test: the fixture file has cases', () => {
  assert.ok(fixtures.cases.length >= 10, `only ${fixtures.cases.length} cases`);
});
