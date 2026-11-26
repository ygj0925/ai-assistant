"""Authenticated loopback broker for bounded PDF text extraction on Linux."""

import argparse
import hmac
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time
import unicodedata
from http import HTTPStatus

from sandbox import OCR_LANGUAGES, READY, STARTUP_FAILURE

INPUT_LIMIT = 32 * 1024
TEXT_LIMIT = 4 * 1024
_HEADER_LIMIT = 4096
_INFO_LIMIT = 8192
_DIAGNOSTIC_LIMIT = 4096
_RASTER_EDGE = 1024
_RASTER_LIMIT = _RASTER_EDGE**2 + 64
_READ_SECONDS = 1.5
_PARSE_SECONDS = 2.5
_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
_HEADER_NAME = re.compile(r"[A-Za-z0-9-]+\Z")
_HEADER_VALUE = re.compile(r"[ -~]*\Z")
_LENGTH = re.compile(r"(?:0|[1-9][0-9]{0,8})\Z")
_PDF = re.compile(br"\A%PDF-(?:1\.[0-7]|2\.0)(?:\r\n?|\n)")
_PDF_TAIL = re.compile(
    br"(?:\r\n?|\n)startxref[ \t]{0,16}(?:\r\n?|\n)"
    br"[ \t]{0,16}([0-9]{1,5})[ \t]{0,16}(?:\r\n?|\n)%%EOF[ \t\r\n]{0,128}\Z"
)
_XREF_TABLE = re.compile(br"xref[ \t]*(?:\r\n?|\n)[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*(?:\r\n?|\n)")
_OBJECT_START = re.compile(br"[1-9][0-9]{0,9}[ \t]+[0-9]{1,5}[ \t]+obj[ \t\r\n]+<<")
_STREAM_START = re.compile(br"(?<=[\r\n \t>])stream(?:\r\n?|\n)")
_XREF_TYPE = re.compile(br"/Type[ \t\r\n]+/XRef(?=[ \t\r\n/>])")
_PAGE_SIZE = re.compile(br"([0-9]{1,4}(?:\.[0-9]+)?) x ([0-9]{1,4}(?:\.[0-9]+)?) pts(?: \([A-Za-z0-9 -]+\))?")
_RASTER_HEADER = re.compile(br"P5\n([1-9][0-9]{0,3}) ([1-9][0-9]{0,3})\n255\n")
_OCR_STARTUP_ERRORS = (b"error opening data file", b"failed loading language", b"could not initialize tesseract")
_RUNTIME_MARKER = ".document-worker-runtime-v1"
_RUNTIME_CONTENTS = {"etc", "fonts", "lib", "lib64", "usr", _RUNTIME_MARKER}
_SANDBOX = Path(__file__).resolve().with_name("sandbox.py")


class InvalidDocument(Exception):
    """The document has no supported text within the limits."""


class SandboxUnavailable(Exception):
    """The kernel sandbox or its allowed runtime could not start."""


class RequestError(Exception):
    def __init__(self, status):
        self.status = status


def canonical_text(raw):
    if not raw or len(raw) > TEXT_LIMIT:
        raise InvalidDocument()
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeError as failure:
        raise InvalidDocument() from failure
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    text = unicodedata.normalize("NFC", text)
    if not text.strip() or any(
        char != "\n" and (unicodedata.category(char) in {"Cc", "Cf", "Cs"} or char in "\u2028\u2029")
        for char in text
    ):
        raise InvalidDocument()
    canonical = (text.rstrip("\n") + "\n").encode("utf-8")
    if len(canonical) > TEXT_LIMIT:
        raise InvalidDocument()
    return canonical


def _command(runtime, operation):
    return (
        "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--propagation", "private",
        "--net", "--pid", "--fork", "--kill-child", "--mount-proc",
        "/usr/bin/python3", "-I", "-B", str(_SANDBOX), str(runtime), operation,
        *(os.readlink("/proc/self/ns/" + name) for name in ("net", "mnt", "pid")),
    )


def _available(deadline):
    return max(0, deadline - time.monotonic())


