import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_RELEASES_PAGE_URL,
  getManualAppUpdateViewModel,
  MANUAL_UPDATE_CURRENT_LABEL,
  MANUAL_UPDATE_RELEASE_ACTION_LABEL,
} from './app-update-status-model';

describe('manual app update status model', () => {
  it('leaves automatic updater states on the existing UI path', () => {
    expect(
      getManualAppUpdateViewModel({
        status: 'idle',
        updateInfo: null,
        errorMessage: null,
      }),
    ).toBeNull();
  });

  it('exposes validated release metadata for a manual update', () => {
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-available',
        updateInfo: {
          releaseName: 'v1.16.0-communityobserved15',
          releaseNotes: 'Fixes the agent queue and adds manual updates.',
          releasePageUrl:
            'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved15',
        },
        errorMessage: null,
      }),
    ).toEqual({
      kind: 'available',
      releaseName: 'v1.16.0-communityobserved15',
      releasePageUrl:
        'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved15',
    });
  });

  it('fails closed when an available result has no release page URL', () => {
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-available',
        updateInfo: {
          releaseName: 'v1.16.0-communityobserved15',
          releaseNotes: 'Release notes',
        },
        errorMessage: null,
      }),
    ).toMatchObject({ kind: 'available', releasePageUrl: null });
  });

  it('provides deterministic idle, checking, current, and error states', () => {
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-idle',
        updateInfo: null,
        errorMessage: null,
      }),
    ).toEqual({ kind: 'idle' });
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-checking',
        updateInfo: null,
        errorMessage: null,
      }),
    ).toEqual({ kind: 'checking' });
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-current',
        updateInfo: null,
        errorMessage: null,
      }),
    ).toEqual({ kind: 'current' });
    expect(
      getManualAppUpdateViewModel({
        status: 'manual-error',
        updateInfo: null,
        errorMessage: '  Network unavailable.  ',
      }),
    ).toEqual({ kind: 'error', errorMessage: 'Network unavailable.' });
  });

  it('keeps the fallback release index canonical', () => {
    expect(COMMUNITY_RELEASES_PAGE_URL).toBe(
      'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases',
    );
  });

  it('keeps manual update copy precise and non-promotional', () => {
    expect(MANUAL_UPDATE_CURRENT_LABEL).toBe('No newer release found');
    expect(MANUAL_UPDATE_RELEASE_ACTION_LABEL).toBe('Open GitHub Release');
  });
});
