# Components Reference

Detailed API for all `@stagewise/stage-ui` components. Import from `@stagewise/stage-ui/components/{name}`.

---

## Button

```tsx
import { Button, buttonVariants } from '@stagewise/stage-ui/components/button';
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'destructive' \| 'warning' \| 'success' \| 'ghost'` | `'primary'` | Visual style |
| `size` | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'icon-2xs' \| 'icon-xs' \| 'icon-sm' \| 'icon-md'` | `'sm'` | Size variant |

`buttonVariants` is exported for use with CVA in custom elements (e.g. links styled as buttons).

**Variant styling:**
- `primary` — `bg-primary-solid text-solid-foreground` with derived border/hover/active
- `secondary` — `bg-surface-1 text-foreground` with derived border/hover/active
- `destructive` — `bg-error-solid text-solid-foreground`
- `ghost` — transparent, `text-muted-foreground`, hover shows `text-foreground`
- Icon sizes render as circles (`rounded-full`) with square dimensions

```tsx
<Button variant="primary" size="sm">Save</Button>
<Button variant="ghost" size="icon-sm"><XIcon className="size-4" /></Button>
```

---

## Input

```tsx
import { Input } from '@stagewise/stage-ui/components/input';
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `size` | `'xs' \| 'sm' \| 'md'` | `'sm'` | Size variant |
| `debounce` | `number` | — | Debounce `onValueChange` by ms |
| `onValueChange` | `(value: string) => void` | — | Base UI value change callback |

Built on `@base-ui/react/input`. Styled with `bg-surface-1 text-foreground` and subtle focus border.

---

## Select

```tsx
import { Select } from '@stagewise/stage-ui/components/select';
import type { SelectItem } from '@stagewise/stage-ui/components/select';
```

Declarative select with `items` array. Supports single and multi-select.

| Prop | Type | Default | Description |
|---|---|---|---|
| `items` | `SelectItemOrSeparator<Value>[]` | required | Items/separators to render |
| `value` | `Value \| Value[]` | — | Controlled value |
| `onValueChange` | `(value, event) => void` | — | Change callback |
| `multiple` | `boolean` | `false` | Enable multi-select |
| `size` | `'xs' \| 'sm' \| 'md'` | `'md'` | Size variant |
| `triggerVariant` | `'ghost' \| 'secondary'` | `'secondary'` | Trigger visual style |
| `placeholder` | `ReactNode` | `'Select…'` | Placeholder text |
| `renderValue` | `(value) => ReactNode` | — | Custom selected display |
| `renderItem` | `(item) => ReactNode` | — | Custom item rendering |
| `customTrigger` | `(props) => ReactElement` | — | Replace the default trigger |
| `side` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'bottom'` | Popup position |

`SelectItem` shape: `{ value, label, triggerLabel?, description?, icon?, disabled?, group? }`

```tsx
<Select
  items={[
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B', description: 'With description' },
  ]}
  value={selected}
  onValueChange={setSelected}
  size="sm"
/>
```

---

## Checkbox

```tsx
import { Checkbox } from '@stagewise/stage-ui/components/checkbox';
```

| Prop | Type | Default |
|---|---|---|
| `size` | `'xs' \| 'sm' \| 'md'` | `'sm'` |

Checked state uses `bg-primary-solid`. All Base UI Checkbox.Root props supported.

---

## Switch

```tsx
import { Switch } from '@stagewise/stage-ui/components/switch';
```

| Prop | Type | Default |
|---|---|---|
| `size` | `'xs' \| 'sm' \| 'md'` | `'sm'` |

Checked state: `bg-primary-solid` with `border-primary-foreground`. All Base UI Switch.Root props supported.

---

## Radio

```tsx
import { RadioGroup, Radio, RadioLabel } from '@stagewise/stage-ui/components/radio';
```

Compound pattern:
```tsx
<RadioGroup value={value} onValueChange={setValue}>
  <RadioLabel>
    <Radio value="opt1" />
    Option 1
  </RadioLabel>
  <RadioLabel>
    <Radio value="opt2" />
    Option 2
  </RadioLabel>
</RadioGroup>
```

---

## Tabs

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@stagewise/stage-ui/components/tabs';
```

Pill-style tab bar with animated transitions on panel content.

```tsx
<Tabs defaultValue="tab1">
  <TabsList>
    <TabsTrigger value="tab1">Tab 1</TabsTrigger>
    <TabsTrigger value="tab2">Tab 2</TabsTrigger>
  </TabsList>
  <TabsContent value="tab1">Content 1</TabsContent>
  <TabsContent value="tab2">Content 2</TabsContent>
</Tabs>
```

---

## Dialog

```tsx
import {
  Dialog, DialogTrigger, DialogContent, DialogTitle,
  DialogDescription, DialogClose, DialogHeader, DialogFooter,
} from '@stagewise/stage-ui/components/dialog';
```