def _process_output(child, content, limit, deadline, startup_errors=()):
    stdout, stderr = bytearray(), bytearray()
    offset = 0
    with selectors.DefaultSelector() as events:
        for pipe, (mask, payload) in (
            (child.stdin, (selectors.EVENT_WRITE, None)),
            (child.stdout, (selectors.EVENT_READ, stdout)),
            (child.stderr, (selectors.EVENT_READ, stderr)),
        ):
            os.set_blocking(pipe.fileno(), False)
            events.register(pipe, mask, payload)
        while events.get_map():
            remaining = _available(deadline)
            if remaining == 0:
                raise (InvalidDocument if stderr.startswith(READY) else SandboxUnavailable)()
            for item, mask in events.select(remaining):
                if mask == selectors.EVENT_WRITE:
                    try:
                        offset += os.write(item.fd, content[offset:offset + 4096])
                    except BrokenPipeError:
                        offset = len(content)
                    if offset == len(content):
                        events.unregister(item.fileobj)
                        item.fileobj.close()
                    continue
                chunk = os.read(item.fd, 4096)
                if not chunk:
                    events.unregister(item.fileobj)
                    continue
                data = item.data
                cap = limit if data is stdout else _DIAGNOSTIC_LIMIT
                if len(data) + len(chunk) > cap:
                    raise InvalidDocument()
                data.extend(chunk)
    try:
        status = child.wait(timeout=_available(deadline))
    except subprocess.TimeoutExpired as failure:
        raise InvalidDocument() from failure
    if not stderr.startswith(READY) or status == STARTUP_FAILURE:
        raise SandboxUnavailable()
    diagnostic = stderr[len(READY):].lower()
    if any(error in diagnostic for error in startup_errors):
        raise SandboxUnavailable()
    if status != 0 or b"syntax error" in diagnostic or b"syntax warning" in diagnostic:
        raise InvalidDocument()
    return bytes(stdout)


def _run(runtime, operation, content, limit, deadline):
    startup_errors = _OCR_STARTUP_ERRORS if operation.startswith("ocr-") else ()
    try:
        with subprocess.Popen(
            _command(runtime, operation),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            close_fds=True, start_new_session=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        ) as child:
            try:
                return _process_output(child, content, limit, deadline, startup_errors)
            finally:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
    except OSError as failure:
        raise SandboxUnavailable() from failure


def _information(info, field):
    rows = [row[len(field):].strip() for row in info.splitlines() if row.startswith(field)]
    if len(rows) != 1:
        raise InvalidDocument()
    return rows[0]


def _has_pdf_envelope(content):
    header = _PDF.match(content)
    if header is None:
        return False
    tail_start = max(0, len(content) - 256)
    tail = _PDF_TAIL.search(content, tail_start)
    if tail is None:
        return False
    offset = int(tail.group(1))
    if not header.end() <= offset < tail.start():
        return False
    pointer = content[offset:min(tail.start(), offset + 8192)]
    if _XREF_TABLE.match(pointer):
        return True
    obj = _OBJECT_START.match(pointer)
    stream = _STREAM_START.search(pointer)
    return bool(obj and stream and _XREF_TYPE.search(pointer, obj.end(), stream.start()))


def _require_scan(info, inventory):
    dimensions = _PAGE_SIZE.fullmatch(_information(info, b"Page size:"))
    if dimensions is None or _information(info, b"Page rot:") != b"0":
        raise InvalidDocument()
    page_width, page_height = (float(value) for value in dimensions.groups())
    if not all(48 <= value <= 4096 for value in (page_width, page_height)):
        raise InvalidDocument()
    rows = inventory.splitlines()
    if len(rows) != 3 or not rows[0].startswith(b"page") or set(rows[1].strip()) != {45}:
        raise InvalidDocument()
    fields = rows[2].split()
    if (
        len(fields) != 16 or fields[:3] != [b"1", b"0", b"image"]
        or fields[5:7] not in ([b"gray", b"1"], [b"rgb", b"3"]) or fields[7] != b"8"
    ):
        raise InvalidDocument()
    measures = (fields[3], fields[4], fields[12], fields[13])
    if not all(value.isdigit() and len(value) <= 4 for value in measures):
        raise InvalidDocument()
    width, height, x_ppi, y_ppi = map(int, measures)
    if not (128 <= width <= 4096 and 128 <= height <= 4096 and x_ppi and y_ppi):
        raise InvalidDocument()
    projected = (72 * width / x_ppi / page_width, 72 * height / y_ppi / page_height)
    if not all(0.9 <= ratio <= 1.1 for ratio in projected):
        raise InvalidDocument()


