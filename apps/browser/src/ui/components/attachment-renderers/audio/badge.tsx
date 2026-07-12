import { Music2Icon } from 'lucide-react';
import type { BadgeProps } from '../types';
import { BadgeShell } from '../shared/badge-shell';

export function AudioBadge(props: BadgeProps) {
  return (
    <BadgeShell
      {...props}
      icon={<Music2Icon className="size-3 shrink-0" />}
      tooltipContent={<span>{props.fileName}</span>}
    />
  );
}
