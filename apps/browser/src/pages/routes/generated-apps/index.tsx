import { createFileRoute } from '@tanstack/react-router';
import {
  useKartonConnected,
  useKartonProcedure,
} from '@pages/hooks/use-karton';
import {
  GENERATED_APP_LIBRARY_URL,
  type GeneratedApp,
  type GeneratedAppsSummary,
} from '@shared/generated-apps';
import {
  GeneratedAppsCatalog,
  type GeneratedAppsActionState,
  type GeneratedAppsNotice,
} from '@ui/screens/generated-apps';
import { getGeneratedAppsSummary } from '@ui/screens/generated-apps/generated-apps-model';
import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_SUMMARY: GeneratedAppsSummary = {
  total: 0,
  ready: 0,
  needsAttention: 0,
  regenerating: 0,
};

export const Route = createFileRoute('/generated-apps/')({
  component: GeneratedAppsPage,
  head: () => ({
    meta: [{ title: 'Generated apps' }],
  }),
});

function GeneratedAppsPage() {
  const connected = useKartonConnected();
  const listGeneratedApps = useKartonProcedure(
    (procedures) => procedures.listGeneratedApps,
  );
  const launchGeneratedApp = useKartonProcedure(
    (procedures) => procedures.launchGeneratedApp,
  );
  const deleteGeneratedApp = useKartonProcedure(
    (procedures) => procedures.deleteGeneratedApp,
  );
  const regenerateGeneratedApp = useKartonProcedure(
    (procedures) => procedures.regenerateGeneratedApp,
  );
  const [apps, setApps] = useState<GeneratedApp[]>([]);
  const [summary, setSummary] = useState<GeneratedAppsSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<GeneratedAppsNotice>(null);
  const [actionState, setActionState] =
    useState<GeneratedAppsActionState>(null);
  const requestGenerationRef = useRef(0);

  const loadApps = useCallback(async () => {
    if (!connected) return;
    const generation = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listGeneratedApps({ sort: 'updated-desc' });
      if (generation !== requestGenerationRef.current) return;
      setApps(result.apps);
      setSummary(result.summary);
    } catch (loadError) {
      if (generation !== requestGenerationRef.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'The generated app library could not be loaded.',
      );
    } finally {
      if (generation === requestGenerationRef.current) setIsLoading(false);
    }
  }, [connected, listGeneratedApps]);

  useEffect(() => {
    if (!connected) return;
    void loadApps();
  }, [connected, loadApps]);

  const updateApp = (updated: GeneratedApp) => {
    setApps((current) => {
      const next = current.map((app) =>
        app.key === updated.key ? updated : app,
      );
      setSummary(getGeneratedAppsSummary(next));
      return next;
    });
  };

  const handleLaunch = async (app: GeneratedApp) => {
    setNotice(null);
    setActionState({ kind: 'launch', key: app.key });
    try {
      const result = await launchGeneratedApp({ key: app.key });
      if (result.ok) {
        updateApp(result.app);
        setNotice({
          tone: 'success',
          message: `Opened “${result.app.title}” in a new preview tab.`,
        });
        return;
      }
      setNotice({ tone: 'error', message: result.message });
    } catch (launchError) {
      setNotice({
        tone: 'error',
        message:
          launchError instanceof Error
            ? launchError.message
            : 'The app preview could not be opened.',
      });
    } finally {
      setActionState(null);
    }
  };

  const handleDelete = async (app: GeneratedApp): Promise<boolean> => {
    setNotice(null);
    setActionState({ kind: 'delete', key: app.key });
    try {
      const result = await deleteGeneratedApp({ key: app.key });
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message });
        return false;
      }
      setApps((current) => {
        const next = current.filter((candidate) => candidate.key !== app.key);
        setSummary(getGeneratedAppsSummary(next));
        return next;
      });
      setNotice({
        tone: 'success',
        message: `Deleted “${app.title}”. The owner task was preserved.`,
      });
      return true;
    } catch (deleteError) {
      setNotice({
        tone: 'error',
        message:
          deleteError instanceof Error
            ? deleteError.message
            : 'The generated app could not be deleted.',
      });
      return false;
    } finally {
      setActionState(null);
    }
  };

  const handleRegenerate = async (app: GeneratedApp): Promise<boolean> => {
    setNotice(null);
    setActionState({ kind: 'regenerate', key: app.key });
    try {
      const result = await regenerateGeneratedApp({ key: app.key });
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message });
        return false;
      }
      updateApp(result.app);
      setNotice({ tone: 'info', message: result.message });
      return true;
    } catch (regenerateError) {
      setNotice({
        tone: 'error',
        message:
          regenerateError instanceof Error
            ? regenerateError.message
            : 'The regeneration request could not be sent.',
      });
      return false;
    } finally {
      setActionState(null);
    }
  };

  return (
    <GeneratedAppsCatalog
      apps={apps}
      summary={summary}
      isLoading={!connected || isLoading}
      error={error}
      notice={notice}
      actionState={actionState}
      onRefresh={loadApps}
      onOpenDetails={(app) => {
        window.location.href = `${GENERATED_APP_LIBRARY_URL}/${encodeURIComponent(app.key)}`;
      }}
      onLaunch={handleLaunch}
      onDelete={handleDelete}
      onRegenerate={handleRegenerate}
    />
  );
}
