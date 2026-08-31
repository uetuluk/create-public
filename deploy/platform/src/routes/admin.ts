import {Hono} from 'hono'
import type {Pool} from 'pg'
import {z} from 'zod'
import {AdminService, type AdminWriteService} from '../lib/admin'
import {assertOperator, assertSuperadmin, type Authenticator, type TokenService} from '../lib/authn'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'

export interface AdminDeps {
    pool: Pool
    admin: AdminService
    writes: AdminWriteService
    authenticator: Authenticator
    tokens: TokenService
    /**
     * True when `PLATFORM_OPERATOR_EMAILS` is set on this host. A role granted
     * here is reverted by the next start when it is, so the response says so
     * rather than letting the change look permanent.
     */
    operatorEmailsPinned?: boolean
}

/**
 * The bounds each limit is validated against.
 *
 * These are the column's range and the host's reality, not a product opinion:
 * `runtime_cpu` is NUMERIC(4,2) so 99.99 is what fits, and a runtime under
 * 64 MiB cannot start Deno at all. A superadmin setting a number inside these
 * bounds is doing something supported even if it is unwise — refusing a value
 * the database and the host would both accept is not this layer's business.
 */
const accountPatchSchema = z.object({
    projectQuota: z.number().int().min(1).max(2_147_483_647).optional(),
    role: z.enum(['user', 'operator', 'superadmin']).optional(),
}).strict()

const projectLimitsSchema = z.object({
    runtimeMemoryMiB: z.number().int().min(64).max(65_536).optional(),
    runtimeCpu: z.number().positive().max(99.99).optional(),
    postgresBytes: z.number().int().min(1024 * 1024).optional(),
    objectBytes: z.number().int().min(1024 * 1024).optional(),
    versions: z.number().int().min(1).max(1000).optional(),
}).strict()

/**
 * The operator API.
 *
 * Reads are open to `operator`; the two mutating routes are gated a second time
 * on `superadmin`. The tier is re-read from the control database on every
 * request, so a demotion takes hold immediately rather than at token expiry —
 * which matters more here than anywhere else on the platform, since these are
 * the only routes that change an account the caller does not own.
 */
export function adminRoutes(deps: AdminDeps) {
    const app = new Hono()
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))
    app.use('*', async (c, next) => {
        await assertOperator(deps.pool, requirePrincipal(c))
        await next()
    })

    app.get('/overview', async c => c.json(await deps.admin.overview()))
    app.get('/accounts', async c => c.json({accounts: await deps.admin.accounts()}))
    app.get('/projects', async c => c.json({projects: await deps.admin.projects()}))
    app.get('/jobs', async c => c.json({jobs: await deps.admin.jobs(Number(c.req.query('limit') ?? 50))}))
    app.get('/audit', async c => c.json({events: await deps.admin.audit(Number(c.req.query('limit') ?? 50))}))

    app.patch('/accounts/:id', async c => {
        const principal = requirePrincipal(c)
        await assertSuperadmin(deps.pool, principal)
        const patch = accountPatchSchema.parse(await c.req.json())
        const account = await deps.writes.updateAccount(principal, c.req.param('id'), patch)
        return c.json({
            account,
            ...(patch.role !== undefined && deps.operatorEmailsPinned
                ? {warning: 'PLATFORM_OPERATOR_EMAILS is set on this host, so this role is reverted on the next restart.'
                    + ' Unset it to manage the operator tier through this API.'}
                : {}),
        })
    })

    app.patch('/projects/:slug', async c => {
        const principal = requirePrincipal(c)
        await assertSuperadmin(deps.pool, principal)
        const patch = projectLimitsSchema.parse(await c.req.json())
        return c.json({project: await deps.writes.updateProjectLimits(principal, c.req.param('slug'), patch)})
    })

    return app
}

export function adminPageRoutes(deps: {publicHost: string}) {
    const app = new Hono()
    app.get('/', c => c.html(ADMIN_PAGE.replace('__PLATFORM_HOST__', deps.publicHost)))
    return app
}

