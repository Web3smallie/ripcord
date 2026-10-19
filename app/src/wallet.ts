import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, formatEther, type Address } from 'viem';
import { ADDR, elysiumTestnet } from './config';
import { erc20Abi } from './abi';
import { publicClient } from './data';

type LinkedWallet = { type: string; address?: string; walletClientType?: string; chainType?: string };

/** Email / Google / wallet login through Privy. New users get an embedded wallet created for them. */
export function useWallet() {
  const { ready, authenticated, login, logout, createWallet, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [error, setError] = useState<string | null>(null);

  // The wallet object Privy lets us sign with. Prefer the embedded one.
  const active = useMemo(
    () => wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0] ?? null,
    [wallets]
  );
  const activeRef = useRef(active);
  activeRef.current = active;

  // The wallet address Privy already knows about from the account, even before the signer has loaded.
  const linked = (user?.linkedAccounts as unknown as LinkedWallet[] | undefined)?.find(
    (a) => a.type === 'wallet' && a.walletClientType === 'privy' && (!a.chainType || a.chainType === 'ethereum')
  );
  const address = ((active?.address ?? linked?.address) as Address | undefined) ?? null;
  const hasEmbeddedAccount = !!linked;

  const walletChainId = active ? Number(String(active.chainId).split(':').pop()) : null;
  const onElysium = active ? walletChainId === elysiumTestnet.id : hasEmbeddedAccount;
  const isEmbedded = active ? active.walletClientType === 'privy' : hasEmbeddedAccount;

  const switchToElysium = useCallback(async () => {
    const a = activeRef.current;
    if (!a) return;
    setError(null);
    try {
      await a.switchChain(elysiumTestnet.id);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : 'Could not switch network');
    }
  }, []);

  useEffect(() => {
    if (active && isEmbedded && !onElysium) void switchToElysium();
  }, [active, isEmbedded, onElysium, switchToElysium]);

  const creating = useRef(false);
  const attempts = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  const createWalletNow = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    try {
      console.info('[ripcord] creating embedded wallet');
      await Promise.race([
        createWallet(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Creating the wallet timed out. Trying again.')), 20_000)),
      ]);
      console.info('[ripcord] wallet created');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[ripcord] createWallet failed', e);
      if (/already/i.test(msg)) attempts.current = 99; // the wallet exists; it only needs to load
      else setError(msg.slice(0, 200));
    } finally {
      creating.current = false;
      setRetryTick((n) => n + 1);
    }
  }, [createWallet]);

  // Create the wallet automatically right after login (up to 3 tries), without waiting for anything else.
  useEffect(() => {
    if (!authenticated) {
      attempts.current = 0;
      return;
    }
    if (!ready || !user || address || creating.current || attempts.current >= 3) return;
    attempts.current += 1;
    void createWalletNow();
  }, [authenticated, ready, user, address, createWalletNow, retryTick]);

  /** A viem wallet client that signs through the logged-in wallet. Waits for the signer to finish loading. */
  const getWalletClient = useCallback(async () => {
    const started = Date.now();
    while (!activeRef.current && Date.now() - started < 20_000) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const a = activeRef.current;
    if (!a) throw new Error('Your wallet is still loading. Try again in a moment.');
    const provider = await a.getEthereumProvider();
    return createWalletClient({ account: a.address as Address, chain: elysiumTestnet, transport: custom(provider as never) });
  }, []);

  return {
    ready: ready && walletsReady,
    authenticated,
    address,
    onElysium,
    isEmbedded,
    hasEmbeddedAccount,
    error,
    login,
    logout,
    switchToElysium,
    createWalletNow,
    getWalletClient,
    settingUp: authenticated && !address,
    signerReady: !!active,
  };
}

/** HYPE (gas) and USDC balances for the logged-in wallet, refreshed every few seconds. */
export function useBalances(address: Address | null) {
  const [hype, setHype] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);

  useEffect(() => {
    if (!address) {
      setHype(null);
      setUsdc(null);
      return;
    }
    let alive = true;
    async function load() {
      try {
        const [h, u] = await Promise.all([
          publicClient.getBalance({ address: address! }),
          publicClient.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address!] }),
        ]);
        if (alive) {
          setHype(Number(formatEther(h)));
          setUsdc(Number(u) / 1e6);
        }
      } catch {
        // keep the last values
      }
    }
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address]);

  return { hype, usdc };
}
