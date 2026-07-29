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

  it('states the combined Auto edits and Always allow policy in both languages', () => {
    expect(
      englishEntries['approval.fileEdits.mode.autoWorkspace.description'],
    ).toBe(
      'Automatically apply eligible ordinary text-file edits. Together with Always allow, project configuration updates skip repeated Accept prompts and new-file creation receives a guarded-shell fallback instruction; secrets, boundary violations, read-only access, and unsafe filesystem links are blocked.',
    );
    expect(
      russianEntries['approval.fileEdits.mode.autoWorkspace.description'],
    ).toBe(
      'Автоматически применять допустимые правки обычных текстовых файлов. Вместе с режимом «Всегда разрешать» файлы конфигурации проекта изменяются без повторного Accept, а для создания новых файлов агент получает указание использовать защищённый терминальный путь. Секреты, нарушение границ, read-only доступ и небезопасные файловые ссылки блокируются.',
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
