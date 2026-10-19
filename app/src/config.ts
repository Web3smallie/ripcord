import { defineChain } from 'viem';

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'https://testnet-rpc.elysium.kinetiq.xyz';
export const KEEPER_URL: string = import.meta.env.VITE_KEEPER_URL ?? 'https://ripcord-53y7.onrender.com';
export const PRIVY_APP_ID: string = import.meta.env.VITE_PRIVY_APP_ID ?? '';
export const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
export const EXECUTOR_START_BLOCK = BigInt(import.meta.env.VITE_EXECUTOR_START_BLOCK ?? '11100000');
export const HOOK_START_BLOCK = BigInt(import.meta.env.VITE_HOOK_START_BLOCK ?? '9648800');

export const elysiumTestnet = defineChain({
  id: 99801,
  name: 'Elysium Testnet',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Elysium Explorer', url: 'https://elysium.kinetiq.xyz/testnet-explorer' },
  },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  testnet: true,
});

export const ADDR = {
  hook: '0x6d01f6644bbf1b5074472D3e85aa1465B4d2bF3d',
  executor: '0x484804031B174B67Efa9A380Dde948bd7627e8Fb',
  usdc: '0x84Cc00D13173f7016Bbab22A736dBf75A154cFE2',
} as const;

export const ROUTER = '0x90332b0ecbb2c9517f405627b0dd5d5265246563' as const; // Ascend's UniversalRouter
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

// Every token launched by Ascend's hook has a supply of 1,000,000,000.
export const TOTAL_SUPPLY = 1_000_000_000;

export const explorerAddress = (a: string) => `${elysiumTestnet.blockExplorers.default.url}/address/${a}`;
