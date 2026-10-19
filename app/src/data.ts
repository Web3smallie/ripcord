import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { ADDR, RPC_URL, elysiumTestnet } from './config';
import { erc20Abi, executorAbi, hookAbi, launchedEvent } from './abi';

// The public RPC rate-limits, so: retry with back-off, batch reads through Multicall3,
// and keep the number of requests small.
export const publicClient = createPublicClient({
  chain: elysiumTestnet,
  transport: http(RPC_URL, { batch: true, retryCount: 5, retryDelay: 600 }),
});

export type Launch = { token: Address; poolId: Hex; creator: Address; block: bigint };
export type Meta = { name: string; symbol: string };

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

const CHUNK = 200_000n;
const PARALLEL = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads every `Launched` event emitted by Ascend's hook from `from` to the latest block. */
export async function scanLaunches(from: bigint): Promise<{ launches: Launch[]; scannedTo: bigint }> {
  const latest = await publicClient.getBlockNumber();
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n;
    ranges.push([start, end > latest ? latest : end]);
  }

  const launches: Launch[] = [];
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const slice = ranges.slice(i, i + PARALLEL);
    const results = await Promise.all(
      slice.map(([a, b]) => publicClient.getLogs({ address: ADDR.hook, event: launchedEvent, fromBlock: a, toBlock: b }))
    );
    for (const logs of results) {
      for (const l of logs) {
        launches.push({ token: l.args.token!, poolId: l.args.poolId!, creator: l.args.creator!, block: l.blockNumber });
      }
    }
    if (i + PARALLEL < ranges.length) await sleep(250);
  }
  return { launches, scannedTo: latest };
}

/** Names and symbols for many tokens in a few calls. Tokens that fail are simply left out. */
export async function fetchMeta(tokens: Address[]): Promise<Map<string, Meta>> {
  const out = new Map<string, Meta>();
  for (let i = 0; i < tokens.length; i += 40) {
    const chunk = tokens.slice(i, i + 40);
    const contracts = chunk.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: 'name' },
      { address: t, abi: erc20Abi, functionName: 'symbol' },
    ]);
    const res = (await publicClient.multicall({
      contracts: contracts as never,
      allowFailure: true,
      batchSize: 0,
    })) as unknown as CallResult[];
    chunk.forEach((t, k) => {
      const n = res[2 * k];
      const s = res[2 * k + 1];
      if (n.status === 'success' && s.status === 'success') {
        out.set(t.toLowerCase(), { name: String(n.result), symbol: String(s.result) });
      }
    });
    if (i + 40 < tokens.length) await sleep(400);
  }
  return out;
}

const ONE_MILLION_TOKENS = 1_000_000n * 10n ** 18n;

/** Price of one token in USDC for many tokens, from the executor's spot preview (no price impact). */
export async function fetchPrices(tokens: Address[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (let i = 0; i < tokens.length; i += 40) {
    const chunk = tokens.slice(i, i + 40);
    const contracts = chunk.map((t) => ({
      address: ADDR.executor,
      abi: executorAbi,
      functionName: 'previewValue',
      args: [t, ONE_MILLION_TOKENS],
    }));
    const res = (await publicClient.multicall({
      contracts: contracts as never,
      allowFailure: true,
      batchSize: 0,
    })) as unknown as CallResult[];
    chunk.forEach((t, k) => {
      const r = res[k];
      if (r.status === 'success') {
        const [quoteValue] = r.result as readonly [bigint, bigint];
        out.set(t.toLowerCase(), Number(quoteValue) / 1e6 / 1_000_000); // USDC has 6 decimals; 1,000,000 tokens
      } else {
        out.set(t.toLowerCase(), null);
      }
    });
    if (i + 40 < tokens.length) await sleep(400);
  }
  return out;
}

export function looksLikeAddress(s: string): boolean {
  return isAddress(s.trim(), { strict: false });
}

/** Checks that a pasted address is a token launched by Ascend, and finds its creator. */
export async function lookupToken(raw: string): Promise<Launch | null> {
  if (!looksLikeAddress(raw)) return null;
  const token = getAddress(raw.trim().toLowerCase());
  try {
    const [, poolId] = await publicClient.readContract({
      address: ADDR.executor,
      abi: executorAbi,
      functionName: 'poolFor',
      args: [token],
    });
    const creator = await publicClient.readContract({
      address: ADDR.hook,
      abi: hookAbi,
      functionName: 'poolCreator',
      args: [poolId],
    });
    return { token, poolId, creator, block: 0n };
  } catch {
    return null;
  }
}
