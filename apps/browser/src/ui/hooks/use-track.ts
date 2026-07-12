import { useKartonProcedure } from './use-karton';

export function useTrack() {
  return useKartonProcedure((p) => p.telemetry.capture);
}
