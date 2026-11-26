import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
import worker


def pdf_fixture(count, text=None, script=False, xref_stream=False):
    """Construct small compressed text PDF pages without bringing in any real files."""
    catalog = b"<< /Type /Catalog /Pages 2 0 R"
    if script:
        catalog += br" /Names << /JavaScript << /Names [(qa) << /S /JavaScript /JS (void\(0\)) >>] >> >>"
    objects = [
        catalog + b" >>",
        b"<< /Type /Pages /Count %d /Kids [%s] >>" % (
            count, b" ".join(b"%d 0 R" % (4 + 2 * i) for i in range(count))
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index in range(count):
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> "
            b"/MediaBox [0 0 300 400] /Contents %d 0 R >>" % (5 + 2 * index)
        )
        label = text if text is not None else b"Synthetic compressed page %d" % (index + 1)
        objects.append(flate_stream(b"BT /F1 12 Tf 30 350 Td (" + label + b") Tj ET\n"))
    return pdf_bytes(objects, xref_stream=xref_stream)


def flate_stream(payload, properties=b""):
    stream = zlib.compress(payload)
    return (
        b"<< " + properties + b"/Length %d /Filter /FlateDecode >>\nstream\n" % len(stream)
        + stream + b"\nendstream"
    )


def unicode_pdf_fixture():
    cmap = b"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Synthetic def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
3 beginbfchar
<0001> <4E2D>
<0002> <6587>
<0003> <00650301>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""
    page = (
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> "
        b"/MediaBox [0 0 300 400] /Contents %d 0 R >>"
    )
    return pdf_bytes([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 2 /Kids [3 0 R 9 0 R] >>",
        page % 8,
        b"<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H "
        b"/DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        b"/FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 500 >>",
        flate_stream(cmap),
        b"<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 4 /FontBBox [0 -250 1100 900] "
        b"/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 740 /StemV 80 >>",
        flate_stream(b"BT /F1 16 Tf 30 350 Td <00010002> Tj ET\n"),
        page % 10,
        flate_stream(b"BT /F1 16 Tf 30 350 Td <0003> Tj ET\n"),
    ])


def pdf_bytes(objects, xref_stream=False):
    content = bytearray(b"%PDF-1.7\n%\xc2\xe5\xe4\xe9\n")
    offsets = []
    for number, entry in enumerate(objects, 1):
        offsets.append(len(content))
        content.extend(b"%d 0 obj\n" % number + entry + b"\nendobj\n")
    xref = len(content)
    if xref_stream:
        stream_id = len(objects) + 1
        entries = b"\x00\x00\x00\x00\x00\xff\xff" + b"".join(
            b"\x01" + offset.to_bytes(4, "big") + b"\x00\x00" for offset in (*offsets, xref)
        )
        properties = b"/Type /XRef /Size %d /Root 1 0 R /W [1 4 2] " % (stream_id + 1)
        content.extend(b"%d 0 obj\n" % stream_id + flate_stream(entries, properties) + b"\nendobj\n")
    else:
        content.extend(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
        for offset in offsets:
            content.extend(b"%010d 00000 n \n" % offset)
        content.extend(b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1))
    content.extend(
        b"startxref\n%d\n%%%%EOF\n" % xref
    )
    return bytes(content)


class CanonicalTextTest(unittest.TestCase):
    def test_normalizes_encoding_without_interpreting_html(self):
        source = "中文\tCafe\u0301\r\n<literal>\r\n\n".encode("utf-8")
        self.assertEqual(worker.canonical_text(source), "中文 Café\n<literal>\n".encode("utf-8"))

    def test_rejects_invalid_controls_empty_and_output_overflows(self):
        for payload in (
            b"", b" \t\r\n", b"\xff", b"A\x00B", b"A\x0cB", "a\u202eb".encode("utf-8"),
            "a\u2029b".encode("utf-8"), b"x" * 4096, b"x" * 4097,
        ):
            with self.subTest(payload_size=len(payload)):
                with self.assertRaises(worker.InvalidDocument):
                    worker.canonical_text(payload)
        self.assertEqual(len(worker.canonical_text(b"x" * 4095 + b"\n")), 4096)


class RequestFramingTest(unittest.TestCase):
    authority = "127.0.0.1:18217"
    token = "Q" * 43

    def check(self, raw, status):
        client, server = socket.socketpair()
        with client, server:
            client.sendall(raw)
            client.shutdown(socket.SHUT_WR)
            with self.assertRaises(worker.RequestError) as failure:
                worker._read_request(server, self.authority, self.token)
            self.assertEqual(failure.exception.status, status)

    def request(self, extra=b"", *, mime=b"application/pdf", declared=3, auth=True):
        value = b"POST /extract HTTP/1.1\r\nHost: " + self.authority.encode()
        if auth:
            value += b"\r\nAuthorization: Bearer " + self.token.encode()
        return (
            value + b"\r\nContent-Type: " + mime + b"\r\nContent-Length: %d" % declared
            + extra + b"\r\n\r\nraw"
        )

    def test_accepts_one_bounded_exact_http11_body(self):
        client, server = socket.socketpair()
        with client, server:
            client.sendall(self.request())
            self.assertEqual(worker._read_request(server, self.authority, self.token), (b"raw", False))

    def test_ocr_negotiates_only_one_exact_opt_in_value(self):
        for value, expected in ((b"true", True), (b"True", False), (b"false", False), (b"true, false", False)):
            client, server = socket.socketpair()
            with client, server:
                client.sendall(self.request(b"\r\nX-Assistant-Allow-OCR: " + value))
                self.assertEqual(worker._read_request(server, self.authority, self.token), (b"raw", expected))
        self.check(self.request(b"\r\nX-Assistant-Allow-OCR: true\r\nx-assistant-allow-ocr: true"), 400)

    def test_rejects_bad_authority_and_ambiguous_type_or_framing(self):
        self.check(self.request(auth=False), 401)
        self.check(self.request(declared=32769), 413)
        self.check(self.request(mime=b"multipart/form-data"), 415)
        self.check(self.request(declared=0), 422)
        self.check(self.request(declared=4), 400)
        self.check(self.request(declared=2), 400)
        for extra in (
            b"\r\nTransfer-Encoding: chunked", b"\r\ncontent-length: 4", b"\r\nHost: changed",
            b"\r\nAuthorization: Bearer forged", b"\r\nUpgrade: h2c", b"\r\nBad: \x00",
        ):
            self.check(self.request(extra), 400)
        self.check(self.request().replace(b"/extract ", b"/extract?url=https://example.invalid "), 404)
        self.check(self.request().replace(self.authority.encode(), b"somewhere.invalid"), 400)


@unittest.skipUnless(os.getenv("ASSISTANT_DOCUMENT_TEST_RUNTIME"), "Build a dedicated runtime first.")
class NativeWorkerTest(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ["ASSISTANT_DOCUMENT_TEST_RUNTIME"])
        self.runtime = worker._trusted_runtime(root)
        self.synthetic = pdf_fixture(2)

    def probe(self, operation, outside, seconds):
        command = list(worker._command(self.runtime, operation))
        command[command.index(str(worker._SANDBOX))] = str(Path(__file__).with_name("sandbox-probe.py"))
        command.append(str(outside))
        with subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            close_fds=True, start_new_session=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "ASSISTANT_DOCUMENT_WORKER_TOKEN": "probe"},
        ) as child:
            try:
                return worker._process_output(
                    child, b"", 4096, time.monotonic() + seconds
                )
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)

    def test_files_process_network_and_memory_isolation(self):
        with tempfile.TemporaryDirectory(prefix="assistant-document-probe.") as outside:
            marker = Path(outside) / "owner-only"
            marker.write_text("Synthetic outside proof", encoding="utf-8")
            evidence = json.loads(self.probe("policy", marker, 3))
            self.assertTrue(all(evidence.values()))
        for operation, seconds in (("cpu", 4), ("delay", 0.5), ("oversized-output", 3)):
            with self.subTest(operation=operation):
                with self.assertRaises(worker.InvalidDocument):
                    self.probe(operation, "", seconds)

    def test_enforces_page_text_and_pdf_limits_on_real_poppler(self):
        exact = b"Synthetic compressed page 1\n\nSynthetic compressed page 2\n"
        self.assertEqual(worker.extract(self.runtime, self.synthetic), (exact, False))
        for content in (
            pdf_fixture(9), pdf_fixture(1, text=b"     "), pdf_fixture(1, script=True),
            self.synthetic[:90], self.synthetic + b"x" * 32769,
        ):
            with self.subTest(payload_size=len(content)):
                with self.assertRaises(worker.InvalidDocument):
                    worker.extract(self.runtime, content)

    def test_extracts_mapped_chinese_and_normalizes_combining_text_in_real_poppler(self):
        self.assertEqual(
            worker.extract(self.runtime, unicode_pdf_fixture()),
            ("中文\n\né\n".encode("utf-8"), False),
        )

    def test_accepts_compressed_xref_and_rejects_repair_of_missing_or_wrong_xref(self):
        expected = b"Synthetic compressed page 1\n\nSynthetic compressed page 2\n"
        encoded_xref = pdf_fixture(2, xref_stream=True)
        self.assertEqual(worker.extract(self.runtime, encoded_xref), (expected, False))
        self.assertEqual(worker.extract(self.runtime, self.synthetic), (expected, False))
        redirected = re.sub(br"startxref\n[0-9]+", b"startxref\n1", self.synthetic)
        missing = re.sub(br"(?s)\nxref\n.*?\ntrailer\n", b"\ntrailer\n", self.synthetic)
        for damaged in (redirected, missing):
            self.assertNotEqual(damaged, self.synthetic)
            with self.assertRaises(worker.InvalidDocument):
                worker.extract(self.runtime, damaged)

    def test_authenticated_loopback_and_real_unavailable_runtime(self):
        with tempfile.TemporaryDirectory(prefix="assistant-document-broker.") as directory:
            copied = Path(directory) / "runtime"
            shutil.copytree(self.runtime, copied)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            token = secrets.token_urlsafe(32)
            with subprocess.Popen(
                ["/usr/bin/python3", "-B", str(SOURCE / "worker.py"), "--port", str(port),
                 "--runtime-root", str(copied)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "ASSISTANT_DOCUMENT_WORKER_TOKEN": token},
            ) as server:
                try:
                    if not server.stdout.readline().startswith(b"Document worker listening on 127.0.0.1:"):
                        self.fail("The isolated broker could not start.")
                    self._call(port, None, self.synthetic, 401)
                    self._call(port, "A" * 43, self.synthetic, 401)
                    body = self._call(port, token, self.synthetic, 200)
                    self.assertEqual(body, b"Synthetic compressed page 1\n\nSynthetic compressed page 2\n")
                    self._call(port, token, pdf_fixture(9), 422)
                    executable = copied / "usr/bin/pdftotext"
                    executable.rename(Path(directory) / "unavailable-pdftotext")
                    self._call(port, token, self.synthetic, 503)
                finally:
                    server.terminate()
                    server.wait(timeout=5)
                    self.assertEqual(server.stdout.read(), b"")
                    self.assertEqual(server.stderr.read(), b"")

    def _call(self, port, token, content, expected):
        client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        headers = {"Content-Type": "application/pdf"}
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            client.request("POST", "/extract", body=content, headers=headers)
            response = client.getresponse()
            self.assertEqual(response.status, expected)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(response.getheader("Connection"), "close")
            body = response.read()
            self.assertEqual(response.getheader("Content-Length"), str(len(body)))
            if expected == 200:
                self.assertEqual(response.getheader("Content-Type"), "text/plain; charset=UTF-8")
            else:
                self.assertEqual(body, b"")
            return body
        finally:
            client.close()
