import { createFileRoute } from '@tanstack/react-router';
import { PluginLibraryPage } from '@pages/plugin-library-page';

export const Route = createFileRoute('/plugins/$pluginId')({
  component: PluginDetailRoute,
  head: () => ({
    meta: [{ title: 'Plugin detail' }],
  }),
});

function PluginDetailRoute() {
  const { pluginId } = Route.useParams();
  return <PluginLibraryPage pluginId={pluginId} />;
}
