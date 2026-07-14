import {
  parseAppUrlIdentity,
  type ParsedAppUrlIdentity,
} from '@shared/isolated-app-origin';

export const CLODEX_APP_REVISION_QUERY = 'clodexRev' as const;
export const CLODEX_APP_REVISION_PATTERN = /^[a-f0-9]{64}$/;

function buildIsolatedAppBootstrapSource(revision?: string): string {
  const historyRevisionGuard = revision
    ? [
        `const expectedRevision=${JSON.stringify(revision)};`,
        'const URLCtor=globalThis.URL;',
        'const defineProperty=Object.defineProperty;',
        'const getOwnPropertyDescriptor=Object.getOwnPropertyDescriptor;',
        'const reflectApply=Reflect.apply;',
        "const parseRevision=(value)=>{let parsed;try{parsed=new URLCtor(value,location.href);}catch{return null;}for(const key of parsed.searchParams.keys()){if(key.toLowerCase()==='clodexrev'&&key!=='clodexRev')return null;}const values=parsed.searchParams.getAll('clodexRev');if(values.length!==1||!/^[a-f0-9]{64}$/.test(values[0]||''))return null;const pair='clodexRev='+values[0];const raw=parsed.search.slice(1).split('&');let count=0;for(const item of raw){if(item===pair)count+=1;}return count===1?values[0]:null;};",
        'if(parseRevision(location.href)!==expectedRevision)failed=true;',
        "const historyPrototype=globalThis.History&&globalThis.History.prototype;const historyObject=globalThis.history;if(!historyPrototype||!historyObject)failed=true;else{for(const name of ['pushState','replaceState']){try{const original=historyPrototype[name];if(typeof original!=='function')throw new TypeError('Missing History method');const guarded=function(...args){if(args.length>=3&&args[2]!==undefined){const next=new URLCtor(String(args[2]),location.href).href;if(parseRevision(next)!==expectedRevision)throw new TypeError('CLODEx app revision is immutable');}return reflectApply(original,this,args);};defineProperty(historyPrototype,name,{value:guarded,writable:false,configurable:false,enumerable:false});defineProperty(historyObject,name,{value:guarded,writable:false,configurable:false,enumerable:false});const prototypeDescriptor=getOwnPropertyDescriptor(historyPrototype,name);const objectDescriptor=getOwnPropertyDescriptor(historyObject,name);if(!prototypeDescriptor||prototypeDescriptor.value!==guarded||prototypeDescriptor.writable||prototypeDescriptor.configurable||!objectDescriptor||objectDescriptor.value!==guarded||objectDescriptor.writable||objectDescriptor.configurable)throw new TypeError('History guard verification failed');}catch{failed=true;}}}",
      ].join('')
    : '';

  return [
    '(()=>{',
    "const names=['RTCPeerConnection','webkitRTCPeerConnection','RTCIceTransport','RTCDtlsTransport','RTCSctpTransport','RTCDataChannel','WebTransport','WebSocket','EventSource'];",
    'let failed=false;',
    'for(const name of names){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false,enumerable:false});if(globalThis[name]!==undefined)failed=true;}catch{failed=true;}}',
    "try{Object.defineProperty(navigator,'sendBeacon',{value:()=>false,writable:false,configurable:false});}catch{}",
    historyRevisionGuard,
    "if(failed){try{window.stop();document.open();document.write('<!doctype html><title>Blocked isolated app</title>');document.close();}finally{throw new Error('Isolated app security bootstrap failed');}}",
    '})();',
  ].join('');
}

const ISOLATED_APP_SCROLLBAR_STYLE =
  '*,*::before,*::after{scrollbar-width:thin;scrollbar-color:var(--color-surface-2,rgba(255,255,255,.15)) transparent}';

export const ISOLATED_APP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'frame-ancestors clodex:',
].join('; ');

export const ISOLATED_APP_RESPONSE_HEADERS = Object.freeze({
  'Content-Security-Policy': ISOLATED_APP_CONTENT_SECURITY_POLICY,
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=()',
});

export type AppContentRevisionDecision =
  | { action: 'allow' }
  | { action: 'redirect'; location: string }
  | { action: 'deny'; reason: 'invalid' | 'mismatch' };

export function parseCanonicalAppContentRevision(
  urlValue: string,
): string | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  for (const key of url.searchParams.keys()) {
    if (
      key.toLowerCase() === CLODEX_APP_REVISION_QUERY.toLowerCase() &&
      key !== CLODEX_APP_REVISION_QUERY
    ) {
      return null;
    }
  }
  const revisions = url.searchParams.getAll(CLODEX_APP_REVISION_QUERY);
  if (
    revisions.length !== 1 ||
    !CLODEX_APP_REVISION_PATTERN.test(revisions[0] ?? '')
  ) {
    return null;
  }

  const rawPairs = url.search.slice(1).split('&');
  const canonicalPair = `${CLODEX_APP_REVISION_QUERY}=${revisions[0]}`;
  if (rawPairs.filter((pair) => pair === canonicalPair).length !== 1) {
    return null;
  }
  return revisions[0] ?? null;
}

