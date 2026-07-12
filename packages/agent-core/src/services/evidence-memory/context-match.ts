import type { EvidenceMemoryClaim } from './index';

const EVIDENCE_CONTEXT_STOP_TERMS = new Set([
  'about',
  'after',
  'before',
  'could',
  'should',
  'their',
  'there',
  'these',
  'those',
  'using',
  'where',
  'which',
  'would',
]);

/**
 * Deterministic lexical containment check shared by production admission and
 * content-free dogfood scoring. One implementation keeps rollout metrics from
 * disagreeing with the actual prompt-deduplication policy.
 */
export function evidenceMemoryContextContainsClaim(
  context: string,
  claim: Pick<EvidenceMemoryClaim, 'subject' | 'text'>,
): boolean {
  const haystack = normalizeEvidenceContextText(context);
  if (!haystack) return false;

  const exactText = normalizeEvidenceContextText(claim.text);
  if (exactText.length >= 24 && haystack.includes(exactText)) return true;

  const subject = normalizeEvidenceContextText(
    claim.subject.replaceAll('.', ' '),
  );
  if (subject.length >= 12 && haystack.includes(subject)) return true;

  const distinctiveTerms = getDistinctiveEvidenceTerms(claim.text);
  if (distinctiveTerms.length === 0) return false;

  // Exact identifiers carry most of the information in code and operational
  // memory. Requiring two when available prevents a shared run/task token from
  // making every sibling claim look present in the same summary.
  const identifierTerms = distinctiveTerms.filter(isEvidenceIdentifierTerm);
  const terms = identifierTerms.length > 0 ? identifierTerms : distinctiveTerms;
  const required =
    identifierTerms.length > 0
      ? Math.min(2, identifierTerms.length)
      : Math.min(
          distinctiveTerms.length,
          Math.max(2, Math.ceil(distinctiveTerms.length * 0.7)),
        );
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matches += 1;
    if (matches >= required) return true;
  }
  return false;
}

/** True when a query carries an exact flag, marker, revision, or identifier. */
export function evidenceMemoryContextHasExactIdentifiers(
  context: string,
): boolean {
  return getDistinctiveEvidenceTerms(context).some(isEvidenceIdentifierTerm);
}

function getDistinctiveEvidenceTerms(value: string): string[] {
  return Array.from(
    new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{5,}/gu) ?? []),
  ).filter((term) => !EVIDENCE_CONTEXT_STOP_TERMS.has(term));
}

function isEvidenceIdentifierTerm(term: string): boolean {
  return /[_-]/u.test(term) || /\d/u.test(term);
}

function normalizeEvidenceContextText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
