import { useState, type ReactNode } from 'react';
import { Download, Eye, EyeOff } from 'lucide-react';
import { LOG_PERIODS, logRange, logOverlaps, type LogPeriod } from './domain/live-export';
import type { LiveRecord } from './shared/live';

const visibilityKey = 'lifecycle.live-log-hidden.v1';
export function LiveActionLog({ records, children }: { records: LiveRecord[]; children: ReactNode }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(visibilityKey) === 'true'; } catch { return false; } });
  const [exporting, setExporting] = useState(false), [period, setPeriod] = useState<LogPeriod>('week');
  const [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [error, setError] = useState(''), [saved, setSaved] = useState('');
  let range, rangeError = '';
  try { range = logRange(period, new Date(), start, end); } catch (failure) { rangeError = (failure as Error).message; }
  const count = range ? records.filter(record => logOverlaps(record, range!)).length : 0;
  function toggle() {
    const value = !hidden; setHidden(value);
    try { localStorage.setItem(visibilityKey, String(value)); } catch { /* Still works for this visit. */ }
  }
  async function exportLog() {
    setError(''); setSaved(''); setExporting(true);
    try {
      // Resolve relative periods at click time, even if this page has been open for hours.
      const path = await window.lifecycle.exportLiveLog(logRange(period, new Date(), start, end));
      if (path) setSaved(`Debug log saved to ${path}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The debug log could not be exported.'); }
    finally { setExporting(false); }
  }
  return <section className="panel settings-panel live-log" aria-labelledby="live-log-title">
    <div className="live-log-heading"><div><h2 id="live-log-title">Live action log <span className="count-pill">{records.length}</span></h2><p>History is kept even when the log is hidden.</p></div><button className="button secondary" aria-expanded={!hidden} aria-controls="live-log-body" onClick={toggle}>{hidden ? <Eye size={15}/> : <EyeOff size={15}/>} {hidden ? 'Show log' : 'Hide log'}</button></div>
    <details className="live-export"><summary><Download size={15}/>Export debug log</summary>
      <div className="live-export-fields">
        <label className="form-label">Date range<select aria-label="Log export date range" value={period} disabled={exporting} onChange={event => setPeriod(event.target.value as LogPeriod)}>{LOG_PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {period === 'custom' && <><label className="form-label">From<input type="date" aria-label="Log export from date" value={start} disabled={exporting} onChange={event => setStart(event.target.value)}/></label><label className="form-label">Through<input type="date" aria-label="Log export through date" value={end} disabled={exporting} onChange={event => setEnd(event.target.value)}/></label></>}
      </div>
      <p>{rangeError || `${count} matching run${count === 1 ? '' : 's'}. Includes full step histories for runs active during this period and diagnostics from this session.`}</p>
      <p>Custom dates include both days in this Mac’s time zone. Export includes database names, timestamps and outcomes; login sessions, activation URLs and mailbox contents are omitted.</p>
      <button className="button secondary" disabled={exporting || !!rangeError} onClick={exportLog}><Download size={15}/>{exporting ? 'Exporting…' : 'Export JSON'}</button>
      {error && <p role="alert" className="export-error">{error}</p>}{saved && <p role="status">{saved}</p>}
    </details>
    {hidden ? <p className="live-log-hidden">Log hidden. Export is still available above.</p> : <div id="live-log-body">{children}</div>}
  </section>;
}
