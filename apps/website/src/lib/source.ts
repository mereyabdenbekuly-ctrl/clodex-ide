import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const contentRoot = path.join(process.cwd(), 'content');

export interface LegalPage {
  slug: string;
  title: string;
  source: string;
}

export function getLegalPage(slug: string): LegalPage | null {
  const filepath = path.join(contentRoot, 'legal', `${slug}.mdx`);
  if (!fs.existsSync(filepath)) return null;

  const raw = fs.readFileSync(filepath, 'utf-8');
  const { data, content } = matter(raw);

  return {
    slug,
    title: (data.title as string) ?? slug,
    source: content,
  };
}
