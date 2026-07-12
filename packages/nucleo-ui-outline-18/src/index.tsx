import type { SVGProps } from 'react';
import {
  AlignLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  BellDot,
  Book,
  BookOpen,
  Brain,
  Bug,
  Cable,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Clipboard,
  ClipboardList,
  Cloud,
  Code,
  Cog,
  Columns2,
  Copy,
  CopyPlus,
  Coffee,
  Database,
  Earth,
  ExternalLink,
  Eye,
  FilePenLine,
  FileSearch,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Globe,
  HardDrive,
  Highlighter,
  Image,
  Info,
  KeyRound,
  Library,
  Loader,
  LockKeyhole,
  LogIn,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquareText,
  Mic,
  Minimize2,
  Moon,
  MoreHorizontal,
  MousePointerClick,
  Music,
  PackagePlus,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pen,
  PenLine,
  PenTool,
  Phone,
  Pin,
  PinOff,
  Plus,
  Presentation,
  Puzzle,
  Redo,
  RefreshCcw,
  Save,
  Search,
  Server,
  Settings,
  Sparkle,
  Sparkles,
  SquareCode,
  SquareDashed,
  SquarePen,
  SquareTerminal,
  Sun,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash,
  TriangleAlert,
  Type,
  Undo,
  UserRound,
  Video,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
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
      height={height ?? size}
      strokeWidth={1.8}
      width={width ?? size}
      {...props}
    />
  );

