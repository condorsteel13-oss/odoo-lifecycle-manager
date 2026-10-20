import { chmod, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BrowserContext } from 'playwright';
import { AppError } from './errors';
import { EncryptedActivationJournal } from './activation-flow';

// The cipher is Electron safeStorage in production (macOS Keychain). No secret
// is sent to the renderer, diagnostics, reports, or ordinary state.json.
export interface SessionCipher { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
const cookie = z.object({ name:z.string().max(256), value:z.string().max(32768), domain:z.string().max(254), path:z.string().startsWith('/').max(2048), expires:z.number(), httpOnly:z.boolean(), secure:z.boolean(), sameSite:z.enum(['Strict','Lax','None']), partitionKey:z.string().optional() }).strip();
export const mailSessionSchema = z.object({ email:z.email().max(254), accessToken:z.string().min(1).max(32768), refreshToken:z.string().min(1).max(32768) }).strict();
export type MailSession = z.infer<typeof mailSessionSchema>;
const saved = z.discriminatedUnion('kind', [
  z.object({version:z.literal(1),kind:z.literal('odoo'),cookies:z.array(cookie).max(2000)}).strict(),
  z.object({version:z.literal(1),kind:z.literal('mail'),session:mailSessionSchema}).strict(),
]);
function odooDomain(domain:string) { return /^(?:\.?odoo\.com|\.?[a-z0-9][a-z0-9-]*\.odoo\.com)$/.test(domain); }
export class SessionVault {
  readonly path:string;
  constructor(private profile:string, private kind:'odoo'|'mail', private cipher:SessionCipher) { this.path=join(profile,'lifecycle-session.enc'); }
  activationJournal(){return new EncryptedActivationJournal(join(this.profile,'activation-handoffs'),this.cipher);}
  private requireCipher(){if(!this.cipher.available())throw new AppError('SESSION_STORAGE_UNAVAILABLE','macOS secure storage is unavailable. Unlock your login keychain to save or reuse connections.');}
  private async read(){
    try{
      const bytes=await readFile(this.path);this.requireCipher();
      if(bytes.length>4_000_000)throw new Error();
      const value=saved.parse(JSON.parse(this.cipher.decrypt(bytes)));
      if(value.kind!==this.kind)throw new Error();
      return value;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      if(error instanceof AppError)throw error;
      throw new AppError('SESSION_STORAGE_UNAVAILABLE','The saved connection could not be unlocked. Sign in again to replace it, or clear saved sessions in Settings.');
    }
  }
  private async write(value:z.infer<typeof saved>){
    this.requireCipher();
    const encrypted=this.cipher.encrypt(JSON.stringify(saved.parse(value)));
    try{
      await mkdir(this.profile,{recursive:true,mode:0o700});await chmod(this.profile,0o700);
      await writeFile(this.path+'.tmp',encrypted,{mode:0o600});await chmod(this.path+'.tmp',0o600);
      await rename(this.path+'.tmp',this.path);
    }catch{throw new AppError('SESSION_STORAGE_UNAVAILABLE','The encrypted connection could not be saved. Check the app’s storage permissions.');}
  }
  async saveOdoo(context:BrowserContext){
    if(this.kind!=='odoo')throw new Error('Wrong vault');
    const cookies=(await context.cookies()).filter(c=>odooDomain(c.domain));
    await this.write({version:1,kind:'odoo',cookies});
  }
  async restoreOdoo(context:BrowserContext){
    const value=await this.read();if(!value||value.kind!=='odoo')return;
    if(value.cookies.some(c=>!odooDomain(c.domain)))throw new AppError('SESSION_STORAGE_UNAVAILABLE','Saved session scope is invalid. Sign in again.');
    await context.addCookies(value.cookies.filter(c=>c.expires===-1||c.expires>Date.now()/1000));
  }
  async saveMail(session:MailSession){if(this.kind!=='mail')throw new Error('Wrong vault');await this.write({version:1,kind:'mail',session});}
  async restoreMail(){const value=await this.read();return value?.kind==='mail'?value.session:null;}
  async clear(){await rm(this.path,{force:true});}
}
