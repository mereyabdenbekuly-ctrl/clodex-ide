export interface DictationOrbPosition {
  x: number;
  y: number;
}

export interface DictationOrbViewport {
  width: number;
  height: number;
}

export const DICTATION_ORB_SIZE = 56;
export const DICTATION_ORB_MARGIN = 16;
export const DICTATION_ORB_DEFAULT_BOTTOM_OFFSET = 112;

export function clampDictationOrbPosition(
  position: DictationOrbPosition,
  viewport: DictationOrbViewport,
): DictationOrbPosition {
  const maxX = Math.max(
    DICTATION_ORB_MARGIN,
    viewport.width - DICTATION_ORB_SIZE - DICTATION_ORB_MARGIN,
  );
  const maxY = Math.max(
    DICTATION_ORB_MARGIN,
    viewport.height - DICTATION_ORB_SIZE - DICTATION_ORB_MARGIN,
  );

  return {
    x: Math.min(Math.max(DICTATION_ORB_MARGIN, position.x), maxX),
    y: Math.min(Math.max(DICTATION_ORB_MARGIN, position.y), maxY),
  };
}

export function getDefaultDictationOrbPosition(
  viewport: DictationOrbViewport,
): DictationOrbPosition {
  return clampDictationOrbPosition(
    {
      x: viewport.width - DICTATION_ORB_SIZE - 24,
      y:
        viewport.height -
        DICTATION_ORB_SIZE -
        DICTATION_ORB_DEFAULT_BOTTOM_OFFSET,
    },
    viewport,
  );
}

export function parseDictationOrbPosition(
  value: string | null,
): DictationOrbPosition | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DictationOrbPosition>;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return {
      x: parsed.x as number,
      y: parsed.y as number,
    };
  } catch {
    return null;
  }
}
