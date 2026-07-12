import { FileTextIcon } from 'lucide-react';
import type { BadgeProps } from '../types';
import { BadgeShell } from '../shared/badge-shell';

export function PdfBadge(props: BadgeProps) {
  return (
    <BadgeShell
      {...props}
      icon={<FileTextIcon className="size-3 shrink-0" />}
      tooltipContent={<span>{props.fileName}</span>}
    />
  );
}
