import { useEffect, useId, useRef, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import type { FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

const PANGRAM = 'The quick brown fox jumps over the lazy dog';
const ALPHABET = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz';
const DIGITS = '0123456789';

export default function FontExpanded({ src, className }: FilePreviewProps) {
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

    const family = `preview-font-exp-${instanceId.replace(/:/g, '')}`;
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

  if (loading) {
    return (
      <div
        className={cn(
          'flex h-32 w-full items-center justify-center rounded-md border border-border bg-surface-1',
          className,
        )}
      >
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex h-32 w-full items-center justify-center rounded-md border border-border border-dashed bg-surface-1 text-muted-foreground text-sm',
          className,
        )}
      >
        Failed to load font
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4',
        className,
      )}
      style={{ fontFamily: fontFamily ?? undefined }}
    >
      <div className="text-center text-foreground text-xl leading-relaxed">
        {PANGRAM}
      </div>
      <div className="text-center text-base text-muted-foreground">
        {ALPHABET}
      </div>
      <div className="text-center text-base text-muted-foreground">
        {DIGITS}
      </div>
    </div>
  );
}
