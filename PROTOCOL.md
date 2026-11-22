# Protocol: `com.giglabo.SMBAct.Shell1`, API 1

How SMBAct talks to its shell plugins: the GNOME Shell extension (`gnome-shell/`) and the KWin script (`kwin/`,
Plasma 6) implement the same operations with the same JSON; only the transport differs (see "KWin transport"). SMBAct
(a separate program) is the only intended client.

## D-Bus

| | |
|---|---|
| Bus | session |
| Name (owned by the plugin) | `com.giglabo.SMBAct.Shell` |
| Object | `/com/giglabo/SMBAct/Shell1` |
| Interface | `com.giglabo.SMBAct.Shell1` |
| Method | `Call(in s request, out s reply)` |
| Signal | `Event(s event)` |

Requests and replies are JSON strings, so a client needs nothing beyond string calls.

**Who may call.** Only the current owner of the well-known name `com.giglabo.SMBAct` (SMBAct requests it with
`DO_NOT_QUEUE`). Every other caller gets the D-Bus error `org.freedesktop.DBus.Error.AccessDenied`. This keeps
unrelated programs out while SMBAct runs. It does not stop a program of the same user that takes the name while SMBAct
is not running; GNOME's own allow-lists have the same limit.

## Requests and replies

```json
{ "op": "moveResize", "id": 2653220665, "x": 90, "y": 80, "width": 640, "height": 420 }
```

```json
{ "ok": true, "result": { "window": { ... } } }
{ "ok": false, "error": { "code": "NO_WINDOW", "message": "no window 2653220665" } }
```

Error codes: `BAD_REQUEST` (not JSON, missing or wrong arguments), `UNKNOWN_OP`, `NO_WINDOW`, `GRAB_FAILED`
(`grabAccelerator`: the shell refused the accelerator), `NO_SNAPSHOT` (`snapshot`: none taken yet),
`TILING_EXTENSION_ACTIVE` (`nativeTiling`: a tiling extension holds the key itself), `FAILED` (the shell threw;
`message` has its text).

Unknown fields in a request are ignored; new optional fields and new operations do not change the API number. A
change that breaks an existing operation does, and `hello` reports which API the plugin speaks.

## Coordinates

Logical pixels of the compositor's layout (Mutter's stage), the same space as Electron's DIPs for windows under
XWayland. Rectangles are `{ "x", "y", "width", "height" }`.

## Window

```json
{
  "id": 2653220665,
  "title": "Licenses — Mozilla Firefox",
  "wmClass": "firefox",
  "wmClassInstance": "Navigator",
  "appId": "org.mozilla.firefox",
  "sandboxedAppId": null,
  "app": "firefox.desktop",
  "pid": 3068,
  "client": "wayland",
  "x11Window": null,
  "type": "normal",
  "frame": { "x": 67, "y": 32, "width": 1213, "height": 768 },
  "clientRect": { "x": 67, "y": 69, "width": 1213, "height": 731 },
  "focus": true,
  "minimized": false,
  "maximized": true,
  "maximizedHorizontally": true,
  "maximizedVertically": true,
  "fullscreen": false,
  "above": false,
  "skipTaskbar": false,
  "monitor": 0,
  "workspace": 0,
  "onAllWorkspaces": false,
  "onActiveWorkspace": true,
  "stack": 4,
  "icon": "/usr/share/icons/hicolor/48x48/apps/firefox.png"
}
```

- `id`: the compositor's window id, unique in the session (fits in a JSON number). Requests also accept the X11 id
  of an XWayland window as `id`.
- `client`: `wayland` or `x11`; `x11Window`: the X11 window id of an XWayland window, else `null`.
- `type`: `normal`, `dialog`, `modal-dialog`, `utility`, `splashscreen`, `menu`, `toolbar`, `desktop`, `dock`, or
  `other`. The plugin lists every managed window; the client picks what it shows.
- `frame`: the visible window including server-side decorations; `clientRect`: the client area (larger than `frame`
  when the window draws its own shadow).
