import { createFileRoute, useSearch } from '@tanstack/react-router';
import {
  ErrorDisplay,
  type ErrorDisplayProps,
} from '@pages/components/error-display';
import {
  classifyError,
  getErrorName,
  type ErrorCategory,
} from '@shared/chromium-errors/error-classification';
import { useKartonProcedure } from '@pages/hooks/use-karton';
import clodexMark from '@assets/clodex-mark.png';

type PageLoadErrorSearch = {
  errorUrl: string;
  errorCode: number;
  errorMessage?: string;
  isSubframe?: string;
  tabId: string;
};

// Warning triangle SVG favicon for error pages (amber color, 16x16)
const ERROR_FAVICON_SVG = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M7.134 1.5a1 1 0 011.732 0l6.062 10.5A1 1 0 0114.062 13.5H1.938a1 1 0 01-.866-1.5L7.134 1.5z' fill='%23f59e0b'/><path d='M8 5.5v3' stroke='white' stroke-width='1.5' stroke-linecap='round'/><circle cx='8' cy='11' r='.75' fill='white'/></svg>`;

export const Route = createFileRoute('/_error-pages/error/page-load-failed')({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: 'Page Load Error' }],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: ERROR_FAVICON_SVG }],
  }),
  validateSearch: (search: Record<string, unknown>): PageLoadErrorSearch => {
    if (!search.errorCode || !search.tabId) {
      throw new Error('Invalid search parameters');
    }

    if (Number.isNaN(Number(search.errorCode))) {
      throw new Error('Invalid error code');
    }

    return {
      errorUrl: (search.errorUrl &&
      (search.errorUrl as string).trim().length > 0
        ? search.errorUrl
        : '(empty)') as string,
      errorCode: Number(search.errorCode),
      errorMessage: search.errorMessage as string | undefined,
      isSubframe: search.isSubframe as string | undefined,
      tabId: search.tabId as string,
    };
  },
});

function RouteComponent() {
  const { errorUrl, errorCode, errorMessage, tabId } = useSearch({
    from: '/_error-pages/error/page-load-failed',
  });

  const trustCertificateAndReload = useKartonProcedure(
    (p) => p.trustCertificateAndReload,
  );

  const classification = classifyError(errorCode, errorUrl);
  const errorName = getErrorName(errorCode);

  // Build title and message from classification
  const title = classification.userFriendlyTitle;
  const message = classification.userFriendlyMessage;

  // Extract origin from error URL for certificate bypass
  const getOriginFromUrl = (url: string): string | null => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };

  const handleTrustCertificate = () => {
    const origin = getOriginFromUrl(errorUrl);
    if (origin && tabId) {
      trustCertificateAndReload(tabId, origin);
    }
  };

  const buttonActions = getErrorButtonActions(
    errorUrl,
    classification.category,
    handleTrustCertificate,
  );
  const linkActions = getErrorLinkActions(errorCode, errorUrl);

  return (
    <main className="flex size-full min-h-screen min-w-screen flex-col items-center justify-center bg-background pb-32">
      <ErrorDisplay
        title={title}
        message={message}
        graphic={
          <img
            className="w-full max-w-48 drop-shadow-2xl"
            src={clodexMark}
            alt="Clodex"
          />
        }
        errorCode={errorCode}
        errorName={errorMessage ? `${errorName} (${errorMessage})` : errorName}
        url={errorUrl}
        showUrl={true}
        dangerous={classification.isDangerous}
        buttonActions={buttonActions}
        linkActions={linkActions}
      />
    </main>
  );
}

/**
 * Get button actions for the error page.
 * - For certificate errors: "Continue (UNSAFE!)" as primary, then "Go Back"
 * - For other errors: "Try Again" then "Go Back"
 */
const getErrorButtonActions = (
  errorUrl: string,
  category: ErrorCategory,
  onTrustCertificate?: () => void,
): Required<ErrorDisplayProps['buttonActions']> => {
  // Certificate errors: Continue (UNSAFE!) as primary action, no Try Again
  if (category === 'certificate' && onTrustCertificate) {
    return [
      {
        label: 'Continue (UNSAFE!)',
        onClick: onTrustCertificate,
      },
      {
        label: 'Go Back',
        onClick: () => {
          window.history.back();
        },
      },
    ];
  }

  // Other errors: Try Again and Go Back
  return [
    {
      label: 'Try Again',
      onClick: () => {
        // Navigate directly to the failed URL to retry loading it.
        // Using replace() so the error page entry is removed from history.
        window.location.replace(errorUrl);
      },
    },
    {
      label: 'Go Back',
      onClick: () => {
        window.history.back();
      },
    },
  ];
};

/**
 * Get link actions for additional help options
 */
const getErrorLinkActions = (
  errorCode: number,
  errorUrl: string,
): Required<ErrorDisplayProps['linkActions']> => {
  const classification = classifyError(errorCode, errorUrl);
  const links: ErrorDisplayProps['linkActions'] = [];

  // Add context-specific help links based on error category
  if (classification.category === 'certificate') {
    // Certificate errors - could add link to security settings
    // links.push({ label: 'Learn about security certificates', href: '...' });
  } else if (classification.category === 'network') {
    // Network errors - could add link to network troubleshooting
    // links.push({ label: 'Troubleshoot connection issues', href: '...' });
  }

  return links;
};
