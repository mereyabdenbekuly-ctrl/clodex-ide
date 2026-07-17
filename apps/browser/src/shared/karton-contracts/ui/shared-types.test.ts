import { describe, expect, it } from 'vitest';
import {
  providerConfigSchema,
  providerProfileSchema,
  userPreferencesSchema,
} from './shared-types';

describe('userPreferencesSchema agent personality defaults', () => {
  it('defaults legacy preferences to pragmatic', () => {
    const parsed = userPreferencesSchema.parse({});

    expect(parsed.agent.personality).toBe('pragmatic');
  });

  it('preserves a supported personality', () => {
    const parsed = userPreferencesSchema.parse({
      agent: { personality: 'friendly' },
    });

    expect(parsed.agent.personality).toBe('friendly');
  });

  it('sanitizes unsupported personalities', () => {
    const parsed = userPreferencesSchema.parse({
      agent: { personality: 'unknown' },
    });

    expect(parsed.agent.personality).toBe('pragmatic');
  });
});

describe('userPreferencesSchema interface language defaults', () => {
  it('keeps legacy installations in English until they opt in', () => {
    const parsed = userPreferencesSchema.parse({
      general: { uiZoomPercentage: 110 },
    });

    expect(parsed.general.interfaceLanguage).toBe('en');
    expect(parsed.general.uiZoomPercentage).toBe(110);
  });

  it.each([
    'system',
    'en',
    'ru',
  ] as const)('preserves the supported %s preference', (interfaceLanguage) => {
    const parsed = userPreferencesSchema.parse({
      general: { interfaceLanguage },
    });

    expect(parsed.general.interfaceLanguage).toBe(interfaceLanguage);
  });

  it('sanitizes unsupported persisted languages', () => {
    const parsed = userPreferencesSchema.parse({
      general: { interfaceLanguage: 'de' },
    });

    expect(parsed.general.interfaceLanguage).toBe('en');
  });
});

describe('userPreferencesSchema collaboration and feature gate defaults', () => {
  it('defaults legacy preferences to the neutral collaboration mode', () => {
    const parsed = userPreferencesSchema.parse({});

    expect(parsed.agent.collaborationMode).toBe('default');
    expect(parsed.featureGates.overrides).toEqual({});
    expect(parsed.memoryNotes).toEqual({
      retention: 'forever',
    });
    expect(parsed.mascotOverlay).toEqual({
      size: 144,
      position: null,
    });
  });

  it('preserves supported collaboration and feature gate overrides', () => {
    const parsed = userPreferencesSchema.parse({
      agent: { collaborationMode: 'review' },
      featureGates: {
        overrides: {
          'collaboration-presets': true,
          'mascot-overlay': true,
        },
      },
      memoryNotes: {
        retention: '90-days',
      },
      mascotOverlay: {
        size: 192,
        position: { x: 24, y: 48 },
      },
    });

    expect(parsed.agent.collaborationMode).toBe('review');
    expect(parsed.featureGates.overrides).toEqual({
      'collaboration-presets': true,
      'mascot-overlay': true,
    });
    expect(parsed.memoryNotes).toEqual({
      retention: '90-days',
    });
    expect(parsed.mascotOverlay).toEqual({
      size: 192,
      position: { x: 24, y: 48 },
    });
  });

  it('sanitizes unsupported collaboration modes and removed feature ids', () => {
    const parsed = userPreferencesSchema.parse({
      agent: { collaborationMode: 'unknown' },
      featureGates: {
        overrides: {
          'collaboration-presets': true,
          'removed-feature': false,
        },
      },
      memoryNotes: {
        retention: 'unsupported',
      },
    });

    expect(parsed.agent.collaborationMode).toBe('default');
    expect(parsed.featureGates.overrides).toEqual({
      'collaboration-presets': true,
    });
    expect(parsed.memoryNotes).toEqual({
      retention: 'forever',
    });
  });

  it('sanitizes invalid mascot size and position values', () => {
    const parsed = userPreferencesSchema.parse({
      mascotOverlay: {
        size: 500,
        position: { x: Number.NaN, y: 10 },
      },
    });

    expect(parsed.mascotOverlay).toEqual({
      size: 144,
      position: null,
    });
  });
});

