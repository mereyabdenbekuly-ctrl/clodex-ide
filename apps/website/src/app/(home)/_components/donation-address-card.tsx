'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UsdtDonationNetwork } from './usdt-donation-networks';

type CopyState = 'idle' | 'copied' | 'error';

function copyWithTemporaryInput(value: string): boolean {
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  return copied;
}

export function DonationAddressCard({
  network,
  copyLabel,
  copiedLabel,
  errorLabel,
}: {
  network: UsdtDonationNetwork;
  copyLabel: string;
  copiedLabel: string;
  errorLabel: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyAddress = () => {
    if (copyWithTemporaryInput(network.address)) {
      setCopyState('copied');
      return;
    }

    if (!navigator.clipboard?.writeText) {
      setCopyState('error');
      return;
    }

    void navigator.clipboard.writeText(network.address).then(
      () => setCopyState('copied'),
      () => setCopyState('error'),
    );
  };

  const buttonLabel =
    copyState === 'copied'
      ? copiedLabel
      : copyState === 'error'
        ? errorLabel
        : copyLabel;

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:bg-white/[0.055]">
      <div className="landing-grid pointer-events-none absolute inset-0 opacity-[0.06]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`size-2.5 rounded-full shadow-[0_0_18px_currentColor] ${network.accentClassName}`}
            />
            <div>
              <h3 className="font-medium text-base text-white tracking-tight">
                {network.name}
              </h3>
              <p className="mt-0.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.16em]">
                USDT · {network.standard}
              </p>
            </div>
          </div>
        </div>

        <code className="mt-5 block min-h-12 break-all rounded-xl border border-white/8 bg-black/25 px-3 py-3 text-[11px] text-white/68 leading-5">
          {network.address}
        </code>

        <button
          type="button"
          onClick={copyAddress}
          className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.055] px-3 font-medium text-white/75 text-xs transition-colors hover:bg-white/[0.09] hover:text-white"
          aria-label={`${copyLabel}: ${network.name}`}
        >
          {copyState === 'copied' ? (
            <Check className="size-3.5 text-emerald-300" />
          ) : (
            <Copy className="size-3.5" />
          )}
          <span aria-live="polite">{buttonLabel}</span>
        </button>
      </div>
    </article>
  );
}
