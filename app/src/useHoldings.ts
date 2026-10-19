import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { erc20Abi } from './abi';
import { fetchMeta, fetchPrices, publicClient } from './data';
import { loadMeta, saveMeta } from './useTokens';

export type Holding = {
  token: Address;
  balance: bigint;
  symbol: string;
  name: string;
  priceUsd: number | null;
  valueUsd: number | null;
};

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Ascend tokens this wallet holds, checked in a few batched calls. */
export function useHoldings(owner: Address | null, tokens: Address[], active: boolean) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  const refresh = useCallback(async () => {
    if (!owner || busy.current || tokensRef.current.length === 0) return;
    busy.current = true;
    setLoading(true);
    try {
      const list = tokensRef.current;
      const held: Array<{ token: Address; balance: bigint }> = [];
      for (let i = 0; i < list.length; i += 40) {
        const chunk = list.slice(i, i + 40);
        const res = (await publicClient.multicall({
          contracts: chunk.map((t) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })) as never,
          allowFailure: true,
          batchSize: 0,
        })) as unknown as CallResult[];
        chunk.forEach((t, k) => {
          const r = res[k];
          if (r.status === 'success' && (r.result as bigint) > 0n) held.push({ token: t, balance: r.result as bigint });
        });
        if (i + 40 < list.length) await sleep(300);
      }

      const tokensHeld = held.map((h) => h.token);
      const cache = loadMeta();
      const missing = tokensHeld.filter((t) => !cache[t.toLowerCase()]);
      if (missing.length) {
        const got = await fetchMeta(missing);
        got.forEach((v, k) => (cache[k] = v));
        saveMeta(cache);
      }
      const prices = tokensHeld.length ? await fetchPrices(tokensHeld) : new Map<string, number | null>();

      setHoldings(
        held
          .map((h) => {
            const k = h.token.toLowerCase();
            const price = prices.get(k) ?? null;
            const whole = Number(h.balance / 10n ** 12n) / 1e6;
            return {
              token: h.token,
              balance: h.balance,
              symbol: cache[k]?.symbol ?? '???',
              name: cache[k]?.name ?? '',
              priceUsd: price,
              valueUsd: price === null ? null : price * whole,
            };
          })
          .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
      );
    } catch {
      // keep the last list
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    if (!active || !owner) return;
    void refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [active, owner, refresh, tokens.length]);

  return { holdings, loading, refresh };
}