describe('userPreferencesSchema sidebar defaults', () => {
  it('defaults sidebar preferences when sidebar is missing', () => {
    const parsed = userPreferencesSchema.parse({});

    expect(parsed.sidebar).toEqual({
      showActiveAgents: true,
      pinnedAgentIds: [],
      agentListGroupingMode: 'age',
      workspaceGroupOrder: [],
      collapsedWorkspaceGroupKeys: [],
    });
  });

  it('defaults pinned agent ids for legacy sidebar preferences', () => {
    const parsed = userPreferencesSchema.parse({
      sidebar: { showActiveAgents: false },
    });

    expect(parsed.sidebar).toEqual({
      showActiveAgents: false,
      pinnedAgentIds: [],
      agentListGroupingMode: 'age',
      workspaceGroupOrder: [],
      collapsedWorkspaceGroupKeys: [],
    });
  });

  it('defaults active agents visibility when only pinned ids exist', () => {
    const parsed = userPreferencesSchema.parse({
      sidebar: { pinnedAgentIds: ['agent-b', 'agent-a'] },
    });

    expect(parsed.sidebar).toEqual({
      showActiveAgents: true,
      pinnedAgentIds: ['agent-b', 'agent-a'],
      agentListGroupingMode: 'age',
      workspaceGroupOrder: [],
      collapsedWorkspaceGroupKeys: [],
    });
  });

  it('defaults invalid grouping mode values', () => {
    const parsed = userPreferencesSchema.parse({
      sidebar: { agentListGroupingMode: 'invalid' },
    });

    expect(parsed.sidebar).toEqual({
      showActiveAgents: true,
      pinnedAgentIds: [],
      agentListGroupingMode: 'age',
      workspaceGroupOrder: [],
      collapsedWorkspaceGroupKeys: [],
    });
  });

  it('preserves complete sidebar preferences', () => {
    const parsed = userPreferencesSchema.parse({
      sidebar: {
        showActiveAgents: false,
        pinnedAgentIds: ['agent-a'],
        agentListGroupingMode: 'workspace',
        workspaceGroupOrder: ['repo:b', 'repo:a'],
        collapsedWorkspaceGroupKeys: ['repo:a', 'repo:a:root'],
      },
    });

    expect(parsed.sidebar).toEqual({
      showActiveAgents: false,
      pinnedAgentIds: ['agent-a'],
      agentListGroupingMode: 'workspace',
      workspaceGroupOrder: ['repo:b', 'repo:a'],
      collapsedWorkspaceGroupKeys: ['repo:a', 'repo:a:root'],
    });
  });
});

describe('providerConfigSchema connected coding plan defaults', () => {
  it('preserves legacy provider configs without connected coding plan ids', () => {
    const parsed = providerConfigSchema.parse({ mode: 'official' });

    expect(parsed).toEqual({ mode: 'official' });
  });

  it('preserves valid connected coding plan ids', () => {
    const parsed = providerConfigSchema.parse({
      mode: 'official',
      encryptedApiKey: 'encrypted-key',
      connectedCodingPlanId: 'glm-coding-plan',
    });

    expect(parsed.connectedCodingPlanId).toBe('glm-coding-plan');
  });

  it('sanitizes invalid connected coding plan ids', () => {
    const parsed = providerConfigSchema.parse({
      mode: 'official',
      connectedCodingPlanId: 'unknown-plan',
    });

    expect(parsed.connectedCodingPlanId).toBeUndefined();
  });
});

