import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { ADDR, EXECUTOR_START_BLOCK } from './config';
import { erc20Abi, executedEvent, executorWriteAbi, orderCreatedEvent } from './abi';
import { publicClient } from './data';

export type Protection = {
  id: bigint;
  token: Address;
  amount: bigint;
  status: 'active' | 'executed' | 'cancelled';
  hasStop: boolean;
  hasCreator: boolean;
  hasHolders: boolean;
  allowance: bigint; // how many tokens the executor is allowed to sell for this wallet
  expiry: number;
  createdTx: Hex;
  exit?: { tokensSold: bigint; quoteReceived: bigint; fee: bigint; trigger: number; tx: Hex };
};

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Created = { id: bigint; token: Address; block: bigint; tx: Hex };
type Exit = NonNullable<Protection['exit']>;

const CHUNK = 200_000n;
const BUFFER = 20n;

/** The protections (orders) that belong to a wallet, read straight from the executor's events. */
export function useProtections(owner: Address | null) {
  const [items, setItems] = useState<Protection[]>([]);
  const [loading, setLoading] = useState(false);
  const created = useRef(new Map<string, Created>());
  const exits = useRef(new Map<string, Exit>());
  const scanned = useRef<bigint>(EXECUTOR_START_BLOCK - 1n);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!owner || busy.current) return;
    busy.current = true;
    try {
      const latest = await publicClient.getBlockNumber();
      let from = scanned.current + 1n > BUFFER ? scanned.current + 1n - BUFFER : EXECUTOR_START_BLOCK;
      if (from < EXECUTOR_START_BLOCK) from = EXECUTOR_START_BLOCK;

      for (let start = from; start <= latest; start += CHUNK) {
        const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
        const [made, done] = await Promise.all([
          publicClient.getLogs({ address: ADDR.executor, event: orderCreatedEvent, args: { owner }, fromBlock: start, toBlock: end }),
          publicClient.getLogs({ address: ADDR.executor, event: executedEvent, args: { owner }, fromBlock: start, toBlock: end }),
        ]);
        for (const l of made) {
          created.current.set(String(l.args.id), {
            id: l.args.id!,
            token: l.args.token!,
            block: l.blockNumber,
            tx: l.transactionHash,
          });
        }
        for (const l of done) {
          exits.current.set(String(l.args.id), {
            tokensSold: l.args.tokensSold!,
            quoteReceived: l.args.quoteReceived!,
            fee: l.args.feePaid!,
            trigger: Number(l.args.trigger),
            tx: l.transactionHash,
          });
        }
      }
      scanned.current = latest;

      const list = [...created.current.values()].sort((a, b) => (a.block < b.block ? 1 : -1)).slice(0, 30);
      if (list.length === 0) {
        setItems([]);
        return;
      }

      // order state and allowances for these orders, in one batched call
      const contracts = list.flatMap((c) => [
        { address: ADDR.executor, abi: executorWriteAbi, functionName: 'orders', args: [c.id] },
        { address: c.token, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.executor] },
      ]);
      const res = (await publicClient.multicall({
        contracts: contracts as never,
        allowFailure: true,
        batchSize: 0,
      })) as unknown as CallResult[];

      const next: Protection[] = [];
      list.forEach((c, i) => {
        const o = res[2 * i];
        const a = res[2 * i + 1];
        if (o.status !== 'success') return;
        const t = o.result as readonly [Address, Address, bigint, bigint, Address, bigint, bigint, number, number, number, number];
        const code = Number(t[10]); // 1 active, 2 executed, 3 cancelled
        next.push({
          id: c.id,
          token: c.token,
          amount: t[2],
          status: code === 2 ? 'executed' : code === 3 ? 'cancelled' : 'active',
          hasStop: t[3] !== 0n,
          hasCreator: t[4] !== '0x0000000000000000000000000000000000000000',
          hasHolders: t[6] !== 0n,
          allowance: a.status === 'success' ? (a.result as bigint) : 0n,
          expiry: Number(t[7]),
          createdTx: c.tx,
          exit: exits.current.get(String(c.id)),
        });
      });
      setItems(next);
    } catch {
      // keep what we have; the next refresh tries again
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    created.current = new Map();
    exits.current = new Map();
    scanned.current = EXECUTOR_START_BLOCK - 1n;
    setItems([]);
    if (!owner) return;
    setLoading(true);
    void refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [owner, refresh]);

  return { items, loading, refresh };
}
