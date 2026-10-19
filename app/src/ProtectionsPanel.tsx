import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { ADDR, explorerAddress, elysiumTestnet } from './config';
import { erc20Abi, executorWriteAbi } from './abi';
import { fetchMeta, publicClient } from './data';
import { formatTokens, formatUsdc, shortAddr } from './format';
import { loadMeta, saveMeta } from './useTokens';
import { useProtections, type Protection } from './protections';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;

const TRIGGER: Record<number, string> = { 1: 'Price stop', 2: 'Creator sold', 3: 'Top holders sold' };
const txUrl = (h: string) => `${elysiumTestnet.blockExplorers.default.url}/tx/${h}`;

export function ProtectionsPanel({ w }: { w: Wallet }) {
  const { items, loading, refresh } = useProtections(w.address);
  const [names, setNames] = useState<Record<string, string>>(() => {
    const m = loadMeta();
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.symbol]));
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // symbols for the tokens that appear here
  useEffect(() => {
    const missing = [...new Set(items.map((p) => p.token))].filter((t) => !names[t.toLowerCase()]);
    if (missing.length === 0) return;
    let alive = true;
    fetchMeta(missing)
      .then((got) => {
        if (!alive || got.size === 0) return;
        const cache = loadMeta();
        got.forEach((v, k) => (cache[k] = v));
        saveMeta(cache);
        setNames((prev) => {
          const next = { ...prev };
          got.forEach((v, k) => (next[k] = v.symbol));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [items, names]);

  async function cancel(p: Protection) {
    setError(null);
    setBusyId(String(p.id));
    try {
      const client = await w.getWalletClient();
      const h = await client.writeContract({
        address: ADDR.executor,
        abi: executorWriteAbi,
        functionName: 'cancel',
        args: [p.id],
        gas: 150_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? 'Could not cancel. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function activate(p: Protection) {
    setError(null);
    setBusyId(String(p.id));
    try {
      const client = await w.getWalletClient();
      const h = await client.writeContract({
        address: p.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [ADDR.executor, p.amount],
        gas: 120_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? 'Could not switch protection on. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  if (!w.authenticated || !w.address) {
    return (
      <p className="muted">
        Log in to see your protections.{' '}
        <button className="btn btn-small" onClick={w.login}>
          Log in
        </button>
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="muted">{loading ? 'Looking for your protections…' : 'You have no protections yet. Buy a token to start one.'}</p>;
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <div className="list">
        {items.map((p) => {
          const symbol = names[p.token.toLowerCase()] ?? shortAddr(p.token);
          const needsActivate = p.status === 'active' && p.allowance < p.amount;
          const guards = [p.hasStop && 'Price stop', p.hasCreator && 'Creator guard', p.hasHolders && 'Holders watch'].filter(Boolean);
          return (
            <div className="card prot" key={String(p.id)}>
              <div className="prot-main">
                <div>
                  <div className="symbol">
                    {symbol} <span className="muted small">#{String(p.id)}</span>
                  </div>
                  <div className="muted small">{formatTokens(p.amount)} tokens · {guards.join(' · ')}</div>
                </div>
                <div className="right">
                  {p.status === 'executed' && <div className="ok-text">Exited</div>}
                  {p.status === 'cancelled' && <div className="muted">Cancelled</div>}
                  {p.status === 'active' && !needsActivate && <div className="ok-text">Watching</div>}
                  {needsActivate && <div className="warn">Not switched on</div>}
                </div>
              </div>

              {p.status === 'executed' && p.exit && (
                <div className="prot-exit">
                  {TRIGGER[p.exit.trigger] ?? 'Triggered'}: sold {formatTokens(p.exit.tokensSold)} for{' '}
                  <b>{formatUsdc(p.exit.quoteReceived - p.exit.fee)} USDC</b>.{' '}
                  <a className="link" href={txUrl(p.exit.tx)} target="_blank" rel="noreferrer">
                    receipt
                  </a>
                </div>
              )}

              <div className="prot-actions">
                <a className="link small" href={explorerAddress(p.token)} target="_blank" rel="noreferrer">
                  {shortAddr(p.token)}
                </a>
                {needsActivate && (
                  <button className="btn btn-small" disabled={busyId === String(p.id)} onClick={() => activate(p)}>
                    {busyId === String(p.id) ? 'Working…' : 'Switch on'}
                  </button>
                )}
                {p.status === 'active' && (
                  <button className="btn btn-ghost btn-small" disabled={busyId === String(p.id)} onClick={() => cancel(p)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
