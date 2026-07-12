import { FilmIcon } from 'lucide-react';
import type { BadgeProps } from '../types';
import { BadgeShell } from '../shared/badge-shell';

export function VideoBadge(props: BadgeProps) {
  return (
    <BadgeShell
      {...props}
      icon={<FilmIcon className="size-3 shrink-0" />}
      tooltipContent={<span>{props.fileName}</span>}
    />
  );
}
