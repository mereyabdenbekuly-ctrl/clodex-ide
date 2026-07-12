import { createFileRoute } from '@tanstack/react-router';
import {
  useKartonConnected,
  useKartonProcedure,
} from '@pages/hooks/use-karton';
import {
  GENERATED_APP_LIBRARY_URL,
  type GeneratedApp,
} from '@shared/generated-apps';
import {
  GeneratedAppDetail,
  type GeneratedAppsActionState,
  type GeneratedAppsNotice,
} from '@ui/screens/generated-apps';
import { useCallback, useEffect, useRef, useState } from 'react';

export const Route = createFileRoute('/generated-apps/$appKey')({
  component: GeneratedAppDetailPage,
  head: () => ({
    meta: [{ title: 'Generated app' }],
  }),
});

function GeneratedAppDetailPage() {
  const { appKey } = Route.useParams();
  const connected = useKartonConnected();
  const getGeneratedApp = useKartonProcedure(
    (procedures) => procedures.getGeneratedApp,
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
  const [app, setApp] = useState<GeneratedApp | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<GeneratedAppsNotice>(null);
  const [actionState, setActionState] =
    useState<GeneratedAppsActionState>(null);
  const requestGenerationRef = useRef(0);

  const loadApp = useCallback(async () => {
    if (!connected) return;
    const generation = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getGeneratedApp({ key: appKey });
      if (generation !== requestGenerationRef.current) return;
      setApp(result);
      if (!result) {
        setError('This generated app no longer exists in the library.');
      }
    } catch (loadError) {
      if (generation !== requestGenerationRef.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'The generated app could not be loaded.',
      );
    } finally {
      if (generation === requestGenerationRef.current) setIsLoading(false);
    }
  }, [appKey, connected, getGeneratedApp]);

  useEffect(() => {
    if (!connected) return;
    void loadApp();
  }, [connected, loadApp]);

  const handleLaunch = async (selectedApp: GeneratedApp) => {
    setNotice(null);
    setActionState({ kind: 'launch', key: selectedApp.key });
    try {
      const result = await launchGeneratedApp({ key: selectedApp.key });
      if (result.ok) {
        setApp(result.app);
        setNotice({
          tone: 'success',
          message: `Opened “${result.app.title}” in a new preview tab.`,
        });
      } else {
        setNotice({ tone: 'error', message: result.message });
      }
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

  const handleDelete = async (selectedApp: GeneratedApp): Promise<boolean> => {
    setNotice(null);
    setActionState({ kind: 'delete', key: selectedApp.key });
    try {
      const result = await deleteGeneratedApp({ key: selectedApp.key });
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message });
        return false;
      }
      window.location.href = GENERATED_APP_LIBRARY_URL;
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

  const handleRegenerate = async (
    selectedApp: GeneratedApp,
  ): Promise<boolean> => {
    setNotice(null);
    setActionState({ kind: 'regenerate', key: selectedApp.key });
    try {
      const result = await regenerateGeneratedApp({
        key: selectedApp.key,
      });
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message });
        return false;
      }
      setApp(result.app);
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
    <GeneratedAppDetail
      app={app}
      isLoading={!connected || isLoading}
      error={error}
      notice={notice}
      actionState={actionState}
      onBack={() => {
        window.location.href = GENERATED_APP_LIBRARY_URL;
      }}
      onRefresh={loadApp}
      onLaunch={handleLaunch}
      onDelete={handleDelete}
      onRegenerate={handleRegenerate}
    />
  );
}
