import {it,expect} from 'vitest';
import {actionDestination} from '../electron/action-diagnostics';
it('reports known route names without recording credentials or parameter values',()=>{
 const secret='private-credential',url=`https://www.odoo.com/odoo-enterprise/confirm-database/fixture/${secret}?email=user@example.com&token=${secret}&${secret}=anything`;
 const summary=actionDestination(url,'https://fixture.odoo.com');
 expect(summary).toContain('Odoo account /odoo-enterprise/confirm-database/[redacted]/[redacted]');
 expect(summary).not.toMatch(/private-credential|user@example|anything/);
});
it('does not disclose external hosts, usernames, fragments or unknown paths',()=>{
 const summary=actionDestination('https://user:secret@private.example/sensitive?secret=value#private','https://fixture.odoo.com');
 expect(summary).toBe('Other destination /[redacted] (parameters: [redacted]; values omitted)');
 expect(actionDestination('/saas_trial/trial-connect?token=secret','https://fixture.odoo.com')).toContain('Selected database /saas_trial/trial-connect');
});
