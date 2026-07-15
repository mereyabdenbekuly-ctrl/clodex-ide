export interface ReviewedMaterializedSymlink {
  path: string;
  target: string;
}

export interface ExtractVerifiedZipArchiveOptions {
  allowedSymlinks: ReviewedMaterializedSymlink[];
  archiveBytes: Uint8Array;
  archiveRoot: string;
  destination: string;
  maximumArchiveEntries?: number;
  maximumExtractedBytes?: number;
}

export function safePortableArchivePath(fileName: string): string;

export function resolveSafeMaterializedSymlinkTarget(
  linkPath: string,
  target: string,
): string;

export function validateReviewedMaterializedSymlinks(
  allowedSymlinks: ReviewedMaterializedSymlink[],
): ReviewedMaterializedSymlink[];

export function extractVerifiedZipArchive(
  options: ExtractVerifiedZipArchiveOptions,
): Promise<{
  entryCount: number;
  extractedBytes: number;
  materializedSymlinks: ReviewedMaterializedSymlink[];
}>;
