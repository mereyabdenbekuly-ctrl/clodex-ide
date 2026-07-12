import { useEffect, useMemo, useRef } from 'react';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import type {
  CommandCenterItem,
  CommandCenterMode,
} from '../command-center-model';
import { buildGroupedRows } from '../command-center-rows';
import { CommandCenterEmptyState } from './command-center-empty-state';
import { CommandCenterRow } from './command-center-row';

export function CommandCenterResults({
  items,
  mode,
  filesLabel,
  query,
  selectedIndex,
  isLoading,
  renamingAgentId,
  onCancelRename,
  onCommitRename,
  onMouseMoved,
  onSelect,
  onHoverIndex,
}: {
  items: CommandCenterItem[];
  mode: CommandCenterMode;
  filesLabel?: string;
  query: string;
  selectedIndex: number;
  isLoading?: boolean;
  renamingAgentId: string | null;
  onCancelRename: () => void;
  onCommitRename: (agentId: string, newTitle: string) => void;
  onMouseMoved: () => void;
  onSelect: (item: CommandCenterItem) => void;
  onHoverIndex: (index: number) => void;
}) {
  const itemRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const rows = useMemo(
    () => buildGroupedRows(items, mode, { filesLabel }),
    [items, mode, filesLabel],
  );

  useEffect(() => {
    itemRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [rows, selectedIndex]);

  if (items.length === 0) {
    return (
      <div
        id="command-center-results"
        role="listbox"
        aria-label="Command center results"
      >
        <CommandCenterEmptyState
          isLoading={isLoading}
          mode={mode}
          query={query}
        />
      </div>
    );
  }

  return (
    <div
      id="command-center-results"
      role="listbox"
      aria-label="Command center results"
    >
      <OverlayScrollbar className="max-h-[min(52vh,28rem)]">
        <div className="flex flex-col gap-0.5 p-1.5" onMouseMove={onMouseMoved}>
          {rows.map((row) => {
            if (row.type === 'header') {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  className="shrink-0 px-2.5 pt-3 pb-1 font-semibold text-[10px] text-token-text-tertiary uppercase tracking-[0.08em] first:pt-1.5"
                >
                  {row.label}
                </div>
              );
            }

            return (
              <CommandCenterRow
                key={row.item.id}
                item={row.item}
                selected={row.itemIndex === selectedIndex}
                isRenaming={
                  row.item.kind === 'agent' &&
                  row.item.agentId === renamingAgentId
                }
                onCancelRename={onCancelRename}
                onCommitRename={onCommitRename}
                onSelect={() => onSelect(row.item)}
                onHover={() => onHoverIndex(row.itemIndex)}
                onRef={(node) => itemRefs.current.set(row.itemIndex, node)}
              />
            );
          })}
        </div>
      </OverlayScrollbar>
    </div>
  );
}
