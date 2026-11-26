import type { PictureRef } from 'expo-camera';
import { Directory, File, Paths } from 'expo-file-system';

export const pngLimit = 1024 * 1024;
export const pngType = 'image/png';

const cameraCache = () => new Directory(Paths.cache, 'qingyu-project-captures');

export function discardCameraPhoto(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // The private cache may already have been removed by the device.
  }
}

export function discardAbandonedCameraPhotos() {
  try {
    const directory = cameraCache();
    if (directory.exists) directory.delete();
  } catch {
    // Individual captures are also discarded when a selection is cleared.
  }
}

export async function prepareProjectPhoto(picture: PictureRef, key: string, signal: AbortSignal) {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const longestEdge = Math.max(picture.width, picture.height);
  if (!(longestEdge > 0) || !Number.isFinite(longestEdge)) throw new Error('Invalid camera image dimensions');

  for (const edge of new Set([1024, 640, 384].map((limit) => Math.min(limit, longestEdge)))) {
    if (signal.aborted) return;
    const image = ImageManipulator.manipulate(picture);
    try {
      if (edge < longestEdge) image.resize(picture.width >= picture.height ? { width: edge } : { height: edge });
      const rendered = await image.renderAsync();
      try {
        if (signal.aborted) return;
        const saved = await rendered.saveAsync({ format: SaveFormat.PNG });
        const file = new File(saved.uri);
        try {
          if (!signal.aborted && file.size > 0 && file.size <= pngLimit && file.type.toLowerCase() === pngType) {
            const directory = cameraCache();
            directory.create({ idempotent: true });
            const destination = new File(directory, `camera-${key}.png`);
            let retained = false;
            try {
              await file.move(destination);
              retained = !signal.aborted;
              return retained ? destination : undefined;
            } finally {
              if (!retained) discardCameraPhoto(destination);
            }
          }
        } finally {
          // `move` changes the instance URI, so use the original URI for temporary-file cleanup.
          discardCameraPhoto(new File(saved.uri));
        }
      } finally {
        rendered.release();
      }
    } finally {
      image.release();
    }
  }
  if (!signal.aborted) throw new Error('Camera PNG exceeds the upload limit');
}
