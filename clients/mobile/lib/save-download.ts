import { Directory } from 'expo-file-system';

export async function readDownloadBytes(blob: Blob, minBytes: number, maxBytes: number) {
  try {
    if (blob.size < minBytes || blob.size > maxBytes) throw new Error('Invalid download size');
    if (!blob.size) return new Uint8Array(0);
    if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    // Expo SDK 56 can return the legacy React Native Blob, which is read through FileReader.
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Could not read download'));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
        else reject(new Error('Invalid download data'));
      };
      reader.readAsArrayBuffer(blob);
    });
  } finally {
    (blob as Blob & { close?: () => void }).close?.();
  }
}

export async function saveDownload(download: () => Promise<Blob | Uint8Array>, options: {
  filename: string; contentType: string; maxBytes: number; signal: AbortSignal; allowEmpty?: boolean;
}) {
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch (failure) {
    if (failure && typeof failure === 'object' && 'code' in failure
      && /cancel(?:l)?ed/i.test(String(failure.code))) return;
    throw failure;
  }
  if (options.signal.aborted) return;
  const payload = await download();
  const minBytes = options.allowEmpty ? 0 : 1;
  const bytes = payload instanceof Uint8Array ? payload : await readDownloadBytes(payload, minBytes, options.maxBytes);
  if (bytes.byteLength < minBytes || bytes.byteLength > options.maxBytes) throw new Error('Invalid download size');
  if (options.signal.aborted) return;
  const file = folder.createFile(options.filename, options.contentType);
  try {
    if (bytes.byteLength) file.write(bytes);
  } catch (failure) {
    try { file.delete(); } catch { /* Best effort for a file created by this save attempt. */ }
    throw failure;
  }
  return file.name;
}
