import type { NativeImage } from 'electron';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Compresses an image to a target size using progressive quality reduction.
 * If quality reduction alone isn't enough, it will resize the image and retry.
 *
 * @param image - The NativeImage to compress
 * @param maxSizeBytes - Maximum file size in bytes (default: 5MB)
 * @returns Data URL of the compressed JPEG image
 */
export function compressImageToTargetSize(
  image: NativeImage,
  maxSizeBytes: number = MAX_IMAGE_SIZE_BYTES,
): string {
  // Try different quality levels, starting high and decreasing
  const qualities = [85, 70, 50, 30];

  for (const quality of qualities) {
    const buffer = image.toJPEG(quality);
    if (buffer.length <= maxSizeBytes)
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  // If still too large at lowest quality, resize to 50% and retry
  const size = image.getSize();
  if (size.width <= 100 || size.height <= 100) {
    // Image is already very small, return it at lowest quality
    const buffer = image.toJPEG(30);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  const scaledImage = image.resize({
    width: Math.floor(size.width * 0.5),
    height: Math.floor(size.height * 0.5),
  });

  return compressImageToTargetSize(scaledImage, maxSizeBytes);
}

/**
 * Extracts the domain (hostname) from a URL for use as a fallback title.
 * Returns the URL itself if parsing fails.
 */
export function getDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}