const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>System admin · __PLATFORM_HOST__</title>
  <link rel="icon" href="/favicon.svg">
  <style>
    :root{color-scheme:dark;font:15px/1.5 Inter,ui-sans-serif,system-ui;background:#090b10;color:#f4f6fb}
    *{box-sizing:border-box}body{margin:0}main{max-width:1280px;margin:auto;padding:40px 24px 96px}
    header{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:32px;flex-wrap:wrap}
    h1{font-size:28px;letter-spacing:-.03em;margin:0}
    h2{font-size:16px;margin:36px 0 12px;letter-spacing:.02em;text-transform:uppercase;color:#9aa3b2}
    .muted{color:#9aa3b2}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    a.button{border:0;border-radius:10px;background:#232a36;color:#fff;padding:9px 14px;font-weight:700;text-decoration:none}
    .card{background:#11151d;border:1px solid #252b37;border-radius:16px;padding:16px}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
    .tile .label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#9aa3b2}
    .tile .value{font-size:26px;font-weight:700;letter-spacing:-.03em;margin-top:4px}
    .tile .sub{font-size:13px;color:#9aa3b2;margin-top:2px}
    table{width:100%;border-collapse:collapse;font-size:14px}
    th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#9aa3b2;font-weight:600;padding:0 10px 8px}
    td{padding:9px 10px;border-top:1px solid #1e242f;vertical-align:top}
    tbody tr:hover{background:#141924}
    .scroll{overflow-x:auto}
    .badge{font-size:12px;border:1px solid #3b4555;border-radius:99px;padding:2px 8px;white-space:nowrap}
    .ok{color:#a6e3a1;border-color:#2d4636}.warn{color:#f9e2af;border-color:#4a4229}.bad{color:#f38ba8;border-color:#4a2b34}
    .bar{height:5px;border-radius:99px;background:#232a36;overflow:hidden;margin-top:5px;min-width:90px}
    .bar span{display:block;height:100%;background:#7aa2f7}.bar span.warn{background:#f9e2af}.bar span.bad{background:#f38ba8}
    code{color:#a6e3a1;font-size:13px;word-break:break-all}
    .err{color:#f38ba8;font-size:13px}
    .nowrap{white-space:nowrap}
    input,select{font:inherit;background:#0b0f16;color:#f4f6fb;border:1px solid #2f3746;border-radius:8px;padding:5px 8px;width:100%;max-width:130px}
    input:focus,select:focus{outline:2px solid #7aa2f7;outline-offset:1px}
    button{font:inherit;font-weight:600;border:1px solid #2f3746;border-radius:8px;background:#232a36;color:#fff;padding:6px 11px;cursor:pointer}
    button:hover{background:#2c3543}button[disabled]{opacity:.5;cursor:default}
    button.primary{background:#2f4c86;border-color:#3a5da0}
    .field{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa3b2;margin-bottom:3px}
    tr.editing{background:#151b26}
    .paused{color:#f9e2af}
  </style>
</head>
<body><main>
  <header>
    <div><h1>System admin</h1><div class="muted" id="who">Checking operator access…</div></div>
    <div class="row"><span class="muted" id="refreshed"></span><a class="button" href="/">Dashboard</a></div>
  </header>
  <p id="error" class="err"></p>
  <div id="view" hidden>
    <div class="tiles" id="tiles"></div>
    <h2>Host</h2><div id="host" class="card"></div>
    <h2>Projects</h2><div class="card scroll" id="projects"></div>
    <h2>Accounts</h2><div class="card scroll" id="accounts"></div>
    <h2>Jobs</h2><div class="card scroll" id="jobs"></div>
    <h2>Recent activity</h2><div class="card scroll" id="audit"></div>
  </div>
</main><script>
const $=s=>document.querySelector(s);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function json(path){const r=await fetch(path,{headers:{accept:'application/json'}});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.message||b.error||r.statusText);return b}
function bytes(n){if(n==null)return '—';const u=['B','KiB','MiB','GiB','TiB'];let v=Number(n),i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return (v<10&&i?v.toFixed(1):Math.round(v))+' '+u[i]}
function when(t){if(!t)return '—';const s=(Date.now()-new Date(t).getTime())/1000;if(s<0)return new Date(t).toLocaleString();if(s<60)return Math.round(s)+'s ago';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'}
function pct(used,total){return total>0?Math.min(100,Math.round(used/total*100)):0}
function bar(used,total){const p=pct(used,total);const c=p>=90?'bad':p>=75?'warn':'';return '<div class="bar"><span class="'+c+'" style="width:'+p+'%"></span></div>'}
function tile(label,value,sub){return '<div class="card tile"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div><div class="sub">'+(sub||'')+'</div></div>'}
function state(v){const good=['ready','running','active','succeeded'],bad=['failed','storage_exceeded'];const c=good.includes(v)?'ok':bad.includes(v)?'bad':'warn';return '<span class="badge '+c+'">'+esc(v)+'</span>'}
function counts(map){return Object.entries(map||{}).map(([k,v])=>esc(k)+' '+v).join(' · ')||'none'}
// A runtime badge answers "is a function container warm", which is not the same
// question as "is this site up", and reading it as the latter sent an operator
// hunting a fault that did not exist. A project with no functions has nothing
// that could ever run, and an idle one is behaving exactly as designed — neither
// deserves the amber that state() gives every value it does not recognise.
function runtimeBadge(p){
  if(!p.deployed)return '<span class="badge">—</span>';
  if(!p.runtime.functions)return '<span class="badge">static</span>';
  if(p.runtime.state==='stopped')return '<span class="badge">idle</span>';
  return state(p.runtime.state);
}
function table(head,rows){return rows.length?'<table><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>':'<p class="muted">Nothing to show.</p>'}

// The page is read-only for an operator and editable for a superadmin, and it
// learns which from /auth/me rather than from what the API happens to let
// through. A row rendered without inputs is a hint, not a control: the PATCH is
// refused server-side either way.
let ME=null,STATE={accounts:[],projects:[]},EDITING=null,BUSY=false;
// The same ladder the server uses, and for the same reason: asking whether a
// role reaches a rank means a tier added on top inherits what is beneath it,
// where a list of names has to be found and extended in every place it appears.
const RANK={user:0,operator:1,superadmin:2};
const atLeast=(role,min)=>(RANK[role]||0)>=RANK[min];
const canWrite=()=>Boolean(ME)&&atLeast(ME.role,'superadmin');
async function patchJson(path,body){
  const r=await fetch(path,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const b=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(b.message||b.error||r.statusText);
  return b;
}
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const MIB=1048576;
function editButton(key,label){return '<button data-edit="'+esc(key)+'">'+esc(label||'Edit')+'</button>'}
function editControls(key){
  return '<div class="row" style="gap:6px;margin-top:8px">'+
    '<button class="primary" data-save="'+esc(key)+'">Save</button>'+
    '<button data-cancel="1">Cancel</button></div>';
}
function field(name,label,value,attrs){
  return '<label style="display:block;margin-bottom:6px"><span class="field">'+esc(label)+'</span>'+
    '<input name="'+esc(name)+'" value="'+esc(value)+'" '+(attrs||'')+'></label>';
}

function renderOverview(o){
  const rt=o.runtimes,h=o.host;
  $('#tiles').innerHTML=[
    tile('Projects',o.projects.total,esc(o.projects.deployed)+' deployed'),
    tile('Accounts',o.accounts.total,esc(o.accounts.activeLast30Days)+' active in 30d · '+esc(o.accounts.operators)+' operator'),
    tile('Running runtimes',rt.byState&&rt.byState.running||0,counts(rt.byState)),
    tile('Runtime memory',bytes(rt.memoryBytes),rt.sampledContainers?bytes(rt.memoryLimitBytes)+' limit · '+when(rt.sampledAt):'no sample yet'),
    tile('Host memory',h?bytes(h.memoryUsedBytes):'—',h?bytes(h.memoryTotalBytes)+' total'+bar(h.memoryUsedBytes,h.memoryTotalBytes):'executor has not reported'),
    tile('Database use',bytes(o.storage.postgresBytes),'of '+bytes(o.storage.postgresBytesMax)+' granted'+bar(o.storage.postgresBytes,o.storage.postgresBytesMax)),
    tile('Object storage',bytes(o.storage.objectBytes),'of '+bytes(o.storage.objectBytesMax)+' granted'+bar(o.storage.objectBytes,o.storage.objectBytesMax)),
    tile('Jobs in flight',(o.jobs.byStatus.queued||0)+(o.jobs.byStatus.running||0),counts(o.jobs.byStatus)+(o.jobs.oldestQueuedAt?'<br>oldest queued '+when(o.jobs.oldestQueuedAt):'')),
    tile('Last 24h',o.delivery.deploymentsLast24Hours+' deploys',o.delivery.versionsLast24Hours+' builds · '+o.delivery.failedDeploymentsLast24Hours+' failed'),
    tile('Tokens',o.accounts.activeTokens,'active personal access tokens'),
  ].join('');
  $('#host').innerHTML=h?
    '<div class="row" style="gap:26px"><div><div class="muted">Worker</div><code>'+esc(h.worker)+'</code></div>'+
    '<div><div class="muted">CPU</div>'+esc(h.cpuCount)+' cores · load '+h.load.map(l=>esc(l.toFixed(2))).join(' / ')+'</div>'+
    '<div><div class="muted">Memory</div>'+bytes(h.memoryUsedBytes)+' of '+bytes(h.memoryTotalBytes)+' used'+bar(h.memoryUsedBytes,h.memoryTotalBytes)+'</div>'+
    '<div><div class="muted">Platform data volume</div>'+(h.dataTotalBytes?bytes(h.dataTotalBytes-h.dataFreeBytes)+' of '+bytes(h.dataTotalBytes)+' used'+bar(h.dataTotalBytes-h.dataFreeBytes,h.dataTotalBytes):'—')+'</div>'+
    '<div><div class="muted">Sampled</div>'+when(h.sampledAt)+'</div></div>'
    :'<p class="muted">No host sample yet. The executor writes one each housekeeping pass, about once a minute.</p>';
}
function projectEditor(p){
  return '<td colspan="10">'+
    '<div class="row" style="gap:14px;align-items:flex-start">'+
      '<div><div class="field">Project</div>'+esc(p.slug)+'</div>'+
      '<div style="min-width:120px">'+field('runtimeMemoryMiB','Memory MiB',p.quota.runtimeMemoryMiB,'type="number" min="64" step="1"')+'</div>'+
      '<div style="min-width:110px">'+field('runtimeCpu','CPUs',p.quota.runtimeCpu,'type="number" min="0.05" max="99.99" step="0.05"')+'</div>'+
      '<div style="min-width:130px">'+field('postgresMiB','PostgreSQL MiB',Math.round(p.quota.postgresBytes/MIB),'type="number" min="1" step="1"')+'</div>'+
      '<div style="min-width:130px">'+field('objectMiB','Objects MiB',Math.round(p.quota.objectBytes/MIB),'type="number" min="1" step="1"')+'</div>'+
      '<div style="min-width:110px">'+field('versions','Versions kept',p.quota.versions,'type="number" min="1" step="1"')+'</div>'+
    '</div>'+
    '<div class="muted" style="font-size:12px;margin-top:6px">A memory or CPU change restarts a running runtime so the new limit takes effect; the next request brings it back. Storage limits apply without a restart.</div>'+
    editControls('project:'+p.slug)+
  '</td>';
}
function renderProjects(projects){
  const head=['Project','Owner','Status','Runtime','Memory','Database','Objects','Versions','Deployed'];
  $('#projects').innerHTML=table(
    canWrite()?head.concat(['']):head,
    projects.map(p=>EDITING==='project:'+p.slug
      ?'<tr class="editing" data-row="project:'+esc(p.slug)+'">'+projectEditor(p)+'</tr>'
      :'<tr>'+
      '<td><a href="'+esc(p.url)+'">'+esc(p.slug)+'</a><div class="muted" style="font-size:12px">'+esc(p.access)+(p.deletedAt?' · deleting':'')+'</div></td>'+
      '<td class="nowrap">'+esc(p.owner.email)+'</td>'+
      '<td>'+state(p.status)+'</td>'+
      '<td>'+runtimeBadge(p)+'<div class="muted" style="font-size:12px">'+(p.runtime.lastSeenAt?'seen '+when(p.runtime.lastSeenAt):'')+'</div>'+(p.runtime.error?'<div class="err">'+esc(p.runtime.error)+'</div>':'')+'</td>'+
      '<td class="nowrap">'+(p.runtime.memoryBytes==null?'<span class="muted">'+esc(p.quota.runtimeMemoryMiB)+' MiB limit</span>':bytes(p.runtime.memoryBytes)+' / '+bytes(p.runtime.memoryLimitBytes)+bar(p.runtime.memoryBytes,p.runtime.memoryLimitBytes)+'<div class="muted" style="font-size:12px">cpu '+esc(p.runtime.cpuPercent)+'%</div>')+'</td>'+
      '<td class="nowrap">'+(p.resources.postgres?bytes(p.usage.postgresBytes)+' / '+bytes(p.quota.postgresBytes)+bar(p.usage.postgresBytes,p.quota.postgresBytes):'<span class="muted">off</span>')+'</td>'+
      '<td class="nowrap">'+(p.resources.storage?bytes(p.usage.objectBytes)+' / '+bytes(p.quota.objectBytes)+bar(p.usage.objectBytes,p.quota.objectBytes):'<span class="muted">off</span>')+'</td>'+
      '<td class="nowrap">'+esc(p.versions.total)+(p.versions.failed?' <span class="badge bad">'+esc(p.versions.failed)+' failed</span>':'')+' <span class="muted">/ '+esc(p.quota.versions)+'</span></td>'+
      '<td class="nowrap">'+when(p.lastDeployedAt)+'</td>'+
      (canWrite()?'<td class="nowrap">'+editButton('project:'+p.slug)+'</td>':'')+
    '</tr>'));
}
function roleBadge(role){
  if(role==='superadmin')return '<span class="badge bad">superadmin</span>';
  if(role==='operator')return '<span class="badge warn">operator</span>';
  return '<span class="badge">user</span>';
}
// The quota shown is the one that binds. For an operator that is the floor
// rather than the stored column, so both are offered: the column is what an
// edit writes, and showing only the effective number would make a save look
// like it did nothing.
function quotaCell(a){
  const used=esc(a.projects)+' / '+esc(a.quota);
  const pending=a.projectsPendingDeletion?' <span class="muted">('+esc(a.projectsPendingDeletion)+' deleting)</span>':'';
  const floor=a.quota!==a.quotaColumn?'<div class="muted" style="font-size:12px">column '+esc(a.quotaColumn)+' · role floor applies</div>':'';
  return used+pending+floor;
}
function accountEditor(a){
  const pinned=a.role==='superadmin';
  return '<td colspan="8">'+
    '<div class="row" style="gap:18px;align-items:flex-start">'+
      '<div><div class="field">Account</div>'+esc(a.email)+'</div>'+
      '<div style="min-width:150px">'+field('projectQuota','Project quota',a.quotaColumn,'type="number" min="1" step="1"')+'</div>'+
      '<div style="min-width:170px"><span class="field">Role</span>'+
        '<select name="role" '+(pinned?'disabled':'')+'>'+
          ['user','operator'].map(r=>'<option value="'+r+'"'+(a.role===r?' selected':'')+'>'+r+'</option>').join('')+
          (pinned?'<option value="superadmin" selected>superadmin</option>':'')+
        '</select>'+
        (pinned?'<div class="muted" style="font-size:12px;max-width:230px">Set by PLATFORM_SUPERADMIN_EMAILS on the host. The quota is still editable.</div>':'')+
      '</div>'+
    '</div>'+editControls('account:'+a.id)+
  '</td>';
}
function renderAccounts(accounts){
  const head=['Account','Role','Projects','Database','Objects','Tokens','Last login','Joined'];
  $('#accounts').innerHTML=table(
    canWrite()?head.concat(['']):head,
    accounts.map(a=>{
      const key='account:'+a.id;
      if(EDITING===key)return '<tr class="editing" data-row="'+esc(key)+'">'+accountEditor(a)+'</tr>';
      return '<tr>'+
        '<td>'+esc(a.email)+'<div class="muted" style="font-size:12px">'+esc(a.name)+'</div></td>'+
        '<td>'+roleBadge(a.role)+'</td>'+
        '<td class="nowrap">'+quotaCell(a)+'</td>'+
        '<td class="nowrap">'+bytes(a.usage.postgresBytes)+'</td>'+
        '<td class="nowrap">'+bytes(a.usage.objectBytes)+'</td>'+
        '<td class="nowrap">'+esc(a.activeTokens)+(a.tokenLastUsedAt?'<div class="muted" style="font-size:12px">used '+when(a.tokenLastUsedAt)+'</div>':'')+'</td>'+
        '<td class="nowrap">'+when(a.lastLoginAt)+'</td>'+
        '<td class="nowrap">'+when(a.createdAt)+'</td>'+
        (canWrite()?'<td class="nowrap">'+editButton(key)+'</td>':'')+
      '</tr>';
    }));
}
function renderJobs(jobs){
  $('#jobs').innerHTML=table(
    ['Job','Project','Status','Attempts','Created','Finished','Detail'],
    jobs.map(j=>'<tr>'+
      '<td class="nowrap">'+esc(j.kind)+'</td>'+
      '<td class="nowrap">'+esc(j.project||'—')+'</td>'+
      '<td>'+state(j.status)+'</td>'+
      '<td class="nowrap">'+esc(j.attempts)+'</td>'+
      '<td class="nowrap">'+when(j.createdAt)+'</td>'+
      '<td class="nowrap">'+when(j.finishedAt)+'</td>'+
      '<td>'+(j.error?'<span class="err">'+esc(j.error)+'</span>':'<span class="muted">'+esc(j.worker||'')+'</span>')+'</td>'+
    '</tr>'));
}
function renderAudit(events){
  $('#audit').innerHTML=table(
    ['When','Action','Account','Project','Detail'],
    events.map(e=>'<tr>'+
      '<td class="nowrap">'+when(e.createdAt)+'</td>'+
      '<td class="nowrap">'+esc(e.action)+'</td>'+
      '<td class="nowrap">'+esc(e.account||'—')+'</td>'+
      '<td class="nowrap">'+esc(e.project||'—')+'</td>'+
      '<td><code>'+esc(JSON.stringify(e.metadata))+'</code></td>'+
    '</tr>'));
}

function rowValues(key){
  const row=document.querySelector('[data-row="'+key.replace(/"/g,'\\"')+'"]');
  const out={};
  if(row)row.querySelectorAll('input,select').forEach(el=>{if(!el.disabled)out[el.name]=el.value});
  return out;
}
// A save reads only the fields that actually changed. Sending the whole form
// back would rewrite a column somebody else edited between this page loading
// and this button being pressed.
function changed(values,before,map){
  const patch={};
  for(const [name,spec] of Object.entries(map)){
    if(!(name in values))continue;
    const next=spec.parse(values[name]);
    if(next===null)throw new Error(spec.label+' must be a number');
    if(next!==spec.current(before))patch[spec.field]=next;
  }
  return patch;
}
async function saveAccount(id){
  const a=STATE.accounts.find(x=>x.id===id);
  if(!a)throw new Error('this account is no longer listed; refresh and try again');
  const v=rowValues('account:'+id);
  const patch=changed(v,a,{
    projectQuota:{field:'projectQuota',label:'Project quota',parse:num,current:x=>x.quotaColumn},
  });
  if('role' in v && v.role!==a.role)patch.role=v.role;
  if(!Object.keys(patch).length)return null;
  const result=await patchJson('/v1/admin/accounts/'+encodeURIComponent(id),patch);
  return result.warning||null;
}
async function saveProject(slug){
  const p=STATE.projects.find(x=>x.slug===slug);
  if(!p)throw new Error('this project is no longer listed; refresh and try again');
  const v=rowValues('project:'+slug);
  const patch=changed(v,p,{
    runtimeMemoryMiB:{field:'runtimeMemoryMiB',label:'Memory',parse:num,current:x=>x.quota.runtimeMemoryMiB},
    runtimeCpu:{field:'runtimeCpu',label:'CPUs',parse:num,current:x=>x.quota.runtimeCpu},
    postgresMiB:{field:'postgresBytes',label:'PostgreSQL',parse:v=>{const n=num(v);return n===null?null:n*MIB},current:x=>x.quota.postgresBytes},
    objectMiB:{field:'objectBytes',label:'Objects',parse:v=>{const n=num(v);return n===null?null:n*MIB},current:x=>x.quota.objectBytes},
    versions:{field:'versions',label:'Versions kept',parse:num,current:x=>x.quota.versions},
  });
  if(!Object.keys(patch).length)return null;
  const r=await patchJson('/v1/admin/projects/'+encodeURIComponent(slug),patch);
  return r.project&&r.project.runtimeRecycled?'Runtime restarting; the next request to '+slug+' brings it back under the new limits.':null;
}
document.addEventListener('click',async e=>{
  const open=e.target.closest('[data-edit]'),save=e.target.closest('[data-save]'),cancel=e.target.closest('[data-cancel]');
  if(!open&&!save&&!cancel)return;
  if(open){EDITING=open.dataset.edit;$('#error').textContent='';draw();return}
  if(cancel){EDITING=null;$('#error').textContent='';draw();return}
  if(BUSY)return;
  BUSY=true;save.disabled=true;
  try{
    const key=save.dataset.save,id=key.slice(key.indexOf(':')+1);
    const notice=key.startsWith('account:')?await saveAccount(id):await saveProject(id);
    EDITING=null;
    await load();
    // A warning is not an error: the change was written. It says what the host
    // is going to do to it, which is the part somebody would otherwise discover
    // after the next restart.
    $('#error').textContent=notice||'';
    $('#error').className=notice?'paused':'err';
  }catch(x){$('#error').className='err';$('#error').textContent=x.message}
  finally{BUSY=false;draw()}
});

function draw(){
  renderProjects(STATE.projects);renderAccounts(STATE.accounts);
  $('#refreshed').innerHTML=EDITING
    ?'<span class="paused">Editing — auto-refresh paused</span>'
    :'Updated '+esc(new Date().toLocaleTimeString());
}
async function load(){
  const [overview,projects,accounts,jobs,audit]=await Promise.all([
    json('/v1/admin/overview'),json('/v1/admin/projects'),json('/v1/admin/accounts'),
    json('/v1/admin/jobs?limit=50'),json('/v1/admin/audit?limit=50'),
  ]);
  STATE.projects=projects.projects;STATE.accounts=accounts.accounts;
  renderOverview(overview);renderJobs(jobs.jobs);renderAudit(audit.events);
  draw();
  $('#view').hidden=false;
}
async function boot(){
  // /auth/me reports the role the account holds now, not the one the session
  // was minted with, so the page never claims access it does not have.
  try{ME=await json('/auth/me')}
  catch{$('#who').textContent='Not signed in.';$('#error').innerHTML='Sign in from the <a href="/">dashboard</a> to view this page.';return}
  if(!atLeast(ME.role,'operator')){
    $('#who').textContent=ME.email;$('#error').textContent='This page is limited to platform operators.';return;
  }
  $('#who').textContent=ME.email+' · '+ME.role+(canWrite()?' · quotas and limits editable':', read-only');
  try{await load()}catch(x){$('#error').textContent=x.message;return}
  // A refresh mid-edit would replace the inputs somebody is typing into, and a
  // save would then read values off a row that had just been redrawn.
  setInterval(()=>{if(EDITING||BUSY)return;load().catch(x=>{$('#error').textContent=x.message})},15000);
}
boot();
</script></body></html>`
