# smbact-shell

Shell plugins for SMBAct, the window management app: a GNOME Shell extension now,
a KWin script later. On a Wayland session only the compositor knows every window, so SMBAct asks it through these
plugins: the window list, moving and resizing, activation, window states, displays.

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

## Releases

A tag `vX.Y.Z` (equal to `version-name` in `metadata.json`) makes GitHub Actions publish
`smbact@giglabo.com.shell-extension.zip` and `SHA256SUMS` as a release. SMBAct pins a tag and checks the sha256.
Every push to `main` and every pull request runs the checks and packs the zip (`.github/workflows/`).

## License

GPL-2.0-or-later (see [LICENSE](LICENSE)). SMBAct itself is a separate program that talks to these plugins over
D-Bus.
