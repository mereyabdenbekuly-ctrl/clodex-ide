import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@clodex/stage-ui/components/button';
import {
  AlertCircleIcon,
  GitPullRequestArrowIcon,
  Loader2Icon,
  SearchIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  HostedPullRequestQuery,
  HostedPullRequestResult,
} from '@shared/hosted-pull-request';
import {
  useKartonConnected,
  useKartonProcedure,
} from '@pages/hooks/use-karton';
import { HostedPullRequestReview } from '@ui/screens/pull-request/hosted-pull-request-review';

type PullRequestSearch = {
  workspace?: string;
  url?: string;
};

export const Route = createFileRoute('/pull-request')({
  validateSearch: (search: Record<string, unknown>): PullRequestSearch => ({
    workspace:
      typeof search.workspace === 'string' && search.workspace.trim()
        ? search.workspace
        : undefined,
    url:
      typeof search.url === 'string' && search.url.trim()
        ? search.url
        : undefined,
  }),
  component: HostedPullRequestPage,
  head: () => ({
    meta: [{ title: 'Hosted pull request review' }],
  }),
});

function QueryPrompt({
  initialValue,
  message,
  onSubmit,
}: {
  initialValue: string;
  message?: string;
  onSubmit: (url: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <div className="flex min-h-screen items-start justify-center bg-token-main-surface-primary px-4 pt-[clamp(5rem,16vh,10rem)]">
      <div className="w-full max-w-xl rounded-2xl border border-token-border-light bg-token-main-surface-primary p-6 shadow-codex-xl">
        <div className="flex size-10 items-center justify-center rounded-xl bg-clodex-green-400/10 text-clodex-green-400">
          <GitPullRequestArrowIcon className="size-5" />
        </div>
        <h1 className="mt-4 font-semibold text-lg text-token-text-primary">
          Review a hosted pull request
        </h1>
        <p className="mt-1 text-sm text-token-text-tertiary">
          Paste a GitHub pull request URL. Private repositories use the GitHub
          Personal Access Token configured in Settings → Plugins.
        </p>
        {message && (
          <div className="mt-4 flex gap-2 rounded-xl border border-warning-foreground/20 bg-warning-foreground/7 px-3 py-2.5 text-token-text-secondary text-xs leading-5">
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
            {message}
          </div>
        )}
        <form
          className="mt-5 flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit(value);
          }}
        >
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-token-border-light bg-token-bg-secondary/35 px-3 focus-within:border-token-border-default">
            <SearchIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
            <input
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              aria-label="GitHub pull request URL"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-token-text-tertiary"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            className="h-10 rounded-xl px-4"
            disabled={!value.trim()}
          >
            Review
          </Button>
        </form>
      </div>
    </div>
  );
}

function HostedPullRequestPage() {
  const search = Route.useSearch();
  const isConnected = useKartonConnected();
  const getHostedPullRequest = useKartonProcedure(
    (procedures) => procedures.getHostedPullRequest,
  );
  const submitHostedPullRequestReview = useKartonProcedure(
    (procedures) => procedures.submitHostedPullRequestReview,
  );
  const mergeHostedPullRequest = useKartonProcedure(
    (procedures) => procedures.mergeHostedPullRequest,
  );
  const openExternalUrl = useKartonProcedure(
    (procedures) => procedures.openExternalUrl,
  );
  const [query, setQuery] = useState<HostedPullRequestQuery | null>(() => {
    if (search.url) return { url: search.url };
    if (search.workspace) return { workspacePath: search.workspace };
    return null;
  });
  const [result, setResult] = useState<HostedPullRequestResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!isConnected || !query) return;
    let cancelled = false;
    void getHostedPullRequest(query)
      .then((nextResult) => {
        if (cancelled) return;
        setResult(nextResult);
      })
      .catch((error) => {
        if (cancelled) return;
        setResult({
          status: 'unavailable',
          reason: 'provider-error',
          message:
            error instanceof Error
              ? error.message
              : 'Hosted pull request review failed.',
          authenticated: false,
          retryable: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [getHostedPullRequest, isConnected, query, refreshKey]);

  const submitUrl = useCallback((url: string) => {
    const normalized = url.trim();
    if (!normalized) return;
    const nextUrl = new URL(window.location.href);
    nextUrl.search = '';
    nextUrl.searchParams.set('url', normalized);
    window.history.replaceState(null, '', nextUrl.toString());
    setResult(null);
    setQuery({ url: normalized });
  }, []);

  if (!query) {
    return <QueryPrompt initialValue="" onSubmit={submitUrl} />;
  }

  if (!isConnected || !result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-token-main-surface-primary">
        <div className="flex items-center gap-2 text-sm text-token-text-tertiary">
          <Loader2Icon className="size-4 animate-spin" />
          Loading hosted pull request…
        </div>
      </div>
    );
  }

  if (result.status === 'unavailable') {
    return (
      <QueryPrompt
        initialValue={query.url ?? ''}
        message={result.message}
        onSubmit={submitUrl}
      />
    );
  }

  return (
    <HostedPullRequestReview
      pullRequest={result.pullRequest}
      authenticated={result.authenticated}
      onRefresh={() => setRefreshKey((current) => current + 1)}
      onOpenExternal={(url) => void openExternalUrl(url)}
      onSubmitReview={(input) => submitHostedPullRequestReview(input)}
      onMerge={(input) => mergeHostedPullRequest(input)}
    />
  );
}
