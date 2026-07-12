// NOTE: This is fully vibe-coded. Feel free to change with vibe-coding as well.
import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_SPEED = 60; // chars/sec

// ── Public types ────────────────────────────────────────────────────────

export type TypingMode = 'char' | 'word' | 'instant' | 'untype';

export interface TypingSegment {
  /** Text to type. Ignored for 'untype' mode. Default: '' */
  text?: string;
  /** Chars per second (char mode) or words per second (word mode). Default: 60 */
  speed?: number;
  /** Milliseconds to wait before this segment starts. Default: 0 */
  pauseBefore?: number;
  /** Reveal granularity. Default: 'char' */
  mode?: TypingMode;
}

export interface ScriptLine {
  segments: TypingSegment[];
  /** CSS class applied to this line's wrapper element */
  className?: string;
  /** Milliseconds to pause before this line starts (applied before the first segment's own pauseBefore) */
  pauseBefore?: number;
}

export interface UseScriptedTypingConfig {
  script: ScriptLine[];
  /** Fallback speed when a segment doesn't specify one. Default: 60 */
  defaultSpeed?: number;
  /** Whether to show a blinking cursor. Default: true */
  cursor?: boolean;
  /** Start the animation on mount. Default: true */
  autoStart?: boolean;
  /** Called once when the entire script finishes */
  onComplete?: () => void;
}

export interface RenderedLine {
  /** Currently visible text for this line */
  text: string;
  /** CSS class from the ScriptLine definition */
  className?: string;
  /** True while this line is the one currently being typed */
  isActive: boolean;
  /** True once every segment in this line has been fully revealed */
  isComplete: boolean;
}

export interface UseScriptedTypingReturn {
  lines: RenderedLine[];
  /** True once the entire script has finished */
  isComplete: boolean;
  /** True while typing is in progress and cursor is enabled */
  showCursor: boolean;
  /** Animation progress from 0 to 1 */
  progress: number;
  /** Restart the animation from the beginning */
  restart: () => void;
  /** Instantly resolve the animation to its final state */
  skipToEnd: () => void;
}

// ── Internal types ──────────────────────────────────────────────────────

interface FlatStep {
  kind: 'pause' | 'type' | 'untype';
  lineIndex: number;
  segmentIndex: number;
  /** For pause steps: duration in ms. For type steps: the segment config */
  pauseMs?: number;
  segment?: TypingSegment;
  /** Cumulative char offset within the line where this segment starts */
  lineCharOffset: number;
  /** For type steps: the full line text after this segment is fully revealed */
  cumulativeText?: string;
}

type EngineState = 'idle' | 'pausing' | 'typing' | 'complete';

// ── Flatten script into a step list ─────────────────────────────────────

function flattenScript(script: ScriptLine[], defaultSpeed: number): FlatStep[] {
  const steps: FlatStep[] = [];

  for (let li = 0; li < script.length; li++) {
    const line = script[li]!;
    let charOffset = 0;
    let runningText = '';

    // Line-level pause
    const linePause = line.pauseBefore ?? 0;
    if (linePause > 0) {
      steps.push({
        kind: 'pause',
        lineIndex: li,
        segmentIndex: 0,
        pauseMs: linePause,
        lineCharOffset: charOffset,
      });
    }

    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si]!;
      const mode = seg.mode ?? 'char';

      // Segment-level pause
      const segPause = seg.pauseBefore ?? 0;
      if (segPause > 0) {
        steps.push({
          kind: 'pause',
          lineIndex: li,
          segmentIndex: si,
          pauseMs: segPause,
          lineCharOffset: charOffset,
        });
      }

      if (mode === 'untype') {
        // Untype step — erases the current line text back to 0
        steps.push({
          kind: 'untype',
          lineIndex: li,
          segmentIndex: si,
          segment: { ...seg, speed: seg.speed ?? defaultSpeed },
          lineCharOffset: 0,
          cumulativeText: runningText,
        });
        charOffset = 0;
        runningText = '';
        continue;
      }

      // Typing step
      const segText = seg.text ?? '';
      runningText += segText;

      steps.push({
        kind: 'type',
        lineIndex: li,
        segmentIndex: si,
        segment: {
          ...seg,
          text: segText,
          speed: seg.speed ?? defaultSpeed,
        },
        lineCharOffset: charOffset,
        cumulativeText: runningText,
      });

      charOffset += segText.length;
    }
  }

  return steps;
}

