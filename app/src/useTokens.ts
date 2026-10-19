import { useEffect, useMemo, useRef, useState } from 'react';
import { TOTAL_SUPPLY, HOOK_START_BLOCK } from './config';
import {
  fetchMeta,
  fetchPrices,
  looksLikeAddress,
  lookupToken,
  scanLaunches,
  type Launch,
  type Meta,
} from './data';

const LAUNCH_KEY = 'ripcord.launches.v3';
const META_KEY = 'ripcord.meta.v3';
const REORG_BUFFER = 20n;
const PAGE = 12;

type StoredLaunch = { token: Launch['token']; poolId: Launch['poolId']; creator: Launch['creator']; block: string };

function loadLaunches(): { scannedTo: bigint; launches: Launch[] } {
  try {
    const raw = localStorage.getItem(LAUNCH_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { scannedTo: string; launches: StoredLaunch[] };
      return { scannedTo: BigInt(s.scannedTo), launches: s.launches.map((l) => ({ ...l, block: BigInt(l.block) })) };
    }
  } catch {
    // fall through to a fresh start
  }
  return { scannedTo: HOOK_START_BLOCK - 1n, launches: [] };
}

function saveLaunches(scannedTo: bigint, launches: Launch[]) {
  try {
    localStorage.setItem(
      LAUNCH_KEY,
      JSON.stringify({ scannedTo: scannedTo.toString(), launches: launches.map((l) => ({ ...l, block: l.block.toString() })) })
    );
  } catch {
    // storage unavailable: rebuilt next time
  }
}

export function loadMeta(): Record<string, Meta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, Meta>;
  } catch {
    return {};
  }
}

export function saveMeta(m: Record<string, Meta>) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}

export type TokenRow = Launch & {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  sameNameCount: number; // how many launched tokens share this name and symbol
};

export type Lookup = { status: 'idle' } | { status: 'loading' } | { status: 'notfound' };

export function useTokens(query: string) {
  const start = useRef(loadLaunches());
  const [launches, setLaunches] = useState<Launch[]>(start.current.launches);
  const [meta, setMeta] = useState<Record<string, Meta>>(loadMeta);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [extra, setExtra] = useState<Launch | null>(null); // a pasted address that is not in the scanned list yet
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const [visible, setVisible] = useState(PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [metaTick, setMetaTick] = useState(0);
  const scannedTo = useRef(start.current.scannedTo);
  const metaRef = useRef(meta);
  metaRef.current = meta;

  const q = query.trim();
  const isAddr = looksLikeAddress(q);

  // 1) keep the list of launches up to date
  useEffect(() => {
    let alive = true;
    let busy = false;
    async function sync() {
      if (busy) return;
      busy = true;
      try {
        const base = scannedTo.current;
        const from = base > HOOK_START_BLOCK + REORG_BUFFER ? base - REORG_BUFFER : HOOK_START_BLOCK;
        const res = await scanLaunches(from);
        scannedTo.current = res.scannedTo;
        if (!alive) return;
        setLaunches((prev) => {
          const map = new Map(prev.map((l) => [l.token.toLowerCase(), l]));
          for (const l of res.launches) map.set(l.token.toLowerCase(), l);
          const next = [...map.values()].sort((a, b) => (a.block < b.block ? 1 : a.block > b.block ? -1 : 0));
          saveLaunches(res.scannedTo, next);
          return next;
        });
        setNotice(null);
      } catch {
        if (alive) setNotice('The network is busy. Showing saved data and retrying…');
      } finally {
        busy = false;
        if (alive) setLoading(false);
      }
    }
    void sync();
    const t = setInterval(sync, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // 2) show 12 at first on every new search
  useEffect(() => setVisible(PAGE), [q]);

  // 3) a pasted address that we have not scanned yet: ask the chain directly
  useEffect(() => {
    setExtra(null);
    if (!isAddr) {
      setLookup({ status: 'idle' });
      return;
    }
    if (launches.some((l) => l.token.toLowerCase() === q.toLowerCase())) {
      setLookup({ status: 'idle' });
      return;
    }
    let alive = true;
    setLookup({ status: 'loading' });
    lookupToken(q).then((l) => {
      if (!alive) return;
      if (l) {
        setExtra(l);
        setLookup({ status: 'idle' });
      } else {
        setLookup({ status: 'notfound' });
      }
    });
    return () => {
      alive = false;
    };
  }, [q, isAddr, launches]);

  // 4) what to display
  const matches = useMemo(() => {
    if (!q) return launches;
    const needle = q.toLowerCase();
    if (isAddr) return launches.filter((l) => l.token.toLowerCase() === needle);
    return launches.filter((l) => {
      const m = meta[l.token.toLowerCase()];
      return (
        l.token.toLowerCase().includes(needle) ||
        (m && (m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)))
      );
    });
  }, [q, isAddr, launches, meta]);

  const shownLaunches = useMemo(() => {
    const base = matches.slice(0, visible);
    return extra ? [extra, ...base.filter((l) => l.token !== extra.token)] : base;
  }, [matches, visible, extra]);

  // 5) names and symbols: the ones on screen first, then everything else slowly in the background
  useEffect(() => {
    const have = metaRef.current;
    const first = shownLaunches.filter((l) => !have[l.token.toLowerCase()]).map((l) => l.token);
    const rest = launches.filter((l) => !have[l.token.toLowerCase()]).map((l) => l.token);
    const todo = [...new Set([...first, ...rest])].slice(0, 40);
    if (todo.length === 0) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const got = await fetchMeta(todo);
        if (!alive) return;
        if (got.size > 0) {
          const next = { ...metaRef.current };
          got.forEach((v, k) => (next[k] = v));
          saveMeta(next);
          setMeta(next);
        }
        // keep going until everything has a name; back off if nothing came back
        setTimeout(() => alive && setMetaTick((n) => n + 1), got.size > 0 ? 500 : 6000);
      } catch {
        setTimeout(() => alive && setMetaTick((n) => n + 1), 8000);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [shownLaunches, launches, metaTick]);

  // 6) prices: only for what is on screen, every 20 seconds
  const shownKey = shownLaunches.map((l) => l.token).join(',');
  useEffect(() => {
    if (shownLaunches.length === 0) return;
    let alive = true;
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const got = await fetchPrices(shownLaunches.map((l) => l.token));
        if (!alive) return;
        setPrices((prev) => {
          const next = { ...prev };
          got.forEach((v, k) => {
            if (v !== null || !(k in next)) next[k] = v;
          });
          return next;
        });
      } catch {
        // keep the previous prices and try again later
      } finally {
        busy = false;
      }
    }
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of launches) {
      const m = meta[l.token.toLowerCase()];
      if (!m) continue;
      const key = `${m.symbol.toLowerCase()}|${m.name.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [launches, meta]);

  const rows: TokenRow[] = shownLaunches.map((l) => {
    const k = l.token.toLowerCase();
    const m = meta[k];
    const p = prices[k] ?? null;
    return {
      ...l,
      name: meta[k]?.name ?? null,
      symbol: meta[k]?.symbol ?? null,
      priceUsd: p,
      marketCapUsd: p === null ? null : p * TOTAL_SUPPLY,
      sameNameCount: m ? nameCounts.get(`${m.symbol.toLowerCase()}|${m.name.toLowerCase()}`) ?? 1 : 1,
    };
  });

  return {
    launches,
    rows,
    total: matches.length + (extra && !matches.some((l) => l.token === extra.token) ? 1 : 0),
    loading,
    notice,
    lookup,
    canShowMore: matches.length > visible,
    showMore: () => setVisible((v) => v + PAGE),
  };
}
