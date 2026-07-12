import { createFileRoute } from '@tanstack/react-router';
import { PluginLibraryPage } from '@pages/plugin-library-page';

export const Route = createFileRoute('/skills/')({
  component: SkillsLibraryRoute,
  head: () => ({
    meta: [{ title: 'Skills' }],
  }),
});

function SkillsLibraryRoute() {
  return <PluginLibraryPage initialView="skills" />;
}
