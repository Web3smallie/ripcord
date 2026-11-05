import { useState } from 'react';
import type { Address } from 'viem';
import { explorerAddress } from './config';
import { MAX_WATCH } from './watchlist';
import { shortAddr } from './format';
import { summarizeConcentration } from './concentration';
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

export function RadarBody({
  result,
  onReload,
  select,
  loadedAt,
}: {
  result: RadarResult;
  onReload: () => void;
  select?: {
    selected: Address[];
    buyer: string | null;
    onToggle: (a: Address) => void;
  };
  loadedAt: number | null;
}) {
  if (result.status === 'error') {
    return (
      <div>
        <div className="banner banner-bad">Couldn’t load Radar data.</div>
        <p className="muted small">The chain could not be read just now: {result.message.split('\n')[0]}</p>
        <button className="btn btn-ghost btn-small" onClick={onReload}>
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
        <button className="btn btn-ghost btn-small" onClick={onReload}>
          Try again
        </button>
      </div>
    );
  }
  const c = summarizeConcentration(result);
  return (
    <div>
      <div className="ok-head">
        <p className="muted small">
          Verified at block {result.block.toString()}
          {loadedAt !== null ? ` · loaded at ${new Date(loadedAt).toLocaleTimeString()}` : ''}
        </p>
        <button className="btn btn-ghost btn-small" onClick={onReload}>
          Refresh
        </button>
      </div>
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
          <span className="muted">Dust wallets</span>
          <span>
            {result.dust.count} wallets hold {fmtTokens(result.dust.balance)}
          </span>
        </div>
      </div>
      <a className="muted small link" href={explorerAddress(result.token)} target="_blank" rel="noreferrer">
        View token contract
      </a>

      <h4 className="radar-h">Supply distribution</h4>
      {c.distribution.map((d) => (
        <div key={d.key} className="dist-row">
          <div className="dist-top">
            <span>{d.label}</span>
            <span className="muted">
              {fmtTokens(d.balance)} · {fmtPct(d.pctTotal, 2)}
            </span>
          </div>
          <div className="dist-bar">
            <span style={{ width: `${d.balance > 0n ? Math.max(d.pctTotal, 0.5) : 0}%` }} />
          </div>
        </div>
      ))}

      <h4 className="radar-h">
        Concentration <span className="pill">provisional thresholds</span>
      </h4>
      {c.notes.length === 0 ? (
        <p className="muted small">No concentration notes under the provisional thresholds.</p>
      ) : (
        <ul className="notes">
          {c.notes.map((n) => (
            <li key={n.key} className={n.breached ? 'warn' : undefined}>
              <div>{n.text}</div>
              <div className="muted small">{n.detail}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{c.methodology}</p>

      <h4 className="radar-h">
        Holder ranking <span className="muted small">verified{select ? ' · tick wallets to watch' : ''}</span>
      </h4>
      <ol className="holders">
        {c.ranked.map((h) => (
          <li key={h.address} className="holder-row">
            {select && (
              <input
                type="checkbox"
                checked={select.selected.some((s) => s.toLowerCase() === h.address.toLowerCase())}
                disabled={
                  h.isContract ||
                  (select.buyer !== null && h.address.toLowerCase() === select.buyer.toLowerCase()) ||
                  (select.selected.length >= MAX_WATCH &&
                    !select.selected.some((s) => s.toLowerCase() === h.address.toLowerCase()))
                }
                onChange={() => select.onToggle(h.address as Address)}
                aria-label={`Watch ${h.address}`}
              />
            )}
            <span className="muted">#{h.rank}</span>
            <a className="link" href={explorerAddress(h.address)} target="_blank" rel="noreferrer">
              {shortAddr(h.address)}
            </a>
            {h.isCreator && <span className="pill">creator</span>}
            {h.isContract && <span className="pill">contract</span>}
            <span className="holder-bal">
              {fmtTokens(h.balance)} · {fmtPct(h.pctCirculating, 2)}
            </span>
          </li>
        ))}
      </ol>
      {result.moreHolders > 0 && (
        <p className="muted small">+{result.moreHolders} further holders above dust not shown.</p>
      )}
    </div>
  );
}

/** `load` exists so tests can feed the panel fake results. The app never passes it. */
export function RadarPanel({
  token,
  onClose,
  onBuy,
  load,
  selectMode,
  initialSelected,
  buyer,
  onUseWatch,
}: {
  token: TokenRow;
  onClose: () => void;
  onBuy: () => void;
  load?: typeof loadRadar;
  selectMode?: boolean;
  initialSelected?: Address[];
  buyer?: string | null;
  onUseWatch?: (addrs: Address[]) => void;
}) {
  const { state, slow, reload, loadedAt } = useRadar(token, { load });
  const [selected, setSelected] = useState<Address[]>(initialSelected ?? []);
  const toggle = (a: Address) =>
    setSelected((prev) =>
      prev.some((s) => s.toLowerCase() === a.toLowerCase())
        ? prev.filter((s) => s.toLowerCase() !== a.toLowerCase())
        : [...prev, a]
    );
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
        {state.phase === 'loading' ? (
          <RadarLoading slow={slow} />
        ) : (
          <RadarBody
            result={state.result}
            onReload={reload}
            loadedAt={loadedAt}
            select={selectMode ? { selected, buyer: buyer ?? null, onToggle: toggle } : undefined}
          />
        )}
        <button
          className="btn btn-block"
          onClick={selectMode && onUseWatch ? () => onUseWatch(selected) : onBuy}
          disabled={selectMode === true && selected.length === 0}
        >
          {selectMode ? `Use ${selected.length} wallet${selected.length === 1 ? '' : 's'}` : 'Continue to Buy & Protect'}
        </button>
        <p className="muted small radar-foot">Protection runs only if a rule trips and the swap succeeds. Losses can still happen.</p>
      </div>
    </div>
  );
}
