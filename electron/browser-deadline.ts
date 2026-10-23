import type { Page } from 'playwright';
import { AppError } from './errors';

// A renderer's AbortSignal timer can pause when Chrome suspends that renderer.
// Keep the deadline in the app process and close only its owned inert reader.
export async function readerDeadline<T>(page:Page, work:(check:()=>void)=>Promise<T>, milliseconds:number, code:string, message:string):Promise<T> {
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const failure=new AppError(code,message);
  const check=()=>{if(expired)throw failure;};
  try {
    return await Promise.race([
      Promise.resolve().then(()=>work(check)),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        expired=true;
        void page.close({runBeforeUnload:false}).catch(()=>{});
        reject(failure);
      },milliseconds);}),
    ]);
  } finally { clearTimeout(timer); }
}

export async function closeReaderPage(page:Page) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { await Promise.race([page.close({runBeforeUnload:false}).catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]); }
  finally { clearTimeout(timer); }
}
