import {AppError} from './errors';
export async function connectionTimeout<T>(work:()=>Promise<T>,message:string,ms=60000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('CONNECTION_TIMEOUT',message)),ms);})]);}
  finally{clearTimeout(timer);}
}
