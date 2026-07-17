import { describe, expect, it } from 'vitest';
import { createAppI18n } from '../instance';
import { taskEn } from './task.en';
import { taskRu } from './task.ru';

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

describe('task locale catalog', () => {
  const englishEntries = flattenCatalog(taskEn);
  const russianEntries = flattenCatalog(taskRu);

  it('keeps English and Russian keys and interpolation variables in parity', () => {
    expect(Object.keys(russianEntries).sort()).toEqual(
      Object.keys(englishEntries).sort(),
    );
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

  it('interpolates the Russian composer placeholder', () => {
    const i18n = createAppI18n('ru');
    expect(
      i18n.t('task:composer.placeholder', {
        queuedHint: 'Нажмите ↵, чтобы отправить сейчас',
      }),
    ).toContain('Нажмите ↵, чтобы отправить сейчас');
  });
});
