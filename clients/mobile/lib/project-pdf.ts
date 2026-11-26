import { decodeUtf8 } from './utf8';

export const pdfFileLimit = 32 * 1024;
export const pdfTextLimit = 4 * 1024;
export const pdfOcrWarning = '扫描件 OCR 文本，可能有误，请对照原件。\n'
  + 'Scanned OCR text may contain errors. Check the original.\n\n';

type PdfProvenance = { id: string; approximateText?: unknown };
export type PdfTextPreview = { id: string; text: string; approximate: boolean };

export function pdfApproximation(item: PdfProvenance): boolean {
  if (item.approximateText === undefined) return false;
  if (item.approximateText === true) return true;
  throw new Error('Unexpected PDF text provenance');
}

export function acceptsPdfHeader(bytes: Uint8Array, general: boolean): boolean {
  if (bytes.length < 9 || bytes.length > pdfFileLimit) return false;
  const header = String.fromCharCode(...bytes.subarray(0, 9));
  return general ? /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]$/.test(header) : header === '%PDF-1.4\n';
}

function canonicalTextBytes(text: string, approximate: boolean): Uint8Array {
  if (typeof text !== 'string' || !text.trim() || !text.endsWith('\n')
      || /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(text.replace(/\n/g, '')) || text.normalize('NFC') !== text) {
    throw new Error('Unexpected PDF text');
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > pdfTextLimit) throw new Error('Unexpected PDF text size');
  if (text.startsWith(pdfOcrWarning) !== approximate || (approximate && !text.slice(pdfOcrWarning.length).trim())) {
    throw new Error('Unexpected PDF text provenance');
  }
  return bytes;
}

export function requirePdfText(text: string, approximate = false): string {
  canonicalTextBytes(text, approximate);
  return text;
}

export function requirePdfPreview(item: PdfProvenance, result: PdfProvenance & { text: string }): PdfTextPreview {
  const approximate = pdfApproximation(item);
  if (item.id !== result.id || pdfApproximation(result) !== approximate) throw new Error('Unexpected PDF text provenance');
  return { id: item.id, text: requirePdfText(result.text, approximate), approximate };
}

export function requirePdfDownload(bytes: Uint8Array, approximate = false): Uint8Array {
  const canonical = canonicalTextBytes(decodeUtf8(bytes), approximate);
  if (bytes.length !== canonical.length || bytes.some((value, index) => value !== canonical[index])) {
    throw new Error('Unexpected PDF text encoding');
  }
  return bytes;
}
