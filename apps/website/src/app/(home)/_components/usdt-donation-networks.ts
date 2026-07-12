export type UsdtDonationNetwork = {
  id: string;
  name: string;
  standard: string;
  address: string;
  accentClassName: string;
};

// Donation addresses are public by design. Keep one explicit address per
// network so the UI never suggests that a wallet address is cross-chain.
export const usdtDonationNetworks: readonly UsdtDonationNetwork[] = [
  {
    id: 'bnb-chain',
    name: 'BNB Chain',
    standard: 'BEP20',
    address: '0xecE224461627a13118982Fa28202Eb9768678AFD',
    accentClassName: 'bg-amber-400',
  },
  {
    id: 'tron',
    name: 'TRON',
    standard: 'TRC20',
    address: 'TAM5uVRpQexgn7gzAhWR7DZyHmyLgRRakP',
    accentClassName: 'bg-red-500',
  },
  {
    id: 'ethereum',
    name: 'Ethereum',
    standard: 'ERC20',
    address: '0xecE224461627a13118982Fa28202Eb9768678AFD',
    accentClassName: 'bg-indigo-400',
  },
  {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    standard: 'C-Chain',
    address: '0xecE224461627a13118982Fa28202Eb9768678AFD',
    accentClassName: 'bg-rose-500',
  },
  {
    id: 'polygon',
    name: 'Polygon',
    standard: 'PoS',
    address: '0xecE224461627a13118982Fa28202Eb9768678AFD',
    accentClassName: 'bg-violet-500',
  },
  {
    id: 'ton',
    name: 'TON',
    standard: 'The Open Network',
    address: 'UQBE4RXHqPAY8Xft2G9kP_6bbfXbY-gRwR0NVvx-_qWsIeD3',
    accentClassName: 'bg-sky-400',
  },
  {
    id: 'solana',
    name: 'Solana',
    standard: 'SPL',
    address: 'DNhzLgaFMZgLynwPxNyh6Znp9evRozbNprFm9BUXr94Z',
    accentClassName: 'bg-emerald-400',
  },
];
