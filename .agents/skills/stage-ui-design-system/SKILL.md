---
name: stage-ui-design-system
description: Stagewise UI theming, design tokens, derived utilities, and component library reference. Use when creating, editing, or reviewing UI in apps/browser, implementing new screens or components, or styling with Tailwind in the stagewise codebase.
---

# Stage UI Design System

All UI in `apps/browser/` is built on `@stagewise/stage-ui` — a shared design system using **OKLCH colors**, **Tailwind CSS 4**, and **Base UI (React)** primitives.

## Importing Styles & Components

**Styles** — import the CSS entry point (already done in the browser app):
```css
@import "../../../../../packages/stage-ui/src/styles/index.css";
```

**Components** — import via package alias:
```tsx
import { Button } from '@stagewise/stage-ui/components/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@stagewise/stage-ui/components/tooltip';
```

**Utility function** — `cn()` merges Tailwind classes (clsx + twMerge):
```tsx
import { cn } from '@stagewise/stage-ui/lib/utils';
```

## Color System (OKLCH)

All colors use OKLCH with a shared hue `--H: 265` (purple). The palette is defined in `palette.css`.

**Base colors** (`--color-base-50` to `--color-base-950`): Low-chroma, nearly grayscale but subtly tinted. Used for 95%+ of the app.

**Primary colors** (`--color-primary-50` to `--color-primary-950`): High-chroma, saturated. Used for CTAs, links, active states.

**Semantic colors**: `success` (green), `error` (red), `warning` (yellow), `info` (blue) — each has `-background`, `-foreground`, `-solid` variants that auto-switch with light/dark.

## Theme Tokens

Defined in `theme.css`, tokens auto-switch between light and dark mode via `prefers-color-scheme`.

### Backgrounds

| Tailwind class | Token | Usage |
|---|---|---|
| `bg-app-background` | `--color-app-background` | Outermost app chrome |
| `bg-background` | `--color-background` | Main content areas, cards, panels |
| `bg-surface-1` | `--color-surface-1` | First elevation above background |
| `bg-surface-2` | `--color-surface-2` | Second elevation (nested elements) |
| `bg-surface-3` | `--color-surface-3` | Third elevation (deeply nested) |
| `bg-surface-tinted` | `--color-surface-tinted` | Primary-tinted highlight surface |
| `bg-overlay` | `--color-overlay` | Modal/dialog backdrops (use with opacity) |

### Text

| Tailwind class | Usage |
|---|---|
| `text-foreground` | Primary readable text |
| `text-muted-foreground` | Secondary/less important text |
| `text-subtle-foreground` | Hints, placeholders, disabled text |
| `text-primary-foreground` | Accent text (links, highlights) |
| `text-solid-foreground` | Text on solid/primary backgrounds |

### Borders

| Tailwind class | Usage |
|---|---|
| `border-border` | Regular borders |
| `border-border-subtle` | Subtle/lighter borders |

### Primary

| Tailwind class | Usage |
|---|---|
| `bg-primary-solid` | Solid primary fill (buttons, badges) |

### Semantic

Pattern: `(bg|text)-{success|error|warning|info}-{background|foreground|solid}`

## Elevation & Shadows

**Light mode**: Use `bg-background` for cards. Depth comes from shadows.
**Dark mode**: Use escalating surfaces based on nesting depth:
- Element on `bg-background` → use `bg-surface-1`
- Element on `bg-surface-1` → use `bg-surface-2`
- Element on `bg-surface-2` → use `bg-surface-3`

Shadow utilities (defined in `shadows.css`):
- `shadow-elevation-1` — subtle card shadow
- `shadow-elevation-2` — prominent popup/modal shadow

## Derived Utilities

These auto-derive border/hover/active colors from an element's background. **Requires the element to have a `bg-*` class set.**

### Borders (derived from background)
- `border-derived-subtle` — light border
- `border-derived` — regular border
- `border-derived-strong` — strong border
- `border-derived-lighter-subtle` / `border-derived-lighter` — explicitly lighter

Same pattern for rings: `ring-derived-subtle`, `ring-derived`, `ring-derived-strong`

### Hover & Active States
- `hover:bg-hover-derived` — hover background
- `active:bg-active-derived` — active/pressed background
- `hover:text-hover-derived` — hover text
- `active:text-active-derived` — active text

### Explicit Lighten/Darken (ignores dark/light mode)
- `bg-derived-lighter` / `bg-derived-lighter-subtle`
- `bg-derived-darker` / `bg-derived-darker-subtle`
- `text-derived-lighter` / `text-derived-lighter-subtle`

## Animations

Defined in `animations.css`. Use as Tailwind classes:

| Class | Effect |
|---|---|
| `animate-progress-bar-indicator` | Repeating slide for progress bars |
| `animate-skeleton-shimmer` | Loading shimmer for skeletons |
| `animate-caret-blink` | Blinking caret for inputs |
| `animate-icon-pulse` | Stroke-width pulse for icons |
| `animate-pulse-full` | Full opacity pulse (0→1→0) |
| `animate-text-pulse` | Muted↔foreground text pulse |
| `animate-text-pulse-warning` | Foreground↔warning text pulse |
| `shimmer-text` | Shimmering gradient text effect |
| `shimmer-text-primary` | Primary-colored shimmer preset |
| `shimmer-text-once` | One-shot shimmer that settles |

Shimmer config: `shimmer-duration-{ms}`, `shimmer-from-{color}`, `shimmer-to-{color}`

## Component Patterns

All components follow these patterns:

1. **Built on Base UI** (`@base-ui/react`) — unstyled React primitives
2. **Variants via CVA** (`class-variance-authority`) — `variant` and `size` props
3. **Class merging** via `cn()` — all accept `className` for overrides
4. **Compound components** — e.g. `Dialog` + `DialogContent` + `DialogTitle`

### Typical usage example

```tsx
import { Button } from '@stagewise/stage-ui/components/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@stagewise/stage-ui/components/tooltip';

<Tooltip>
  <TooltipTrigger>
    <Button variant="secondary" size="sm">Click me</Button>
  </TooltipTrigger>
  <TooltipContent side="top">Helpful hint</TooltipContent>
</Tooltip>
```

## Available Components

For detailed API and props of each component, see [components-reference.md](components-reference.md).

| Component | Import path | Key props |
|---|---|---|
| **Button** | `components/button` | `variant`: primary, secondary, destructive, warning, success, ghost. `size`: xs, sm, md, lg, icon-2xs, icon-xs, icon-sm, icon-md |
| **Input** | `components/input` | `size`: xs, sm, md. `debounce`: ms. Built on Base UI Input |
| **Select** | `components/select` | `items`, `value`, `onValueChange`, `size`, `triggerVariant`: ghost/secondary, `multiple` |
| **Checkbox** | `components/checkbox` | `size`: xs, sm, md. Built on Base UI Checkbox |
| **Switch** | `components/switch` | `size`: xs, sm, md. Built on Base UI Switch |
| **Radio** | `components/radio` | `RadioGroup` + `Radio` + `RadioLabel`. Built on Base UI Radio |
| **Tabs** | `components/tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| **Dialog** | `components/dialog` | `Dialog`, `DialogTrigger`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogClose`, `DialogHeader`, `DialogFooter` |
| **Popover** | `components/popover` | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverTitle`, `PopoverDescription`, `PopoverClose`, `PopoverFooter` |
| **Tooltip** | `components/tooltip` | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` |
| **Menu** | `components/menu` | `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`, `MenuSeparator`, `MenuSubmenu`, `MenuSubmenuTrigger`, `MenuSubmenuContent` |
| **Collapsible** | `components/collapsible` | `Collapsible`, `CollapsibleTrigger` (size: default/condensed), `CollapsibleContent` |
| **Progress** | `components/progress` | `Progress`, `ProgressTrack` (variant: normal/warning, busy, slim), `ProgressLabel`, `ProgressValue` |
| **Skeleton** | `components/skeleton` | `variant`: rectangle, circle, text. `size`: xs–full. `animate`: boolean |
| **Form** | `components/form` | `Form`, `FormFieldset`, `FormField`, `FormFieldLabel`, `FormFieldTitle`, `FormFieldDescription`, `FormFieldError`, `FormFieldSeparator` |
| **Resizable** | `components/resizable` | `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`. Built on react-resizable-panels |
| **OverlayScrollbar** | `components/overlay-scrollbar` | Custom scrollbar wrapper |
| **Toaster** | `components/toaster` | Toast notification system |
| **Breadcrumb** | `components/breadcrumb` | Breadcrumb navigation |
| **Combobox** | `components/combobox` | Combobox/autocomplete input |
| **InputOtp** | `components/input-otp` | OTP code input |
| **SearchableSelect** | `components/searchable-select` | Searchable dropdown select |
| **SplitText** | `components/split-text` | Text splitting utility |
| **PreviewCard** | `components/preview-card` | Card with preview content |
| **LogoText** | `components/logo-text` | Stagewise logo text |

## Quick Decision Guide

**Picking a background:**
- Top-level page → `bg-app-background`
- Card/panel → `bg-background`
- Nested element → escalate: `bg-surface-1` → `bg-surface-2` → `bg-surface-3`

**Picking text color:**
- Primary content → `text-foreground`
- Secondary info → `text-muted-foreground`
- Placeholder/disabled → `text-subtle-foreground`
- Links/accents → `text-primary-foreground`

**Borders & states (on elements with `bg-*`):**
- Border: `border border-derived` or `border border-derived-subtle`
- Hover: `hover:bg-hover-derived`
- Active: `active:bg-active-derived`

**Icons:** Use `lucide-react` or `nucleo-ui-fill-18` (project-specific icon set).

## Storybook

Preview components and color definitions:
```bash
pnpm --filter stagewise storybook
```
