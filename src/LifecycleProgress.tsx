import type { LifecycleProgress as Progress } from './shared/progress';

export function LifecycleProgress({progress,message,events,onStop,stopping=false}: {
  progress:Progress; message?:string; events?:Progress[]; onStop?:()=>void; stopping?:boolean;
}) {
  return <section className={`lifecycle-progress ${progress.status}`} aria-label="Lifecycle progress details">
    <div className="progress-heading"><strong role="status" aria-live="polite">{message??progress.message}</strong><span>{progress.percent}%</span></div>
    <progress aria-label="Lifecycle progress" max={100} value={progress.percent}/>
    {progress.detail?<p>{progress.detail}</p>:null}
    <div className="progress-footer"><small>Step progress</small>{onStop?<button className="button secondary" disabled={stopping} onClick={onStop}>{stopping?'Stopping…':'Stop lifecycle'}</button>:null}</div>
    {events?.length?<details><summary>Step history</summary><ol>{events.map((event,index)=><li key={`${event.at}-${index}`}><span>{event.message}</span><small>{event.status} · {new Date(event.at).toLocaleTimeString()}</small>{event.detail?<p>{event.detail}</p>:null}</li>)}</ol></details>:null}
  </section>;
}
