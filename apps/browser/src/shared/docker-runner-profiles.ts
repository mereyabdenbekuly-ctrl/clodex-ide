import { z } from 'zod';

const dockerImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

export const dockerRunnerProfileInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required.').max(80),
  image: z
    .string()
    .trim()
    .max(2048)
    .regex(
      dockerImagePattern,
      'Image must be pinned to an immutable sha256 digest.',
    ),
  cpus: z.coerce.number().finite().min(0.25).max(64),
  memoryMb: z.coerce.number().int().min(128).max(262_144),
  pidsLimit: z.coerce.number().int().min(16).max(65_536),
});

export type DockerRunnerProfileInput = z.infer<
  typeof dockerRunnerProfileInputSchema
>;

export type DockerRunnerProfile = {
  id: string;
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  lastCheckSucceeded: boolean | null;
  lastError: string | null;
};

export type DockerRunnerRuntimeSource = 'none' | 'profile' | 'environment';

export type DockerRunnerProfilesSnapshot = {
  profiles: DockerRunnerProfile[];
  selectedProfileId: string | null;
  runtime: {
    source: DockerRunnerRuntimeSource;
    activeProfileId: string | null;
    environmentOverride: boolean;
    message: string;
  };
};

export type DockerRunnerProfileFailure = {
  ok: false;
  code:
    | 'invalid-input'
    | 'not-found'
    | 'docker-unavailable'
    | 'operation-failed';
  message: string;
  profile?: DockerRunnerProfile;
};

export type SaveDockerRunnerProfileResult =
  | { ok: true; profile: DockerRunnerProfile; message: string }
  | DockerRunnerProfileFailure;

export type DeleteDockerRunnerProfileResult =
  | { ok: true; id: string; message: string }
  | DockerRunnerProfileFailure;

export type DockerRunnerProfileOperationResult =
  | { ok: true; profile: DockerRunnerProfile; message: string }
  | DockerRunnerProfileFailure;

export type DockerRunnerProfileSelectionResult =
  | {
      ok: true;
      selectedProfileId: string | null;
      profile?: DockerRunnerProfile;
      message: string;
    }
  | DockerRunnerProfileFailure;
