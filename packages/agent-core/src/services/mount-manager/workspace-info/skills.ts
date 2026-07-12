import { resolve } from 'node:path';
import { homedir } from 'node:os';
import matter from 'gray-matter';
import { readFile, readdir, stat } from '../../../fs';

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Whether this skill appears in the slash-command popup. Defaults to `true`. */
  userInvocable: boolean;
  /** Whether this skill appears in the system prompt for the agent. Defaults to `true`. */
  agentInvocable: boolean;
}

export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  userInvocable?: boolean;
  agentInvocable?: boolean;
} {
  try {
    const { data } = matter(content);
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description:
        typeof data.description === 'string' ? data.description : undefined,
      userInvocable:
        typeof data['user-invocable'] === 'boolean'
          ? data['user-invocable']
          : undefined,
      agentInvocable:
        typeof data['agent-invocable'] === 'boolean'
          ? data['agent-invocable']
          : undefined,
    };
  } catch {
    return {};
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function discoverSkills(skillsDir: string): Promise<Skill[]> {
  if (!(await pathExists(skillsDir))) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = resolve(skillsDir, entry.name);
    const skillMdPath = resolve(skillPath, 'SKILL.md');
    if (!(await pathExists(skillMdPath))) continue;

    const content = await readFile(skillMdPath, 'utf-8');
    const meta = parseFrontmatter(content);
    if (!meta.name || !meta.description) continue;

    skills.push({
      name: meta.name,
      description: meta.description,
      path: skillPath,
      userInvocable: meta.userInvocable ?? true,
      agentInvocable: meta.agentInvocable ?? true,
    });
  }

  return skills;
}

/**
 * Discover user-level global skills from ~/.clodex/skills/
 * and ~/.agents/skills/. Does not require a workspace runtime.
 * Deduplicates by name; .clodex wins over .agents.
 */
export async function discoverGlobalSkills(): Promise<Skill[]> {
  const home = homedir();
  const clodexPath = resolve(home, '.clodex', 'skills');
  const agentsPath = resolve(home, '.agents', 'skills');

  const [clodexSkills, agentsSkills] = await Promise.all([
    discoverSkills(clodexPath),
    discoverSkills(agentsPath),
  ]);

  clodexSkills.sort((a, b) => a.name.localeCompare(b.name));
  agentsSkills.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const skill of [...clodexSkills, ...agentsSkills]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    result.push(skill);
  }
  return result;
}

/**
 * Discover workspace-scoped skills under `.clodex/skills/` and
 * `.agents/skills/`. Dedupes by name; `.clodex/` wins over
 * `.agents/`.
 */
export async function getSkills(workspacePath: string): Promise<Skill[]> {
  const clodexSkillsPath = resolve(workspacePath, '.clodex', 'skills');
  const globalSkillsPath = resolve(workspacePath, '.agents', 'skills');

  const [clodexSkills, globalSkills] = await Promise.all([
    discoverSkills(clodexSkillsPath),
    discoverSkills(globalSkillsPath),
  ]);

  clodexSkills.sort((a, b) => a.name.localeCompare(b.name));
  globalSkills.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const result: Skill[] = [];

  for (const skill of [...clodexSkills, ...globalSkills]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    result.push(skill);
  }

  return result;
}
