import { describe, expect, it } from 'vitest';
import {
  evidenceMemoryContextContainsClaim,
  evidenceMemoryContextHasExactIdentifiers,
} from './context-match';

describe('Evidence Memory baseline context matching', () => {
  it('matches claim-specific identifiers retained by compression', () => {
    expect(
      evidenceMemoryContextContainsClaim(
        'Keep EMDFFACTA1 and value_1_2_3 as the canonical build marker.',
        {
          subject: 'dogfood.exact.3',
          text: 'The canonical build marker EMDFFACTA1 maps to value_1_2_3.',
        },
      ),
    ).toBe(true);
  });

  it('rejects sibling claims that share only a run token and generic words', () => {
    expect(
      evidenceMemoryContextContainsClaim(
        'Run EMDF-RUN-1 uses CURRENT-2; previous repository values are invalid.',
        {
          subject: 'dogfood.run.routing-mode.1',
          text: 'Run EMDF-RUN-1 used LEGACY-1 with legacy_1_2_1.',
        },
      ),
    ).toBe(false);
  });

  it('requires broad lexical coverage when no exact identifier exists', () => {
    expect(
      evidenceMemoryContextContainsClaim(
        'The public API must stay stable across releases.',
        {
          subject: 'api.compatibility',
          text: 'Keep the public API stable for every release.',
        },
      ),
    ).toBe(true);
    expect(
      evidenceMemoryContextContainsClaim('The API changed yesterday.', {
        subject: 'api.compatibility',
        text: 'Keep the public API stable for every release.',
      }),
    ).toBe(false);
  });

  it('detects exact identifiers without treating ordinary prose as exact', () => {
    expect(
      evidenceMemoryContextHasExactIdentifiers(
        'Find EMDF-RUN-1 and value_1_2_3 exactly.',
      ),
    ).toBe(true);
    expect(
      evidenceMemoryContextHasExactIdentifiers(
        'Find the public API compatibility decision.',
      ),
    ).toBe(false);
  });
});