- `stack`: position in the stacking order, 0 = bottom.
- `workspace`: the index of the window's workspace (KWin: virtual desktop), 0 = the first; `-1` when it is on more than
  one (KWin) or Mutter gives none. On GNOME a window on all workspaces reports the active one, so read it with
  `onAllWorkspaces`.
- `tiled` (KWin, plugin 2.1.0 and later): the window sits in a KWin tile (quick tile or a custom tile), which KWin
  does not count as maximized (`maximizedVertically` stays false). The GNOME extension leaves it out: a Mutter tile is
  a vertical maximize and shows as `maximizedVertically`.
- `onActiveWorkspace` (plugin 2.1.0 and later): the window is on the workspace showing now, or on all of them (GNOME:
  `located_on_workspace`, which also counts the windows of secondary monitors when workspaces are on the primary only).
  Absent from older plugins.
- `icon`: a file path from the icon theme, PNG when the theme has one (only when asked for, see `listWindows`), or
  `null`. `iconPng` turns any icon file (SVG too) into PNG bytes.

## Operations (API 1)

| op | arguments | result |
|---|---|---|
| `hello` | | `{ api, plugin, version, shell, session, ops }` |
| `listWindows` | `icons?` (bool), `iconSize?` (px, default 48) | `{ windows: Window[] }` |
| `getWindow` | `id`, `icons?`, `iconSize?` | `{ window }` |
| `activeWindow` | `icons?`, `iconSize?` | `{ window }` (`null` when nothing has focus) |
| `moveResize` | `id`, `x`, `y`, `width`, `height`, `space?` (`frame` default, or `client`) | `{ window }` |
| `activate` | `id`, `time?` | `{ window }` |
| `raise` | `id` | `{ window }` |
| `setState` | `id`, `state`, `on` | `{ window }` |
| `close` | `id`, `force?` | `{ closed: true }` |
| `showDesktop` | `show` | `{ windows }` (how many were minimized or restored) |
| `displays` | | `{ monitors: [{ index, geometry, workArea, scale, primary, connector }] }` |
| `iconPng` | `path` (an `icon` path), `size?` (px, default 48) | `{ png, width, height }` (`png`: base64 PNG bytes) |
| `pointer` | | `{ x, y }` |
| `grabAccelerator` | `accelerator` (GTK notation, `<Control><Alt>x`) | `{ accelerator, action }` |
| `ungrabAccelerator` | `accelerator` (as grabbed) | `{ released }` |
| `snapshots` | `ids`, `maxSize?` (px, default 480, at most 1024), `background?` (`#rrggbb`, default white) | `{ snapshots: Snapshot[] }` (the cached ones) |
| `snapshot` | `id` | `{ snapshot }` |
| `dragWatch` | `table` (a zone table, or `null` to stop) | `{ watching, reason?, draws, restoreDuringMove }` |
| `dragAnswer` | `drag`, `allow` | `{ ok }` (`false`: no such drag running) |
| `dragRestoreSize` | `drag`, `width`, `height` | `{ ok }` (`false`: no such drag, or the window is maximized) |
| `nativeTiling` | `suppress?` (`true` hold off, `false` give back, absent: read) | `{ edgeTiling, user, held, saved?, tilingExtension }` |

The last four are the GNOME Shell extension's only (plugin 2.2.0 and later); see "Window drags" and "Mutter's edge
tiling" below.

- `setState` states: `minimized`, `maximized`, `maximizedHorizontally`, `maximizedVertically`, `fullscreen`,
  `above`.
- `displays`: `connector` (plugin 2.1.0 and later) is the output's connector name (`DP-1`, `HDMI-A-1`, `Virtual-1`:
  GNOME from Mutter's monitor manager, KWin `Output.name`), `null` when the shell does not tell; absent from older
  plugins. It stays the same while the monitor stays on that port.
