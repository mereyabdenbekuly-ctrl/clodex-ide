import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { cn } from '@clodex/stage-ui/lib/utils';
import { memo, useMemo } from 'react';
import { LoaderCircleIcon } from 'lucide-react';

interface ContextUsageRingProps {
  percentage: number;
  usedKb: number;
  maxKb: number;
  isCompressing?: boolean;
  className?: string;
}

export const ContextUsageRing = memo(function ContextUsageRing({
  percentage,
  usedKb,
  maxKb,
  isCompressing = false,
  className,
}: ContextUsageRingProps) {
  const boundedPercentage = Math.min(100, Math.max(0, percentage));
  const ringColor = useMemo(() => {
    if (boundedPercentage >= 90) return 'text-error-foreground';
    if (boundedPercentage >= 70) return 'text-warning-foreground';
    return 'text-primary-foreground';
  }, [boundedPercentage]);

  const size = 16;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (boundedPercentage / 100) * circumference;

  return (
    <Tooltip>
      <TooltipTrigger>
        <div
          className={cn(
            'relative flex shrink-0 items-center justify-center gap-1.5',
            className,
          )}
          role="progressbar"
          aria-label={`Context usage: ${boundedPercentage}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={boundedPercentage}
        >
          <svg
            width={size}
            height={size}
            className="transition-all duration-300 ease-out"
          >
            {/* Background circle */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-surface-1 dark:text-surface-2"
            />
            {/* Progress circle */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className={`${ringColor} transition-all duration-300 ease-out`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          {isCompressing && (
            <span
              className="flex items-center gap-1 text-muted-foreground text-xs"
              data-context-compaction-status
              aria-live="polite"
            >
              <LoaderCircleIcon className="size-3 animate-spin" />
              Compressing context…
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {boundedPercentage}% - {usedKb}k / {maxKb}k used
      </TooltipContent>
    </Tooltip>
  );
});
