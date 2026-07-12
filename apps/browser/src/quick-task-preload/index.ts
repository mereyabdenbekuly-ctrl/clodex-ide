import { contextBridge, ipcRenderer } from 'electron';
import {
  QUICK_TASK_WINDOW_CHANNELS,
  type QuickTaskWindowBridge,
  type QuickTaskWindowContext,
  type QuickTaskWindowSubmitInput,
  type QuickTaskWindowSubmitResult,
} from '../shared/quick-task-window';

const bridge: QuickTaskWindowBridge = {
  getContext: () =>
    ipcRenderer.invoke(
      QUICK_TASK_WINDOW_CHANNELS.getContext,
    ) as Promise<QuickTaskWindowContext>,
  submit: (input: QuickTaskWindowSubmitInput) =>
    ipcRenderer.invoke(
      QUICK_TASK_WINDOW_CHANNELS.submit,
      input,
    ) as Promise<QuickTaskWindowSubmitResult>,
  close: () =>
    ipcRenderer.invoke(QUICK_TASK_WINDOW_CHANNELS.close) as Promise<void>,
  onContext: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(value as QuickTaskWindowContext);
    };
    ipcRenderer.on(QUICK_TASK_WINDOW_CHANNELS.context, handler);
    return () => {
      ipcRenderer.removeListener(QUICK_TASK_WINDOW_CHANNELS.context, handler);
    };
  },
};

contextBridge.exposeInMainWorld('quickTask', bridge);