- `moveResize` takes the frame rect, or with `space: "client"` the client rect (the compositor converts it with the
  window's own decorations and shadow).
- `moveResize` leaves maximized and fullscreen first, then moves and resizes in two steps, so windows with resize
  increments (terminals) keep the requested position.
- Wayland windows apply a new geometry or state asynchronously (the client acknowledges it about a frame later), so
  the `window` in the reply of `moveResize` and `setState` may still show the previous geometry; read it again
  with `getWindow` (or wait for `windowsChanged`) when the new one matters.
- `activate` uses the server's current time unless `time` is given (an input event's timestamp).
- `close` asks the window to close; `force` kills its client.
- `grabAccelerator` makes the accelerator a global hotkey, whatever window has the focus, the way GNOME grabs its
  custom shortcuts: it fires on the desktop and in the overview, never on the lock or login screen. Each press sends
  an `accelerator` event. It fails with `GRAB_FAILED` when another shortcut (GNOME's own, a custom one, another
  extension's) has the combination, or when Mutter cannot parse it. Grabbing the same string again is a no-op.
- `snapshots` answers at once with the snapshots it has; the ones that are missing, stale (the window was damaged
  or resized since) or of another size are taken one at a time when the shell is idle, and each sends a `snapshot`
  event; fetch it with `snapshot`. A snapshot costs the compositor about a frame, so they are never taken on a timer.
  The window that just lost the focus is taken quietly (no event) a moment later when its snapshot is stale.
  Minimized windows keep their last snapshot. A `Snapshot` is `{ id, mime, data, width, height, fresh }`: `data` is
  base64 JPEG of the visible window (the frame rect, without a client-side shadow), scaled to fit `maxSize`, over
  `background`; `fresh` is false when the window changed since it was taken.
- Grabs belong to the client: the plugin releases all of them when the owner of `com.giglabo.SMBAct` goes away or
  changes, and when it is disabled. A client that starts again grabs again.
- GNOME disables every user extension while the screen is locked and enables them again after the unlock (seen on
  GNOME 50), so the plugin's bus name goes away and comes back without any grabs. Clients watch
  `com.giglabo.SMBAct.Shell` (`NameOwnerChanged`) and grab again when it reappears. The hotkeys do not fire on the
  lock screen anyway.
- `showDesktop` with `show: true` minimizes the visible windows of the active workspace and remembers them; `false`
  restores those.

## Window drags (GNOME, plugin 2.2.0)

SMBAct places a window the user drags to a screen edge or corner (its "positioning with the mouse"). The extension is
its drag source on GNOME: it reports when a window is dragged and which zone of SMBAct's table the pointer is in, and
nothing else. It draws nothing (SMBAct draws its zone map and the footprint itself, `draws: false`) and moves no window
at the end of a drag (SMBAct's own action does, through `moveResize` / `setState`).

`dragWatch` gives the table; drags are reported only while one is set:

```json
{ "seq": 3, "space": "logical", "armDelayMs": 0, "sharedEdgeDelayMs": 400, "stickPx": 24, "modifier": "shift",
  "zones": [ { "id": "d0/left", "display": "d0", "area": "left", "action": "left-half",
               "triggers": [ { "x": 0, "y": 96, "width": 30, "height": 888 } ], "when": "no-modifier", "shared": false } ] }
```

- `triggers` are half-open rectangles in the compositor's coordinates; a zone with two (an L-shaped corner) counts in
  either. `when`: `plain` (any drag), `modifier` (only while the modifier is held), `no-modifier` (until the modifier
  is pressed once during the drag). `shared` zones (on an edge between two monitors) arm after `sharedEdgeDelayMs`,
  the others after `armDelayMs`; moving on to a neighbouring zone while one is armed re-arms at once. An armed zone
  holds the pointer up to `stickPx` outside its triggers. The rules are SMBAct's hit-test; `hitTest.js` is a port of it
  and runs SMBAct's fixtures (`tests/`).
- A drag is a pointer move of a normal, movable, resizable window that is not fullscreen, with the primary button:
  `grab-op-begin` with `(op & ~UNCONSTRAINED) === MOVING` (the title bar, a client-side drag, the top bar, Super+drag).
  Keyboard moves, resizes and touch drags are not reported. One drag at a time.
- The pointer and the modifiers are sampled every 16 ms during the drag (`global.get_pointer()`); the modifier bits
  are shift 1, ctrl 2, alt 4, super 8.

Events: `{ "type": "drag", "event": <event> }`, where `<event>` is one of

```json
{ "type": "begin", "drag": 7, "window": { "OwnerHandle": 3306, "Handle": 3209482314 }, "frame": { "x": 900, "y": 300, "width": 640, "height": 467 },
  "pointer": { "x": 1220, "y": 318 }, "press": { "x": 1220, "y": 318 }, "table": 3, "time": 81234.5, "owner": "gedit" }
{ "type": "zone", "drag": 7, "zone": "d0/left", "pointer": { "x": 8, "y": 500 } }
{ "type": "end", "drag": 7, "zone": "d0/left", "cancelled": false, "frame": { "x": -312, "y": 482, "width": 640, "height": 467 }, "pointer": { "x": 8, "y": 500 } }
{ "type": "end", "drag": 7, "zone": null, "cancelled": true, "reason": "escape", "frame": { "x": 900, "y": 300, "width": 640, "height": 467 }, "pointer": { "x": 8, "y": 500 } }
```

- `window`: `Handle` is the window's `id` (as in `Window`), `OwnerHandle` its pid; `frame` is the frame at the begin;
  `table` the `seq` hit against; `time` the shell's monotonic clock in ms.
- `zone` reports transitions only (armed, re-armed, disarmed with `null`), never the pointer stream.
- `end`: `zone` is the zone of the drop (the armed one, or a fast throw into a zone that arms at once), `null` for
  none. `cancelled` when the grab ended with the button still down (Escape) or with the window back where it began
  (Mutter puts it back on Escape); then `reason` is `escape` or `put-back`. A drag also ends cancelled when its window
  goes away (`window-closed`), the monitors change (`displays-changed`), the workspace changes without the window
  (`workspace-changed`), a zone would arm while the overview is open (`overview`) or over a monitor showing a
  fullscreen window (`fullscreen`), or the watch stops (`stopped`); `frame` is `null` then.

`dragAnswer` is SMBAct's answer to `begin` (may this window be placed); `allow: false` keeps the window as it is.
`dragRestoreSize` gives the dragged window a size back: once the pointer is 12 px off the press, the window gets
`width` x `height` during the move, with the pointer at the same share of its width and at the same height in it where
it grabbed it; once per drag. A window maximized both ways is Mutter's to restore (`{ ok: false }`); a one-axis
maximize (how SMBAct holds a full-height half) is left first.

## Mutter's edge tiling (GNOME, plugin 2.2.0)

`nativeTiling` holds `org.gnome.mutter edge-tiling` off for the client and gives it back:

- `suppress: true` saves the user's own value (or that there was none), writes `false` and holds it; repeated calls
  keep the first saved value. It is refused with `TILING_EXTENSION_ACTIVE` while an extension that holds the key
  itself is active (Ubuntu's Tiling Assistant, `tiling-assistant@ubuntu.com` / `@leleat-on-github`, Tiling Shell): the
  write would end up in that extension's own restore record.
- `suppress: false` puts the saved value back (resets the key when there was none), only over its own `false` and
  never while such an extension is active.
- When somebody else switches the key on during the hold (Settings, another extension being disabled), the hold ends
  without a write: no fight over it.
- The hold belongs to the client, like grabs: it is given back when the owner of `com.giglabo.SMBAct` goes away or
  changes, and when the extension is disabled (a screen lock). A client that starts again holds again.
- The reply: `edgeTiling` the effective value, `user` the user's own (`null`: none), `held`, `saved` while held,
  `tilingExtension` the uuid of an active extension that holds the key, or `null`.

The drag watch belongs to the client too: it stops when the client goes away or changes, and when the extension is
disabled.

## Events

`Event` carries `{ "type": ..., ... }`:

- `windowsChanged`: a window appeared, went away, moved, resized or changed state (coalesced, at most every 100 ms).
- `focusChanged` with `id` (or `null`).
- `accelerator` with `accelerator` (the string given to `grabAccelerator`) and `time` (the key press's timestamp,
  usable as `activate`'s `time`).
- `snapshot` with `id`: a snapshot asked for with `snapshots` is ready.
- `drag` with `event`: a window drag against the client's zone table (see "Window drags").

## History

- API 1 (2026-11): window list, geometry, activation, states, close, displays, pointer, events.
- API 1, plugin 1.0.0-alpha.2 (2026-11): `grabAccelerator`, `ungrabAccelerator`, the `accelerator` event (new
  operations, same API; clients look for them in `hello`'s `ops`).
- API 1, plugin 1.0.0-alpha.3 (2026-11): `snapshots`, `snapshot`, the `snapshot` event.
- API 1, plugin 2.0.0 (2026-11): the first full release, with SMBAct 2.0.0; the same API as 1.0.0-alpha.3.
- API 1, plugin 2.1.0 (2026-11): `connector` in `displays`, `onActiveWorkspace` and (KWin) `tiled` in the window
  (new optional fields, same API), with SMBAct 2.1.0.
- API 1, plugin 2.2.0 (not released yet): `dragWatch`, `dragAnswer`, `dragRestoreSize`, `nativeTiling`, the `drag`
  event (GNOME only; new operations, same API; clients look for them in `hello`'s `ops`).

## KWin transport

A KWin script cannot own a D-Bus name or serve calls, so the direction turns around. SMBAct owns
`com.giglabo.SMBAct`, serves the interface `com.giglabo.SMBAct.KWin1` on `/com/giglabo/SMBAct/KWin1` and loads
`smbact-kwin.js` into KWin through `org.kde.KWin` `/Scripting` (`loadScript(path, "smbact")`, then
`/Scripting/Script<id>` `run`): no install, no new login. The script calls in:

| method | | |
|---|---|---|
| `Hello(s hello)` | once, when the script runs | `hello` is the `hello` operation's result (`plugin: "smbact-kwin"`) |
| `Next(s reply) -> s request` | in a loop | hands over the reply to the previous request (empty the first time) and gets the next request; SMBAct holds the call until it has one and answers `{"op":"noop"}` after 15 s (Qt's D-Bus timeout is 25 s) |
| `Event(s event)` | fire and forget | the events above (`windowsChanged` at most every 100 ms and after a drag, `focusChanged`) |

Requests and replies carry `seq` (the transport pairs them by it; `id` stays a request argument). SMBAct accepts the
calls only from the owner of `org.kde.KWin`. When SMBAct goes away the script's calls fail and its loop ends; SMBAct
unloads it when it quits and loads it again when it starts or when KWin restarts.

What the KWin script does not have: `snapshots` / `snapshot` (KWin offers window screenshots only through
`org.kde.KWin.ScreenShot2`, which takes a file descriptor and an authorized caller), `grabAccelerator` (on Plasma
SMBAct's own X11 hotkeys fire with any focus: KWin passes key combinations to XWayland apps), `iconPng` (a window's
icon is a QIcon: the script reports `desktopFile` and SMBAct looks the icon up), and the X11 marks (`client`,
`x11Window` are `null`: KWin's scripting API does not tell X11 from Wayland windows; SMBAct matches them against the X
server's own list). Window ids are the first 32 bits of KWin's UUID for the window (stable across reloads). The
window drags and `nativeTiling` (plugin 2.2.0) are the GNOME Shell extension's only so far.

- API 1, plugin 1.0.0-alpha.3 (2026-11): the KWin script (`kwin/smbact-kwin.js`).

