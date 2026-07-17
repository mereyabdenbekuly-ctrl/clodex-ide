import { describe, expect, it } from 'vitest';
import { createAppI18n } from './instance';
import { isInterfaceLanguage, isSupportedInterfaceLocale } from './locales';
import { resolveInterfaceLocale, syncHtmlLanguage } from './resolver';
import { I18N_NAMESPACES, I18N_RESOURCES } from './resources';

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];

  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('interface locale resolution', () => {
  it('honors an explicit supported preference', () => {
    expect(resolveInterfaceLocale('ru', ['en-US'])).toBe('ru');
    expect(resolveInterfaceLocale('en', ['ru-RU'])).toBe('en');
  });

  it('normalizes the first supported system locale', () => {
    expect(resolveInterfaceLocale('system', ['kk-KZ', 'ru_RU'])).toBe('ru');
    expect(resolveInterfaceLocale('system', 'EN-us')).toBe('en');
  });

  it('falls back to English for missing or unsupported preferences', () => {
    expect(resolveInterfaceLocale(undefined, ['ru-RU'])).toBe('en');
    expect(resolveInterfaceLocale('system', ['kk-KZ'])).toBe('en');
  });

  it('validates persisted preferences and concrete locales', () => {
    expect(isInterfaceLanguage('system')).toBe(true);
    expect(isInterfaceLanguage('ru')).toBe(true);
    expect(isInterfaceLanguage('de')).toBe(false);
    expect(isSupportedInterfaceLocale('en')).toBe(true);
    expect(isSupportedInterfaceLocale('system')).toBe(false);
  });
});

describe('static i18n resources', () => {
  it('keeps the English and Russian catalogs structurally aligned', () => {
    expect(I18N_NAMESPACES).toContain('common');
    expect(I18N_NAMESPACES).toContain('settings');
    expect(leafPaths(I18N_RESOURCES.ru).sort()).toEqual(
      leafPaths(I18N_RESOURCES.en).sort(),
    );
  });

  it('translates settings and Russian plural forms', () => {
    const i18n = createAppI18n('ru');

    expect(i18n.t('settings:personalization.title')).toBe('Персонализация');
    expect(i18n.t('itemCount', { count: 2 })).toBe('2 элемента');
    expect(i18n.t('itemCount', { count: 5 })).toBe('5 элементов');
  });
});

describe('html language synchronization', () => {
  it('updates the root language attribute for assistive technology', () => {
    const target = { lang: 'en' };

    syncHtmlLanguage('ru', target);

    expect(target.lang).toBe('ru');
  });
});