Full-screen on mobile, centered modal on desktop (`sm:min-w-lg sm:rounded-xl`). Includes backdrop blur.

```tsx
<Dialog>
  <DialogTrigger><Button>Open</Button></DialogTrigger>
  <DialogContent>
    <DialogClose />
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description text</DialogDescription>
    </DialogHeader>
    {/* content */}
    <DialogFooter>
      <Button variant="primary">Confirm</Button>
      <Button variant="secondary">Cancel</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

## Popover

```tsx
import {
  Popover, PopoverTrigger, PopoverContent,
  PopoverTitle, PopoverDescription, PopoverClose, PopoverFooter,
} from '@stagewise/stage-ui/components/popover';
```

Floating panel with backdrop, rounded corners, and scale animation.

| Prop (on Content) | Type | Default |
|---|---|---|
| `side` | `'top' \| 'bottom' \| 'left' \| 'right'` | — |
| `sideOffset` | `number` | `4` |
| `align` | `'start' \| 'center' \| 'end'` | — |

---

## Tooltip

```tsx
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from '@stagewise/stage-ui/components/tooltip';
```

Wrap your app with `<TooltipProvider>` (already done in browser app's context providers).

| Prop (on Content) | Type | Default |
|---|---|---|
| `side` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` |
| `align` | `'start' \| 'center' \| 'end'` | `'center'` |
| `sideOffset` | `number` | `2` |

**TooltipTrigger** uses `render` prop to clone the child — pass a single `ReactElement`.

---

## Menu

```tsx
import {
  Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator,
  MenuSubmenu, MenuSubmenuTrigger, MenuSubmenuContent,
  MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuCheckboxItem,
} from '@stagewise/stage-ui/components/menu';
```

Context/dropdown menu system with submenus. Size prop: `'xs' | 'sm' | 'md'` (default `'sm'`).

```tsx
<Menu>
  <MenuTrigger><Button variant="ghost" size="icon-sm"><MoreIcon /></Button></MenuTrigger>
  <MenuContent side="bottom" align="end">
    <MenuItem>Edit</MenuItem>
    <MenuItem>Duplicate</MenuItem>
    <MenuSeparator />
    <MenuItem className="text-error-foreground">Delete</MenuItem>
  </MenuContent>
</Menu>
```

---

## Collapsible

```tsx
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@stagewise/stage-ui/components/collapsible';
```

| Prop (on Trigger) | Type | Required |
|---|---|---|
| `size` | `'default' \| 'condensed'` | yes |

Animated height transition on expand/collapse.

---

## Progress

```tsx
import { Progress, ProgressTrack, ProgressLabel, ProgressValue } from '@stagewise/stage-ui/components/progress';
```

| Prop (on Track) | Type | Default |
|---|---|---|
| `variant` | `'normal' \| 'warning'` | `'normal'` |
| `busy` | `boolean` | `false` |
| `slim` | `boolean` | `false` |

```tsx
<Progress value={75}>
  <ProgressLabel>Uploading</ProgressLabel>
  <ProgressValue>{(formatted) => formatted}</ProgressValue>
  <ProgressTrack busy />
</Progress>
```

---

## Skeleton

```tsx
import { Skeleton } from '@stagewise/stage-ui/components/skeleton';
```

| Prop | Type | Default |
|---|---|---|
| `variant` | `'rectangle' \| 'circle' \| 'text'` | `'rectangle'` |
| `size` | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | `'md'` |
| `animate` | `boolean` | `true` |

---

## Form

```tsx
import {
  Form, FormFieldset, FormField, FormFieldLabel,
  FormFieldTitle, FormFieldDescription, FormFieldError, FormFieldSeparator,
} from '@stagewise/stage-ui/components/form';
```

Structured form layout. `FormFieldset` accepts a `title` string for section headers.

```tsx
<Form onSubmit={handleSubmit}>
  <FormFieldset title="Account">
    <FormField>
      <FormFieldLabel>Email</FormFieldLabel>
      <Input name="email" />
      <FormFieldError />
    </FormField>
  </FormFieldset>
</Form>
```

---

## Resizable

```tsx
import {
  ResizablePanelGroup, ResizablePanel, ResizableHandle,
} from '@stagewise/stage-ui/components/resizable';
```

Built on `react-resizable-panels`. Used for sidebar/content layout splits.

---

## OverlayScrollbar

```tsx
import { OverlayScrollbar } from '@stagewise/stage-ui/components/overlay-scrollbar';
```

Custom thin scrollbar overlay wrapper. Wrap any scrollable content.

---

## Toaster

```tsx
import { Toaster, toast } from '@stagewise/stage-ui/components/toaster';
```

Toast notification system. Place `<Toaster />` once in the app root.
