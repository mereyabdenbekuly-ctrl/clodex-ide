import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import {
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  ShieldAlert,
} from 'lucide-react';
import { Suspense } from 'react';
import { Footer } from '../(home)/_components/footer';
import { Navbar } from '../(home)/navbar';
import {
  COMMUNITY_RELEASE,
  LEGACY_COMMUNITY_RELEASE,
} from '@/lib/community-release';

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const params = await searchParams;
  const isRussian = params.lang === 'ru';
  const isDownloadReady =
    COMMUNITY_RELEASE.status === 'verified' &&
    COMMUNITY_RELEASE.downloads.length > 0;
  const copy = isRussian
    ? {
        readyBadge: 'Проверенный Free Community Technical Preview',
        pendingBadge: 'Проверка новой Free-сборки',
        readyTitle: 'Скачать CLODEx',
        pendingTitle: 'Новая Free-сборка готовится',
        readyDescription:
          'Выберите пакет для своей платформы и проверьте его перед установкой.',
        pendingDescription:
          'Прямые скачивания временно приостановлены. Следующая Community-сборка будет опубликована только после сборки из актуальной main, проверки packaged bytes и подтверждения границы Free/managed.',
        pendingVersion: 'Статус релиза · проверка ещё не завершена',
        download: 'Скачать',
        pendingCardTitle: 'Ссылки появятся после проверки',
        pendingCardText:
          'Мы не выдаём предыдущий артефакт за сборку, соответствующую новому Free Product Contract. После публикации здесь появятся пакеты для macOS, Windows и Linux, SHA-256 и evidence.',
        warningTitle: 'Без доверенной подписи и нотариализации',
        warning:
          'Пока не появится доверенная platform signing identity, macOS-пакеты могут быть ad-hoc signed, но не подписаны trusted Developer ID и не нотарифицированы; Windows-пакеты не подписаны Authenticode. Проверяйте SHA-256 и используйте только штатную проверку отдельного приложения. Не отключайте Gatekeeper, SmartScreen, Defender или аналогичную защиту глобально.',
        readyVerifyTitle: 'Проверьте релиз',
        pendingVerifyTitle: 'Что требуется до публикации',
        readyVerify:
          'Вместе со сборкой публикуются checksums, validation manifests, SBOM, предупреждения и evidence archive.',
        pendingVerify:
          'Нужны зелёные boundary-проверки, byte-level аудит готового пакета и привязанные к точному source commit release notes. Только после этого сборка станет текущим Free download.',
        release: 'GitHub-релиз',
        legacyTitle: 'Предыдущий релиз — только legacy',
        legacyDescription: `${LEGACY_COMMUNITY_RELEASE.name} (${LEGACY_COMMUNITY_RELEASE.version}) создан до enforced Free/managed boundary и не проверен на соответствие текущему Free Product Contract. Он остаётся историческим tester artifact и не является текущей рекомендуемой Free-сборкой.`,
        legacyLink: 'Открыть legacy release notes',
        help: 'Следить за статусом можно в',
      }
    : {
        readyBadge: 'Verified Free Community Technical Preview',
        pendingBadge: 'New Free build verification',
        readyTitle: 'Download CLODEx',
        pendingTitle: 'A new Free build is being prepared',
        readyDescription:
          'Choose the package that matches your platform and verify it before installation.',
        pendingDescription:
          'Direct downloads are temporarily paused. The next Community build will be published only after it is built from current main, its packaged bytes are inspected, and the Free/managed boundary is verified.',
        pendingVersion: 'Release status · verification not yet complete',
        download: 'Download',
        pendingCardTitle: 'Links will appear after verification',
        pendingCardText:
          'We are not presenting an older artifact as compliant with the new Free Product Contract. Once published, this page will provide macOS, Windows, and Linux packages together with SHA-256 checksums and release evidence.',
        warningTitle: 'Not trust-signed or notarized',
        warning:
          "Until a trusted platform-signing identity is available, macOS packages may be ad-hoc signed but are not signed with a trusted Developer ID and are not notarized; Windows packages are not Authenticode-signed. Verify SHA-256 and use only the operating system's per-application review flow. Do not disable Gatekeeper, SmartScreen, Defender, or equivalent protections globally.",
        readyVerifyTitle: 'Verify the release',
        pendingVerifyTitle: 'What must pass before publication',
        readyVerify:
          'Checksums, validation manifests, SBOMs, warnings, and packaged evidence are published with the build.',
        pendingVerify:
          'Boundary checks, a byte-level audit of the packaged application, and release notes pinned to the exact source commit must pass. Only then will the build become the current Free download.',
        release: 'GitHub release',
        legacyTitle: 'Previous release — legacy only',
        legacyDescription: `${LEGACY_COMMUNITY_RELEASE.name} (${LEGACY_COMMUNITY_RELEASE.version}) was produced before the enforced Free/managed boundary and has not been verified against the current Free Product Contract. It remains a historical tester artifact, not the current recommended Free build.`,
        legacyLink: 'Open legacy release notes',
        help: 'Follow release status in',
      };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Suspense>
        <Navbar />
      </Suspense>

      <main className="mx-auto w-full max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-4 font-medium text-primary-foreground text-sm uppercase tracking-[0.18em]">
            {isDownloadReady ? copy.readyBadge : copy.pendingBadge}
          </p>
          <h1 className="font-medium text-4xl tracking-tight sm:text-6xl">
            {isDownloadReady ? copy.readyTitle : copy.pendingTitle}
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            {isDownloadReady ? copy.readyDescription : copy.pendingDescription}
          </p>
          <p className="mt-3 font-mono text-muted-foreground text-sm">
            {COMMUNITY_RELEASE.version ?? copy.pendingVersion}
          </p>
        </div>

        {isDownloadReady ? (
          <section className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {COMMUNITY_RELEASE.downloads.map((download) => (
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
                <h2 className="font-medium text-xl">{copy.pendingCardTitle}</h2>
                <p className="mt-2 max-w-3xl text-muted-foreground">
                  {copy.pendingCardText}
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
                {isDownloadReady
                  ? copy.readyVerifyTitle
                  : copy.pendingVerifyTitle}
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">
                {isDownloadReady ? copy.readyVerify : copy.pendingVerify}
              </p>
            </div>
          </div>
          {isDownloadReady && (
            <div className="flex flex-wrap gap-2">
              {COMMUNITY_RELEASE.checksumsUrl && (
                <a
                  href={COMMUNITY_RELEASE.checksumsUrl}
                  className={buttonVariants({
                    size: 'sm',
                    variant: 'secondary',
                  })}
                >
                  SHA256SUMS
                </a>
              )}
              {COMMUNITY_RELEASE.evidenceUrl && (
                <a
                  href={COMMUNITY_RELEASE.evidenceUrl}
                  className={buttonVariants({
                    size: 'sm',
                    variant: 'secondary',
                  })}
                >
                  Evidence
                </a>
              )}
              {COMMUNITY_RELEASE.releaseUrl && (
                <a
                  href={COMMUNITY_RELEASE.releaseUrl}
                  className={buttonVariants({
                    size: 'sm',
                    variant: 'ghost',
                  })}
                >
                  {copy.release}
                </a>
              )}
            </div>
          )}
        </section>

        {!isDownloadReady && (
          <section className="mt-8 rounded-2xl border border-border-subtle bg-surface-1 p-6">
            <h2 className="font-medium text-lg">{copy.legacyTitle}</h2>
            <p className="mt-2 max-w-4xl text-muted-foreground">
              {copy.legacyDescription}
            </p>
            <a
              href={LEGACY_COMMUNITY_RELEASE.releaseUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ size: 'sm', variant: 'ghost' }),
                'mt-4',
              )}
            >
              {copy.legacyLink}
              <ExternalLink className="size-4" />
            </a>
          </section>
        )}

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
