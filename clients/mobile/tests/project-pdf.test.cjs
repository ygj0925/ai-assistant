const assert = require('node:assert/strict');
const test = require('node:test');
const { acceptsPdfHeader, pdfApproximation, pdfFileLimit, pdfOcrWarning, pdfTextLimit, requirePdfDownload,
  requirePdfPreview, requirePdfText } =
  require('../.expo/project-pdf-test/project-pdf.js');

const utf8 = (text) => new TextEncoder().encode(text);

test('the basic header stays exact and general intake accepts only supported versions and line breaks', () => {
  assert.equal(acceptsPdfHeader(utf8('%PDF-1.4\nbody'), false), true);
  for (const version of ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0']) {
    for (const newline of ['\n', '\r', '\r\n']) {
      const bytes = utf8(`%PDF-${version}${newline}body`);
      assert.equal(acceptsPdfHeader(bytes, true), true);
      assert.equal(acceptsPdfHeader(bytes, false), version === '1.4' && newline === '\n');
    }
  }
  for (const sample of ['%PDF-2.1\n', '%PDF-1.8\n', '%PDF-1.7\t', '%PDF-1.7', '\n%PDF-1.7\n']) {
    assert.equal(acceptsPdfHeader(utf8(sample), true), false);
  }
  const oversized = new Uint8Array(pdfFileLimit + 1);
  oversized.set(utf8('%PDF-1.4\n'));
  assert.equal(acceptsPdfHeader(oversized, false), false);
  assert.equal(acceptsPdfHeader(oversized, true), false);
});

test('legacy spacing and canonical Unicode are preserved for literal display and download', () => {
  for (const text of ['   Old <em>literal</em>   \n\n', '你好，Café и 😀\n第二页\n', '新行\n'.repeat(40)]) {
    const bytes = utf8(text);
    assert.equal(requirePdfText(text), text);
    assert.strictEqual(requirePdfDownload(bytes), bytes);
  }
});

test('canonical text requires NFC, valid scalars, final LF and no other controls or format characters', () => {
  for (const text of ['Cafe\u0301\n', 'word', ' \n', 'a\tb\n', 'a\rb\n', 'a\u0085b\n',
    'a\u200Bb\n', 'a\u2028b\n', 'a\u2029b\n', 'a\u202Eb\n', 'a\uD800b\n']) {
    assert.throws(() => requirePdfText(text), /Unexpected PDF text/);
  }
});

test('the limit counts UTF-8 bytes and downloads reject malformed or noncanonical encodings', () => {
  const text = '中'.repeat(1365) + '\n';
  assert.equal(utf8(text).length, pdfTextLimit);
  assert.equal(requirePdfText(text), text);
  assert.throws(() => requirePdfText('中' + text), /Unexpected PDF text size/);
  assert.throws(() => requirePdfDownload(Uint8Array.of(0xC0, 0xAF, 10)));
  assert.throws(() => requirePdfDownload(Uint8Array.of(0xED, 0xA0, 0x80, 10)));
  assert.throws(() => requirePdfDownload(utf8('\uFEFFtext\n')), /Unexpected PDF text encoding/);
});

test('preview fails closed when current OCR provenance, warning or attachment identity disagree', () => {
  const exact = { id: 'a', text: 'Exact text\n' };
  const scan = { id: 'a', approximateText: true, text: pdfOcrWarning + 'Approximate text\n' };
  assert.deepEqual(requirePdfPreview(exact, exact), { id: 'a', text: exact.text, approximate: false });
  assert.deepEqual(requirePdfPreview(scan, scan), { id: 'a', text: scan.text, approximate: true });
  for (const result of [exact, { ...scan, approximateText: undefined }, { ...scan, approximateText: false },
    { ...scan, id: 'b' }, { ...scan, text: exact.text }, { ...scan, text: pdfOcrWarning + ' \n' }]) {
    assert.throws(() => requirePdfPreview(scan, result), /Unexpected PDF text provenance/);
  }
  assert.throws(() => requirePdfPreview(exact, { ...exact, text: scan.text }), /Unexpected PDF text provenance/);
  assert.throws(() => pdfApproximation({ id: 'a', approximateText: null }), /Unexpected PDF text provenance/);
});

test('downloaded OCR bytes must carry the permanent warning and fit within the total UTF-8 limit', () => {
  const text = pdfOcrWarning + 'Café approximate\n';
  const bytes = utf8(text);
  assert.strictEqual(requirePdfDownload(bytes, true), bytes);
  assert.throws(() => requirePdfDownload(bytes), /Unexpected PDF text provenance/);
  assert.throws(() => requirePdfDownload(utf8('Unlabelled\n'), true), /Unexpected PDF text provenance/);
  const full = pdfOcrWarning + 'a'.repeat(pdfTextLimit - utf8(pdfOcrWarning).length - 1) + '\n';
  assert.equal(requirePdfDownload(utf8(full), true).length, pdfTextLimit);
  assert.throws(() => requirePdfDownload(utf8(full + '\n'), true), /Unexpected PDF text size/);
});
