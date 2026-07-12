import {
  useKartonConnected,
  useKartonProcedure,
} from '@pages/hooks/use-karton';
import {
  PLUGIN_LIBRARY_URL,
  createPluginLibraryDetailUrl,
  type PluginLibrarySnapshot,
} from '@shared/plugin-library';
import {
  PluginLibraryCatalog,
  PluginLibraryDetail,
  type PluginLibraryActionState,
  type PluginLibraryNotice,
  type PluginLibraryView,
} from '@ui/screens/plugin-library';
import { createPluginLibraryItems } from '@ui/screens/plugin-library/plugin-library-model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function PluginLibraryPage({
  initialView = 'plugins',
  pluginId,
}: {
  initialView?: PluginLibraryView;
  pluginId?: string;
}) {
  const connected = useKartonConnected();
  const getPluginLibrary = useKartonProcedure(
    (procedures) => procedures.getPluginLibrary,
  );
  const refreshPluginLibrary = useKartonProcedure(
    (procedures) => procedures.refreshPluginLibrary,
  );
  const installPlugin = useKartonProcedure(
    (procedures) => procedures.installPluginLibraryItem,
  );
  const updatePlugin = useKartonProcedure(
    (procedures) => procedures.updatePluginLibraryItem,
  );
  const uninstallPlugin = useKartonProcedure(
    (procedures) => procedures.uninstallPluginLibraryItem,
  );
  const setPluginEnabled = useKartonProcedure(
    (procedures) => procedures.setPluginLibraryItemEnabled,
  );
  const setCredential = useKartonProcedure(
    (procedures) => procedures.setPluginLibraryCredential,
  );
  const deleteCredential = useKartonProcedure(
    (procedures) => procedures.deletePluginLibraryCredential,
  );
  const [snapshot, setSnapshot] = useState<PluginLibrarySnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<PluginLibraryNotice>(null);
  const [actionState, setActionState] =
    useState<PluginLibraryActionState>(null);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (!connected) return;
    const generation = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const next = await getPluginLibrary();
      if (generation !== requestGenerationRef.current) return;
      setSnapshot(next);
    } catch (loadError) {
      if (generation !== requestGenerationRef.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'The plugin library could not be loaded.',
      );
    } finally {
      if (generation === requestGenerationRef.current) setIsLoading(false);
    }
  }, [connected, getPluginLibrary]);

  useEffect(() => {
    if (!connected) return;
    void load();
  }, [connected, load]);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await refreshPluginLibrary();
      setSnapshot(next);
      setNotice({
        tone: 'success',
        message: 'The signed marketplace catalog was verified and refreshed.',
      });
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'The marketplace catalog could not be refreshed.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const runMarketplaceAction = async (
    kind: 'install' | 'update' | 'uninstall',
    targetPluginId: string,
  ) => {
    const operation = {
      install: installPlugin,
      update: updatePlugin,
      uninstall: uninstallPlugin,
    }[kind];
    setActionState({ kind, pluginId: targetPluginId });
    setNotice(null);
    try {
      const response = await operation(targetPluginId);
      setSnapshot(response.snapshot);
      if (response.result.ok) {
        setNotice({
          tone: 'success',
          message: `${kind === 'install' ? 'Installed' : kind === 'update' ? 'Updated' : 'Uninstalled'} ${targetPluginId}.`,
        });
      } else {
        setNotice({
          tone: 'error',
          message: `${response.result.error}${response.result.rolledBack ? ' The previous installation was restored.' : ''}`,
        });
      }
    } catch (operationError) {
      setNotice({
        tone: 'error',
        message:
          operationError instanceof Error
            ? operationError.message
            : `The plugin ${kind} operation failed.`,
      });
      await load();
    } finally {
      setActionState(null);
    }
  };

  const toggle = async (targetPluginId: string, enabled: boolean) => {
    setActionState({ kind: 'toggle', pluginId: targetPluginId });
    setNotice(null);
    try {
      setSnapshot(await setPluginEnabled(targetPluginId, enabled));
      setNotice({
        tone: 'success',
        message: `${targetPluginId} is now ${enabled ? 'enabled' : 'disabled'} for agents.`,
      });
    } catch (toggleError) {
      setNotice({
        tone: 'error',
        message:
          toggleError instanceof Error
            ? toggleError.message
            : 'The plugin state could not be changed.',
      });
    } finally {
      setActionState(null);
    }
  };

  const saveCredential = async (
    typeId: string,
    data: Record<string, string>,
  ) => {
    setActionState({
      kind: 'credential',
      pluginId: pluginId ?? typeId,
    });
    setNotice(null);
    try {
      setSnapshot(await setCredential({ typeId, data }));
      setNotice({
        tone: 'success',
        message: 'The credential was encrypted and saved locally.',
      });
    } catch (credentialError) {
      setNotice({
        tone: 'error',
        message:
          credentialError instanceof Error
            ? credentialError.message
            : 'The credential could not be saved.',
      });
      throw credentialError;
    } finally {
      setActionState(null);
    }
  };

  const removeCredential = async (typeId: string) => {
    setActionState({
      kind: 'credential',
      pluginId: pluginId ?? typeId,
    });
    setNotice(null);
    try {
      setSnapshot(await deleteCredential(typeId));
      setNotice({
        tone: 'success',
        message: 'The stored credential was removed.',
      });
    } catch (credentialError) {
      setNotice({
        tone: 'error',
        message:
          credentialError instanceof Error
            ? credentialError.message
            : 'The credential could not be removed.',
      });
      throw credentialError;
    } finally {
      setActionState(null);
    }
  };

  const selectedItem = useMemo(() => {
    if (!snapshot || !pluginId) return null;
    return (
      createPluginLibraryItems(snapshot).find((item) => item.id === pluginId) ??
      null
    );
  }, [pluginId, snapshot]);

  if (pluginId) {
    return (
      <PluginLibraryDetail
        item={selectedItem}
        snapshot={snapshot}
        isLoading={!connected || isLoading}
        error={
          error ??
          (!isLoading && snapshot && !selectedItem
            ? 'This plugin is no longer present in the library.'
            : null)
        }
        notice={notice}
        actionState={actionState}
        onBack={() => {
          window.location.href = PLUGIN_LIBRARY_URL;
        }}
        onRefresh={load}
        onMarketplaceAction={runMarketplaceAction}
        onToggle={toggle}
        onSaveCredential={saveCredential}
        onDeleteCredential={removeCredential}
      />
    );
  }

  return (
    <PluginLibraryCatalog
      snapshot={snapshot}
      isLoading={!connected || isLoading}
      error={error}
      notice={notice}
      actionState={actionState}
      initialView={initialView}
      onRefresh={refresh}
      onOpenPlugin={(targetPluginId) => {
        window.location.href = createPluginLibraryDetailUrl(targetPluginId);
      }}
      onMarketplaceAction={runMarketplaceAction}
      onToggle={toggle}
    />
  );
}
