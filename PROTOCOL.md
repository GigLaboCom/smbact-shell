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
(`grabAccelerator`: the shell refused the accelerator), `NO_SNAPSHOT` (`snapshot`: none taken yet), `FAILED` (the
shell threw; `message` has its text).

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
| `displays` | | `{ monitors: [{ index, geometry, workArea, scale, primary }] }` |
| `iconPng` | `path` (an `icon` path), `size?` (px, default 48) | `{ png, width, height }` (`png`: base64 PNG bytes) |
| `pointer` | | `{ x, y }` |
| `grabAccelerator` | `accelerator` (GTK notation, `<Control><Alt>x`) | `{ accelerator, action }` |
| `ungrabAccelerator` | `accelerator` (as grabbed) | `{ released }` |
| `snapshots` | `ids`, `maxSize?` (px, default 480, at most 1024), `background?` (`#rrggbb`, default white) | `{ snapshots: Snapshot[] }` (the cached ones) |
| `snapshot` | `id` | `{ snapshot }` |

- `setState` states: `minimized`, `maximized`, `maximizedHorizontally`, `maximizedVertically`, `fullscreen`,
  `above`.
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

## Events

`Event` carries `{ "type": ..., ... }`:

- `windowsChanged`: a window appeared, went away, moved, resized or changed state (coalesced, at most every 100 ms).
- `focusChanged` with `id` (or `null`).
- `accelerator` with `accelerator` (the string given to `grabAccelerator`) and `time` (the key press's timestamp,
  usable as `activate`'s `time`).
- `snapshot` with `id`: a snapshot asked for with `snapshots` is ready.

## History

- API 1 (2026-11): window list, geometry, activation, states, close, displays, pointer, events.
- API 1, plugin 1.0.0-alpha.2 (2026-11): `grabAccelerator`, `ungrabAccelerator`, the `accelerator` event (new
  operations, same API; clients look for them in `hello`'s `ops`).
- API 1, plugin 1.0.0-alpha.3 (2026-11): `snapshots`, `snapshot`, the `snapshot` event.
- API 1, plugin 2.0.0 (2026-11): the first full release, with SMBAct 2.0.0; the same API as 1.0.0-alpha.3.

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
server's own list). Window ids are the first 32 bits of KWin's UUID for the window (stable across reloads).

- API 1, plugin 1.0.0-alpha.3 (2026-11): the KWin script (`kwin/smbact-kwin.js`).

