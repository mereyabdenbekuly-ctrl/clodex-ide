import { lazy, useEffect, useId, useRef, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

const PANGRAM = 'The quick brown fox jumps over the lazy dog';
const ALPHABET = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz';

function useFontFace(src: string) {
  const instanceId = useId();
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const fontFaceRef = useRef<FontFace | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setFontFamily(null);

    const family = `preview-font-${instanceId.replace(/:/g, '')}`;
    const fontFace = new FontFace(family, `url(${src})`);

    fontFace
      .load()
      .then(() => {
        if (cancelled) return;
        (document.fonts as FontFaceSet & { add(f: FontFace): void }).add(
          fontFace,
        );
        fontFaceRef.current = fontFace;
        setFontFamily(family);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (fontFaceRef.current) {
        (document.fonts as FontFaceSet & { delete(f: FontFace): void }).delete(
          fontFaceRef.current,
        );
        fontFaceRef.current = null;
      }
    };
  }, [src, instanceId]);

  return { fontFamily, loading, error };
}

function FontCompact({ src, className }: FilePreviewProps) {
  const { fontFamily, loading, error } = useFontFace(src);

  if (loading) {
    return (
      <div
        className={cn(
          'flex w-full items-center justify-center rounded-sm bg-background p-3 ring-1 ring-border-subtle',
          className,
        )}
      >
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex w-full items-center justify-center rounded-sm bg-background p-3 ring-1 ring-border-subtle',
          className,
        )}
      >
        <span className="text-muted-foreground text-xs">
          Failed to load font
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-1 overflow-hidden rounded-sm bg-background p-3 ring-1 ring-border-subtle',
        className,
      )}
      style={{ fontFamily: fontFamily ?? undefined }}
    >
      <div className="truncate text-foreground text-sm leading-relaxed">
        {PANGRAM}
      </div>
      <div className="truncate text-muted-foreground text-xs">{ALPHABET}</div>
    </div>
  );
}

export const fontPreview: FilePreviewEntry = {
  id: 'font',
  mimePatterns: ['font/*'],
  variants: {
    compact: FontCompact,
    expanded: lazy(() => import('./font-expanded')),
  },
};
