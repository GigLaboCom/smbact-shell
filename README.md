# smbact-shell

Shell plugins for SMBAct, the window management app: a GNOME Shell extension and a KWin script (KDE Plasma 6). On a
Wayland session only the compositor knows every window, so SMBAct asks it through these plugins: the window list,
moving and resizing, activation, window states, displays; on GNOME also global hotkeys, window snapshots and the window
drags SMBAct places with the mouse.

The plugins are thin executors. They hold no product logic and do nothing on their own; SMBAct installs them and
calls them over D-Bus. The protocol is in [PROTOCOL.md](PROTOCOL.md).

## GNOME Shell extension

`gnome-shell/smbact@giglabo.com/` — GNOME Shell 46 to 51.

SMBAct installs it for you. By hand:

```bash
scripts/pack.sh
gnome-extensions install --force dist/smbact@giglabo.com.shell-extension.zip
gnome-extensions enable smbact@giglabo.com
```

On Wayland a newly installed or updated extension starts after you log out and back in.

Only SMBAct may call it: the extension answers the current owner of the D-Bus name `com.giglabo.SMBAct` and refuses
everyone else.

## KWin script

`kwin/smbact-kwin.js` — KDE Plasma 6 (checked on Plasma 6.6). SMBAct loads it into KWin itself when it starts
(`org.kde.KWin` `/Scripting`), nothing to install and no new login; it unloads it when it quits. A KWin script cannot
serve D-Bus calls, so the script calls SMBAct instead (PROTOCOL.md, "KWin transport"); it answers only to KWin.

By hand, with something serving `com.giglabo.SMBAct.KWin1` (SMBAct does):

```bash
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$PWD/kwin/smbact-kwin.js" smbact
qdbus6 org.kde.KWin /Scripting/Script<id> org.kde.kwin.Script.run
```

## Releases

A tag `vX.Y.Z` (equal to `version-name` in `metadata.json`; `vX.Y.Z-alpha.N`, `-beta.N`, `-rc.N` become pre-releases) makes GitHub Actions publish
`smbact@giglabo.com.shell-extension.zip`, `smbact-kwin.js` and `SHA256SUMS` as a release (the KWin script's `VERSION`
must match too). SMBAct pins a tag and checks the sha256 of both.
Every push to `main` and every pull request runs the checks and the tests and packs the zip (`.github/workflows/`).

## Tests

`node --test tests/*.test.mjs`: the drag hit-test (`gnome-shell/smbact@giglabo.com/hitTest.js`) against SMBAct's shared
fixtures (`tests/fixtures/`, see its README for where they come from). The rest is checked live in SMBAct's GNOME test
VM (smbact-app `scripts/dev/linux/drag-snap/gnome/`). By hand: `scripts/call.py --drag table.json 60` prints the drag
events against a zone table.

## License

GPL-2.0-or-later (see [LICENSE](LICENSE)). SMBAct itself is a separate program that talks to these plugins over
D-Bus.
