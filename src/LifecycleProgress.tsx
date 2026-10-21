import type { LifecycleProgress as Progress } from './shared/progress';
import { useEffect, useState } from 'react';

function waitingCountdown(message: string | undefined) {
  const match = message?.match(/^(.*waiting for activation email) \((\d+):(\d{2})\)$/);
  return match ? { prefix: match[1], seconds: Number(match[2]) * 60 + Number(match[3]) } : null;
}

export function LifecycleProgress({progress,message,events,onStop,stopping=false}: {
  progress:Progress; message?:string; events?:Progress[]; onStop?:()=>void; stopping?:boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const sourceMessage = message ?? progress.message;
  const [deadline, setDeadline] = useState<number | null>(() => {
    const countdown = waitingCountdown(sourceMessage);
    return countdown ? Date.now() + countdown.seconds * 1000 : null;
  });
  useEffect(() => {
    const countdown = waitingCountdown(sourceMessage);
    setDeadline(countdown ? Date.now() + countdown.seconds * 1000 : null);
  }, [sourceMessage]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const countdown = waitingCountdown(sourceMessage);
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const displayMessage = countdown && remaining !== null
    ? `${countdown.prefix} (${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')})`
    : sourceMessage;
  return <section className={`lifecycle-progress ${progress.status}`} aria-label="Lifecycle progress details">
    <div className="progress-heading"><strong role="status" aria-live="polite">{displayMessage}</strong><span>{progress.percent}%</span></div>
    <progress aria-label="Lifecycle progress" max={100} value={progress.percent}/>
    {progress.detail?<p>{progress.detail}</p>:null}
    <div className="progress-footer"><small>Step progress</small>{onStop?<button className="button secondary" disabled={stopping} onClick={onStop}>{stopping?'Stopping…':'Stop lifecycle'}</button>:null}</div>
    {events?.length?<details><summary>Step history</summary><ol>{events.map((event,index)=><li key={`${event.at}-${index}`}><span>{event.message}</span><small>{event.status} · {new Date(event.at).toLocaleTimeString()}</small>{event.detail?<p>{event.detail}</p>:null}</li>)}</ol></details>:null}
  </section>;
}
