import { describe, expect, it } from 'vitest';
import type { DesktopAutomationApp } from '@shared/desktop-automation';
import { selectUniqueDesktopCaptureSource } from './desktop-capture-source';

const app: DesktopAutomationApp = {
  name: 'Preview App',
  bundleId: 'com.example.preview',
  windowTitle: 'Project Preview',
};

describe('selectUniqueDesktopCaptureSource', () => {
  it('uses one exact normalized window-title match', () => {
    const selected = selectUniqueDesktopCaptureSource(
      [{ name: 'Other' }, { name: '  PROJECT PREVIEW  ' }],
      app,
    );

    expect(selected?.name).toBe('  PROJECT PREVIEW  ');
  });

  it('falls back only to one exact normalized application-name match', () => {
    const selected = selectUniqueDesktopCaptureSource(
      [{ name: 'Preview App — Project Preview' }, { name: 'preview app' }],
      app,
    );

    expect(selected?.name).toBe('preview app');
  });

  it('never uses substring matches', () => {
    expect(
      selectUniqueDesktopCaptureSource(
        [
          { name: 'Project Preview — Other App' },
          { name: 'Preview App — Project Preview' },
        ],
        app,
      ),
    ).toBeUndefined();
  });

  it('fails closed when an exact match is ambiguous', () => {
    expect(() =>
      selectUniqueDesktopCaptureSource(
        [{ name: 'Project Preview' }, { name: 'project preview' }],
        app,
      ),
    ).toThrow('capture is ambiguous');
  });
});
