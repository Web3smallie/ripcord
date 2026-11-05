import { useCallback, useEffect, useState } from 'react';
import type { Launch } from './data';
import { loadRadar, type RadarResult } from './radar';

type RadarLaunch = Pick<Launch, 'token' | 'creator' | 'block' | 'devBuyTokens'>;

export type RadarState = { phase: 'loading' } | { phase: 'done'; result: RadarResult };

const TTL_MS = 60_000;
const SLOW_MS = 8_000;
const cache = new Map<string, { at: number; result: RadarResult }>();

/**
 * Loads the Radar for one token when the panel opens. A recent good answer is reused for a minute.
 * A failed read is never cached, so "Try again" always asks the chain again.
 */
export function useRadar(
  launch: RadarLaunch | null,
  opts: { load?: typeof loadRadar; slowMs?: number } = {}
): { state: RadarState; slow: boolean; reload: () => void } {
  const load = opts.load ?? loadRadar;
  const slowMs = opts.slowMs ?? SLOW_MS;
  const [state, setState] = useState<RadarState>({ phase: 'loading' });
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!launch) return;
    const hit = cache.get(launch.token);
    if (attempt === 0 && hit && Date.now() - hit.at < TTL_MS) {
      setSlow(false);
      setState({ phase: 'done', result: hit.result });
      return;
    }
    let cancelled = false;
    setState({ phase: 'loading' });
    setSlow(false);
    const timer = setTimeout(() => {
      if (!cancelled) setSlow(true);
    }, slowMs);
    void load(launch).then((result) => {
      if (cancelled) return;
      clearTimeout(timer);
      if (result.status !== 'error') cache.set(launch.token, { at: Date.now(), result });
      setSlow(false);
      setState({ phase: 'done', result });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [launch?.token, launch?.creator, launch?.block, launch?.devBuyTokens, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, slow, reload };
}