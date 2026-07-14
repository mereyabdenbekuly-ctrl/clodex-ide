import { canonicalizeJson, parseCanonicalJson } from '@clodex/contracts';
import {
  validateApprovalReviewChallenge,
  validateArtifactReplayReference,
  type ApprovalArtifactReplayReference,
  type ApprovalReviewChallenge,
} from './approval-artifact.js';
import type { ApprovalReplayRegistryPort } from './approval-service.js';

export type ApprovalReplayErrorCode =
  | 'artifact-replay'
  | 'review-collision'
  | 'review-mismatch'
  | 'review-replay'
  | 'unknown-review';

export class ApprovalReplayError extends Error {
  public constructor(
    public readonly code: ApprovalReplayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalReplayError';
  }
}

export interface ApprovalReplayRegistrySnapshot {
  readonly pendingReviewIds: readonly string[];
  readonly consumedReviewIds: readonly string[];
  readonly consumedApprovalIds: readonly string[];
  readonly consumedArtifactDigests: readonly string[];
}

/**
 * Single-isolate reference implementation only. Operations are synchronous
 * and atomic with respect to JavaScript re-entry, but are not durable,
 * multi-process safe, rollback resistant, or a production replay registry.
 */
export class InMemoryApprovalReplayRegistry
  implements ApprovalReplayRegistryPort
{
  public readonly durability = 'memory-only' as const;

  readonly #pendingReviews = new Map<string, string>();
  readonly #seenReviewNonces = new Set<string>();
  readonly #consumedReviewIds = new Set<string>();
  readonly #consumedApprovalIds = new Set<string>();
  readonly #consumedApprovalNonces = new Set<string>();
  readonly #consumedArtifactDigests = new Set<string>();

  public registerReview(challengeValue: ApprovalReviewChallenge): void {
    const challenge = validateApprovalReviewChallenge(challengeValue);
    if (
      this.#pendingReviews.has(challenge.reviewId) ||
      this.#consumedReviewIds.has(challenge.reviewId) ||
      this.#seenReviewNonces.has(challenge.nonce)
    ) {
      throw new ApprovalReplayError(
        'review-collision',
        'Review ID or nonce has already been registered',
      );
    }
    this.#pendingReviews.set(challenge.reviewId, canonicalizeJson(challenge));
    this.#seenReviewNonces.add(challenge.nonce);
  }

  public consumeReview(challengeValue: ApprovalReviewChallenge): void {
    const challenge = validateApprovalReviewChallenge(challengeValue);
    if (this.#consumedReviewIds.has(challenge.reviewId)) {
      throw new ApprovalReplayError(
        'review-replay',
        'Review challenge has already been consumed',
      );
    }
    const registered = this.#pendingReviews.get(challenge.reviewId);
    if (!registered) {
      throw new ApprovalReplayError(
        'unknown-review',
        'Review challenge is not registered',
      );
    }

    // Consume before comparison: a tampered submission invalidates the review
    // and cannot be retried with guessed values.
    this.#pendingReviews.delete(challenge.reviewId);
    this.#consumedReviewIds.add(challenge.reviewId);
    if (registered !== canonicalizeJson(challenge)) {
      throw new ApprovalReplayError(
        'review-mismatch',
        'Submitted review challenge does not exactly match registration',
      );
    }
  }

  public consumeArtifact(
    referenceValue: ApprovalArtifactReplayReference,
  ): void {
    const reference = validateArtifactReplayReference(referenceValue);
    if (
      this.#consumedApprovalIds.has(reference.approvalId) ||
      this.#consumedApprovalNonces.has(reference.nonce) ||
      this.#consumedArtifactDigests.has(reference.artifactDigest)
    ) {
      throw new ApprovalReplayError(
        'artifact-replay',
        'Approval Artifact ID, nonce, or digest has already been consumed',
      );
    }
    this.#consumedApprovalIds.add(reference.approvalId);
    this.#consumedApprovalNonces.add(reference.nonce);
    this.#consumedArtifactDigests.add(reference.artifactDigest);
  }

  public snapshot(): ApprovalReplayRegistrySnapshot {
    return clone({
      pendingReviewIds: [...this.#pendingReviews.keys()].sort(),
      consumedReviewIds: [...this.#consumedReviewIds].sort(),
      consumedApprovalIds: [...this.#consumedApprovalIds].sort(),
      consumedArtifactDigests: [...this.#consumedArtifactDigests].sort(),
    });
  }
}

function clone<Value>(value: Value): Value {
  return parseCanonicalJson(canonicalizeJson(value)) as Value;
}