// ── Compute total script duration in ms ──────────────────────────────

function computeStepDurationMs(step: FlatStep): number {
  if (step.kind === 'pause') return step.pauseMs ?? 0;

  const seg = step.segment;
  if (!seg) return 0;
  const speed = seg.speed ?? DEFAULT_SPEED;

  if (step.kind === 'untype') {
    const charCount = step.cumulativeText?.length ?? 0;
    return charCount > 0 ? (charCount / speed) * 1000 : 0;
  }

  const mode = seg.mode ?? 'char';
  if (mode === 'instant') return 0;

  const textLen = (seg.text ?? '').length;
  if (mode === 'word') {
    const words = (seg.text ?? '').match(/\S+\s*/g);
    return words ? (words.length / speed) * 1000 : 0;
  }

  return textLen > 0 ? (textLen / speed) * 1000 : 0;
}

function computeTotalDurationMs(steps: FlatStep[]): number {
  let total = 0;
  for (const step of steps) total += computeStepDurationMs(step);

  return total;
}

// ── Build rendered lines snapshot ───────────────────────────────────────

function buildLines(
  script: ScriptLine[],
  activeLineIndex: number,
  visibleCharsPerLine: number[],
  lineSourceTexts: string[],
  engineState: EngineState,
): RenderedLine[] {
  return script.map((line, li) => {
    const sourceText = lineSourceTexts[li] ?? '';
    const visibleCount = visibleCharsPerLine[li] ?? 0;
    const text = sourceText.slice(0, visibleCount);
    const isComplete =
      visibleCount >= sourceText.length && sourceText.length > 0;

    const isActive =
      engineState !== 'complete' &&
      engineState !== 'idle' &&
      li === activeLineIndex;

    return {
      text,
      className: line.className,
      isActive,
      isComplete,
    };
  });
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useScriptedTyping({
  script,
  defaultSpeed = DEFAULT_SPEED,
  cursor = true,
  autoStart = true,
  onComplete,
}: UseScriptedTypingConfig): UseScriptedTypingReturn {
  // Flatten the script once (treat script as stable across renders)
  const stepsRef = useRef<FlatStep[]>([]);
  const scriptRef = useRef(script);

  // Animation state kept in refs to avoid per-frame re-renders
  const engineStateRef = useRef<EngineState>('idle');
  const stepIndexRef = useRef(0);
  const charAccRef = useRef(0);
  const pauseRemainingRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const onCompleteRef = useRef(onComplete);
  const cursorRef = useRef(cursor);

  // Per-line visible character counts (mutated in-place for perf)
  const visibleCharsRef = useRef<number[]>([]);

  // Per-line source text (the text that visibleChars slices from)
  const lineSourceTextRef = useRef<string[]>([]);

  // Word-mode tracking
  const wordIndexRef = useRef(0);

  // Progress tracking
  const totalDurationRef = useRef(0);
  const elapsedRef = useRef(0);

  // React state — updated once per frame at most
  const emptySource = new Array(script.length).fill('') as string[];
  const [renderedLines, setRenderedLines] = useState<RenderedLine[]>(() =>
    buildLines(
      script,
      0,
      new Array(script.length).fill(0),
      emptySource,
      'idle',
    ),
  );
  const [isComplete, setIsComplete] = useState(false);
  const [progress, setProgress] = useState(0);

  // Keep callback ref fresh
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // ── Helpers ─────────────────────────────────────────────────────────

  const getActiveLineIndex = useCallback((): number => {
    const steps = stepsRef.current;
    const idx = stepIndexRef.current;
    if (idx >= steps.length) {
      return scriptRef.current.length - 1;
    }
    return steps[idx]!.lineIndex;
  }, []);

  const commitState = useCallback(() => {
    const activeLineIndex = getActiveLineIndex();
    setRenderedLines(
      buildLines(
        scriptRef.current,
        activeLineIndex,
        visibleCharsRef.current,
        lineSourceTextRef.current,
        engineStateRef.current,
      ),
    );
    setIsComplete(engineStateRef.current === 'complete');
    const total = totalDurationRef.current;
    setProgress(total > 0 ? Math.min(elapsedRef.current / total, 1) : 0);
  }, [getActiveLineIndex]);

  // ── Core animation loop ─────────────────────────────────────────────

  const animate = useCallback(() => {
    const now = performance.now();
    const steps = stepsRef.current;

    // First frame — seed timestamp
    if (lastFrameRef.current === null) {
      lastFrameRef.current = now;
      rafRef.current = requestAnimationFrame(animate);
      return;
    }

    const deltaMs = now - lastFrameRef.current;
    lastFrameRef.current = now;
    elapsedRef.current += deltaMs;

    // Walk through steps, consuming time
    let remaining = deltaMs;

    while (remaining > 0 && engineStateRef.current !== 'complete') {
      const idx = stepIndexRef.current;
      if (idx >= steps.length) {
        engineStateRef.current = 'complete';
        break;
      }

      const step = steps[idx];

      // ── Pausing ───────────────────────────────────────────────────
      if (engineStateRef.current === 'pausing') {
        if (pauseRemainingRef.current <= remaining) {
          remaining -= pauseRemainingRef.current;
          pauseRemainingRef.current = 0;
          stepIndexRef.current++;
          engineStateRef.current =
            stepIndexRef.current >= steps.length ? 'complete' : 'typing';
        } else {
          pauseRemainingRef.current -= remaining;
          remaining = 0;
        }
        continue;
      }

      // ── Enter pause / untype / type ─────────────────────────────
      if (!step) continue;
      if (step.kind === 'pause') {
        engineStateRef.current = 'pausing';
        pauseRemainingRef.current = step.pauseMs ?? 0;
        continue;
      }

      const seg = step.segment!;
      const li = step.lineIndex;
      const segText = seg.text ?? '';
      const speed = seg.speed ?? DEFAULT_SPEED;

      // ── Untype mode ─────────────────────────────────────────────
      if (step.kind === 'untype') {
        const deltaSec = remaining / 1000;
        remaining = 0;
        charAccRef.current += speed * deltaSec;
        const charsToErase = Math.floor(charAccRef.current);

        if (charsToErase > 0) {
          charAccRef.current -= charsToErase;
          const current = visibleCharsRef.current[li] ?? 0;
          const next = Math.max(current - charsToErase, 0);
          visibleCharsRef.current[li] = next;

          if (next <= 0) {
            charAccRef.current = 0;
            stepIndexRef.current++;
            engineStateRef.current =
              stepIndexRef.current >= steps.length ? 'complete' : 'typing';
          }
        }
        continue;
      }

      // ── Type steps — update line source text ────────────────────
      if (step.cumulativeText != null) {
        lineSourceTextRef.current[li] = step.cumulativeText;
      }

      const mode = seg.mode ?? 'char';

      if (mode === 'instant') {
        visibleCharsRef.current[li] = step.lineCharOffset + segText.length;
        stepIndexRef.current++;
        engineStateRef.current =
          stepIndexRef.current >= steps.length ? 'complete' : 'typing';
        continue;
      }

      if (mode === 'word') {
        const words = segText.match(/\S+\s*/g) || [segText];
        const msPerWord = 1000 / speed;

        if (wordIndexRef.current >= words.length) {
          wordIndexRef.current = 0;
          stepIndexRef.current++;
          engineStateRef.current =
            stepIndexRef.current >= steps.length ? 'complete' : 'typing';
          continue;
        }

        charAccRef.current += remaining;
        remaining = 0;

        while (
          charAccRef.current >= msPerWord &&
          wordIndexRef.current < words.length
        ) {
          charAccRef.current -= msPerWord;
          wordIndexRef.current++;
          const revealedText = words.slice(0, wordIndexRef.current).join('');
          visibleCharsRef.current[li] =
            step.lineCharOffset + revealedText.length;
        }

        if (wordIndexRef.current >= words.length) {
          visibleCharsRef.current[li] = step.lineCharOffset + segText.length;
          wordIndexRef.current = 0;
          charAccRef.current = 0;
          stepIndexRef.current++;
          engineStateRef.current =
            stepIndexRef.current >= steps.length ? 'complete' : 'typing';
        }
        continue;
      }

      // ── char mode (default) ─────────────────────────────────────
      const deltaSec = remaining / 1000;
      remaining = 0;
      charAccRef.current += speed * deltaSec;
      const charsToReveal = Math.floor(charAccRef.current);

      if (charsToReveal > 0) {
        charAccRef.current -= charsToReveal;
        const currentInSeg =
          (visibleCharsRef.current[li] ?? 0) - step.lineCharOffset;
        const nextInSeg = Math.min(
          currentInSeg + charsToReveal,
          segText.length,
        );
        visibleCharsRef.current[li] = step.lineCharOffset + nextInSeg;

        if (nextInSeg >= segText.length) {
          charAccRef.current = 0;
          stepIndexRef.current++;
          engineStateRef.current =
            stepIndexRef.current >= steps.length ? 'complete' : 'typing';
        }
      }
    }

    // Commit to React state
    commitState();

    if (engineStateRef.current === 'complete') {
      rafRef.current = undefined;
      onCompleteRef.current?.();
      return;
    }

    rafRef.current = requestAnimationFrame(animate);
  }, [commitState]);

  // ── Start / restart ─────────────────────────────────────────────────

  const start = useCallback(() => {
    // Cancel any running animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }

    // Re-flatten (supports calling restart after script changes)
    stepsRef.current = flattenScript(scriptRef.current, defaultSpeed);
    visibleCharsRef.current = new Array(scriptRef.current.length).fill(0);
    lineSourceTextRef.current = new Array(scriptRef.current.length).fill('');
    totalDurationRef.current = computeTotalDurationMs(stepsRef.current);
    elapsedRef.current = 0;

    // Reset engine
    stepIndexRef.current = 0;
    charAccRef.current = 0;
    pauseRemainingRef.current = 0;
    wordIndexRef.current = 0;
    lastFrameRef.current = null;

    if (stepsRef.current.length === 0) {
      engineStateRef.current = 'complete';
      commitState();
      return;
    }

    const firstStep = stepsRef.current[0];
    if (firstStep?.kind === 'pause') {
      engineStateRef.current = 'pausing';
      pauseRemainingRef.current = firstStep?.pauseMs ?? 0;
    } else {
      engineStateRef.current = 'typing';
    }

    commitState();
    rafRef.current = requestAnimationFrame(animate);
  }, [defaultSpeed, animate, commitState]);

  const restart = useCallback(() => {
    setIsComplete(false);
    setProgress(0);
    start();
  }, [start]);

  const skipToEnd = useCallback(() => {
    if (engineStateRef.current === 'complete') return;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }

    // Ensure steps are populated even if start() was never called
    if (stepsRef.current.length === 0) {
      stepsRef.current = flattenScript(scriptRef.current, defaultSpeed);
      visibleCharsRef.current = new Array(scriptRef.current.length).fill(0);
      lineSourceTextRef.current = new Array(scriptRef.current.length).fill('');
    }

    const steps = stepsRef.current;
    for (const step of steps) {
      if (step.kind === 'pause') continue;

      const li = step.lineIndex;

      if (step.kind === 'untype') {
        visibleCharsRef.current[li] = 0;
        lineSourceTextRef.current[li] = '';
        continue;
      }

      if (step.cumulativeText != null) {
        lineSourceTextRef.current[li] = step.cumulativeText;
      }
      const segText = step.segment?.text ?? '';
      visibleCharsRef.current[li] = step.lineCharOffset + segText.length;
    }

    engineStateRef.current = 'complete';
    stepIndexRef.current = steps.length;
    elapsedRef.current = totalDurationRef.current;
    commitState();
    onCompleteRef.current?.();
  }, [commitState, defaultSpeed]);

  // ── Auto-start on mount ─────────────────────────────────────────────

  useEffect(() => {
    scriptRef.current = script;
    if (autoStart) {
      start();
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    };
    // Only re-run when the script identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, autoStart]);

  // ── Return ──────────────────────────────────────────────────────────

  return {
    lines: renderedLines,
    isComplete,
    showCursor: cursorRef.current && !isComplete,
    progress,
    restart,
    skipToEnd,
  };
}
