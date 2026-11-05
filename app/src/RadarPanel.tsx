import { shortAddr } from './format';
import type { loadRadar, RadarResult } from './radar';
import { useRadar } from './useRadar';
import type { TokenRow } from './useTokens';

/** A token amount with 18 decimals, as a short number such as 991.49M. */
export function fmtTokens(x: bigint): string {
  const n = Number(x / 10n ** 14n) / 1e4;
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n < 1000 ? 4 : 2 }).format(n);
}

/** A percentage with the given decimals. Tiny non-zero values read "<0.01%" instead of a misleading "0.00%". */
export function fmtPct(n: number, decimals: number): string {
  const floor = 10 ** -decimals;
  if (n > 0 && n < floor) return `<${floor.toFixed(decimals)}%`;
  return `${n.toFixed(decimals)}%`;
}

export function RadarLoading({ slow }: { slow: boolean }) {
  return (
    <div role="status" aria-live="polite">
      <p className="muted small">{slow ? 'Still reading the chain. Tokens with a long history take longer.' : 'Reading the chain…'}</p>
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '70%' }} />
      <div className="skeleton" style={{ width: '85%' }} />
    </div>
  );
}

export function RadarBody({ result, onRetry }: { result: RadarResult; onRetry: () => void }) {
  if (result.status === 'error') {
    return (
      <div>
        <div className="banner banner-bad">Couldn’t load Radar data.</div>
        <p className="muted small">The chain could not be read just now: {result.message.split('\n')[0]}</p>
        <button className="btn btn-ghost btn-small" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (result.status === 'incomplete') {
    return (
      <div>
        <div className="banner">
          <strong>Data incomplete.</strong> This token’s holder history does not match what the chain reports, so no figures are shown.
        </div>
        <details className="small muted" style={{ margin: '10px 0' }}>
          <summary>Check details</summary>
          <ul>
            {result.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
        <button className="btn btn-ghost btn-small" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  // Interim summary of verified figures. The ring and holder rows replace this in the next step.
  return (
    <div className="radar-facts">
      <div>
        <span className="muted">Total supply</span>
        <span>{fmtTokens(result.totalSupply)}</span>
      </div>
      <div>
        <span className="muted">Held by the pool (unsold)</span>
        <span>{fmtPct(result.poolPctTotal, 2)} of total</span>
      </div>
      <div>
        <span className="muted">Circulating supply</span>
        <span>{fmtTokens(result.circulating)}</span>
      </div>
      <div>
        <span className="muted">Creator</span>
        <span>
          {result.creator
            ? `${fmtPct(result.creator.pctCirculating, 1)} of circulating (${fmtPct(result.creator.pctTotal, 2)} of total)`
            : 'holds no tokens now'}
        </span>
      </div>
      <div>
        <span className="muted">Other holders listed</span>
        <span>{result.holders.length}</span>
      </div>
    </div>
  );
}

/** `load` exists so tests can feed the panel fake results. The app never passes it. */
export function RadarPanel({ token, onClose, load }: { token: TokenRow; onClose: () => void; load?: typeof loadRadar }) {
  const { state, slow, reload } = useRadar(token, { load });
  const symbol = token.symbol ?? shortAddr(token.token);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal radar" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            {symbol}
            <span className="muted"> · Radar</span>
          </h3>
          <button className="btn btn-ghost btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted small radar-sub">On-chain facts, not a prediction.</p>
        {state.phase === 'loading' ? <RadarLoading slow={slow} /> : <RadarBody result={state.result} onRetry={reload} />}
        <p className="muted small radar-foot">Protection runs only if a rule trips and the swap succeeds. Losses can still happen.</p>
      </div>
    </div>
  );
}