def _validate_raster(raster):
    header = _RASTER_HEADER.match(raster)
    if header is None:
        raise InvalidDocument()
    width, height = map(int, header.groups())
    if width > _RASTER_EDGE or height > _RASTER_EDGE or len(raster) - header.end() != width * height:
        raise InvalidDocument()


def extract(runtime, content, ocr_language=None):
    if not content or len(content) > INPUT_LIMIT or not _has_pdf_envelope(content):
        raise InvalidDocument()
    deadline = time.monotonic() + _PARSE_SECONDS
    info = _run(runtime, "info", content, _INFO_LIMIT, deadline)
    pages = _information(info, b"Pages:")
    if pages not in (b"1", b"2", b"3", b"4", b"5", b"6", b"7", b"8"):
        raise InvalidDocument()
    if _information(info, b"Encrypted:") != b"no" or _information(info, b"JavaScript:") != b"no":
        raise InvalidDocument()
    embedded = _run(runtime, "text", content, TEXT_LIMIT, deadline)
    if embedded.strip():
        return canonical_text(embedded), False
    if ocr_language is None or pages != b"1":
        raise InvalidDocument()
    inventory = _run(runtime, "images", content, _INFO_LIMIT, deadline)
    _require_scan(info, inventory)
    raster = _run(runtime, "raster", content, _RASTER_LIMIT, deadline)
    _validate_raster(raster)
    return canonical_text(_run(runtime, "ocr-" + ocr_language, raster, TEXT_LIMIT, deadline)), True


def _receive(peer, length, deadline):
    remaining = _available(deadline)
    if remaining == 0:
        raise RequestError(HTTPStatus.REQUEST_TIMEOUT)
    peer.settimeout(remaining)
    try:
        chunk = peer.recv(length)
    except TimeoutError as failure:
        raise RequestError(HTTPStatus.REQUEST_TIMEOUT) from failure
    if not chunk:
        raise RequestError(HTTPStatus.BAD_REQUEST)
    return chunk


def _read_headers(peer, deadline):
    initial = bytearray()
    while (end := initial.find(b"\r\n\r\n")) < 0:
        remaining = _HEADER_LIMIT + 4 - len(initial)
        if remaining <= 0:
            raise RequestError(HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE)
        initial.extend(_receive(peer, min(1024, remaining), deadline))
    try:
        lines = initial[:end].decode("ascii").split("\r\n")
    except UnicodeError as failure:
        raise RequestError(HTTPStatus.BAD_REQUEST) from failure
    fields = {}
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        key = name.lower()
        if (
            not separator or _HEADER_NAME.fullmatch(name) is None
            or _HEADER_VALUE.fullmatch(value) is None or key in fields
        ):
            raise RequestError(HTTPStatus.BAD_REQUEST)
        fields[key] = value.strip(" ")
    return lines[0], fields, initial[end + 4:]


def _read_request(peer, authority, token):
    deadline = time.monotonic() + _READ_SECONDS
    target, fields, content = _read_headers(peer, deadline)
    if target != "POST /extract HTTP/1.1":
        raise RequestError(HTTPStatus.NOT_FOUND)
    if fields.get("host") != authority or any(
        name in fields for name in
        ("transfer-encoding", "content-encoding", "expect", "upgrade", "trailer")
    ):
        raise RequestError(HTTPStatus.BAD_REQUEST)
    secret = fields.get("authorization", "")
    if not secret.startswith("Bearer ") or not hmac.compare_digest(secret[7:], token):
        raise RequestError(HTTPStatus.UNAUTHORIZED)
    encoded_length = fields.get("content-length", "")
    if _LENGTH.fullmatch(encoded_length) is None:
        raise RequestError(HTTPStatus.BAD_REQUEST)
    size = int(encoded_length)
    if size > INPUT_LIMIT:
        raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    if size == 0:
        raise RequestError(HTTPStatus.UNPROCESSABLE_ENTITY)
    if fields.get("content-type") != "application/pdf":
        raise RequestError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
    if len(content) > size:
        raise RequestError(HTTPStatus.BAD_REQUEST)
    while len(content) < size:
        content.extend(_receive(peer, size - len(content), deadline))
    return bytes(content), fields.get("x-assistant-allow-ocr") == "true"


