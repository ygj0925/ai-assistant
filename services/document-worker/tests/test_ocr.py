import http.client
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import unittest

from test_worker import SOURCE, flate_stream, pdf_bytes, pdf_fixture, worker

_MIXED = ("中文测试", "工作空间", "ENGLISH OCR 12345")
_ENGLISH = ("ENGLISH OCR 12345", "PRIVATE SYNTHETIC SAMPLE")


def scan_fixture(font_path, lines=_MIXED, pages=1, full_page=True):
    """Draw a synthetic grayscale page and build a PDF with no font or text layer."""
    from PIL import Image, ImageDraw, ImageFont

    width, height = 1024, 576
    page_image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(page_image)
    font = ImageFont.truetype(str(font_path), 54)
    for index, line in enumerate(lines):
        draw.text((width // 12, height // 10 + index * height // 4), line, font=font, fill=0)
    image = flate_stream(
        page_image.tobytes(),
        b"/Type /XObject /Subtype /Image /Width 1024 /Height 576 "
        b"/ColorSpace /DeviceGray /BitsPerComponent 8 ",
    )
    display = flate_stream(
        b"q %d 0 0 %d 0 0 cm /Scan Do Q" % (
            (width, height) if full_page else (width // 2, height // 2)
        )
    )
    page = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1024 576] "
        b"/Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>"
    )
    kids = b"3 0 R" if pages == 1 else b"3 0 R 6 0 R"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count %d /Kids [%s] >>" % (pages, kids),
        page,
        image,
        display,
    ]
    if pages == 2:
        objects.append(page)
    content = pdf_bytes(objects)
    if len(content) > worker.INPUT_LIMIT:
        raise AssertionError("The synthetic scan exceeds the service ingress cap.")
    return content


class RasterContractTest(unittest.TestCase):
    def test_only_accepts_exact_bounded_grayscale_geometry(self):
        worker._validate_raster(b"P5\n2 2\n255\n" + bytes(4))
        for invalid in (
            b"P5\n2 2\n255\n" + bytes(5),
            b"P5\n2 2\n255\n" + bytes(3),
            b"P5\n1025 1\n255\n" + bytes(1025),
            b"P6\n2 2\n255\n" + bytes(12),
            b"P5\n2 2\n65535\n" + bytes(8),
        ):
            with self.assertRaises(worker.InvalidDocument):
                worker._validate_raster(invalid)


@unittest.skipUnless(
    os.getenv("ASSISTANT_DOCUMENT_TEST_OCR_RUNTIME") and os.getenv("ASSISTANT_DOCUMENT_TEST_OCR_FONT"),
    "Build the selected OCR runtime and provide a known synthetic fixture font.",
)
class NativeOcrTest(unittest.TestCase):
    def setUp(self):
        self.language = os.getenv("ASSISTANT_DOCUMENT_TEST_OCR_LANGUAGE", "chi_sim")
        self.runtime = worker._trusted_runtime(Path(os.environ["ASSISTANT_DOCUMENT_TEST_OCR_RUNTIME"]), self.language)
        self.font = Path(os.environ["ASSISTANT_DOCUMENT_TEST_OCR_FONT"])
        self.lines = _MIXED if self.language == "chi_sim" else _ENGLISH
        self.synthetic = scan_fixture(self.font, self.lines)
        self.expected = ("\n".join(self.lines) + "\n").encode("utf-8")

    def test_default_disabled_and_ineligible_documents_stay_closed(self):
        with self.assertRaises(worker.InvalidDocument):
            worker.extract(self.runtime, self.synthetic)
        for input_pdf in (
            scan_fixture(self.font, ()),
            scan_fixture(self.font, self.lines, pages=2),
            scan_fixture(self.font, self.lines, full_page=False),
            pdf_fixture(1, text=b" "),
        ):
            with self.subTest(bytes=len(input_pdf)):
                with self.assertRaises(worker.InvalidDocument):
                    worker.extract(self.runtime, input_pdf, self.language)

    def test_broker_provenance_exact_sample_and_native_model_unavailability(self):
        with tempfile.TemporaryDirectory(prefix="assistant-document-ocr-test.") as directory:
            runtime = Path(directory) / "runtime"
            shutil.copytree(self.runtime, runtime)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            token = secrets.token_urlsafe(32)
            with subprocess.Popen(
                ["/usr/bin/python3", "-B", str(SOURCE / "worker.py"), "--port", str(port),
                 "--runtime-root", str(runtime), "--ocr-language", self.language],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "ASSISTANT_DOCUMENT_WORKER_TOKEN": token},
            ) as server:
                try:
                    self.assertTrue(server.stdout.readline().startswith(b"Document worker listening"))
                    self.assertEqual(self._request(port, token, self.synthetic, None), (422, None, b""))
                    self.assertEqual(self._request(port, token, self.synthetic, "True"), (422, None, b""))
                    self.assertEqual(self._request(port, token, self.synthetic), (200, "ocr", self.expected))
                    embedded = pdf_fixture(1)
                    self.assertEqual(self._request(port, token, embedded), (200, None, b"Synthetic compressed page 1\n"))
                    self.assertEqual(self._request(port, token, embedded, None), (200, None, b"Synthetic compressed page 1\n"))
                    model = runtime / "tessdata" / (self.language + ".traineddata")
                    model.rename(Path(directory) / "unavailable-model")
                    self.assertEqual(self._request(port, token, self.synthetic), (503, None, b""))
                    model.write_bytes(b"Synthetic invalid OCR model")
                    self.assertEqual(self._request(port, token, self.synthetic), (503, None, b""))
                    self.assertEqual(self._request(port, token, embedded), (200, None, b"Synthetic compressed page 1\n"))
                finally:
                    server.terminate()
                    server.wait(timeout=5)
                    self.assertEqual(server.stdout.read(), b"")
                    self.assertEqual(server.stderr.read(), b"")

    def _request(self, port, token, content, permission="true"):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            headers = {
                "Content-Type": "application/pdf", "Authorization": "Bearer " + token,
            }
            if permission is not None:
                headers["X-Assistant-Allow-OCR"] = permission
            connection.request("POST", "/extract", content, headers)
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.getheader("Content-Length"), str(len(body)))
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            if response.status == 200:
                self.assertEqual(response.getheader("Content-Type"), "text/plain; charset=UTF-8")
            return response.status, response.getheader("X-Assistant-Text-Source"), body
        finally:
            connection.close()
