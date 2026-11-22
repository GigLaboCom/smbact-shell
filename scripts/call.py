#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Call the SMBAct shell plugin by hand, the way SMBAct does: own com.giglabo.SMBAct on the session bus, then send
com.giglabo.SMBAct.Shell1.Call with a JSON request and print the JSON reply. Needs python3-dbus. Only while SMBAct is
not running (it owns the name then).

    scripts/call.py hello
    scripts/call.py listWindows '{"icons": true}'
    scripts/call.py moveResize '{"id": 123, "x": 100, "y": 100, "width": 800, "height": 600}'
    scripts/call.py --events 10          # print Event signals for 10 seconds
    scripts/call.py --grab '<Control><Alt>j' 30   # hold a hotkey for 30 seconds, print its presses
    scripts/call.py --snapshots /tmp/shots 480       # snapshot every listed window into /tmp/shots, print timings
    scripts/call.py --drag table.json 60 [WxH]        # watch drags against a zone table for 60 s, print the events;
                                                     # with WxH every drag also gets dragRestoreSize W, H
    scripts/call.py --as-stranger hello  # without the name: expect AccessDenied
"""
import json
import sys

import dbus
import dbus.mainloop.glib

DEST, PATH, IFACE, CLIENT = "com.giglabo.SMBAct.Shell", "/com/giglabo/SMBAct/Shell1", "com.giglabo.SMBAct.Shell1", "com.giglabo.SMBAct"


def main(argv):
    stranger = "--as-stranger" in argv
    argv = [a for a in argv if a != "--as-stranger"]
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "--snapshots":
        return snapshots(argv[1] if len(argv) > 1 else "/tmp/smbact-shots", int(argv[2]) if len(argv) > 2 else 480)
    if argv[0] == "--grab":
        return grab(argv[1], int(argv[2]) if len(argv) > 2 else 30)
    if argv[0] == "--drag":
        return drag(argv[1], int(argv[2]) if len(argv) > 2 else 60, argv[3] if len(argv) > 3 else None)
    if argv[0] == "--events":
        from gi.repository import GLib
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        bus = dbus.SessionBus()
        bus.add_signal_receiver(lambda e: print(e, flush=True), "Event", IFACE, None, PATH)
        loop = GLib.MainLoop()
        GLib.timeout_add_seconds(int(argv[1]) if len(argv) > 1 else 10, loop.quit)
        loop.run()
        return 0
    bus = dbus.SessionBus()
    if not stranger:
        got = bus.request_name(CLIENT, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
        if got not in (dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER, dbus.bus.REQUEST_NAME_REPLY_ALREADY_OWNER):
            print(f"cannot own {CLIENT} (is SMBAct running?)", file=sys.stderr)
            return 1
    request = json.loads(argv[1]) if len(argv) > 1 else {}
    request["op"] = argv[0]
    try:
        reply = bus.get_object(DEST, PATH).get_dbus_method("Call", IFACE)(json.dumps(request))
    except dbus.DBusException as e:
        print(json.dumps({"dbusError": e.get_dbus_name(), "message": e.get_dbus_message()}))
        return 1
    print(reply)
    return 0


def snapshots(out_dir, max_size):
    """Requests snapshots of every normal window twice: the first answer is empty (nothing cached), the windows come
    one by one as `snapshot` events; the second answer has them all, fresh."""
    import base64, os, time
    from gi.repository import GLib
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    got = bus.request_name(CLIENT, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
    if got not in (dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER, dbus.bus.REQUEST_NAME_REPLY_ALREADY_OWNER):
        print(f"cannot own {CLIENT} (is SMBAct running?)", file=sys.stderr)
        return 1
    call = bus.get_object(DEST, PATH).get_dbus_method("Call", IFACE)
    req = lambda **r: json.loads(call(json.dumps(r)))
    windows = [w for w in req(op="listWindows")["result"]["windows"] if w["type"] == "normal" and not w["skipTaskbar"]]
    ids = [w["id"] for w in windows]
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.monotonic()
    first = req(op="snapshots", ids=ids, maxSize=max_size, background="#ffffff")
    print(json.dumps({"windows": len(ids), "cached at first": len(first["result"]["snapshots"])}), flush=True)
    arrived = {}
    loop = GLib.MainLoop()

    def on_event(e):
        event = json.loads(e)
        if event.get("type") == "snapshot":
            arrived[event["id"]] = round((time.monotonic() - t0) * 1000)
            if len(arrived) == len(ids):
                loop.quit()

    bus.add_signal_receiver(on_event, "Event", IFACE, None, PATH)
    GLib.timeout_add_seconds(20, loop.quit)
    loop.run()
    second = req(op="snapshots", ids=ids, maxSize=max_size, background="#ffffff")["result"]["snapshots"]
    for snap in second:
        title = next((w["title"] for w in windows if w["id"] == snap["id"]), "?")
        path = os.path.join(out_dir, f"{snap['id']}.jpg")
        data = base64.b64decode(snap["data"])
        open(path, "wb").write(data)
        print(json.dumps({"id": snap["id"], "title": title[:40], "size": [snap["width"], snap["height"]],
                          "kb": round(len(data) / 1024, 1), "fresh": snap["fresh"], "at_ms": arrived.get(snap["id"])}))
    return 0


def grab(accelerator, seconds):
    """Grabs belong to the owner of com.giglabo.SMBAct: keep the name (and the grab) while listening."""
    from gi.repository import GLib
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    got = bus.request_name(CLIENT, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
    if got not in (dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER, dbus.bus.REQUEST_NAME_REPLY_ALREADY_OWNER):
        print(f"cannot own {CLIENT} (is SMBAct running?)", file=sys.stderr)
        return 1
    call = bus.get_object(DEST, PATH).get_dbus_method("Call", IFACE)
    reply = json.loads(call(json.dumps({"op": "grabAccelerator", "accelerator": accelerator})))
    print(json.dumps(reply), flush=True)
    if not reply.get("ok"):
        return 1

    def on_event(e):
        event = json.loads(e)
        if event.get("type") == "accelerator":
            print(json.dumps(event), flush=True)

    bus.add_signal_receiver(on_event, "Event", IFACE, None, PATH)
    loop = GLib.MainLoop()
    GLib.timeout_add_seconds(seconds, loop.quit)
    loop.run()
    print(call(json.dumps({"op": "ungrabAccelerator", "accelerator": accelerator})), flush=True)
    return 0


def drag(table_file, seconds, restore):
    """The drag watch belongs to the owner of com.giglabo.SMBAct: keep the name while listening, stop the watch after."""
    import time
    from gi.repository import GLib
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    got = bus.request_name(CLIENT, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
    if got not in (dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER, dbus.bus.REQUEST_NAME_REPLY_ALREADY_OWNER):
        print(f"cannot own {CLIENT} (is SMBAct running?)", file=sys.stderr)
        return 1
    call = bus.get_object(DEST, PATH).get_dbus_method("Call", IFACE)
    with open(table_file) as f:
        table = json.load(f)
    print(call(json.dumps({"op": "dragWatch", "table": table})), flush=True)
    size = [int(v) for v in restore.split("x")] if restore else None
    t0 = time.monotonic()

    def on_event(e):
        event = json.loads(e)
        if event.get("type") != "drag":
            return
        d = event["event"]
        print(json.dumps({"at_ms": round((time.monotonic() - t0) * 1000), **d}), flush=True)
        if size and d.get("type") == "begin":
            print(call(json.dumps({"op": "dragRestoreSize", "drag": d["drag"], "width": size[0], "height": size[1]})), flush=True)

    bus.add_signal_receiver(on_event, "Event", IFACE, None, PATH)
    loop = GLib.MainLoop()
    GLib.timeout_add_seconds(seconds, loop.quit)
    loop.run()
    print(call(json.dumps({"op": "dragWatch", "table": None})), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
