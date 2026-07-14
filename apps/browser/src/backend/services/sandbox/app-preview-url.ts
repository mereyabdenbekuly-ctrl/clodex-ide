export function createSandboxAppPreviewUrl(input: {
  agentId: string;
  appId: string;
  pluginId?: string;
  title?: string;
  cacheBust: number;
}): string {
  const params = new URLSearchParams({
    agentId: input.agentId,
    t: String(input.cacheBust),
  });
  if (input.pluginId) params.set('pluginId', input.pluginId);

  const trimmedTitle = input.title?.trim();
  if (trimmedTitle) {
    params.set(
      'title',
      Buffer.from(trimmedTitle, 'utf8').toString('base64url'),
    );
  }

  return `clodex://internal/preview/${encodeURIComponent(input.appId)}?${params.toString()}`;
}
