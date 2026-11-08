#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Call the SMBAct shell plugin by hand, the way SMBAct does: own com.giglabo.SMBAct on the session bus, then send
com.giglabo.SMBAct.Shell1.Call with a JSON request and print the JSON reply. Needs python3-dbus. Only while SMBAct is
not running (it owns the name then).

    scripts/call.py hello
    scripts/call.py listWindows '{"icons": true}'
    scripts/call.py moveResize '{"id": 123, "x": 100, "y": 100, "width": 800, "height": 600}'
    scripts/call.py --events 10          # print Event signals for 10 seconds
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


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
