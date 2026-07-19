import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import { Clock3, Download, FileCheck2, ShieldAlert } from 'lucide-react';
import { Suspense } from 'react';
import { Footer } from '../(home)/_components/footer';
import { Navbar } from '../(home)/navbar';
import {
  COMMUNITY_RELEASE,
  getReadyCommunityRelease,
} from '@/lib/community-release';

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const params = await searchParams;
  const isRussian = params.lang === 'ru';
  const readyRelease = getReadyCommunityRelease(COMMUNITY_RELEASE);
  const copy = isRussian
    ? {
        readyBadge: 'Проверенный Free Community Technical Preview',
        unavailableBadge: 'Free Community download недоступен',
        readyTitle: 'Скачать CLODEx Community Observed 11',
        unavailableTitle: 'Ссылки на сборку недоступны',
        readyDescription:
          'Community Observed 11 прошла проверку Free/managed boundary и packaged bytes. Выберите пакет для своей платформы и проверьте его перед установкой.',
        unavailableDescription:
          'Проверенный release manifest неполон, поэтому страница не показывает прямые ссылки. Не используйте случайные или старые installer-файлы.',
        unavailableVersion: 'Release manifest unavailable',
        download: 'Скачать',
        unavailableCardTitle: 'Fail-closed download mapping',
        unavailableCardText:
          'Прямые installer URL скрыты, пока source commit, build run, tag, checksums, evidence и все пять имён файлов не образуют один полный проверенный mapping.',
        warningTitle: 'Без доверенной подписи и нотариализации',
        warning:
          'macOS-пакеты подписаны ad-hoc, но не trusted Developer ID и не нотарифицированы; Windows-пакет не подписан Authenticode; Linux-пакеты не имеют vendor signature CLODEx. Проверяйте SHA-256 и используйте только штатную проверку отдельного приложения. Не отключайте Gatekeeper, SmartScreen, Defender или аналогичную защиту глобально.',
        readyVerifyTitle: 'Проверьте релиз',
        unavailableVerifyTitle: 'Почему ссылки скрыты',
        readyVerify:
          'SHA256SUMS покрывает пять installer-файлов и evidence archive. В evidence входят validation manifests, SBOM, предупреждения, внутренние checksums и byte-audit report.',
        unavailableVerify:
          'CLODEx не публикует частичную или неоднозначную release mapping. Используйте только точные ссылки, SHA-256 и evidence текущего release manifest.',
        release: 'GitHub-релиз',
        source: 'Исходный код',
        build: 'GitHub Actions',
        help: 'Детали релиза и сообщения о проблемах:',
      }
    : {
        readyBadge: 'Verified Free Community Technical Preview',
        unavailableBadge: 'Free Community download unavailable',
        readyTitle: 'Download CLODEx Community Observed 11',
        unavailableTitle: 'Build links are unavailable',
        readyDescription:
          'Community Observed 11 passed the Free/managed boundary and packaged-byte gates. Choose the package for your platform and verify it before installation.',
        unavailableDescription:
          'The verified release manifest is incomplete, so this page exposes no direct links. Do not use arbitrary or older installer files.',
        unavailableVersion: 'Release manifest unavailable',
        download: 'Download',
        unavailableCardTitle: 'Fail-closed download mapping',
        unavailableCardText:
          'Direct installer URLs remain hidden unless the source commit, build run, tag, checksums, evidence, and all five filenames form one complete verified mapping.',
        warningTitle: 'Not trust-signed or notarized',
        warning:
          "The macOS packages are ad-hoc signed, not signed with a trusted Developer ID, and not notarized; the Windows package is not Authenticode-signed; the Linux packages have no CLODEx vendor signature. Verify SHA-256 and use only the operating system's per-application review flow. Do not disable Gatekeeper, SmartScreen, Defender, or equivalent protections globally.",
        readyVerifyTitle: 'Verify the release',
        unavailableVerifyTitle: 'Why the links are hidden',
        readyVerify:
          'SHA256SUMS covers five installer files and the evidence archive. The evidence includes validation manifests, SBOMs, warnings, internal checksums, and the byte-audit report.',
        unavailableVerify:
          'CLODEx does not expose a partial or ambiguous release mapping. Use only the exact URLs, SHA-256 checksums, and evidence from the current release manifest.',
        release: 'GitHub release',
        source: 'Source',
        build: 'GitHub Actions',
        help: 'Release details and problem reports:',
      };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Suspense>
        <Navbar />
      </Suspense>

      <main className="mx-auto w-full max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-4 font-medium text-primary-foreground text-sm uppercase tracking-[0.18em]">
            {readyRelease ? copy.readyBadge : copy.unavailableBadge}
          </p>
          <h1 className="font-medium text-4xl tracking-tight sm:text-6xl">
            {readyRelease ? copy.readyTitle : copy.unavailableTitle}
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            {readyRelease ? copy.readyDescription : copy.unavailableDescription}
          </p>
          <p className="mt-3 font-mono text-muted-foreground text-sm">
            {readyRelease?.version ?? copy.unavailableVersion}
          </p>
        </div>

        {readyRelease ? (
          <section className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {readyRelease.downloads.map((download) => (
              <article
                key={download.id}
                className="rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-medium text-xl">{download.platform}</h2>
                    <p className="mt-1 text-muted-foreground text-sm">
                      {download.architecture} · {download.format}
                    </p>
                  </div>
                  <Download className="size-5 text-primary-foreground" />
                </div>
                <a
                  href={download.href}
                  className={cn(
                    buttonVariants({ size: 'md', variant: 'primary' }),
                    'mt-6 w-full',
                  )}
                >
                  {copy.download} {download.format}
                </a>
              </article>
            ))}
          </section>
        ) : (
          <section className="mt-12 rounded-2xl border border-primary-foreground/30 bg-primary-foreground/5 p-8">
            <div className="flex gap-4">
              <Clock3 className="mt-0.5 size-6 shrink-0 text-primary-foreground" />
              <div>
                <h2 className="font-medium text-xl">
                  {copy.unavailableCardTitle}
                </h2>
                <p className="mt-2 max-w-3xl text-muted-foreground">
                  {copy.unavailableCardText}
                </p>
              </div>
            </div>
          </section>
        )}

        <section className="mt-8 rounded-2xl border border-warning-foreground/30 bg-warning-foreground/5 p-6">
          <div className="flex gap-4">
            <ShieldAlert className="mt-0.5 size-6 shrink-0 text-warning-foreground" />
            <div>
              <h2 className="font-medium text-lg">{copy.warningTitle}</h2>
              <p className="mt-2 text-muted-foreground">{copy.warning}</p>
            </div>
          </div>
        </section>

        <section className="mt-8 flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <FileCheck2 className="mt-0.5 size-5 shrink-0 text-primary-foreground" />
            <div>
              <h2 className="font-medium">
                {readyRelease
                  ? copy.readyVerifyTitle
                  : copy.unavailableVerifyTitle}
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">
                {readyRelease ? copy.readyVerify : copy.unavailableVerify}
              </p>
              {readyRelease && (
                <p className="mt-2 text-muted-foreground text-xs">
                  {copy.source}:{' '}
                  <a
                    href={readyRelease.sourceUrl}
                    className="font-mono text-primary-foreground hover:underline"
                  >
                    {readyRelease.sourceCommit.slice(0, 12)}
                  </a>{' '}
                  · {copy.build}:{' '}
                  <a
                    href={readyRelease.buildRunUrl}
                    className="font-mono text-primary-foreground hover:underline"
                  >
                    {readyRelease.buildRunId}
                  </a>
                </p>
              )}
            </div>
          </div>
          {readyRelease && (
            <div className="flex flex-wrap gap-2">
              <a
                href={readyRelease.checksumsUrl}
                className={buttonVariants({
                  size: 'sm',
                  variant: 'secondary',
                })}
              >
                SHA256SUMS
              </a>
              <a
                href={readyRelease.evidenceUrl}
                className={buttonVariants({
                  size: 'sm',
                  variant: 'secondary',
                })}
              >
                Evidence
              </a>
              <a
                href={readyRelease.releaseUrl}
                className={buttonVariants({
                  size: 'sm',
                  variant: 'ghost',
                })}
              >
                {copy.release}
              </a>
            </div>
          )}
        </section>

        <p className="mt-8 text-center text-muted-foreground text-sm">
          {copy.help}{' '}
          <a
            href="https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases"
            className="text-primary-foreground hover:underline"
          >
            GitHub Releases
          </a>{' '}
          ·{' '}
          <a
            href="https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new/choose"
            className="text-primary-foreground hover:underline"
          >
            GitHub Issues
          </a>
        </p>
      </main>

      <Footer />
    </div>
  );
}
