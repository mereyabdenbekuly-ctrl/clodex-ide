import { useMemo } from 'react';
import { useIsContainerScrollable } from './use-is-container-scrollable';

export type ScrollFadeAxis = 'horizontal' | 'vertical' | 'both';

export interface UseScrollFadeMaskOptions {
  /**
   * Which axis to apply the fade mask to.
   * @default 'both'
   */
  axis?: ScrollFadeAxis;
  /**
   * Fade distance in pixels when scrollable in that direction.
   * @default 16
   */
  fadeDistance?: number;
  /**
   * Individual fade distances for each side (overrides fadeDistance).
   */
  fadeDistances?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}

export interface UseScrollFadeMaskReturn {
  /** Style object to spread onto the container element */
  maskStyle: React.CSSProperties;
  /** Whether content can be scrolled left */
  canScrollLeft: boolean;
  /** Whether content can be scrolled right */
  canScrollRight: boolean;
  /** Whether content can be scrolled up */
  canScrollUp: boolean;
  /** Whether content can be scrolled down */
  canScrollDown: boolean;
}

/**
 * Hook that combines scroll detection with fade mask styling.
 *
 * Detects scroll position and returns a style object with CSS mask-image
 * that fades edges where more content is available.
 *
 * @example
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null);
 * const { maskStyle } = useScrollFadeMask(containerRef, {
 *   axis: 'horizontal',
 *   fadeDistance: 32,
 * });
 *
 * return (
 *   <div ref={containerRef} className="mask-alpha overflow-auto" style={maskStyle}>
 *     {children}
 *   </div>
 * );
 * ```
 */
export function useScrollFadeMask(
  containerRef: React.RefObject<HTMLElement | null>,
  options: UseScrollFadeMaskOptions = {},
): UseScrollFadeMaskReturn {
  const { axis = 'both', fadeDistance = 16, fadeDistances } = options;

  const { canScrollLeft, canScrollRight, canScrollUp, canScrollDown } =
    useIsContainerScrollable(containerRef);

  const maskStyle = useMemo(() => {
    // Determine fade distances for each side
    const topFade =
      axis !== 'horizontal' && canScrollUp
        ? (fadeDistances?.top ?? fadeDistance)
        : 0;
    const bottomFade =
      axis !== 'horizontal' && canScrollDown
        ? (fadeDistances?.bottom ?? fadeDistance)
        : 0;
    const leftFade =
      axis !== 'vertical' && canScrollLeft
        ? (fadeDistances?.left ?? fadeDistance)
        : 0;
    const rightFade =
      axis !== 'vertical' && canScrollRight
        ? (fadeDistances?.right ?? fadeDistance)
        : 0;

    // Build gradient strings based on axis
    const gradients: string[] = [];

    if (axis === 'horizontal' || axis === 'both')
      gradients.push(
        `linear-gradient(to right, transparent 0px, black ${leftFade}px, black calc(100% - ${rightFade}px), transparent 100%)`,
      );

    if (axis === 'vertical' || axis === 'both')
      gradients.push(
        `linear-gradient(to bottom, transparent 0px, black ${topFade}px, black calc(100% - ${bottomFade}px), transparent 100%)`,
      );

    const maskImage = gradients.join(', ');

    return {
      maskImage,
      WebkitMaskImage: maskImage,
      // When using multiple gradients, they need to intersect
      ...(gradients.length > 1 && {
        maskComposite: 'intersect',
        WebkitMaskComposite: 'source-in',
      }),
    } as React.CSSProperties;
  }, [
    axis,
    fadeDistance,
    fadeDistances,
    canScrollLeft,
    canScrollRight,
    canScrollUp,
    canScrollDown,
  ]);

  return {
    maskStyle,
    canScrollLeft,
    canScrollRight,
    canScrollUp,
    canScrollDown,
  };
}
