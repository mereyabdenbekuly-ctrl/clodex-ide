import { z } from 'zod';
import type { DownloadState } from '../pages-api/types';

/** Speed data point for download speed history */
export type DownloadSpeedDataPoint = {
  /** Unix timestamp in ms */
  timestamp: number;
  /** Speed in KB/s */
  speedKBps: number;
  /** Total bytes received at this point */
  totalBytes: number;
};

/** Summary download info for the control button display */
export type DownloadSummary = {
  /** Download ID */
  id: number;
  /** Filename */
  filename: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Whether this is an active/running download */
  isActive: boolean;
  /** Download state */
  state: DownloadState;
  /** Whether the download is paused (only for active) */
  isPaused?: boolean;
  /** Target path on disk */
  targetPath: string;
  /** Download start time */
  startTime: Date;
  /** Download end time (for completed) */
  endTime?: Date;
  /** Current download speed in KB/s (only for active downloads) */
  currentSpeedKBps?: number;
  /** Speed history for graphing (up to 100 data points covering 10 minutes) */
  speedHistory?: DownloadSpeedDataPoint[];
};

/** Schema for downloads state persisted data */
export const downloadsStateSchema = z.object({
  /** ISO timestamp when downloads were last marked as seen */
  lastSeenAt: z.string().nullable(),
});

export type DownloadsState = z.infer<typeof downloadsStateSchema>;
