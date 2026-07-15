import type { SVGProps } from 'react';
import {
  BrainCircuit,
  Database,
  Download,
  Earth,
  FileText,
  Folder,
  FolderOpen,
  History,
  KeyRound,
  OctagonAlert,
  PenTool,
  Settings,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string, Icon: LucideIcon) =>
  ({ size = 18, width, height, children: _children, ...props }: IconProps) => (
    <Icon
      aria-hidden="true"
      data-icon={label}
      fill="currentColor"
      fillOpacity={0.22}
      height={height ?? size}
      strokeWidth={1.8}
      width={width ?? size}
      {...props}
    />
  );

export const IconBrainNodesFillDuo18 = createIcon(
  'IconBrainNodesFillDuo18',
  BrainCircuit,
);
export const IconDatabaseFillDuo18 = createIcon(
  'IconDatabaseFillDuo18',
  Database,
);
export const IconDownload4FillDuo18 = createIcon(
  'IconDownload4FillDuo18',
  Download,
);
export const IconEarthFillDuo18 = createIcon('IconEarthFillDuo18', Earth);
export const IconFinderFillDuo18 = createIcon(
  'IconFinderFillDuo18',
  FolderOpen,
);
export const IconFolderContent2FillDuo18 = createIcon(
  'IconFolderContent2FillDuo18',
  Folder,
);
export const IconGear3FillDuo18 = createIcon('IconGear3FillDuo18', Settings);
export const IconHistoryFillDuo18 = createIcon('IconHistoryFillDuo18', History);
export const IconLockKeyFillDuo18 = createIcon(
  'IconLockKeyFillDuo18',
  KeyRound,
);
export const IconNoteFillDuo18 = createIcon('IconNoteFillDuo18', FileText);
export const IconPenDrawSparkleFillDuo18 = createIcon(
  'IconPenDrawSparkleFillDuo18',
  PenTool,
);
export const IconSpace3dFillDuo18 = createIcon(
  'IconSpace3dFillDuo18',
  Sparkles,
);
export const IconTriangleWarningFillDuo18 = createIcon(
  'IconTriangleWarningFillDuo18',
  TriangleAlert,
);
export const IconWarningFillDuo18 = createIcon(
  'IconWarningFillDuo18',
  OctagonAlert,
);
