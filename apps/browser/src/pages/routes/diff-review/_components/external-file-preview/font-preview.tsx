import { useState, useEffect, memo, useRef, useId, type FC } from 'react';
import { Loader2Icon } from 'lucide-react';
import { inferFontMimeType } from '@ui/utils/file-type-utils';

const FONT_SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog';
const FONT_SAMPLE_CHARS =
  'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz';
const FONT_SAMPLE_NUMBERS = '0123456789';

export interface FontPreviewProps {
  base64Content: string | null;
  mimeType: string | null;
  filePath: string;
  isLoading: boolean;
  error: string | null;
}

export const FontPreview: FC<FontPreviewProps> = memo(
  ({ base64Content, mimeType, filePath, isLoading, error }) => {
    const instanceId = useId();
    const [fontFamily, setFontFamily] = useState<string | null>(null);
    const [fontError, setFontError] = useState<string | null>(null);
    const fontFaceRef = useRef<FontFace | null>(null);

    useEffect(() => {
      if (!base64Content) return;

      let cancelled = false;
      const resolvedMime = mimeType ?? inferFontMimeType(filePath);
      const uniqueFontFamily = `preview-font-${instanceId.replace(/:/g, '')}`;
      const dataUrl = `url(data:${resolvedMime};base64,${base64Content})`;

      const fontFace = new FontFace(uniqueFontFamily, dataUrl);
      fontFace
        .load()
        .then(() => {
          if (cancelled) return;
          (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(
            fontFace,
          );
          fontFaceRef.current = fontFace;
          setFontFamily(uniqueFontFamily);
        })
        .catch((err) => {
          if (cancelled) return;
          setFontError(
            err instanceof Error ? err.message : 'Failed to load font',
          );
        });

      return () => {
        cancelled = true;
        if (fontFaceRef.current) {
          (
            document.fonts as FontFaceSet & { delete(font: FontFace): void }
          ).delete(fontFaceRef.current);
          fontFaceRef.current = null;
        }
      };
    }, [base64Content, mimeType, filePath, instanceId]);

    if (isLoading) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-border bg-surface-1">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        </div>
      );
    }

    const displayError = error ?? fontError;
    if (displayError) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-error border-dashed bg-error/5 text-error-foreground text-sm">
            {displayError}
          </div>
        </div>
      );
    }

    if (base64Content === null) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-border border-dashed bg-surface-1 text-muted-foreground text-sm">
            No file
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4">
        <div
          className="text-center text-2xl text-foreground leading-relaxed"
          style={{ fontFamily: fontFamily ?? undefined }}
        >
          {FONT_SAMPLE_TEXT}
        </div>
        <div
          className="text-center text-lg text-muted-foreground"
          style={{ fontFamily: fontFamily ?? undefined }}
        >
          {FONT_SAMPLE_CHARS}
        </div>
        <div
          className="text-center text-lg text-muted-foreground"
          style={{ fontFamily: fontFamily ?? undefined }}
        >
          {FONT_SAMPLE_NUMBERS}
        </div>
      </div>
    );
  },
);
