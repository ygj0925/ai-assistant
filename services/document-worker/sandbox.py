"""Configure the disposable Linux namespace before executing one fixed Poppler command."""

import ctypes
import errno
import os
import resource
import sys

READY = b"document-sandbox-ready\n"
STARTUP_FAILURE = 78
COMMANDS = {
    "info": ("/usr/bin/pdfinfo", "-enc", "UTF-8", "-"),
    "text": (
        "/usr/bin/pdftotext",
        "-enc", "UTF-8", "-eol", "unix", "-f", "1", "-l", "8", "-nopgbrk", "-", "-",
    ),
    "images": ("/usr/bin/pdfimages", "-f", "1", "-l", "1", "-list", "-"),
    "raster": (
        "/usr/bin/pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-gray",
        "-scale-to", "1024", "-",
    ),
}
OCR_LANGUAGES = ("chi_sim", "eng")
OCR_COMMANDS = {
    "ocr-" + language: (
        "/usr/bin/tesseract", "stdin", "stdout", "--tessdata-dir", "/tessdata",
        "-l", language, "--oem", "1", "--psm", "6",
    )
    for language in OCR_LANGUAGES
}

_MS_RDONLY = 1
_MS_NOSUID = 2
_MS_NODEV = 4
_MS_REMOUNT = 32
_MS_BIND = 4096
_PR_CAPBSET_DROP = 24
_PR_SET_NO_NEW_PRIVS = 38
_PR_GET_NO_NEW_PRIVS = 39
_PR_CAP_AMBIENT = 47
_PR_CAP_AMBIENT_CLEAR_ALL = 4
_LINUX_CAPABILITY_VERSION_3 = 0x20080522
_SCMP_ACT_ALLOW = 0x7FFF0000
_SCMP_ACT_EPERM = 0x00050000 | errno.EPERM

_DENIED_SYSCALLS = (
    "socket", "socketcall", "socketpair", "connect", "bind", "listen", "accept", "accept4",
    "sendto", "sendmsg", "sendmmsg", "recvfrom", "recvmsg", "recvmmsg", "shutdown",
    "mount", "umount2", "pivot_root", "chroot", "unshare", "setns", "move_mount",
    "fsopen", "fsconfig", "fsmount", "fspick", "open_tree", "mount_setattr",
    "clone", "clone3", "fork", "vfork", "ptrace", "process_vm_readv", "process_vm_writev",
    "bpf", "io_uring_setup", "pidfd_getfd", "open_by_handle_at",
)


def _require(condition):
    if not condition:
        raise RuntimeError("Sandbox initialization failed.")


def _restrict_syscalls(seccomp):
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p,
    ]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    policy = seccomp.seccomp_init(_SCMP_ACT_ALLOW)
    _require(policy is not None)
    try:
        for name in _DENIED_SYSCALLS:
            number = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number >= 0:
                _require(seccomp.seccomp_rule_add_array(policy, _SCMP_ACT_EPERM, number, 0, None) == 0)
        _require(seccomp.seccomp_load(policy) == 0)
    finally:
        seccomp.seccomp_release(policy)


def _drop_capabilities(libc, last_capability):
    for capability in range(last_capability + 1):
        _require(libc.prctl(_PR_CAPBSET_DROP, capability, 0, 0, 0) == 0)
    _require(libc.prctl(_PR_CAP_AMBIENT, _PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) == 0)
    header = (ctypes.c_uint32 * 2)(_LINUX_CAPABILITY_VERSION_3, 0)
    empty = (ctypes.c_uint32 * 6)()
    _require(libc.capset(ctypes.byref(header), ctypes.byref(empty)) == 0)
    _require(libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0)
    _require(libc.prctl(_PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1)
    _require(libc.capget(ctypes.byref(header), ctypes.byref(empty)) == 0 and not any(empty))


def configure(root, caller_network_ns, caller_mount_ns, caller_pid_ns):
    """Verify namespace isolation, restrict filesystem access and drop capabilities."""
    _require(os.getpid() == 1 and os.getuid() == 0)
    for name, caller in (("net", caller_network_ns), ("mnt", caller_mount_ns), ("pid", caller_pid_ns)):
        _require(os.readlink("/proc/self/ns/" + name) != caller)
    with open("/proc/net/route", encoding="ascii") as routes:
        _require(all(line.startswith("Iface") for line in routes))
    with open("/proc/net/dev", encoding="ascii") as interfaces:
        _require([line.split(":", 1)[0].strip() for line in list(interfaces)[2:]] == ["lo"])
    with open("/proc/sys/kernel/cap_last_cap", encoding="ascii") as max_capability:
        last_capability = int(max_capability.read())

    libc = ctypes.CDLL(None, use_errno=True)
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    libc.mount.restype = ctypes.c_int
    target = os.fsencode(root)
    _require(libc.mount(target, target, None, _MS_BIND, None) == 0)
    readonly = _MS_RDONLY | _MS_NOSUID | _MS_NODEV | _MS_REMOUNT | _MS_BIND
    _require(libc.mount(None, target, None, readonly, None) == 0)
    os.chroot(root)
    os.chdir("/")
    # Popen has already closed all unrelated handles. Clear the remaining nonstandard descriptors.
    descriptor_limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    if descriptor_limit != resource.RLIM_INFINITY:
        os.closerange(3, descriptor_limit)
    os.environ.clear()
    os.environ.update(LANG="C.UTF-8", LC_ALL="C.UTF-8", HOME="/", FONTCONFIG_PATH="/etc/fonts")
    os.umask(0o077)
    _drop_capabilities(libc, last_capability)
    _restrict_syscalls(seccomp)

    for limit, maximum in (
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_AS, 128 * 1024**2),
        (resource.RLIMIT_CPU, 1),
        (resource.RLIMIT_NOFILE, 32),
        (resource.RLIMIT_FSIZE, 65536),
    ):
        resource.setrlimit(limit, (maximum, maximum))


if __name__ == "__main__":
    try:
        runtime, operation, *namespaces = sys.argv[1:]
        configure(runtime, *namespaces)
        if operation in OCR_COMMANDS:
            language = operation.removeprefix("ocr-")
            _require(os.access("/tessdata/" + language + ".traineddata", os.R_OK))
            os.environ.update(OMP_THREAD_LIMIT="1", OMP_NUM_THREADS="1")
            command = OCR_COMMANDS[operation]
        else:
            command = COMMANDS[operation]
        os.write(2, READY)
        os.execve(command[0], command, dict(os.environ))
    except (OSError, RuntimeError, ValueError, KeyError, TypeError):
        sys.exit(STARTUP_FAILURE)
