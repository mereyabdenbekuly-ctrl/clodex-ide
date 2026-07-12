'use client';

import { useState } from 'react';
import { CopyIcon, CheckIcon } from 'lucide-react';
import { Button } from '@clodex/stage-ui/components/button';

export function CopyMarkdownButton({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_e) {
      // Optionally handle error
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={className}
      onClick={handleCopy}
      aria-label="Copy page as markdown"
      title="Copy as markdown"
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <CopyIcon className="h-3 w-3" />
          <span>Copy as markdown</span>
        </>
      )}
    </Button>
  );
}
