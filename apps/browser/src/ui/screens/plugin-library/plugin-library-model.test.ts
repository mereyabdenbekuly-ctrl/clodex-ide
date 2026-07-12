import { describe, expect, it } from 'vitest';
import type { PluginLibrarySnapshot } from '@shared/plugin-library';
import {
  createPluginLibraryItems,
  createPluginLibrarySkills,
  filterPluginLibraryItems,
  filterPluginLibrarySkills,
  getPluginLibrarySummary,
} from './plugin-library-model';

const snapshot: PluginLibrarySnapshot = {
  plugins: [
    {
      id: 'figma',
      displayName: 'Figma',
      description: 'Inspect designs',
      requiredCredentials: ['figma-pat'],
      logoSvg: null,
      skills: [{ name: 'Inspect Figma', description: 'Read selected frames' }],
      source: 'bundled',
      version: null,
      permissions: ['skills', 'credentials'],
    },
    {
      id: 'release-readiness',
      displayName: 'Release Readiness',
      description: 'Validate release evidence',
      requiredCredentials: [],
      logoSvg: null,
      skills: [
        { name: 'Release audit', description: 'Check release evidence' },
      ],
      source: 'marketplace',
      version: '1.0.0',
      permissions: ['skills', 'filesystem'],
    },
  ],
  marketplace: {
    enabled: true,
    status: 'ready',
    keyId: 'official-1',
    generatedAt: 1,
    expiresAt: 2,
    refreshedAt: 1,
    error: null,
    warnings: [],
    installed: [
      {
        id: 'release-readiness',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        source: 'official',
        installedAt: 1,
        updatedAt: 1,
        manifest: {
          schemaVersion: 1,
          id: 'release-readiness',
          version: '1.0.0',
          displayName: 'Release Readiness',
          description: 'Validate release evidence',
          publisher: 'Clodex',
          compatibility: { minAppVersion: '1.0.0' },
          permissions: ['skills', 'filesystem'],
          requiredCredentials: [],
        },
      },
    ],
    catalog: [
      {
        manifest: {
          schemaVersion: 1,
          id: 'release-readiness',
          version: '1.1.0',
          displayName: 'Release Readiness',
          description: 'Validate release evidence',
          publisher: 'Clodex',
          compatibility: { minAppVersion: '1.0.0' },
          permissions: ['skills', 'filesystem'],
          requiredCredentials: [],
        },
        sha256: 'b'.repeat(64),
        compatible: true,
        compatibilityError: null,
        installedVersion: '1.0.0',
        updateAvailable: true,
      },
      {
        manifest: {
          schemaVersion: 1,
          id: 'cloud-lab',
          version: '2.0.0',
          displayName: 'Cloud Lab',
          description: 'Run cloud experiments',
          publisher: 'Clodex',
          compatibility: { minAppVersion: '9.0.0' },
          permissions: ['network'],
          requiredCredentials: [],
        },
        sha256: 'c'.repeat(64),
        compatible: false,
        compatibilityError: 'Requires Clodex 9.0.0',
        installedVersion: null,
        updateAvailable: false,
      },
    ],
  },
  disabledPluginIds: ['figma'],
  configuredCredentialIds: [],
};

describe('plugin library model', () => {
  const items = createPluginLibraryItems(snapshot);

  it('merges bundled, installed, and catalog-only plugins', () => {
    expect(items.map((item) => item.id)).toEqual([
      'figma',
      'release-readiness',
      'cloud-lab',
    ]);
    expect(items.find((item) => item.id === 'figma')?.enabled).toBe(false);
    expect(
      items.find((item) => item.id === 'release-readiness')?.updateAvailable,
    ).toBe(true);
    expect(items.find((item) => item.id === 'cloud-lab')?.installed).toBe(
      false,
    );
  });

  it('filters by source, state, compatibility, and skill text', () => {
    expect(
      filterPluginLibraryItems(items, {
        query: '',
        source: 'marketplace',
        status: 'updates',
      }).map((item) => item.id),
    ).toEqual(['release-readiness']);
    expect(
      filterPluginLibraryItems(items, {
        query: '',
        source: 'all',
        status: 'incompatible',
      }).map((item) => item.id),
    ).toEqual(['cloud-lab']);
    expect(
      filterPluginLibraryItems(items, {
        query: 'selected frames',
        source: 'all',
        status: 'all',
      }).map((item) => item.id),
    ).toEqual(['figma']);
  });

  it('builds searchable skill rows and summary counts', () => {
    const skills = createPluginLibrarySkills(items);
    expect(filterPluginLibrarySkills(skills, 'release')).toHaveLength(1);
    expect(getPluginLibrarySummary(items)).toEqual({
      total: 3,
      installed: 2,
      enabled: 1,
      updates: 1,
      skills: 2,
    });
  });
});
