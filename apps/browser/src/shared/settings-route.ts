export type SettingsSection =
  | 'models-providers'
  | 'custom-providers'
  | 'agent-general'
  | 'agent-os'
  | 'network-egress'
  | 'automations'
  | 'memory'
  | 'skills-context'
  | 'worktree-setup'
  | 'remote-connections'
  | 'plugins'
  | 'mcp'
  | 'personalization'
  | 'browsing'
  | 'history'
  | 'website-permissions'
  | 'clear-data'
  | 'account'
  | 'about';

export type SettingsRoute =
  | { section: Exclude<SettingsSection, 'website-permissions'> }
  | { section: 'website-permissions'; host: string };

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  'models-providers': 'Models & Providers',
  'custom-providers': 'Custom Providers',
  'agent-general': 'General',
  'agent-os': 'Agent OS',
  'network-egress': 'Network Egress',
  automations: 'Automations',
  memory: 'Memory',
  'skills-context': 'Skills & Context files',
  'worktree-setup': 'Worktrees',
  'remote-connections': 'Remote Connections',
  plugins: 'Plugins',
  mcp: 'MCP & Cloud tools',
  personalization: 'Personalization',
  browsing: 'General',
  history: 'History',
  'website-permissions': 'Website Permissions',
  'clear-data': 'Clear data',
  account: 'Account',
  about: 'About',
};
