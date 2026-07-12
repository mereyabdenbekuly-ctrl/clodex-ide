export interface CloudTaskArtifactIdentity {
  executionId: string;
  artifactId: string;
}

export type CloudTaskArtifactActionResult =
  | { ok: true; cancelled?: false }
  | { ok: false; cancelled?: boolean; error: string };
