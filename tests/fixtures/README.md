# Shared test fixtures

`hit-test.json` is the contract of the drag hit-test (PROTOCOL.md, `dragWatch`): pointer paths and the zone transitions
they must give. It is a **byte-for-byte copy** of SMBAct's `app-native/shared/drag-snap/fixtures/hit-test.json`
(smbact-app master `d2c7c05`, 2026-11-22, sha256 `adea94a3aec4ca7c12f3d6b2b4d8d1a4304e65a6d2e2c26e0b01ee3725fe3871`).
SMBAct's TypeScript reference (`app-native/shared/drag-snap/hit-test.ts`), smbact-helper's Rust copy
(`cli/crates/winctl/src/drag.rs`), this extension's `hitTest.js` and the KWin script's own copy (`kwin/smbact-kwin.js`,
run by `tests/kwin.test.mjs`) run the same cases.

A change to the hit-test changes SMBAct's fixture first; copy it here unchanged and run `node --test tests/*.test.mjs`.
