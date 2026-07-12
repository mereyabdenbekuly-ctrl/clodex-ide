import dns from 'node:dns/promises';
import net from 'node:net';
import { AGENT_OS_LIMITS } from '@shared/agent-os';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type SkillDownloadLookup = (hostname: string) => Promise<string[]>;

export interface SkillDownloadOptions {
  fetchImpl?: typeof fetch;
  lookupHost?: SkillDownloadLookup;
  maxBytes?: number;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  ) {
    return false;
  }
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  );
}

export function isPublicSkillDownloadAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = net.isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

async function defaultLookupHost(hostname: string): Promise<string[]> {
  return (
    await dns.lookup(hostname, {
      all: true,
      verbatim: true,
    })
  ).map((entry) => entry.address);
}

export async function assertSafeSkillDownloadUrl(
  url: URL,
  lookupHost: SkillDownloadLookup = defaultLookupHost,
): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Skill download URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Skill download URL may not include credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Skill download URL must use a public host');
  }

  const literalFamily = net.isIP(hostname);
  const addresses =
    literalFamily === 0 ? await lookupHost(hostname) : [hostname];
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicSkillDownloadAddress(address))
  ) {
    throw new Error('Skill download URL resolves to a non-public address');
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel('Skill package exceeded the download size limit');
        throw new Error('Skill download exceeds the package size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function downloadRemoteSkillPackage(
  urlValue: string,
  options: SkillDownloadOptions = {},
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const maxBytes = options.maxBytes ?? AGENT_OS_LIMITS.maxSkillPackageBytes;
  let currentUrl = new URL(urlValue);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertSafeSkillDownloadUrl(currentUrl, lookupHost);
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error('Skill download redirect has no destination');
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error('Skill download followed too many redirects');
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Skill download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new Error('Skill download exceeds the package size limit');
    }
    return await readBodyWithLimit(response, maxBytes);
  }

  throw new Error('Skill download followed too many redirects');
}