def _reply(peer, status, content=b"", ocr=False):
    headers = (
        f"HTTP/1.1 {status.value} {status.phrase}\r\n"
        f"Content-Length: {len(content)}\r\n"
        "Cache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "Connection: close\r\n"
    )
    if status == HTTPStatus.OK:
        headers += "Content-Type: text/plain; charset=UTF-8\r\n"
        if ocr:
            headers += "X-Assistant-Text-Source: ocr\r\n"
    peer.settimeout(0.75)
    peer.sendall(headers.encode("ascii") + b"\r\n" + content)


def _handle(peer, authority, token, runtime, ocr_language):
    try:
        content, allow_ocr = _read_request(peer, authority, token)
        canonical, ocr = extract(runtime, content, ocr_language if allow_ocr else None)
    except RequestError as failure:
        _reply(peer, failure.status)
    except InvalidDocument:
        _reply(peer, HTTPStatus.UNPROCESSABLE_ENTITY)
    except SandboxUnavailable:
        _reply(peer, HTTPStatus.SERVICE_UNAVAILABLE)
    else:
        _reply(peer, HTTPStatus.OK, canonical, ocr)


def _trusted_runtime(root, ocr_language=None):
    owner = os.getuid()
    if not root.is_absolute() or root.resolve(strict=True) != root or owner == 0:
        raise ValueError("Use a dedicated private Linux runtime directory as an ordinary user.")
    contents = {child.name for child in root.iterdir()}
    if not _RUNTIME_CONTENTS <= contents <= _RUNTIME_CONTENTS | {"tessdata"}:
        raise ValueError("The dedicated document runtime layout is invalid.")
    for directory, subdirs, files in os.walk(root, followlinks=False):
        paths = [Path(directory), *(Path(directory) / entry for entry in (*subdirs, *files))]
        for path in paths:
            properties = path.lstat()
            if (
                properties.st_uid != owner or properties.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
                or not (stat.S_ISDIR(properties.st_mode) or stat.S_ISREG(properties.st_mode))
                or stat.S_ISREG(properties.st_mode) and properties.st_nlink != 1
            ):
                raise ValueError("The runtime contains an untrusted file or directory.")
    tools = ("pdftotext", "pdfinfo")
    if ocr_language is not None:
        tools += ("pdfimages", "pdftoppm", "tesseract")
        data = root / "tessdata"
        expected = ocr_language + ".traineddata"
        if not data.is_dir() or {item.name for item in data.iterdir()} != {expected}:
            raise ValueError("The single configured OCR model is missing.")
        if not (data / expected).is_file():
            raise ValueError("The OCR runtime data is invalid.")
    for executable in tools:
        if not os.access(root / "usr/bin" / executable, os.X_OK):
            raise ValueError("Required Poppler runtime is missing.")
    return root


def serve(port, token, runtime, ocr_language=None):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(4)
        print(f"Document worker listening on 127.0.0.1:{port}", flush=True)
        while True:
            peer, _ = listener.accept()
            with peer:
                try:
                    _handle(peer, f"127.0.0.1:{port}", token, runtime, ocr_language)
                except OSError:
                    # Network disconnects carry no document or credential diagnostics.
                    continue


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--ocr-language", choices=OCR_LANGUAGES)
    options = parser.parse_args()
    token = os.environ.pop("ASSISTANT_DOCUMENT_WORKER_TOKEN", "")
    if sys.platform != "linux" or platform.machine() != "x86_64":
        parser.error("This worker requires a Linux x86-64 host.")
    if not 1024 <= options.port <= 65535 or _TOKEN.fullmatch(token) is None:
        parser.error("Configure an unprivileged port and a 32–128 character worker token.")
    try:
        runtime = _trusted_runtime(options.runtime_root, options.ocr_language)
        serve(options.port, token, runtime, options.ocr_language)
    except (OSError, ValueError):
        parser.error("The worker could not start with the configured private runtime.")
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