export const IconArrowRightOutline18 = createIcon(
  'IconArrowRightOutline18',
  ArrowRight,
);
export const IconArrowUpRightOutline18 = createIcon(
  'IconArrowUpRightOutline18',
  ArrowUpRight,
);
export const IconArrowsOppositeDirectionXOutline18 = createIcon(
  'IconArrowsOppositeDirectionXOutline18',
  GitCompareArrows,
);
export const IconArrowsToCenterOutline18 = createIcon(
  'IconArrowsToCenterOutline18',
  Minimize2,
);
export const IconBanOutline18 = createIcon('IconBanOutline18', Ban);
export const IconBellDotOutline18 = createIcon('IconBellDotOutline18', BellDot);
export const IconBookOpen5Outline18 = createIcon(
  'IconBookOpen5Outline18',
  BookOpen,
);
export const IconBookOpenOutline18 = createIcon(
  'IconBookOpenOutline18',
  BookOpen,
);
export const IconBooks2Outline18 = createIcon('IconBooks2Outline18', Library);
export const IconBoxSparkleOutline18 = createIcon(
  'IconBoxSparkleOutline18',
  PackagePlus,
);
export const IconBrainOutline18 = createIcon('IconBrainOutline18', Brain);
export const IconBranchOutOutline18 = createIcon(
  'IconBranchOutOutline18',
  GitBranch,
);
export const IconBugOutline18 = createIcon('IconBugOutline18', Bug);
export const IconCameraOutline18 = createIcon('IconCameraOutline18', Camera);
export const IconCheck2Outline18 = createIcon('IconCheck2Outline18', Check);
export const IconCheckOutline18 = createIcon('IconCheckOutline18', Check);
export const IconChevronDownOutline18 = createIcon(
  'IconChevronDownOutline18',
  ChevronDown,
);
export const IconChevronExpandYOutline18 = createIcon(
  'IconChevronExpandYOutline18',
  ChevronsUpDown,
);
export const IconChevronLeftOutline18 = createIcon(
  'IconChevronLeftOutline18',
  ChevronLeft,
);
export const IconChevronReduceYOutline18 = createIcon(
  'IconChevronReduceYOutline18',
  Minimize2,
);
export const IconChevronRightOutline18 = createIcon(
  'IconChevronRightOutline18',
  ChevronRight,
);
export const IconCircleInfoOutline18 = createIcon(
  'IconCircleInfoOutline18',
  Info,
);
export const IconCircleQuestionOutline18 = createIcon(
  'IconCircleQuestionOutline18',
  CircleHelp,
);
export const IconClipboardContentOutline18 = createIcon(
  'IconClipboardContentOutline18',
  ClipboardList,
);
export const IconClipboardOutline18 = createIcon(
  'IconClipboardOutline18',
  Clipboard,
);
export const IconClone2Outline18 = createIcon('IconClone2Outline18', Copy);
export const IconCloneDashed2Outline18 = createIcon(
  'IconCloneDashed2Outline18',
  CopyPlus,
);
export const IconCodeBranchOutline18 = createIcon(
  'IconCodeBranchOutline18',
  GitBranch,
);
export const IconCodeCommitOutline18 = createIcon(
  'IconCodeCommitOutline18',
  GitCommitHorizontal,
);
export const IconColorPaletteOutline18 = createIcon(
  'IconColorPaletteOutline18',
  Palette,
);
export const IconConnection2Outline18 = createIcon(
  'IconConnection2Outline18',
  Cable,
);
export const IconCopyIdOutline18 = createIcon('IconCopyIdOutline18', Copy);
export const IconCopyOutline18 = createIcon('IconCopyOutline18', Copy);
export const IconDatabaseSearchOutline18 = createIcon(
  'IconDatabaseSearchOutline18',
  Database,
);
export const IconDotsOutline18 = createIcon(
  'IconDotsOutline18',
  MoreHorizontal,
);
export const IconEarthOutline18 = createIcon('IconEarthOutline18', Earth);
export const IconEarthSearchOutline18 = createIcon(
  'IconEarthSearchOutline18',
  Globe,
);
export const IconEnvelopeOutline18 = createIcon('IconEnvelopeOutline18', Mail);
export const IconEye2Outline18 = createIcon('IconEye2Outline18', Eye);
export const IconEyeOutline18 = createIcon('IconEyeOutline18', Eye);
export const IconFilePenOutline18 = createIcon(
  'IconFilePenOutline18',
  FilePenLine,
);
export const IconFileSearchOutline18 = createIcon(
  'IconFileSearchOutline18',
  FileSearch,
);
export const IconFloppyDiskOutline18 = createIcon(
  'IconFloppyDiskOutline18',
  Save,
);
export const IconFolder5Outline18 = createIcon('IconFolder5Outline18', Folder);
export const IconFolderCloudOutline18 = createIcon(
  'IconFolderCloudOutline18',
  Cloud,
);
export const IconFolderOpenOutline18 = createIcon(
  'IconFolderOpenOutline18',
  FolderOpen,
);
export const IconFolderOutline18 = createIcon('IconFolderOutline18', Folder);
export const IconFolderPenOutline18 = createIcon(
  'IconFolderPenOutline18',
  SquarePen,
);
export const IconFolderPlusOutline18 = createIcon(
  'IconFolderPlusOutline18',
  FolderPlus,
);
export const IconFolderSearchOutline18 = createIcon(
  'IconFolderSearchOutline18',
  FolderSearch,
);
export const IconGear2Outline18 = createIcon('IconGear2Outline18', Cog);
export const IconGear3Outline18 = createIcon('IconGear3Outline18', Settings);
export const IconGlobe3Outline18 = createIcon('IconGlobe3Outline18', Globe);
export const IconHardDriveOutline18 = createIcon(
  'IconHardDriveOutline18',
  HardDrive,
);
export const IconHelpChatOutline18 = createIcon(
  'IconHelpChatOutline18',
  MessageCircle,
);
export const IconHotDrinkOutline18 = createIcon(
  'IconHotDrinkOutline18',
  Coffee,
);
export const IconImageSparkle3Outline18 = createIcon(
  'IconImageSparkle3Outline18',
  Image,
);
export const IconKey2Outline18 = createIcon('IconKey2Outline18', KeyRound);
export const IconLoader6Outline18 = createIcon('IconLoader6Outline18', Loader);
export const IconLocation2Outline18 = createIcon(
  'IconLocation2Outline18',
  MapPin,
);
export const IconLockKeyOutline18 = createIcon(
  'IconLockKeyOutline18',
  LockKeyhole,
);
export const IconMagicWandOutline18 = createIcon(
  'IconMagicWandOutline18',
  WandSparkles,
);
export const IconMagnifierMinusOutline18 = createIcon(
  'IconMagnifierMinusOutline18',
  ZoomOut,
);
export const IconMagnifierOutline18 = createIcon(
  'IconMagnifierOutline18',
  Search,
);
export const IconMagnifierPlusOutline18 = createIcon(
  'IconMagnifierPlusOutline18',
  ZoomIn,
);
export const IconMicrophone3Outline18 = createIcon(
  'IconMicrophone3Outline18',
  Mic,
);
export const IconMoonOutline18 = createIcon('IconMoonOutline18', Moon);
export const IconMsgSleepOutline18 = createIcon(
  'IconMsgSleepOutline18',
  MessageCircle,
);
export const IconMsgWritingOutline18 = createIcon(
  'IconMsgWritingOutline18',
  MessageSquareText,
);
export const IconMusicOutline18 = createIcon('IconMusicOutline18', Music);
export const IconOpenExternalOutline18 = createIcon(
  'IconOpenExternalOutline18',
  ExternalLink,
);
export const IconOpenRectArrowInOutline18 = createIcon(
  'IconOpenRectArrowInOutline18',
  LogIn,
);
export const IconPaperclip2Outline18 = createIcon(
  'IconPaperclip2Outline18',
  Paperclip,
);
export const IconPen2Outline18 = createIcon('IconPen2Outline18', Pen);
export const IconPenDrawSparkleOutline18 = createIcon(
  'IconPenDrawSparkleOutline18',
  PenTool,
);
export const IconPenOutline18 = createIcon('IconPenOutline18', Pen);
export const IconPenPlusOutline18 = createIcon(
  'IconPenPlusOutline18',
  SquarePen,
);
export const IconPenWriting3Outline18 = createIcon(
  'IconPenWriting3Outline18',
  PenLine,
);
export const IconPhoneOutline18 = createIcon('IconPhoneOutline18', Phone);
export const IconPinTackOutline18 = createIcon('IconPinTackOutline18', Pin);
export const IconPinTackSlashOutline18 = createIcon(
  'IconPinTackSlashOutline18',
  PinOff,
);
export const IconPlusOutline18 = createIcon('IconPlusOutline18', Plus);
export const IconPresentationScreenVideoOutline18 = createIcon(
  'IconPresentationScreenVideoOutline18',
  Presentation,
);
export const IconPuzzlePieceOutline18 = createIcon(
  'IconPuzzlePieceOutline18',
  Puzzle,
);
export const IconRedoOutline18 = createIcon('IconRedoOutline18', Redo);
export const IconRefreshAnticlockwiseOutline18 = createIcon(
  'IconRefreshAnticlockwiseOutline18',
  RefreshCcw,
);
export const IconSearchContentOutline18 = createIcon(
  'IconSearchContentOutline18',
  Search,
);
export const IconServerOutline18 = createIcon('IconServerOutline18', Server);
export const IconSideProfileSparkleOutline18 = createIcon(
  'IconSideProfileSparkleOutline18',
  UserRound,
);
export const IconSidebarLeftHideOutline18 = createIcon(
  'IconSidebarLeftHideOutline18',
  PanelLeftClose,
);
export const IconSidebarLeftShowOutline18 = createIcon(
  'IconSidebarLeftShowOutline18',
  PanelLeftOpen,
);
export const IconSidebarRightHideOutline18 = createIcon(
  'IconSidebarRightHideOutline18',
  PanelRightClose,
);
export const IconSidebarRightShowOutline18 = createIcon(
  'IconSidebarRightShowOutline18',
  PanelRightOpen,
);
export const IconSparkleOutline18 = createIcon('IconSparkleOutline18', Sparkle);
export const IconSpeakerOutline18 = createIcon(
  'IconSpeakerOutline18',
  Sparkles,
);
export const IconSplitViewOutline18 = createIcon(
  'IconSplitViewOutline18',
  Columns2,
);
export const IconSquareCodeOutline18 = createIcon(
  'IconSquareCodeOutline18',
  SquareCode,
);
export const IconSquareDashedOutline18 = createIcon(
  'IconSquareDashedOutline18',
  SquareDashed,
);
export const IconSquareTerminalOutline18 = createIcon(
  'IconSquareTerminalOutline18',
  SquareTerminal,
);
export const IconSunOutline18 = createIcon('IconSunOutline18', Sun);
export const IconTerminalOutline18 = createIcon(
  'IconTerminalOutline18',
  Terminal,
);
export const IconTextAlignLeft2Outline18 = createIcon(
  'IconTextAlignLeft2Outline18',
  AlignLeft,
);
export const IconTextBgColorOutline18 = createIcon(
  'IconTextBgColorOutline18',
  Highlighter,
);
export const IconTextColorOutline18 = createIcon(
  'IconTextColorOutline18',
  Type,
);
export const IconThumbsDownOutline18 = createIcon(
  'IconThumbsDownOutline18',
  ThumbsDown,
);
export const IconThumbsUpOutline18 = createIcon(
  'IconThumbsUpOutline18',
  ThumbsUp,
);
export const IconTrashOutline18 = createIcon('IconTrashOutline18', Trash);
export const IconTriangleWarningOutline18 = createIcon(
  'IconTriangleWarningOutline18',
  TriangleAlert,
);
export const IconUndoOutline18 = createIcon('IconUndoOutline18', Undo);
export const IconVersionsOutline18 = createIcon('IconVersionsOutline18', Book);
export const IconVideoOutline18 = createIcon('IconVideoOutline18', Video);
export const IconWindowCodeOutline18 = createIcon(
  'IconWindowCodeOutline18',
  Code,
);
export const IconWindowPointerOutline18 = createIcon(
  'IconWindowPointerOutline18',
  MousePointerClick,
);
export const IconXmarkOutline18 = createIcon('IconXmarkOutline18', X);
