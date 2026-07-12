import { z } from 'zod';

export const MASCOT_OVERLAY_MIN_SIZE = 80;
export const MASCOT_OVERLAY_MAX_SIZE = 224;
export const MASCOT_OVERLAY_DEFAULT_SIZE = 144;
export const MASCOT_OVERLAY_VIEWPORT_MARGIN = 16;

export const mascotOverlayPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type MascotOverlayPosition = z.infer<typeof mascotOverlayPositionSchema>;

export const DEFAULT_MASCOT_OVERLAY_PREFERENCES = {
  size: MASCOT_OVERLAY_DEFAULT_SIZE,
  position: null,
} as const;

export const mascotOverlayPreferencesSchema = z
  .object({
    size: z
      .number()
      .int()
      .min(MASCOT_OVERLAY_MIN_SIZE)
      .max(MASCOT_OVERLAY_MAX_SIZE)
      .catch(MASCOT_OVERLAY_DEFAULT_SIZE)
      .default(MASCOT_OVERLAY_DEFAULT_SIZE),
    position: mascotOverlayPositionSchema.nullable().catch(null).default(null),
  })
  .default(DEFAULT_MASCOT_OVERLAY_PREFERENCES)
  .catch(DEFAULT_MASCOT_OVERLAY_PREFERENCES);
export type MascotOverlayPreferences = z.infer<
  typeof mascotOverlayPreferencesSchema
>;

export type MascotOverlayViewport = {
  width: number;
  height: number;
};

export type MascotOverlayBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function resolveAxisBounds(
  viewportSize: number,
  mascotSize: number,
  margin: number,
): { min: number; max: number } {
  const freeSpace = viewportSize - mascotSize;

  if (freeSpace < margin * 2) {
    const centered = Math.max(0, freeSpace / 2);
    return { min: centered, max: centered };
  }

  return {
    min: margin,
    max: freeSpace - margin,
  };
}

export function getMascotOverlayBounds(
  viewport: MascotOverlayViewport,
  size: number,
  margin = MASCOT_OVERLAY_VIEWPORT_MARGIN,
): MascotOverlayBounds {
  const horizontal = resolveAxisBounds(viewport.width, size, margin);
  const vertical = resolveAxisBounds(viewport.height, size, margin);

  return {
    minX: horizontal.min,
    maxX: horizontal.max,
    minY: vertical.min,
    maxY: vertical.max,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampMascotOverlayPosition(
  position: MascotOverlayPosition,
  viewport: MascotOverlayViewport,
  size: number,
  margin = MASCOT_OVERLAY_VIEWPORT_MARGIN,
): MascotOverlayPosition {
  const bounds = getMascotOverlayBounds(viewport, size, margin);

  return {
    x: clamp(position.x, bounds.minX, bounds.maxX),
    y: clamp(position.y, bounds.minY, bounds.maxY),
  };
}

export function getDefaultMascotOverlayPosition(
  viewport: MascotOverlayViewport,
  size: number,
  margin = MASCOT_OVERLAY_VIEWPORT_MARGIN,
): MascotOverlayPosition {
  const bounds = getMascotOverlayBounds(viewport, size, margin);

  return {
    x: bounds.maxX,
    y: bounds.maxY,
  };
}

export function resolveMascotOverlayPosition(
  persistedPosition: MascotOverlayPosition | null,
  viewport: MascotOverlayViewport,
  size: number,
  margin = MASCOT_OVERLAY_VIEWPORT_MARGIN,
): MascotOverlayPosition {
  if (persistedPosition === null) {
    return getDefaultMascotOverlayPosition(viewport, size, margin);
  }

  return clampMascotOverlayPosition(persistedPosition, viewport, size, margin);
}

function applyRubberBand(value: number, min: number, max: number): number {
  if (value < min) return min + (value - min) * 0.24;
  if (value > max) return max + (value - max) * 0.24;
  return value;
}

export function rubberBandMascotOverlayPosition(
  position: MascotOverlayPosition,
  viewport: MascotOverlayViewport,
  size: number,
  margin = MASCOT_OVERLAY_VIEWPORT_MARGIN,
): MascotOverlayPosition {
  const bounds = getMascotOverlayBounds(viewport, size, margin);

  return {
    x: applyRubberBand(position.x, bounds.minX, bounds.maxX),
    y: applyRubberBand(position.y, bounds.minY, bounds.maxY),
  };
}

export type MascotOverlayMotion = {
  position: MascotOverlayPosition;
  velocity: MascotOverlayPosition;
};

export type MascotOverlaySpringStep = MascotOverlayMotion & {
  settled: boolean;
};

export function stepMascotOverlaySpring(
  motion: MascotOverlayMotion,
  target: MascotOverlayPosition,
  deltaMs: number,
): MascotOverlaySpringStep {
  const deltaSeconds = Math.min(Math.max(deltaMs, 0) / 1000, 1 / 30);
  const stiffness = 300;
  const damping = 30;

  const accelerationX =
    stiffness * (target.x - motion.position.x) - damping * motion.velocity.x;
  const accelerationY =
    stiffness * (target.y - motion.position.y) - damping * motion.velocity.y;
  const velocity = {
    x: motion.velocity.x + accelerationX * deltaSeconds,
    y: motion.velocity.y + accelerationY * deltaSeconds,
  };
  const position = {
    x: motion.position.x + velocity.x * deltaSeconds,
    y: motion.position.y + velocity.y * deltaSeconds,
  };
  const settled =
    Math.abs(target.x - position.x) < 0.2 &&
    Math.abs(target.y - position.y) < 0.2 &&
    Math.abs(velocity.x) < 1 &&
    Math.abs(velocity.y) < 1;

  if (settled) {
    return {
      position: target,
      velocity: { x: 0, y: 0 },
      settled: true,
    };
  }

  return { position, velocity, settled: false };
}

export type MascotAgentStatus =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'success'
  | 'error';

export type MascotAgentSnapshot = {
  id: string;
  isWorking: boolean;
  isWaitingForUser: boolean;
  hasError: boolean;
  hasUnseen: boolean;
};

export type MascotAgentSignal = {
  status: MascotAgentStatus;
  targetAgentId: string | null;
};

function getMascotAgentPriority(snapshot: MascotAgentSnapshot): number {
  if (snapshot.hasError) return 4;
  if (snapshot.isWaitingForUser) return 3;
  if (snapshot.isWorking) return 2;
  if (snapshot.hasUnseen) return 1;
  return 0;
}

function getMascotAgentStatus(
  snapshot: MascotAgentSnapshot,
): MascotAgentStatus {
  if (snapshot.hasError) return 'error';
  if (snapshot.isWaitingForUser) return 'waiting';
  if (snapshot.isWorking) return 'working';
  if (snapshot.hasUnseen) return 'success';
  return 'idle';
}

export function deriveMascotAgentSignal(
  snapshots: MascotAgentSnapshot[],
): MascotAgentSignal {
  let selected: MascotAgentSnapshot | null = null;
  let selectedPriority = -1;

  for (const snapshot of snapshots) {
    const priority = getMascotAgentPriority(snapshot);
    if (priority > selectedPriority) {
      selected = snapshot;
      selectedPriority = priority;
    }
  }

  if (selected === null) {
    return { status: 'idle', targetAgentId: null };
  }

  return {
    status: getMascotAgentStatus(selected),
    targetAgentId: selected.id,
  };
}
