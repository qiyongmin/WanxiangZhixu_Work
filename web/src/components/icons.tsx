/** Local KBW icon boundary: vendor-neutral Lucide SVG, no icon font or CDN.
 * Icon names and button aria-labels preserve the existing 56-name consumer API.
 * Lucide React is ISC licensed; see THIRD_PARTY_NOTICES.md.
 */
import {
  Activity,
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  Blocks,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Code,
  Columns3,
  Compass,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  FilePenLine,
  FileText,
  Folder,
  GitCommitHorizontal,
  GripVertical,
  History,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Link,
  List,
  ListChecks,
  ListTodo,
  Maximize,
  Moon,
  Palette,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Plus,
  Repeat,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  SunMoon,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';

export type IconName =
  | 'search'
  | 'plus'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'palette'
  | 'layout'
  | 'more'
  | 'chevron-down'
  | 'chevron-right'
  | 'panel-left'
  | 'panel-right'
  | 'cockpit'
  | 'tasks'
  | 'activity'
  | 'folder'
  | 'plug'
  | 'blocks'
  | 'settings'
  | 'overview'
  | 'board'
  | 'week'
  | 'list'
  | 'close'
  | 'edit'
  | 'archive'
  | 'trash'
  | 'grip'
  | 'bell'
  | 'bell-off'
  | 'note'
  | 'paperclip'
  | 'repeat'
  | 'subtasks'
  | 'open'
  | 'restore'
  | 'check'
  | 'eye'
  | 'history'
  | 'expand'
  | 'download'
  | 'file-text'
  | 'bot'
  | 'link'
  | 'shield-check'
  | 'sparkles'
  | 'check-circle'
  | 'clock'
  | 'arrow-left'
  | 'git-commit'
  | 'star'
  | 'layers'
  | 'compass'
  | 'code'
  | 'copy'
  | 'play';

const GLYPHS: Record<IconName, LucideIcon> = {
  'search': Search,
  'plus': Plus,
  'sun': Sun,
  'moon': Moon,
  'auto': SunMoon,
  'palette': Palette,
  'layout': LayoutGrid,
  'more': Ellipsis,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  'cockpit': LayoutDashboard,
  'tasks': ListTodo,
  'activity': Activity,
  'folder': Folder,
  'plug': Plug,
  'blocks': Blocks,
  'settings': Settings,
  'overview': PanelsTopLeft,
  'board': Columns3,
  'week': CalendarDays,
  'list': List,
  'close': X,
  'edit': Pencil,
  'archive': Archive,
  'trash': Trash2,
  'grip': GripVertical,
  'bell': Bell,
  'bell-off': BellOff,
  'note': FilePenLine,
  'paperclip': Paperclip,
  'repeat': Repeat,
  'subtasks': ListChecks,
  'open': ExternalLink,
  'restore': RotateCcw,
  'check': Check,
  'eye': Eye,
  'history': History,
  'expand': Maximize,
  'download': Download,
  'file-text': FileText,
  'bot': Bot,
  'link': Link,
  'shield-check': ShieldCheck,
  'sparkles': Sparkles,
  'check-circle': CircleCheck,
  'clock': Clock3,
  'arrow-left': ArrowLeft,
  'git-commit': GitCommitHorizontal,
  'star': Star,
  'layers': Layers,
  'compass': Compass,
  'code': Code,
  'copy': Copy,
  'play': Play,
};

/** Decorative icon; surrounding button/link supplies the accessible name. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Glyph = GLYPHS[name];
  return <Glyph className="icon" size={size} strokeWidth={1.8} aria-hidden="true" focusable="false" />;
}
