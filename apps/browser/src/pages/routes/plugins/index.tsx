import { createFileRoute } from '@tanstack/react-router';
import { PluginLibraryPage } from '@pages/plugin-library-page';

export const Route = createFileRoute('/plugins/')({
  component: PluginsLibraryRoute,
  head: () => ({
    meta: [{ title: 'Skills & Plugins' }],
  }),
});

function PluginsLibraryRoute() {
  return <PluginLibraryPage initialView="plugins" />;
}
