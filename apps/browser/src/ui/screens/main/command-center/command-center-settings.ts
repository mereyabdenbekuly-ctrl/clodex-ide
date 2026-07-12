import type { SettingCommandItem } from './command-center-model';
import type { SettingsRoute } from '@shared/settings-route';

export type CommandCenterSettingDefinition = Omit<
  SettingCommandItem,
  'kind' | 'mode' | 'icon'
> & {
  iconName:
    | 'models'
    | 'key'
    | 'provider'
    | 'settings'
    | 'automations'
    | 'context'
    | 'worktrees'
    | 'remote'
    | 'plugins'
    | 'mcp'
    | 'memory'
    | 'browser'
    | 'history'
    | 'personalization';
  settingsRoute?: SettingsRoute;
};

const ROUTE_MODELS_PROVIDERS: SettingsRoute = { section: 'models-providers' };
const ROUTE_CUSTOM_PROVIDERS: SettingsRoute = { section: 'custom-providers' };
const ROUTE_AGENT_GENERAL: SettingsRoute = { section: 'agent-general' };
const ROUTE_AUTOMATIONS: SettingsRoute = { section: 'automations' };
const ROUTE_MEMORY: SettingsRoute = { section: 'memory' };
const ROUTE_SKILLS_CONTEXT: SettingsRoute = { section: 'skills-context' };
const ROUTE_WORKTREE_SETUP: SettingsRoute = { section: 'worktree-setup' };
const ROUTE_REMOTE_CONNECTIONS: SettingsRoute = {
  section: 'remote-connections',
};
const ROUTE_PLUGINS: SettingsRoute = { section: 'plugins' };
const ROUTE_MCP: SettingsRoute = { section: 'mcp' };
const ROUTE_PERSONALIZATION: SettingsRoute = { section: 'personalization' };
const ROUTE_BROWSING: SettingsRoute = { section: 'browsing' };
const ROUTE_HISTORY: SettingsRoute = { section: 'history' };

export const commandCenterSettings: CommandCenterSettingDefinition[] = [
  {
    id: 'setting:models-providers',
    title: 'Models & Providers',
    subtitle: 'Configure Clodex models, provider keys, and custom endpoints',
    keywords: ['models', 'providers', 'llm', 'ai', 'clodex'],
    url: '',
    settingsRoute: ROUTE_MODELS_PROVIDERS,
    iconName: 'models',
  },
  {
    id: 'setting:api-keys',
    title: 'Set API Keys',
    subtitle: 'Connect Anthropic, OpenAI, Google, and other providers',
    keywords: [
      'api keys',
      'anthropic',
      'openai',
      'google',
      'deepseek',
      'moonshot',
      'alibaba',
      'z-ai',
      'minimax',
      'xiaomi-mimo',
      'mistral',
    ],
    url: '',
    settingsRoute: ROUTE_MODELS_PROVIDERS,
    iconName: 'key',
  },
  {
    id: 'setting:custom-providers',
    title: 'Custom Providers',
    subtitle: 'Manage custom model endpoints',
    keywords: ['custom provider', 'endpoint', 'openai compatible', 'bedrock'],
    url: '',
    settingsRoute: ROUTE_CUSTOM_PROVIDERS,
    iconName: 'provider',
  },
  {
    id: 'setting:agent-general',
    title: 'General Agent Settings',
    subtitle: 'Configure default agent behavior',
    keywords: ['agent', 'general', 'settings', 'behavior'],
    url: '',
    settingsRoute: ROUTE_AGENT_GENERAL,
    iconName: 'settings',
  },
  {
    id: 'setting:automations',
    title: 'Automations',
    subtitle: 'Schedule recurring, one-time, local, and cloud agent tasks',
    keywords: ['automations', 'scheduled tasks', 'cron', 'scheduler', 'wake'],
    url: '',
    settingsRoute: ROUTE_AUTOMATIONS,
    iconName: 'automations',
  },
  {
    id: 'setting:memory',
    title: 'Memory',
    subtitle: 'Export, reset, and configure retention for long-term notes',
    keywords: ['memory', 'notes', 'retention', 'export', 'reset'],
    url: '',
    settingsRoute: ROUTE_MEMORY,
    iconName: 'memory',
  },
  {
    id: 'setting:skills-context',
    title: 'Skills & Context files',
    subtitle: 'Manage skill and context file preferences',
    keywords: ['skills', 'context', 'agents.md', 'workspace.md'],
    url: '',
    settingsRoute: ROUTE_SKILLS_CONTEXT,
    iconName: 'context',
  },
  {
    id: 'setting:worktree-setup',
    title: 'Worktrees',
    subtitle: 'Manage worktree setup scripts',
    keywords: ['worktree', 'worktrees', 'setup', 'script', 'branch'],
    url: '',
    settingsRoute: ROUTE_WORKTREE_SETUP,
    iconName: 'worktrees',
  },
  {
    id: 'setting:remote-connections',
    title: 'Remote Connections',
    subtitle: 'Manage encrypted SSH profiles and live remote sessions',
    keywords: [
      'remote',
      'ssh',
      'server',
      'connection',
      'terminal',
      'private key',
      'password',
    ],
    url: '',
    settingsRoute: ROUTE_REMOTE_CONNECTIONS,
    iconName: 'remote',
  },
  {
    id: 'setting:plugins',
    title: 'Plugins',
    subtitle: 'Configure bundled and enabled plugins',
    keywords: ['plugins', 'extensions', 'tools'],
    url: '',
    settingsRoute: ROUTE_PLUGINS,
    iconName: 'plugins',
  },
  {
    id: 'setting:mcp',
    title: 'MCP & Cloud tools',
    subtitle: 'Inspect the Clodex Tools Gateway and available remote tools',
    keywords: [
      'mcp',
      'model context protocol',
      'cloud tools',
      'gateway',
      'ssh',
      'remote',
    ],
    url: '',
    settingsRoute: ROUTE_MCP,
    iconName: 'mcp',
  },
  {
    id: 'setting:personalization',
    title: 'Personalization',
    subtitle:
      'Configure UI size, theme colors, notifications, and dock behavior',
    keywords: ['personalization', 'theme', 'colors', 'ui size', 'sound'],
    url: '',
    settingsRoute: ROUTE_PERSONALIZATION,
    iconName: 'personalization',
  },
  {
    id: 'setting:browsing',
    title: 'Browsing Settings',
    subtitle: 'Configure browser behavior and permissions',
    keywords: ['browser', 'browsing', 'permissions', 'search engine'],
    url: '',
    settingsRoute: ROUTE_BROWSING,
    iconName: 'browser',
  },
  {
    id: 'setting:history',
    title: 'History',
    subtitle: 'Open browsing history',
    keywords: ['history', 'visited', 'pages'],
    url: '',
    settingsRoute: ROUTE_HISTORY,
    iconName: 'history',
  },
];
