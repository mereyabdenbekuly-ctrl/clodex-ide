import { z } from 'zod';

export const sessionTeleportInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  prompt: z.string().trim().min(1).max(100_000),
});
export type SessionTeleportInput = z.infer<typeof sessionTeleportInputSchema>;

export const createSessionShareInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
});
export type CreateSessionShareInput = z.infer<
  typeof createSessionShareInputSchema
>;

export interface SessionContinuityReadiness {
  sessionId: string;
  exists: boolean;
  cloudAvailable: boolean;
  sharingAvailable: boolean;
  messageCount: number;
  workspacePaths: string[];
  readyForTeleport: boolean;
  readyForSharing: boolean;
  reasons: string[];
}

export interface SessionShareRecord {
  id: string;
  sessionId: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SessionShareSnapshot {
  shares: SessionShareRecord[];
}

export interface ReadOnlySessionSharePayload {
  sessionId: string;
  title: string;
  createdAt: string;
  messages: Array<{
    role: 'user' | 'assistant';
    text: string;
    createdAt: string | null;
  }>;
}
