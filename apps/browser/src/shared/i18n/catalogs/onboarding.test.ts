import { describe, expect, it } from 'vitest';
import { createAppI18n } from '../instance';
import { commonAuthEn } from './common-auth.en';
import { commonAuthRu } from './common-auth.ru';
import { onboardingEn } from './onboarding.en';
import { onboardingRu } from './onboarding.ru';

type CatalogNode = string | { readonly [key: string]: CatalogNode };

function flattenCatalog(
  node: CatalogNode,
  prefix = '',
): Record<string, string> {
  if (typeof node === 'string') return { [prefix]: node };

  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) =>
      Object.entries(flattenCatalog(value, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}

function interpolationNames(value: string): string[] {
  return Array.from(
    value.matchAll(/{{\s*([\w.-]+)\s*}}/g),
    (match) => match[1] ?? '',
  ).sort();
}

describe.each([
  ['common auth', commonAuthEn, commonAuthRu],
  ['onboarding', onboardingEn, onboardingRu],
] as const)('%s locale catalog', (_name, english, russian) => {
  const englishEntries = flattenCatalog(english);
  const russianEntries = flattenCatalog(russian);

  it('keeps English and Russian keys in parity', () => {
    expect(Object.keys(russianEntries).sort()).toEqual(
      Object.keys(englishEntries).sort(),
    );
  });

  it('keeps interpolation variables in parity', () => {
    for (const [key, englishValue] of Object.entries(englishEntries)) {
      expect(interpolationNames(russianEntries[key] ?? ''), key).toEqual(
        interpolationNames(englishValue),
      );
    }
  });

  it('does not contain empty translations', () => {
    expect(Object.values(englishEntries).every((value) => value.trim())).toBe(
      true,
    );
    expect(Object.values(russianEntries).every((value) => value.trim())).toBe(
      true,
    );
  });
});

it('preserves onboarding interpolation placeholders', () => {
  expect(onboardingEn.auth.signedInAs).toContain('{{name}}');
  expect(onboardingRu.auth.signedInAs).toContain('{{name}}');
  expect(onboardingEn.auth.apiKey.showMoreProviders).toContain('{{count}}');
  expect(onboardingRu.auth.apiKey.showMoreProviders).toContain('{{count}}');
});

it('interpolates Russian onboarding values at runtime', () => {
  const i18n = createAppI18n('ru');

  expect(i18n.t('onboarding:auth.signedInAs', { name: 'Алия' })).toBe(
    'Вы вошли как Алия',
  );
  expect(i18n.t('onboarding:auth.apiKey.showMoreProviders', { count: 4 })).toBe(
    'Показать ещё 4 провайдера',
  );
});
