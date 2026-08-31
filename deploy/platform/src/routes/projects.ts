import {Readable} from 'node:stream'
import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {bodyLimit} from 'hono/body-limit'
import {z} from 'zod'
import {requireScopes, type Authenticator, type TokenService} from '../lib/authn'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'
import {MAX_SHOWCASE_SHOT_BYTES, MAX_SOURCE_BYTES, type ProjectService} from '../lib/projects'

export function projectRoutes(deps: {projects: ProjectService; authenticator: Authenticator; tokens: TokenService}) {
    const app = new Hono()
    const jsonBody = bodyLimit({maxSize: 1024 * 1024})
    const sourceBody = bodyLimit({maxSize: MAX_SOURCE_BYTES})
    const shotBody = bodyLimit({maxSize: MAX_SHOWCASE_SHOT_BYTES})
    app.use('*', (c, next) => {
        if (c.req.path.endsWith('/sources')) return sourceBody(c, next)
        if (c.req.path.endsWith('/showcase/screenshot')) return shotBody(c, next)
        return jsonBody(c, next)
    })
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))

    app.get('/', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json({projects: await deps.projects.list(principal)})
    })
    app.post('/', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        // Not 'showcase': a project that does not exist yet has nothing to
        // show and no description to show it under. The gallery is reached by
        // PATCH /:slug/access once there is a deployed version, which is also
        // the one place the description requirement is enforced.
        const body = z.object({
            slug: z.string(),
            access: z.enum(['owner', 'network']).optional(),
            postgres: z.boolean().optional(),
            storage: z.boolean().optional(),
            llm: z.boolean().optional(),
        }).parse(await c.req.json())
        return c.json(await deps.projects.create(principal, body), 202)
    })
    app.get('/:slug', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json(await deps.projects.get(principal, c.req.param('slug')))
    })
    app.patch('/:slug/access', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const body = z.object({access: z.enum(['owner', 'network', 'showcase'])}).parse(await c.req.json())
        return c.json(await deps.projects.updateAccess(principal, c.req.param('slug'), body.access))
    })
    app.put('/:slug/showcase', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const body = z.object({description: z.string()}).parse(await c.req.json())
        return c.json(await deps.projects.setShowcaseListing(principal, c.req.param('slug'), body.description))
    })
    // Raw bytes rather than multipart, matching POST /:slug/sources: there is
    // no multipart parser in this service and one image does not justify
    // adding a body format for. The declared content type is not trusted —
    // the service checks the PNG magic bytes.
    app.put('/:slug/showcase/screenshot', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const bytes = Buffer.from(await c.req.arrayBuffer())
        return c.json(await deps.projects.setShowcaseScreenshot(principal, c.req.param('slug'), bytes))
    })
    app.post('/:slug/resources', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const body = z.object({
            postgres: z.boolean().optional(),
            storage: z.boolean().optional(),
            llm: z.boolean().optional(),
        }).parse(await c.req.json())
        return c.json(await deps.projects.enableResources(principal, c.req.param('slug'), body), 202)
    })
    app.post('/:slug/database/exports', async c => {
        const principal = requirePrincipal(c); checked(principal, 'database:read')
        const body = z.object({include: z.enum(['schema', 'all']).default('schema')})
            .parse(await c.req.json().catch(() => ({})))
        return c.json(await deps.projects.exportDatabase(principal, c.req.param('slug'), body.include))
    })
    app.get('/:slug/database/exports/:jobId/download', async c => {
        const principal = requirePrincipal(c); checked(principal, 'database:read')
        const file = await deps.projects.exportFile(principal, c.req.param('slug'), c.req.param('jobId'))
        // Streamed rather than read into memory: a dump can be hundreds of MiB
        // and this container runs under a small memory limit. The URL carries no
        // capability, so one pasted into a transcript is inert without the
        // caller's own credentials.
        const {createReadStream} = await import('node:fs')
        const stream = createReadStream(file.path)
        return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
            'content-type': 'application/gzip',
            'content-length': String(file.sizeBytes),
            'content-disposition': `attachment; filename="${file.filename}"`,
            'cache-control': 'no-store',
        })
    })
    app.put('/:slug/secrets', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const body = z.object({secrets: z.record(z.string().nullable())}).parse(await c.req.json())
        return c.json(await deps.projects.setSecrets(principal, c.req.param('slug'), body.secrets))
    })
    app.post('/:slug/sources', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (!['application/gzip', 'application/x-gzip'].includes(contentType ?? '')) {
            throw new HTTPException(415, {message: 'source uploads must use application/gzip'})
        }
        const contentLength = c.req.header('content-length')
        if (!contentLength) throw new HTTPException(411, {message: 'content-length is required'})
        const length = Number(contentLength)
        if (!Number.isSafeInteger(length) || length < 1) throw new HTTPException(400, {message: 'invalid content-length'})
        if (length > MAX_SOURCE_BYTES) throw new HTTPException(413, {message: 'source archive too large'})
        const body = new Uint8Array(await c.req.arrayBuffer())
        return c.json(await deps.projects.uploadSource(principal, c.req.param('slug'), body, c.req.header('x-content-sha256')), 201)
    })
    app.post('/:slug/versions', async c => {
        const principal = requirePrincipal(c); checked(principal, 'deployments:write')
        const body = z.object({sourceRevisionId: z.string().uuid()}).parse(await c.req.json())
        return c.json(await deps.projects.createVersion(
            principal,
            c.req.param('slug'),
            body.sourceRevisionId,
            c.req.header('idempotency-key'),
        ), 202)
    })
    app.get('/:slug/versions', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json({versions: await deps.projects.listVersions(principal, c.req.param('slug'))})
    })
    app.get('/:slug/versions/:versionId', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json(await deps.projects.getVersion(principal, c.req.param('slug'), c.req.param('versionId')))
    })
    app.post('/:slug/versions/:versionId/probe', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        const body = await c.req.json().catch(() => ({}))
        return c.json(await deps.projects.probeVersion(
            principal, c.req.param('slug'), c.req.param('versionId'), body,
        ))
    })
    app.post('/:slug/versions/:versionId/render', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json(await deps.projects.renderVersion(principal, c.req.param('slug'), c.req.param('versionId')))
    })
    app.post('/:slug/deployments', async c => {
        const principal = requirePrincipal(c); checked(principal, 'deployments:write')
        const body = z.object({versionId: z.string().uuid()}).parse(await c.req.json())
        return c.json(await deps.projects.deploy(
            principal,
            c.req.param('slug'),
            body.versionId,
            c.req.header('idempotency-key'),
        ), 201)
    })
    app.get('/:slug/deployments/:deploymentId', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        return c.json(await deps.projects.getDeployment(
            principal,
            c.req.param('slug'),
            c.req.param('deploymentId'),
        ))
    })
    app.get('/:slug/analytics', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:read')
        const days = c.req.query('days')
        return c.json(await deps.projects.analytics(
            principal,
            c.req.param('slug'),
            days === undefined ? undefined : Number(days),
        ))
    })
    app.get('/:slug/logs', async c => {
        const principal = requirePrincipal(c); checked(principal, 'logs:read')
        return c.json({logs: await deps.projects.logs(principal, c.req.param('slug'), Number(c.req.query('limit') ?? 200))})
    })
    app.delete('/:slug', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        const body = z.object({confirmation: z.string(), immediate: z.boolean().optional()}).parse(await c.req.json())
        return c.json(await deps.projects.delete(
            principal,
            c.req.param('slug'),
            body.confirmation,
            body.immediate ?? false,
        ), 202)
    })
    app.post('/:slug/restore', async c => {
        const principal = requirePrincipal(c); checked(principal, 'sites:write')
        return c.json(await deps.projects.restore(principal, c.req.param('slug')))
    })
    return app
}

function checked(principal: Parameters<typeof requireScopes>[0], scope: Parameters<typeof requireScopes>[1]): void {
    try {
        requireScopes(principal, scope)
    } catch (error) {
        throw new HTTPException(403, {message: (error as Error).message})
    }
}
