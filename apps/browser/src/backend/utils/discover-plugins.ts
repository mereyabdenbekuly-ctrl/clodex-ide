import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pluginMetadataSchema, type PluginDefinition } from '@shared/plugins';
import { pluginMarketplaceManifestSchema } from '@shared/plugin-marketplace';
import { parseFrontmatter } from '@/agents/shared/prompts/utils/get-skills';

export async function discoverPlugins(
  pluginsDir: string,
  source: PluginDefinition['source'] = 'bundled',
): Promise<PluginDefinition[]> {
  if (!existsSync(pluginsDir)) return [];

  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const plugins: PluginDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = resolve(pluginsDir, entry.name);
    const metadataPath = resolve(pluginDir, 'metadata.json');
    if (!existsSync(metadataPath)) continue;

    let metadata: ReturnType<typeof pluginMetadataSchema.safeParse>;
    try {
      const raw = await readFile(metadataPath, 'utf-8');
      metadata = pluginMetadataSchema.safeParse(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!metadata.success) continue;

    let logoSvg: string | null = null;
    const logoPath = resolve(pluginDir, 'logo.svg');
    if (existsSync(logoPath)) {
      try {
        logoSvg = await readFile(logoPath, 'utf-8');
      } catch {
        // ignore unreadable logo
      }
    }

    const skills: PluginDefinition['skills'] = [];
    const skillMdPath = resolve(pluginDir, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      try {
        const content = await readFile(skillMdPath, 'utf-8');
        const fm = parseFrontmatter(content);
        if (fm.name && fm.description) {
          skills.push({ name: fm.name, description: fm.description });
        }
      } catch {
        // ignore unreadable skill
      }
    }

    let version: string | null = null;
    let permissions: PluginDefinition['permissions'] = [];
    const manifestPath = resolve(pluginDir, 'plugin.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const manifest = pluginMarketplaceManifestSchema.safeParse(
          JSON.parse(raw),
        );
        if (manifest.success && manifest.data.id === entry.name) {
          version = manifest.data.version;
          permissions = manifest.data.permissions;
        }
      } catch {
        // Bundled legacy plugins do not need a marketplace manifest.
      }
    }

    plugins.push({
      id: entry.name,
      displayName: metadata.data.displayName,
      description: metadata.data.description,
      requiredCredentials: metadata.data.requiredCredentials,
      logoSvg,
      skills,
      source,
      version,
      permissions,
    });
  }

  return plugins;
}
