import {Hono} from 'hono'

/**
 * `showcaseOrigin` is the hostname the logged-out gallery is framed from. It is
 * a label under the platform's wildcard, which resolves publicly to a private
 * address:
 * on the network the frame loads, off it the request goes nowhere and the
 * section stays hidden. That is the whole mechanism, and it lives here rather
 * than in a served config because the page needs it before it can ask for
 * anything.
 */
export function dashboardRoutes(deps: {showcaseOrigin: string; publicBaseUrl: string; signInHint: string}) {
    const app = new Hono()
    const page = DASHBOARD
        .replace(/__SHOWCASE_ORIGIN__/g, deps.showcaseOrigin)
        .replace(/__PLATFORM_HOST__/g, new URL(deps.publicBaseUrl).host)
        .replace(/__PLATFORM_ORIGIN__/g, deps.publicBaseUrl)
        .replace(/__SIGNIN_HINT__/g, deps.signInHint)
    app.get('/', c => c.html(page))
    return app
}

const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>__PLATFORM_HOST__</title>
  <link rel="icon" href="/favicon.svg">
  <style>
    :root{color-scheme:dark;font:15px/1.5 Inter,ui-sans-serif,system-ui;background:#090b10;color:#f4f6fb}
    *{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:auto;padding:56px 24px 96px}
    header{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:52px}
    h1{font-size:clamp(32px,6vw,64px);letter-spacing:-.06em;line-height:1;margin:0 0 18px}
    h2{font-size:18px;margin:0}.muted{color:#9aa3b2}.hero{max-width:700px;margin-bottom:42px}
    .card{background:#11151d;border:1px solid #252b37;border-radius:18px;padding:20px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}
    /* auto-FILL for the two lists, for the same reason spelled out below on
       .gallery: auto-fit collapses the empty tracks and stretches what is left,
       so an account with one project rendered it as a single 992px card. The
       form row above keeps auto-fit, because two forms splitting the width
       evenly is exactly what it should do. */
    #projects,#tokens{grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}
    /* There was no rule for a plain link at all, so every project URL fell back
       to the browser's default blue-then-purple against a near-black page.
       a.button and a.tile set their own colour at higher specificity. */
    a{color:#7aa2f7}
    button,a.button{border:0;border-radius:10px;background:#fff;color:#080a0e;padding:10px 15px;font-weight:700;text-decoration:none;cursor:pointer}
    button.secondary{background:#232a36;color:#fff}
    /* font:inherit or these render in the browser's default UI font at ~13px,
       a visibly different typeface from the Inter around them. */
    input,select,textarea{width:100%;font:inherit;padding:11px;border-radius:9px;border:1px solid #343b48;background:#0b0e14;color:#fff;margin:7px 0 12px}
    textarea{resize:vertical}
    .project{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    /* min-width:0 is the whole fix, and it looks like nothing: a flex item
       refuses by default to shrink below its min-content width, and this
       column's min-content is an unbreakable https://<slug>.<platform domain>.
       So the row overflowed the card and squeezed the one item that could
       shrink — the badge — until "showcase" read "showcas". */
    .project>div{min-width:0}
    .project strong{overflow-wrap:anywhere}
    /* The slug above already names the project and every URL ends in the same
       the same domain suffix, so one clipped line loses nothing and keeps every
       card header the same height. The full URL stays in the title. */
    .project a{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{font-size:12px;border:1px solid #3b4555;border-radius:99px;padding:3px 8px;white-space:nowrap;flex:none}
    /* Grid already gives the cards in a row equal height; this spends the
       leftover on the gap above the stats footer, so those bordered bands line
       up along the bottom of a row instead of floating wherever the content
       happened to end. The auto margin has to sit on the LAST child: on the
       button it would push each card's button down by that card's own stats
       height, and a project with no sparkline yet has a shorter block than one
       with — which is exactly how they fell out of line.
       Scoped to #projects because .token below is also a .card and sets
       display:flex without a direction — it would inherit this column. */
    #projects .card{display:flex;flex-direction:column}
    #projects .card>.stats{margin-top:auto}
    /* align-self or the button stretches to the full width of the column. */
    #projects .card>button{align-self:flex-start}
    code{color:#a6e3a1;word-break:break-all}.row{display:flex;gap:10px;align-items:center}.hidden{display:none}#notice{margin:16px 0;color:#f9e2af}
    fieldset{border:1px solid #343b48;border-radius:9px;margin:7px 0 12px;padding:10px 12px}
    legend{padding:0 6px;font-size:13px;color:#9aa3b2}
    .check{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:14px}
    input[type=checkbox]{width:auto;margin:0}
    .token{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    button.danger{background:#3a2027;color:#ffb4b4;padding:6px 11px;font-size:13px}
    /* auto-FILL, not auto-fit. auto-fit collapses the empty tracks and stretches
       what is left, so a gallery holding one project rendered that project as a
       single 992px card with a 689px-tall screenshot — the whole page, for one
       app. auto-fill keeps the track width it was given and simply leaves the
       rest of the row empty, so one card looks like one card.
       Wider than the generic .grid because a card here carries a screenshot of a
       1440px-wide page; at 270px that is a smudge. 380px gives two columns in
       the 992px content area, which keeps a page title legible. */
    .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px}
    a.tile{display:block;text-decoration:none;color:inherit;background:#11151d;border:1px solid #252b37;border-radius:18px;overflow:hidden}
    a.tile:hover{border-color:#3b4555}
    /* One fixed shape for every card, whatever the page behind it looks like.
       object-position:top because the top of a page is the part that says what
       it is. */
    .shot{display:block;width:100%;aspect-ratio:1.44;object-fit:cover;object-position:top;background:#0b0e14;border-bottom:1px solid #252b37}
    /* Capture is asynchronous and can fail, so a card must read as complete
       with no image at all rather than showing a broken one. */
    .shot.empty{display:flex;align-items:center;justify-content:center;color:#4b5364;font-size:13px}
    .tile-body{padding:14px 16px 16px}
    .tile-body p{margin:6px 0 0}
    .desc{font-size:14px;color:#c7cedb}
    .by{font-size:12px;color:#7d8798;margin-top:8px}
    .section-note{margin:0 0 14px;font-size:13px}
    /* The visit summary on a project card. Rendered after the card, because it
       is fetched per project rather than carried on the project list. */
    .stats{margin:12px 0 0;padding-top:12px;border-top:1px solid #252b37}
    .stats .figure{font-size:14px}
    .stats b{font-weight:700}
    .spark{display:block;width:100%;height:34px;margin-top:8px;overflow:visible}
    .spark path{fill:none;stroke:#a6e3a1;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
    .spark .base{stroke:#252b37;stroke-width:1}
    .stats .range{font-size:12px;color:#7d8798;margin:4px 0 0;display:flex;justify-content:space-between}
    .tile-views{font-size:12px;color:#7d8798;margin-top:6px}
  </style>
</head>
<body><main>
  <header><strong>RITSDEV / SITES</strong><div class="row"><a class="button secondary" href="/skills/create-ritsdev/SKILL.md">Guide</a><a id="adminlink" class="button secondary hidden" href="/admin">System admin</a><span id="account" class="muted">Checking session…</span><button id="signout" class="secondary hidden">Sign out</button></div></header>
  <section class="hero"><h1>Ship small apps to the network.</h1><p class="muted">Static sites, Deno functions, a dedicated PostgreSQL database, and S3-compatible storage. Source comes from the CLI or the public MCP; deployed apps remain inside the private network.</p></section>
  <div id="logged-out" class="hidden">
    <div class="card"><h2>Sign in to start</h2><p class="muted">__SIGNIN_HINT__ New accounts get a quota of three projects.</p><a class="button" href="/auth/google">Continue with Google</a></div>
    <!-- Stays hidden unless the frame reports back. It is served from a
         hostname that resolves to a private address, so a browser off the
         network never loads it and this section never appears. -->
    <section id="showcase-public" class="hidden" style="margin-top:40px">
      <h2 style="margin:0 0 6px">From the network</h2>
      <p class="section-note muted">Projects whose owners chose to share them. You are seeing these because you are on the platform's network; the sites themselves open only from here or the VPN.</p>
      <iframe id="showcase-frame" title="Shared projects" style="width:100%;border:0;display:block" scrolling="no"></iframe>
    </section>
  </div>
  <div id="logged-in" class="hidden">
    <section id="showcase" class="hidden">
      <h2 style="margin:0 0 6px">From the network</h2>
      <p class="section-note muted">Projects whose owners chose to share them. The sites themselves open only from the private network or the VPN.</p>
      <div id="gallery" class="gallery"></div>
    </section>
    <div class="grid" style="margin-top:32px">
      <form id="create" class="card"><h2>New project</h2><label>Slug<input name="slug" placeholder="my-site" pattern="[a-z][a-z0-9-]{2,39}" required></label><label>Access<select name="access"><option value="owner">Only me</option><option value="network">Everyone on the network</option></select></label><p class="muted" style="font-size:13px;margin:0 0 10px">To put a project in the gallery, deploy it, give it a description, then set its access to Shared in the gallery.</p><button>Create project</button></form>
      <form id="token" class="card"><h2>Personal token</h2><p class="muted">For the CLI or MCP clients that cannot use OAuth. Shown once, at creation.</p>
        <p class="muted" style="font-size:13px">Install the CLI:<br><code>curl -fsSL __PLATFORM_ORIGIN__/cli -o ritsdev &amp;&amp; chmod +x ritsdev</code></p>
        <label>Name<input name="name" value="My CLI" required></label>
        <fieldset><legend>Scopes</legend>
          <label class="check"><input type="checkbox" name="scopes" value="sites:read" checked> <span>sites:read <span class="muted">— list and inspect projects</span></span></label>
          <label class="check"><input type="checkbox" name="scopes" value="sites:write" checked> <span>sites:write <span class="muted">— create, configure, delete</span></span></label>
          <label class="check"><input type="checkbox" name="scopes" value="deployments:write" checked> <span>deployments:write <span class="muted">— build and deploy</span></span></label>
          <label class="check"><input type="checkbox" name="scopes" value="logs:read" checked> <span>logs:read <span class="muted">— read build and runtime logs</span></span></label>
          <label class="check"><input type="checkbox" name="scopes" value="database:read"> <span>database:read <span class="muted">— download a full copy of the project database</span></span></label>
        </fieldset>
        <label>Expires after<select name="expiresInDays">
          <option value="1">1 day</option><option value="7">7 days</option>
          <option value="30" selected>30 days</option><option value="90">90 days</option>
          <option value="365">365 days</option>
        </select></label>
        <button>Create token</button></form>
    </div>
    <p id="notice"></p>
    <h2 style="margin:32px 0 14px">Active tokens</h2><div id="tokens" class="grid"></div>
    <h2 style="margin:32px 0 14px">Projects</h2><div id="projects" class="grid"></div>
  </div>
</main><script>
const $=s=>document.querySelector(s);
async function json(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.message||b.error||r.statusText);return b}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The role ladder, as the server holds it. Asked as a rank rather than a list
// of names so a tier added above operator keeps the admin link instead of
// silently losing it.
const ROLE_RANK={user:0,operator:1,superadmin:2};
const atLeastRole=(role,min)=>(ROLE_RANK[role]||0)>=ROLE_RANK[min];
/* The frame is only pointed at the embed host once, and only for a visitor who
   is not signed in. A browser that cannot route to that host fails silently —
   which is exactly the signal we want, since the host resolves to a private
   address that does not exist on the public internet. */
const SHOWCASE_ORIGIN='__SHOWCASE_ORIGIN__';
function publicGallery(){
  const frame=$('#showcase-frame');
  addEventListener('message',e=>{
    const d=e.data;
    if(!d||d.ritsdev!=='showcase')return;
    if(e.origin!==SHOWCASE_ORIGIN)return;
    /* Reveal on the frame's first word — that is the reachability signal, and
       it must not wait for a height, because the frame cannot measure itself
       until this section stops being display:none. Resize separately, whenever
       a real number turns up. */
    $('#showcase-public').classList.remove('hidden');
    if(typeof d.height==='number'&&d.height>0)frame.style.height=(d.height+8)+'px';
  });
  frame.src=SHOWCASE_ORIGIN+'/showcase-embed';
}
async function boot(){try{const me=await json('/auth/me');$('#account').textContent=me.email;if(atLeastRole(me.role,'operator'))$('#adminlink').classList.remove('hidden');$('#signout').classList.remove('hidden');$('#logged-in').classList.remove('hidden');await load();await loadGallery();await loadTokens()}catch{$('#account').textContent='';$('#logged-out').classList.remove('hidden');publicGallery()}}
$('#signout').onclick=async()=>{try{await json('/auth/logout',{method:'POST'});location.href='/'}catch(x){$('#notice').textContent=x.message}}
const ACCESS_LABELS={owner:'Only me',network:'Everyone on the network',showcase:'Shared in the gallery'};
function accessOptions(current){return Object.keys(ACCESS_LABELS).map(v=>\`<option value="\${v}"\${v===current?' selected':''}>\${ACCESS_LABELS[v]}</option>\`).join('')}
async function load(){const {projects}=await json('/v1/projects');$('#projects').innerHTML=projects.length?projects.map(p=>\`<article class="card"><div class="project"><div><strong>\${esc(p.slug)}</strong><div><a href="\${esc(p.url)}" title="\${esc(p.url)}">\${esc(p.url)}</a></div><small class="muted">\${esc(p.status)} · \${p.currentVersionId?'deployed':'not deployed'}</small></div><span class="badge">\${esc(p.access)}</span></div>
<label style="margin-top:12px;display:block">Gallery description<textarea data-desc="\${esc(p.slug)}" maxlength="200" rows="2" placeholder="What is this app for?">\${esc(p.showcase.description)}</textarea></label>
<label>Access<select data-access="\${esc(p.slug)}">\${accessOptions(p.access)}</select></label>
\${p.showcase.draft?\`<p class="muted" style="font-size:13px;margin:0 0 10px">Suggested from your page — check it before using it: “\${esc(p.showcase.draft)}” <button class="secondary" style="padding:4px 9px;font-size:12px" data-usedraft="\${esc(p.slug)}" data-draft="\${esc(p.showcase.draft)}">Use this</button></p>\`:''}
<button class="secondary" data-save="\${esc(p.slug)}">Save listing</button>
<div class="stats hidden" data-stats="\${esc(p.slug)}"></div></article>\`).join(''):'<p class="muted">No projects yet.</p>';loadStats(projects)}
/* Fetched per project rather than carried on /v1/projects, so the project list
   query stays a plain select and a mutation never pays for an aggregate. The
   quota is three projects for a normal account, so this is three small
   requests, issued together. A project whose stats fail to load simply keeps
   its card without them. */
async function loadStats(projects){await Promise.all(projects.map(async p=>{
 const box=$('[data-stats="'+CSS.escape(p.slug)+'"]');if(!box)return;
 let a;try{a=await json('/v1/projects/'+encodeURIComponent(p.slug)+'/analytics')}catch{return}
 const parts=[];
 parts.push('<b>'+a.views.toLocaleString()+'</b> page load'+(a.views===1?'':'s'));
 parts.push('<b>'+a.visitors.toLocaleString()+'</b> visitor'+(a.visitors===1?'':'s'));
 if(a.apiRequests)parts.push('<b>'+a.apiRequests.toLocaleString()+'</b> API request'+(a.apiRequests===1?'':'s'));
 const days=a.daily.map(d=>d.views);
 const total=a.views+a.apiRequests;
 box.innerHTML='<p class="figure">'+parts.join(' · ')+' <span class="muted">· last '+a.days+' days</span></p>'
  +(total?spark(days)+'<p class="range"><span>'+esc(a.daily[0].day)+'</span><span>'+esc(a.daily[a.daily.length-1].day)+'</span></p>':'')
  +'<p class="range"><span>Counted at the edge — nothing is added to your pages. Your own visits count too, unless the site is set to Only me.</span></p>';
 box.classList.remove('hidden');
}))}
/* Hand-rolled because this page has no build step and no dependencies, and one
   polyline does not justify changing that. The ||1 on the peak is load-bearing:
   an all-zero series would otherwise divide by zero and put NaN in every
   coordinate, rendering nothing at all. */
function spark(values){if(!values.length)return '';
 const w=100,h=34,peak=Math.max.apply(null,values)||1,step=values.length>1?w/(values.length-1):0;
 const d=values.map((v,i)=>(i?'L':'M')+(i*step).toFixed(2)+','+(h-(v/peak)*h).toFixed(2)).join(' ');
 return '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true">'
  +'<path class="base" d="M0,'+h+' L'+w+','+h+'"></path><path d="'+d+'"></path></svg>'}
/* The description is saved before the access change, because moving to
   showcase with no description is refused by the server; doing it the other
   way round would make "type a description and pick Shared" fail once. */
$('#projects').onclick=async e=>{const d=e.target.dataset||{};
 if(d.usedraft){$('[data-desc="'+CSS.escape(d.usedraft)+'"]').value=d.draft;return}
 if(!d.save)return;const slug=d.save;
 try{const desc=$('[data-desc="'+CSS.escape(slug)+'"]').value.trim();const access=$('[data-access="'+CSS.escape(slug)+'"]').value;
  if(desc)await json('/v1/projects/'+encodeURIComponent(slug)+'/showcase',{method:'PUT',body:JSON.stringify({description:desc})});
  await json('/v1/projects/'+encodeURIComponent(slug)+'/access',{method:'PATCH',body:JSON.stringify({access})});
  $('#notice').textContent='Saved '+slug+'.';await load();await loadGallery()}catch(x){$('#notice').textContent=x.message}}
/* Signed-in only, and it is the caller's own session that fetches every image:
   the gallery never becomes readable by handing a URL to someone else. */
async function loadGallery(){let projects=[];try{({projects}=await json('/v1/showcase'))}catch{return}
 if(!projects.length){$('#showcase').classList.add('hidden');return}
 $('#showcase').classList.remove('hidden');
 $('#gallery').innerHTML=projects.map(p=>\`<a class="tile" href="\${esc(p.url)}">\${p.screenshotUrl?\`<img class="shot" src="\${esc(p.screenshotUrl)}" alt="" loading="lazy">\`:'<div class="shot empty">No screenshot yet</div>'}<div class="tile-body"><strong>\${esc(p.slug)}</strong><p class="desc">\${esc(p.description)}</p><p class="by">by \${esc(p.ownerName)}</p><p class="tile-views">\${p.views.toLocaleString()} view\${p.views===1?'':'s'} in the last 30 days</p></div></a>\`).join('')}
$('#create').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));try{await json('/v1/projects',{method:'POST',body:JSON.stringify(d)});e.target.reset();await load()}catch(x){$('#notice').textContent=x.message}}
async function loadTokens(){const {tokens}=await json('/v1/tokens');const active=tokens.filter(t=>!t.revokedAt);$('#tokens').innerHTML=active.length?active.map(t=>\`<article class="card token"><div><strong>\${esc(t.name)}</strong> <code>…\${esc(t.lastFour)}</code><div class="muted" style="font-size:13px;margin-top:4px">\${t.scopes.map(esc).join(', ')}</div><small class="muted">expires \${t.expiresAt?new Date(t.expiresAt).toLocaleDateString():'never'} · \${t.lastUsedAt?'last used '+new Date(t.lastUsedAt).toLocaleDateString():'never used'}</small></div><button class="danger" data-revoke="\${esc(t.id)}">Revoke</button></article>\`).join(''):'<p class="muted">No active tokens.</p>'}
$('#tokens').onclick=async e=>{const id=e.target.dataset&&e.target.dataset.revoke;if(!id)return;if(!confirm('Revoke this token? Anything using it stops working immediately.'))return;try{await json('/v1/tokens/'+encodeURIComponent(id),{method:'DELETE'});$('#notice').textContent='Token revoked.';await loadTokens()}catch(x){$('#notice').textContent=x.message}}
$('#token').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const scopes=f.getAll('scopes');if(!scopes.length){$('#notice').textContent='Select at least one scope.';return}try{const t=await json('/v1/tokens',{method:'POST',body:JSON.stringify({name:f.get('name'),scopes,expiresInDays:Number(f.get('expiresInDays'))})});$('#notice').innerHTML='Copy this token now, it is not shown again: <code>'+esc(t.token)+'</code>';await loadTokens()}catch(x){$('#notice').textContent=x.message}}
boot();
</script></body></html>`
