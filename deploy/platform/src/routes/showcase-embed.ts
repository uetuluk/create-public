import {timingSafeEqual} from 'node:crypto'
import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {networkAllowed, parseCidrList} from '../lib/network-cidr'
import type {ProjectService, ShowcaseEntry} from '../lib/projects'

/**
 * The gallery as a logged-out visitor on the private network sees it.
 *
 * It exists because of a DNS fact that decides the whole design. Every request
 * to the platform's own domain arrives through the Cloudflare Tunnel — the name
 * resolves to Cloudflare from inside the network as well as outside it, and
 * there is no split-horizon record — so the control plane sees a visitor's
 * public egress address and cannot tell a person sitting on the LAN from a
 * stranger. A `NETWORK_CIDRS` test on the dashboard would reject both.
 *
 * The wildcard beneath it is the opposite: it resolves, publicly, to a private
 * address. From the internet that is simply unroutable. So the reachability
 * question the control plane cannot answer, the visitor's own browser can — it
 * either loads a subresource from that hostname or it does not. The dashboard
 * embeds this page in an iframe and reveals the section only when it reports
 * back.
 *
 * That is why the data is served *here* rather than published on the root
 * domain behind a client-side check. A check in the page would be decoration:
 * anyone could read the underlying endpoint directly. Serving the gallery only
 * on a host that does not route off the network is the control.
 *
 * Four things have to hold, and none of them is the iframe:
 *
 *  1. The `showcase.` label resolves to the LAN address, like every
 *     other wildcard host, and is deliberately absent from the tunnel.
 *  2. Caddy binds only `LAN_BIND_IP`.
 *  3. Caddy stamps `EDGE_PROXY_SECRET` on the hop, which is verified below, so
 *     a request that reached this process by some other route is refused even
 *     if it carries the right Host header.
 *  4. The forwarded visitor address is checked against `NETWORK_CIDRS`, the
 *     same test the gateway applies to a `network` site.
 *
 * The iframe is how the *page* finds out. These four are why the *data* stays
 * on the network.
 */
export const SHOWCASE_EMBED_PATH = '/showcase-embed'

export function showcaseEmbedRoutes(deps: {
    projects: ProjectService
    edgeProxySecret: string
    networkCidrs: string
    /** The one hostname this surface answers on, e.g. showcase.sites.example.org. */
    embedHost: string
}) {
    const app = new Hono()
    const allowedNetworks = parseCidrList(deps.networkCidrs, 'NETWORK_CIDRS')
    const embedHost = deps.embedHost.toLowerCase()

    app.use('*', async (c, next) => {
        const host = (c.req.header('host') ?? '').toLowerCase().split(':')[0]
        // Checked before the edge token so a probe on the public hostname
        // cannot even learn that the token is what it is missing.
        if (host !== embedHost) throw new HTTPException(404, {message: 'not found'})
        if (!safeEqual(c.req.header('x-ritsdev-edge-token'), deps.edgeProxySecret)) {
            throw new HTTPException(403, {message: 'requests must pass through the site edge'})
        }
        const visitor = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim()
        if (!networkAllowed(allowedNetworks, visitor)) {
            throw new HTTPException(403, {message: 'this page is only available from the network'})
        }
        await next()
    })

    app.get('/', async c => {
        const projects = await deps.projects.listShowcase()
        // The content security policy, including the frame-ancestors rule that
        // keeps this page framed by the dashboard alone, is applied globally in
        // server.ts so the two cannot drift apart.
        return c.html(embedPage(projects), 200, {'cache-control': 'no-store'})
    })

    app.get('/shot/:slug', async c => {
        const slug = c.req.param('slug').replace(/\.png$/, '')
        const shot = await deps.projects.showcaseScreenshot(slug)
        return c.body(new Uint8Array(shot.body), 200, {
            'content-type': 'image/png',
            etag: `"${shot.capturedAt.getTime()}"`,
            'cache-control': 'public, max-age=300',
        })
    })

    return app
}

function safeEqual(value: string | undefined, expected: string): boolean {
    if (!value) return false
    const left = Buffer.from(value)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character] as string))

/**
 * Deliberately a whole document rather than a fragment: it is a cross-origin
 * iframe, so it cannot inherit the dashboard's stylesheet and carries its own.
 * The styles are kept in step with the dashboard's `.gallery` block by hand,
 * which is the cost of the isolation being real.
 */
export function embedPage(projects: ShowcaseEntry[]): string {
    const cards = projects.map(project => `<a class="tile" href="${esc(project.url)}" target="_top">`
        + (project.screenshotUrl
            ? `<img class="shot" src="${SHOWCASE_EMBED_PATH}/shot/${esc(project.slug)}.png" alt="" loading="lazy">`
            : '<div class="shot empty">No screenshot yet</div>')
        + `<div class="tile-body"><strong>${esc(project.slug)}</strong>`
        + `<p class="desc">${esc(project.description)}</p>`
        + `<p class="by">by ${esc(project.ownerName)}</p>`
        + `<p class="tile-views">${project.views.toLocaleString()} view${project.views === 1 ? '' : 's'} in the last 30 days</p>`
        + `</div></a>`).join('')

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;font:15px/1.5 Inter,ui-sans-serif,system-ui;color:#f4f6fb}
*{box-sizing:border-box}body{margin:0;background:transparent}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px}
a.tile{display:block;text-decoration:none;color:inherit;background:#11151d;border:1px solid #252b37;border-radius:18px;overflow:hidden}
a.tile:hover{border-color:#3b4555}
.shot{display:block;width:100%;aspect-ratio:1.44;object-fit:cover;object-position:top;background:#0b0e14;border-bottom:1px solid #252b37}
.shot.empty{display:flex;align-items:center;justify-content:center;color:#4b5364;font-size:13px}
.tile-body{padding:14px 16px 16px}.tile-body p{margin:6px 0 0}
.desc{font-size:14px;color:#c7cedb}.by{font-size:12px;color:#7d8798;margin-top:8px}
.tile-views{font-size:12px;color:#7d8798;margin-top:6px}
.muted{color:#9aa3b2}
</style></head>
<body><div class="gallery">${cards || '<p class="muted">Nothing shared yet.</p>'}</div>
<script>
// The parent keeps its section hidden until this arrives, so a browser that
// cannot reach this host shows nothing rather than an empty frame. The height
// travels with it because a cross-origin iframe cannot size itself.
//
// The ResizeObserver is not belt-and-braces, it is the mechanism. Until the
// parent reveals that section it is display:none, and a frame inside a
// display:none subtree has no layout at all — every measurement here is 0, and
// the 'load' event has already been and gone by the time the parent unhides it.
// Reporting once would therefore pin the frame at zero height forever: the
// gallery would be present, correct, and one pixel tall. The observer fires
// again when layout finally happens, and again when the screenshots decode and
// the cards grow.
//
// Two separate signals, and they must stay separate. "I loaded" is what tells
// the parent it is on a network that can reach this host, and it has to be sent
// before any measurement is possible — gating it on a height deadlocks, because
// the parent reveals the section only on a message and the frame can only
// measure once it has been revealed. "I am this tall" then follows whenever
// there is a real number to send, and never carries a zero, which the parent
// cannot tell apart from an empty gallery.
function height(){
  return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight)
}
function send(message){parent.postMessage(Object.assign({ritsdev:'showcase'},message),'*')}
function report(){var h=height();if(h>0)send({height:h})}
send({ready:true});
addEventListener('load',report);
addEventListener('resize',report);
new ResizeObserver(report).observe(document.body);
report();
</script></body></html>`
}