describe('providerProfileSchema', () => {
  it('defaults legacy preferences to no selected provider', () => {
    const parsed = userPreferencesSchema.parse({});
    expect(parsed.providerProfiles).toEqual([]);
    expect(parsed.defaultProviderProfileId).toBeUndefined();
  });

  it('persists only a credential reference, never key material', () => {
    const parsed = providerProfileSchema.parse({
      id: 'openai-main',
      providerType: 'openai',
      displayName: 'OpenAI',
      apiKeyReference: 'provider.openai-main',
      protocol: 'openai-responses',
      enabled: true,
    });

    expect(parsed).toEqual({
      id: 'openai-main',
      providerType: 'openai',
      displayName: 'OpenAI',
      apiKeyReference: 'provider.openai-main',
      protocol: 'openai-responses',
      customHeaders: {},
      enabled: true,
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-');
  });
});

describe('userPreferencesSchema worktree cleanup snooze defaults', () => {
  it('defaults worktree cleanup snoozes when missing', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceSettings: {},
        disabledModelIds: [],
        disabledPluginIds: [],
        workspaceGitActionPreferences: { general: {}, repositories: {} },
      },
    });

    expect(parsed.agent.workspaceGitCleanup).toEqual({
      dismissedCandidates: {},
    });
  });

  it('preserves valid worktree cleanup snoozes', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceGitCleanup: {
          dismissedCandidates: {
            '/worktree/a': { dismissedAt: 1710000000000 },
            '/worktree/b': { dismissedAt: 1710000001000 },
          },
        },
      },
    });

    expect(parsed.agent.workspaceGitCleanup).toEqual({
      dismissedCandidates: {
        '/worktree/a': { dismissedAt: 1710000000000 },
        '/worktree/b': { dismissedAt: 1710000001000 },
      },
    });
  });

  it('sanitizes invalid worktree cleanup snooze entries', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceGitCleanup: {
          dismissedCandidates: {
            '/worktree/a': { dismissedAt: 1710000000000 },
            '/worktree/b': { dismissedAt: 'invalid' },
            '/worktree/c': null,
          },
        },
      },
    });

    expect(parsed.agent.workspaceGitCleanup).toEqual({
      dismissedCandidates: {
        '/worktree/a': { dismissedAt: 1710000000000 },
      },
    });
  });
});

describe('userPreferencesSchema model thinking override defaults', () => {
  it('defaults model thinking overrides when missing', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceSettings: {},
        disabledModelIds: [],
        disabledPluginIds: [],
        workspaceGitActionPreferences: { general: {}, repositories: {} },
        workspaceGitCleanup: { dismissedCandidates: {} },
      },
    });

    expect(parsed.agent.modelThinkingOverrides).toEqual({});
  });

  it('preserves valid model thinking overrides', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        modelThinkingOverrides: {
          'gpt-5.5': { enabled: true, provider: 'openai', value: 'high' },
          'claude-opus-4.8': { enabled: false, provider: 'anthropic' },
        },
      },
    });

    expect(parsed.agent.modelThinkingOverrides).toEqual({
      'gpt-5.5': { enabled: true, provider: 'openai', value: 'high' },
      'claude-opus-4.8': { enabled: false, provider: 'anthropic' },
    });
  });

  it('sanitizes invalid model thinking override entries field-by-field', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        modelThinkingOverrides: {
          'gpt-5.5': { enabled: true, provider: 'invalid', value: 'high' },
          'claude-opus-4.8': { enabled: 'nope', provider: 'anthropic' },
          'gemini-3.1-pro-preview': null,
        },
      },
    });

    expect(parsed.agent.modelThinkingOverrides).toEqual({
      'gpt-5.5': { enabled: true, value: 'high' },
      'claude-opus-4.8': { provider: 'anthropic' },
      'gemini-3.1-pro-preview': {},
    });
  });
});

describe('userPreferencesSchema workspace Git action defaults', () => {
  it('defaults workspace Git action preferences when missing', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceSettings: {},
        disabledModelIds: [],
        disabledPluginIds: [],
      },
    });

    expect(parsed.agent.workspaceGitActionPreferences).toEqual({
      general: {},
      repositories: {},
    });
  });

  it('preserves valid workspace Git action preferences', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceGitActionPreferences: {
          general: { selectedAction: 'create-branch' },
          repositories: {
            '/repo/.git': {
              selectedAction: 'create-worktree',
              createWorktreeFrom: 'develop',
              createBranchFrom: 'release',
              switchWorktreeTarget: '/repo/worktrees/test',
            },
          },
        },
      },
    });

    expect(parsed.agent.workspaceGitActionPreferences).toEqual({
      general: { selectedAction: 'create-branch' },
      repositories: {
        '/repo/.git': {
          selectedAction: 'create-worktree',
          createWorktreeFrom: 'develop',
          createBranchFrom: 'release',
          switchWorktreeTarget: '/repo/worktrees/test',
        },
      },
    });
  });

  it('defaults invalid workspace Git action preference values', () => {
    const parsed = userPreferencesSchema.parse({
      agent: {
        workspaceGitActionPreferences: {
          general: { selectedAction: 'invalid-action' },
          repositories: {
            '/repo/.git': { selectedAction: 'invalid-action' },
          },
        },
      },
    });

    expect(parsed.agent.workspaceGitActionPreferences).toEqual({
      general: {},
      repositories: {
        '/repo/.git': {},
      },
    });
  });
});