/**
 * Bind an isolated agent-app HTML navigation URL to the exact full-tree hash.
 * The caller only invokes this after resolving a valid manifest and identity.
 */
export function decideAppContentRevision(
  urlValue: string,
  currentAssetHash: string,
): AppContentRevisionDecision {
  if (!CLODEX_APP_REVISION_PATTERN.test(currentAssetHash)) {
    return { action: 'deny', reason: 'invalid' };
  }

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return { action: 'deny', reason: 'invalid' };
  }

  for (const key of url.searchParams.keys()) {
    if (
      key.toLowerCase() === CLODEX_APP_REVISION_QUERY.toLowerCase() &&
      key !== CLODEX_APP_REVISION_QUERY
    ) {
      return { action: 'deny', reason: 'invalid' };
    }
  }
  const revisions = url.searchParams.getAll(CLODEX_APP_REVISION_QUERY);
  if (revisions.length === 0) {
    url.searchParams.append(CLODEX_APP_REVISION_QUERY, currentAssetHash);
    return { action: 'redirect', location: url.toString() };
  }
  const revision = parseCanonicalAppContentRevision(urlValue);
  if (!revision) {
    return { action: 'deny', reason: 'invalid' };
  }
  return revision === currentAssetHash
    ? { action: 'allow' }
    : { action: 'deny', reason: 'mismatch' };
}

/** Injected immediately after a leading doctype, otherwise before all app HTML. */
export function hardenIsolatedAppHtml(
  html: string,
  authorityRevision?: string,
): string {
  if (
    authorityRevision !== undefined &&
    !CLODEX_APP_REVISION_PATTERN.test(authorityRevision)
  ) {
    throw new TypeError('Invalid isolated app authority revision');
  }
  const bootstrap = `<script data-clodex-isolated-bootstrap>${buildIsolatedAppBootstrapSource(authorityRevision)}</script><style data-clodex-isolated-style>${ISOLATED_APP_SCROLLBAR_STYLE}</style>`;
  const leadingDoctype = /^\s*<!doctype\s+html[^>]*>/i.exec(html);
  if (!leadingDoctype) return `${bootstrap}${html}`;
  const insertionPoint = leadingDoctype.index + leadingDoctype[0].length;
  return `${html.slice(0, insertionPoint)}${bootstrap}${html.slice(insertionPoint)}`;
}

export type AppNetworkRequestDecisionInput = {
  url: string;
  frameUrl?: string | null;
  referrer?: string | null;
  resourceType?: string;
};

export type AppFrameNavigationDecisionInput = {
  targetUrl: string;
  initiatorUrl?: string | null;
  frameUrl?: string | null;
};

function parseIsolatedSource(
  value: string | null | undefined,
): ParsedAppUrlIdentity | null {
  if (!value) return null;
  const parsed = parseAppUrlIdentity(value);
  return parsed?.classification === 'isolated' ? parsed : null;
}

function sameIsolatedApp(
  left: ParsedAppUrlIdentity,
  right: ParsedAppUrlIdentity,
): boolean {
  return (
    left.classification === 'isolated' &&
    right.classification === 'isolated' &&
    left.host === right.host &&
    left.identity.namespace === right.identity.namespace &&
    left.identity.entityId === right.identity.entityId &&
    left.identity.appId === right.identity.appId
  );
}

/**
 * Block every request attributed to an isolated app unless it is a same-app
 * app:// resource. This covers fetch/XHR, scripts, images, pings, WebSockets,
 * WebTransport handshakes, and direct frame navigation without affecting
 * traffic whose requesting frame and referrer are both non-app contexts.
 */
export function shouldBlockIsolatedAppRequest(
  input: AppNetworkRequestDecisionInput,
): boolean {
  const sources = [
    parseIsolatedSource(input.frameUrl),
    parseIsolatedSource(input.referrer),
  ].filter((source): source is ParsedAppUrlIdentity => source !== null);
  if (sources.length === 0) return false;

  const target = parseIsolatedSource(input.url);
  return !target || !sources.every((source) => sameIsolatedApp(source, target));
}

/**
 * Cover navigation schemes that Electron's webRequest layer may never observe.
 * A navigation initiated by, or replacing, an isolated app frame may remain
 * inside that exact isolated app identity and nowhere else.
 */
export function shouldBlockIsolatedAppFrameNavigation(
  input: AppFrameNavigationDecisionInput,
): boolean {
  return shouldBlockIsolatedAppRequest({
    url: input.targetUrl,
    frameUrl: input.frameUrl,
    referrer: input.initiatorUrl,
    resourceType: 'subFrame',
  });
}
