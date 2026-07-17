import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentOs,
  Automations,
  McpRuntime,
  PluginLibrary,
  Workspace,
} from '@ui/assets/feature-images';
import { useTrack } from '@ui/hooks/use-track';
import { cn } from '@ui/utils';
import { useTranslation } from 'react-i18next';

interface Slide {
  trackingName: string;
  heading: string;
  previewHeading: string;
  subtitle: string;
  image: string;
}

const SLIDE_INTERVAL = 6500;
const FADE_DURATION = 200;
const SLIDE_COUNT = 5;

export function StepDemo() {
  const { t } = useTranslation('onboarding');
  const slides = useMemo<Slide[]>(
    () => [
      {
        trackingName: 'Workspace',
        heading: t('demo.slides.workspace.heading'),
        previewHeading: t('demo.slides.workspace.previewHeading'),
        subtitle: t('demo.slides.workspace.subtitle'),
        image: Workspace,
      },
      {
        trackingName: 'Agent OS',
        heading: t('demo.slides.agentOs.heading'),
        previewHeading: t('demo.slides.agentOs.previewHeading'),
        subtitle: t('demo.slides.agentOs.subtitle'),
        image: AgentOs,
      },
      {
        trackingName: 'Automations',
        heading: t('demo.slides.automations.heading'),
        previewHeading: t('demo.slides.automations.previewHeading'),
        subtitle: t('demo.slides.automations.subtitle'),
        image: Automations,
      },
      {
        trackingName: 'MCP Runtime',
        heading: t('demo.slides.mcpRuntime.heading'),
        previewHeading: t('demo.slides.mcpRuntime.previewHeading'),
        subtitle: t('demo.slides.mcpRuntime.subtitle'),
        image: McpRuntime,
      },
      {
        trackingName: 'Extensions',
        heading: t('demo.slides.extensions.heading'),
        previewHeading: t('demo.slides.extensions.previewHeading'),
        subtitle: t('demo.slides.extensions.subtitle'),
        image: PluginLibrary,
      },
    ],
    [t],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [slideKey, setSlideKey] = useState(0);
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const track = useTrack();

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (fadeRef.current) clearTimeout(fadeRef.current);
    timerRef.current = null;
    fadeRef.current = null;
  }, []);

  /** Transition to next/prev index, optionally resuming auto-play. */
  const transitionTo = useCallback(
    (getNext: (prev: number) => number, resumeAutoPlay: boolean) => {
      clearTimers();
      setVisible(false);
      fadeRef.current = setTimeout(() => {
        fadeRef.current = null;
        setActiveIndex(getNext);
        setSlideKey((k) => k + 1);
        setVisible(true);
        if (resumeAutoPlay && !pausedRef.current) {
          timerRef.current = setInterval(
            () => transitionTo((p) => (p + 1) % SLIDE_COUNT, true),
            SLIDE_INTERVAL,
          );
        }
      }, FADE_DURATION);
    },
    [clearTimers],
  );

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);

  const goTo = useCallback(
    (index: number) => {
      if (index === activeIndex) return;
      pause();
      track('onboarding-demo-slide-clicked', {
        slide_name: slides[index]?.trackingName ?? `slide-${index}`,
      });
      transitionTo(() => index, false);
    },
    [activeIndex, pause, track, transitionTo],
  );

  useEffect(() => {
    timerRef.current = setInterval(
      () => transitionTo((p) => (p + 1) % SLIDE_COUNT, true),
      SLIDE_INTERVAL,
    );
    return clearTimers;
  }, [transitionTo, clearTimers]);

  const slide = slides[activeIndex];

  if (!slide) return null;

  return (
    <div className="flex flex-1 items-center justify-center gap-0">
      <div
        className={cn(
          'flex w-fit flex-col items-center transition-opacity',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        style={{ transitionDuration: `${FADE_DURATION}ms` }}
      >
        <h1 className="font-semibold text-2xl text-foreground">
          {slide.heading}
        </h1>
        <p className="pt-1 text-muted-foreground text-sm">{slide.subtitle}</p>
        <div className="flex w-1/2 flex-col gap-2 pt-4">
          <img
            src={slide.image}
            alt={slide.heading}
            className="block h-auto w-full rounded-md border border-border-subtle"
          />
          <SlideIndicators
            slides={slides}
            activeIndex={activeIndex}
            slideKey={slideKey}
            animationDuration={SLIDE_INTERVAL}
            paused={paused}
            onGoTo={goTo}
          />
        </div>
      </div>
    </div>
  );
}

function SlideIndicators({
  slides,
  activeIndex,
  slideKey,
  animationDuration,
  paused,
  onGoTo,
}: {
  slides: Slide[];
  activeIndex: number;
  slideKey: number;
  animationDuration: number;
  paused: boolean;
  onGoTo: (index: number) => void;
}) {
  return (
    <div className="grid w-full grid-cols-5 gap-2 pt-8">
      <style>
        {`@keyframes indicator-fill {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }`}
      </style>
      {slides.map((slide, index) => {
        const isCurrent = index === activeIndex;
        return (
          <button
            type="button"
            key={`slide-btn-${index}`}
            onClick={() => onGoTo(index)}
            className={cn(
              'app-no-drag relative cursor-pointer overflow-hidden rounded-md px-2 py-1.5',
              'text-center font-medium text-xs leading-tight',
              'transition-colors duration-150',
              isCurrent
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground/80',
              'bg-background/l-4_c-2 dark:bg-background/l12_cx0.9',
            )}
          >
            {/* Progress fill layer — only on active slide */}
            {isCurrent && (
              <div
                key={slideKey}
                className="absolute inset-0 bg-background/l-12_c-2 dark:bg-background/l22_cx0.9"
                style={
                  paused
                    ? undefined
                    : {
                        transformOrigin: 'left',
                        animation: `indicator-fill ${animationDuration}ms linear forwards`,
                      }
                }
              />
            )}
            {/* Label on top of fill */}
            <span className="relative z-10">{slide.previewHeading}</span>
          </button>
        );
      })}
    </div>
  );
}
