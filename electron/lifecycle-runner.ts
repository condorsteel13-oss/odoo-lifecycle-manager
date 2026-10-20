import { setTimeout as delay } from 'node:timers/promises';
import type { LiveRecord, LiveReview } from '../src/shared/live';
import { AppError } from './errors';
import { LiveService } from './live-service';

export interface RunnerOptions {
  signal: AbortSignal;
  progress: (stage:string,recordId:string)=>void;
  readLink: (record:LiveRecord)=>Promise<string>;
  wait?: (signal:AbortSignal)=>Promise<void>;
  now?: ()=>number;
  timeoutMs?: number;
}
export function assertRunning(signal:AbortSignal){
  if(signal.aborted)throw new AppError('LIFECYCLE_STOPPED','Lifecycle stopped. Any submitted action may still complete. Use the action log to verify; no further action will start.');
}

// Only this invocation continues a cycle. Nothing resumes on startup or on a
// preference change. Retries below are reads; sends and links retain one-shot logs.
export class LifecycleRunner {
  constructor(private live:LiveService,private options:RunnerOptions){}
  async finish(id:string,mode:'guided'|'automatic'):Promise<LiveReview|null>{
    const {signal}=this.options,now=this.options.now??Date.now;
    const deadline=now()+(this.options.timeoutMs??15*60_000);
    while(now()<deadline){
      assertRunning(signal);this.options.progress('Waiting for the copy and checking its identity, activation and expiry',id);
      try{
        await this.live.verifyCopy(id);assertRunning(signal);
        this.options.progress(mode==='guided'?'Preparing the separate deletion review':'Verifying both databases before deleting the original',id);
        const review=await this.live.prepareDelete(id);assertRunning(signal);
        if(mode==='guided')return review;
        await this.live.commitAutomatic(review.ticket);
        return null;
      }catch(error){
        assertRunning(signal);
        const record=this.live.getRecord(id);
        const code=error instanceof AppError?error.code:'';
        // Never continue or replay a deletion with an uncertain outcome.
        if(['delete-submitting','delete-unknown','deleted','copy-removed','copy-retained'].includes(record.phase))throw error;
        if(code==='LIVE_BLOCKED'&&record.phase==='activation-pending'){
          this.options.progress('Activating the copy using the signed-in user’s connected mailbox',id);
          try{
            const activation=await this.live.startActivation(id);assertRunning(signal);
            if(activation)await this.live.completeActivation(id,this.options.readLink);
          }
          catch(activationError){
            assertRunning(signal);
            const after=this.live.getRecord(id),activationCode=activationError instanceof AppError?activationError.code:'';
            if(activationCode!=='MAIL_NOT_ARRIVED'&&!(activationCode==='LIVE_BLOCKED'&&after.phase==='awaiting-expiry'))throw activationError;
          }
        }else if(!(code==='DATABASE_MISSING'||code==='LIVE_BLOCKED'&&record.phase==='awaiting-expiry'))throw error;
      }
      assertRunning(signal);
      if(this.options.wait)await this.options.wait(signal);
      else await delay(15_000,undefined,{signal}).catch(()=>assertRunning(signal));
    }
    throw new AppError('LIFECYCLE_WAITING','The copy is not ready after 15 minutes. No deletion started. Check the log and use Continue lifecycle when ready; duplication will not be submitted again.');
  }
}
