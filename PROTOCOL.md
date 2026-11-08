# Protocol: `com.giglabo.SMBAct.Shell1`, API 1

How SMBAct talks to its shell plugins. The GNOME Shell extension implements it today; a KWin script will
implement the same operations. SMBAct (a separate program) is the only intended client.

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
(`grabAccelerator`: the shell refused the accelerator), `FAILED` (the shell threw; `message` has its text).

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

## History

- API 1 (2026-11): window list, geometry, activation, states, close, displays, pointer, events.
- API 1, plugin 1.0.0-alpha.2 (2026-11): `grabAccelerator`, `ungrabAccelerator`, the `accelerator` event (new
  operations, same API; clients look for them in `hello`'s `ops`).
