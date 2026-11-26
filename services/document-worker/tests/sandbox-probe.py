"""Exercise the actual production sandbox with synthetic probes."""

import errno
import json
import mmap
import os
from pathlib import Path
import socket
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sandbox


def denied(action, expected):
    try:
        action()
    except OSError as failure:
        if failure.errno != expected:
            raise
        return True
    raise AssertionError("The kernel allowed a forbidden action.")


runtime, operation, net_ns, mount_ns, pid_ns, outside = sys.argv[1:]
sandbox.configure(runtime, net_ns, mount_ns, pid_ns)
os.write(2, sandbox.READY)

if operation == "policy":
    os.stat("/usr/bin/pdftotext")
    receipt = {
        "privatePidMountAndNetworkNamespaces": os.getpid() == 1,
        "credentialEnvironmentAbsent": "ASSISTANT_DOCUMENT_WORKER_TOKEN" not in os.environ,
        "outsideSyntheticFileDenied": denied(lambda: os.open(outside, os.O_RDONLY), errno.ENOENT),
        "relativeTraversalDenied": denied(lambda: os.open("/../owner-only", os.O_RDONLY), errno.ENOENT),
        "noProcMountInJail": denied(lambda: os.open("/proc/self/status", os.O_RDONLY), errno.ENOENT),
        "filesystemReadOnly": denied(lambda: os.open("/new", os.O_WRONLY | os.O_CREAT, 0o600), errno.EROFS),
        "ipv4SocketDenied": denied(lambda: socket.socket(socket.AF_INET), errno.EPERM),
        "unixSocketDenied": denied(lambda: socket.socket(socket.AF_UNIX), errno.EPERM),
        "forkDenied": denied(os.fork, errno.EPERM),
        "addressSpaceLimit": denied(lambda: mmap.mmap(-1, 192 * 1024**2), errno.ENOMEM),
    }
    print(json.dumps(receipt), flush=True)
elif operation == "cpu":
    while True:
        pass
elif operation == "delay":
    time.sleep(20)
elif operation == "oversized-output":
    os.write(1, b"0" * (64 * 1024))
else:
    raise AssertionError("Unsupported test operation.")
