import { memo, useCallback, useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { cn } from '@clodex/stage-ui/lib/utils';
import {
  IconBookOpenOutline18,
  IconBugOutline18,
  IconFileSearchOutline18,
  IconFolder5Outline18,
  IconXmarkFill18,
} from '@clodex/icons';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useTrack } from '@ui/hooks/use-track';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { EMPTY_MOUNTS } from '@shared/karton-contracts/ui';
import { Logo } from '@ui/components/ui/logo';
import {
  requestChatInputFocus,
  requestChatInputPrefill,
} from '../_lib/chat-input-events';

/**
 * Empty-chat suggestion list.
 *
 * Work Home scope:
 * - Quick starts are always available, even when recent workspaces exist.
 * - Recent workspace rows stay visible until mounted or dismissed.
 * - The strip below the chat input owns the "Connect new workspace"
 *   affordance via its `+` button, so this list never duplicates that.
 */

/**
 * How many recent workspace rows to show. Dismissing one promotes the
 * next-most-recent into view.
 */
const RECENT_WORKSPACE_LIMIT = 3;

export interface EmptyChatSuggestionsProps {
  removedSuggestionIds: Set<string>;
  onDismiss: (id: string) => void;
}

export const EmptyChatSuggestions = memo(function EmptyChatSuggestions({
  removedSuggestionIds,
  onDismiss,
}: EmptyChatSuggestionsProps) {
  const [openAgent] = useOpenAgent();
  const recentlyOpenedWorkspaces = useKartonState(
    (s) => s.userExperience.storedExperienceData.recentlyOpenedWorkspaces,
  );
  const allMounts = useKartonState((s) =>
    openAgent
      ? (s.toolbox[openAgent]?.workspace?.mounts ?? EMPTY_MOUNTS)
      : EMPTY_MOUNTS,
  );
  const mountedPaths = useMemo(
    () => new Set(allMounts.map((m) => m.path)),
    [allMounts],
  );
  const mountWorkspace = useKartonProcedure((p) => p.toolbox.mountWorkspace);
  const track = useTrack();

  // Filter dismissed entries BEFORE the slice so that dismissing a
  // recent workspace promotes the next-most-recent one into view.
  const sortedRecents = useMemo(() => {
    return [...recentlyOpenedWorkspaces]
      .filter((w) => !mountedPaths.has(w.path))
      .filter((w) => !removedSuggestionIds.has(`connect-workspace-${w.path}`))
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, RECENT_WORKSPACE_LIMIT);
  }, [recentlyOpenedWorkspaces, mountedPaths, removedSuggestionIds]);

  // Connecting a workspace deliberately keeps other recent workspaces
  // visible. The newly mounted workspace drops out of the list
  // automatically via the `mountedPaths` filter above.
  const connect = useCallback(
    async (path: string) => {
      if (!openAgent) return;
      track('workspace-connect-started');
      try {
        await mountWorkspace(openAgent, path);
        track('workspace-connect-finished');
        requestChatInputFocus();
      } catch {
        track('workspace-connect-failed', { source: 'recent-workspace' });
      }
    },
    [openAgent, mountWorkspace, track],
  );

  return (
    <EmptyChatHero>
      <div className="flex w-full flex-col gap-5 text-left">
        <HeroSuggestionGroup label="Quick starts">
          {HERO_PROMPTS.map((prompt) => (
            <SuggestionRow
              key={prompt.id}
              icon={prompt.icon}
              onActivate={() => {
                track('empty-chat-hero-clicked', {
                  suggestion_id: prompt.id,
                });
                requestChatInputPrefill(prompt.text);
              }}
            >
              <span className="shrink-0 text-base leading-tight">
                {prompt.label}
              </span>
            </SuggestionRow>
          ))}
        </HeroSuggestionGroup>

        {sortedRecents.length > 0 && (
          <HeroSuggestionGroup
            label="Recent workspaces"
            className="border-token-border-light border-t pt-4"
          >
            {sortedRecents.map((workspace) => {
              const id = `connect-workspace-${workspace.path}`;
              return (
                <SuggestionRow
                  key={workspace.path}
                  onActivate={() => {
                    track('suggestion-clicked', {
                      suggestion_id: id,
                      context: 'empty-chat',
                    });
                    void connect(workspace.path);
                  }}
                  icon={<IconFolder5Outline18 className="size-4 shrink-0" />}
                  onDismiss={() => onDismiss(id)}
                  dismissTooltip="Dismiss suggestion"
                >
                  <span className="shrink-0 text-sm leading-tight">
                    Connect{' '}
                    <span className="font-medium text-token-text-primary">
                      {workspace.name}
                    </span>
                  </span>
                  <span
                    className="ml-2 min-w-0 flex-1 truncate text-token-text-tertiary text-xs leading-normal group-hover/suggestion:text-token-text-secondary"
                    dir="rtl"
                  >
                    <span dir="ltr">{workspace.path}</span>
                  </span>
                </SuggestionRow>
              );
            })}
          </HeroSuggestionGroup>
        )}
      </div>
    </EmptyChatHero>
  );
});

function HeroSuggestionGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex w-full flex-col gap-1', className)}>
      <h2 className="px-2.5 pb-1 font-medium text-token-text-tertiary text-xs">
        {label}
      </h2>
      {children}
    </section>
  );
}

// ============================================================================
// Shared row chrome
// ============================================================================
//
// Chrome conventions:
// - Left icon swaps to a dismiss-cross on hover when dismissable.
// - Hover/focus highlight on the entire row, click anywhere activates.

function SuggestionRow({
  onActivate,
  icon,
  onDismiss,
  dismissTooltip,
  onHoverEnter,
  children,
}: {
  onActivate: () => void;
  icon: React.ReactNode;
  onDismiss?: () => void;
  dismissTooltip?: string;
  onHoverEnter?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={onHoverEnter}
      className={cn(
        'group/suggestion relative flex min-h-10 w-full cursor-pointer flex-row items-center gap-2.5 rounded-lg px-2.5 py-2 text-token-description-foreground outline-none transition-[background-color,color,transform] duration-150',
        'hover:bg-token-list-hover-background hover:text-token-foreground active:scale-[0.995]',
        'focus-visible:bg-token-list-hover-background focus-visible:text-token-foreground focus-visible:ring-1 focus-visible:ring-token-focus-border',
      )}
    >
      {/* Left icon: swaps to dismiss-cross on hover when dismissable.
          The resting icon and the X are siblings; both have explicit
          opacity classes so the resting icon actually fades out (a
          `display: contents` wrapper would not — opacity needs a box). */}
      {onDismiss ? (
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              data-dismiss
              aria-label={dismissTooltip ?? 'Dismiss suggestion'}
              className="group/dismiss relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary-solid/40"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                }
              }}
            >
              <span className="flex size-3.5 items-center justify-center group-hover/suggestion:opacity-0 group-focus-visible/suggestion:opacity-0">
                {icon}
              </span>
              <IconXmarkFill18 className="absolute size-3.5 text-token-text-tertiary opacity-0 group-hover/dismiss:text-token-foreground group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{dismissTooltip ?? 'Dismiss'}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      {children}
    </div>
  );
}

// ============================================================================
// EmptyChatHero mirrors Codex Work Home: centered brand mark + headline,
// compact suggestion rows, and the composer anchored below by ChatPanel.
// ============================================================================

const HERO_PROMPTS: ReadonlyArray<{
  id: string;
  label: string;
  icon: React.ReactNode;
  text: string;
}> = [
  {
    id: 'hero-explain-codebase',
    label: 'Explain this codebase',
    icon: <IconBookOpenOutline18 className="size-3.5 shrink-0" />,
    text: 'Explain the structure of this codebase and the main entry points.',
  },
  {
    id: 'hero-refactor',
    label: 'Find a file to refactor',
    icon: <IconFileSearchOutline18 className="size-3.5 shrink-0" />,
    text: 'Pick a file in this workspace and refactor it for readability.',
  },
  {
    id: 'hero-add-tests',
    label: 'Add tests for X',
    icon: <IconBugOutline18 className="size-3.5 shrink-0" />,
    text: 'Find the most critical untested function and add unit tests for it.',
  },
];

function EmptyChatHero({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="codex-empty-hero flex w-full max-w-2xl flex-col items-center gap-6 text-center"
      data-testid="empty-chat-hero"
    >
      <div className="flex select-none flex-col items-center gap-4">
        <Logo
          color="current"
          aria-hidden
          className="size-10 text-token-foreground opacity-35"
        />
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="font-normal text-[28px] text-token-text-primary leading-tight tracking-[-0.02em]">
            What can I help with?
          </h1>
          <p className="max-w-lg text-sm text-token-text-tertiary leading-relaxed">
            Ask about the codebase, plan a change, or start an implementation.
          </p>
        </div>
      </div>
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );
}
