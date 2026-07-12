import { useKartonState } from '@ui/hooks/use-karton';
import type { SettingsSection } from '@shared/settings-route';
import { ModelsProvidersSection } from './sections/models-providers-section';
import { CustomProvidersSection } from './sections/custom-providers-section';
import { GeneralSettingsSection } from './sections/general-settings-section';
import { SkillsContextSection } from './sections/skills-context-section';
import { PluginsSection } from './sections/plugins-section';
import { BrowsingSettingsSection } from './sections/browsing-settings-section';
import { PersonalizationSettingsSection } from './sections/personalization-settings-section';
import { WebsitePermissionsSection } from './sections/website-permissions-section';
import { ClearDataSection } from './sections/clear-data-section';
import { AccountSection } from './sections/account-section';
import { AboutSection } from './sections/about-section';
import { HistorySection } from './sections/history-section';
import { WorktreeSetupSection } from './sections/agent-settings.worktree-setup';
import { AgentOsSettingsSection } from './agent-os/agent-os-settings-section';
import { MemorySettingsSection } from './sections/memory-settings-section';
import { McpSettingsSection } from './sections/mcp-settings-section';
import { RemoteConnectionsSection } from './sections/remote-connections-section';
import { AutomationsSettingsSection } from './sections/automations-settings-section';
import { NetworkEgressSection } from './sections/network-egress-section';

export function SettingsContent() {
  const settingsRoute = useKartonState((s) => s.appScreen.settingsRoute);
  const section = settingsRoute.section as SettingsSection;

  switch (section) {
    case 'models-providers':
      return <ModelsProvidersSection />;
    case 'custom-providers':
      return <CustomProvidersSection />;
    case 'agent-general':
      return <GeneralSettingsSection />;
    case 'agent-os':
      return <AgentOsSettingsSection />;
    case 'network-egress':
      return <NetworkEgressSection />;
    case 'automations':
      return <AutomationsSettingsSection />;
    case 'memory':
      return <MemorySettingsSection />;
    case 'skills-context':
      return <SkillsContextSection />;
    case 'worktree-setup':
      return <WorktreeSetupSection />;
    case 'remote-connections':
      return <RemoteConnectionsSection />;
    case 'plugins':
      return <PluginsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'personalization':
      return <PersonalizationSettingsSection />;
    case 'browsing':
      return <BrowsingSettingsSection />;
    case 'website-permissions':
      return <WebsitePermissionsSection />;
    case 'clear-data':
      return <ClearDataSection />;
    case 'account':
      return <AccountSection />;
    case 'about':
      return <AboutSection />;
    case 'history':
      return <HistorySection />;
  }
}
