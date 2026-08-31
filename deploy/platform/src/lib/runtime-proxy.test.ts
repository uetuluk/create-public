import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {
    assertStagingOutsideSource,
    migrationSessionGuards,
    nodeBuildScript,
    parseNetworkList,
    parseRuntimeContainers,
    publishArtifactPermissions,
    PROJECT_LOG_INSERT_SQL,
    runtimeHealthCommand,
    runtimeWrapper,
} from '../executor'
import {
    describeError,
    enqueueRuntimeStart,
    isUpstreamUnreachable,
    networkAllowed,
    parseCidrList,
    prepareRuntimeProxyHeaders,
    RUNTIME_PROXY_HEADER,
} from '../gateway'

type RuntimeHandler = (request: Request) => Response | Promise<Response>

test('runtime wrapper rejects direct requests and strips its internal credential', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'rits-runtime-proxy-'))
    try {
        await writeFile(join(sourceRoot, 'handler.mjs'), `
export function fetch(request) {
    return Response.json({
        internalToken: request.headers.get(${JSON.stringify(RUNTIME_PROXY_HEADER)}),
        project: request.headers.get("x-ritsdev-project"),
    });
}
`)
        let handler: RuntimeHandler | undefined
        const deno = {
            env: {get: (name: string) => name === 'RITSDEV_PROXY_SECRET' ? 'runtime-secret' : undefined},
            serve: (_options: unknown, runtimeHandler: RuntimeHandler) => {
                handler = runtimeHandler
            },
        }
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
            new (...args: string[]): (...values: unknown[]) => Promise<unknown>
        }
        await new AsyncFunction('Deno', runtimeWrapper('handler.mjs', sourceRoot))(deno)
        assert(handler)

        assert.equal((await handler(new Request('http://runtime/__ritsdev_health'))).status, 200)
        assert.equal((await handler(new Request('http://runtime/api'))).status, 403)
        assert.equal((await handler(new Request('http://runtime/api', {
            headers: {[RUNTIME_PROXY_HEADER]: 'wrong-secret'},
        }))).status, 403)

        const authorized = await handler(new Request('http://runtime/api', {
            headers: {
                [RUNTIME_PROXY_HEADER]: 'runtime-secret',
                'x-ritsdev-project': 'project-id',
            },
        }))
        assert.equal(authorized.status, 200)
        assert.deepEqual(await authorized.json(), {
            internalToken: null,
            project: 'project-id',
        })
    } finally {
        await rm(sourceRoot, {recursive: true, force: true})
    }
})

test('gateway replaces attacker-controlled internal headers before proxying', () => {
    const headers = prepareRuntimeProxyHeaders(new Headers({
        cookie: 'app=value; __Host-ritsdev_site=platform-session',
        host: 'attacker.invalid',
        'x-ritsdev-edge-token': 'edge-secret',
        'x-ritsdev-render-token': 'render-secret',
        [RUNTIME_PROXY_HEADER]: 'attacker-secret',
    }), {
        hostname: 'site.sites.example.test',
        projectId: 'project-id',
        proxySecret: 'generated-secret',
    })

    assert.equal(headers.get(RUNTIME_PROXY_HEADER), 'generated-secret')
    assert.equal(headers.get('x-forwarded-host'), 'site.sites.example.test')
    assert.equal(headers.get('x-ritsdev-project'), 'project-id')
    assert.equal(headers.get('x-ritsdev-edge-token'), null)
    assert.equal(headers.get('x-ritsdev-render-token'), null)
    assert.equal(headers.get('host'), null)
    assert.equal(headers.get('cookie'), 'app=value')
})

test('gateway recognises tenant runtime peers it must refuse', () => {
    const pool = parseCidrList('192.168.68.0/22', 'RUNTIME_NETWORK_POOL')

    // Observed live: per-project /28s are carved out of this pool, and the
    // gateway shares each bridge with the runtime it proxies for.
    assert.equal(networkAllowed(pool, '192.168.71.117'), true)
    assert.equal(networkAllowed(pool, '192.168.68.1'), true)
    assert.equal(networkAllowed(pool, '192.168.71.255'), true)
    // Caddy, the compose control networks, and the container's own loopback
    // health check must still get through.
    assert.equal(networkAllowed(pool, '192.168.64.3'), false)
    assert.equal(networkAllowed(pool, '192.168.72.5'), false)
    assert.equal(networkAllowed(pool, '127.0.0.1'), false)
    assert.equal(networkAllowed(pool, ''), false)
})

test('migration guards set no parameter the project role cannot set', () => {
    const guards = migrationSessionGuards(30_000)

    // Superuser-only (SUSET) parameters fail for the non-superuser migration
    // role and abort the whole migration, so they must be pinned to the role at
    // provisioning time instead of set inside the transaction.
    const superuserOnly = ['temp_file_limit', 'log_min_duration_statement', 'session_replication_role']
    for (const parameter of superuserOnly) {
        assert.equal(
            guards.some(guard => guard.includes(parameter)), false,
            `${parameter} is superuser-only and cannot be SET LOCAL by the migration role`,
        )
    }
    assert.equal(guards.every(guard => guard.startsWith('SET LOCAL ')), true)
    assert.equal(guards.some(guard => guard.includes(`statement_timeout = '30000ms'`)), true)
    assert.equal(guards.some(guard => guard.includes('lock_timeout')), true)
})

test('published artifacts are traversable by the unprivileged gateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rits-artifact-perms-'))
    try {
        // Mirrors the executor: mkdir -p <artifacts>/<project>/<version> with
        // mode 0700, which silently leaves the project directory closed.
        const projectDir = join(root, 'project-id')
        const versionDir = join(projectDir, 'version-id')
        await mkdir(join(versionDir, 'static', 'assets'), {recursive: true, mode: 0o700})
        await writeFile(join(versionDir, 'static', 'index.html'), '<!doctype html>', {mode: 0o600})
        await writeFile(join(versionDir, 'static', 'assets', 'main.js'), 'export {}', {mode: 0o600})

        await publishArtifactPermissions(versionDir)

        // Every directory from the project down must be traversable by others,
        // and every file readable, or static serving 404s.
        for (const directory of [
            projectDir,
            versionDir,
            join(versionDir, 'static'),
            join(versionDir, 'static', 'assets'),
        ]) {
            const mode = (await stat(directory)).mode & 0o777
            assert.equal(Boolean(mode & 0o001), true, `${directory} must be traversable by others (got ${mode.toString(8)})`)
            assert.equal(Boolean(mode & 0o004), true, `${directory} must be listable by others (got ${mode.toString(8)})`)
        }
        for (const file of [
            join(versionDir, 'static', 'index.html'),
            join(versionDir, 'static', 'assets', 'main.js'),
        ]) {
            const mode = (await stat(file)).mode & 0o777
            assert.equal(Boolean(mode & 0o004), true, `${file} must be readable by others (got ${mode.toString(8)})`)
            assert.equal(Boolean(mode & 0o111), false, `${file} must not be executable (got ${mode.toString(8)})`)
        }
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('node build copies its output out while the tmpfs workspace still exists', () => {
    const script = nodeBuildScript('npm ci && npm run build', 'dist')

    assert.match(script, /cp -a \/source\/\. \/workspace\//)
    assert.match(script, /npm run build && cp -a \/workspace\/dist\/\. \/out\//)
    // The copy must be part of the container command; a post-exit `docker cp`
    // would read an already-discarded tmpfs.
    assert.equal(script.trimEnd().endsWith('/out/'), true)
})

test('project networks are parsed from docker output for gateway reattachment', () => {
    // A recreated gateway drops off every project network while the runtimes
    // keep running, so this list is what repairs a platform-wide 502.
    assert.deepEqual(
        parseNetworkList('ritsdev-project-aaa\nritsdev-project-bbb\n'),
        ['ritsdev-project-aaa', 'ritsdev-project-bbb'],
    )
    assert.deepEqual(parseNetworkList('  ritsdev-project-aaa  \n\n'), ['ritsdev-project-aaa'])
    // `docker network ls` returns empty output when nothing matches, and the
    // helper is also called with null when the command is allowed to fail.
    assert.deepEqual(parseNetworkList(''), [])
    assert.deepEqual(parseNetworkList(null), [])
    assert.deepEqual(parseNetworkList(undefined), [])
})

test('build staging is rejected when it lives inside the uploaded source', () => {
    // An author may ship prebuilt files in the directory named by build.output
    // and use a no-op command. Staging there would delete exactly those files
    // and the deployment would then succeed while serving nothing, so the
    // executor refuses the arrangement outright.
    assertStagingOutsideSource('/data/work/build-abc', '/data/work/output-abc')
    assertStagingOutsideSource('/data/work/build-abc', '/data/work/build-abcd/out')

    for (const inside of [
        '/data/work/build-abc/public',
        '/data/work/build-abc/nested/dist',
        '/data/work/build-abc/../build-abc/dist',
    ]) {
        assert.throws(
            () => assertStagingOutsideSource('/data/work/build-abc', inside),
            /must not live inside the uploaded source/,
            `${inside} should be rejected`,
        )
    }
})

test('runtime health check passes no permission flags deno eval would reject', () => {
    const command = runtimeHealthCommand('rits-site-abc-def')

    assert.deepEqual(command.slice(0, 4), ['exec', 'rits-site-abc-def', 'deno', 'eval'])
    assert.equal(command.filter(argument => argument.startsWith('--allow-')).length, 0)
    assert.match(command.at(-1) ?? '', /__ritsdev_health/)
})

test('gateway strips connection-scoped headers the runtime client would reject', () => {
    const headers = prepareRuntimeProxyHeaders(new Headers({
        connection: 'keep-alive, x-hop-scoped',
        'keep-alive': 'timeout=5',
        'proxy-connection': 'keep-alive',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        trailer: 'x-checksum',
        expect: '100-continue',
        'x-hop-scoped': 'connection-named',
        'x-forwarded-for': '203.0.113.7',
    }), {
        hostname: 'site.sites.example.test',
        projectId: 'project-id',
        proxySecret: 'generated-secret',
    })

    for (const name of [
        'connection',
        'keep-alive',
        'proxy-connection',
        'transfer-encoding',
        'upgrade',
        'te',
        'trailer',
        'expect',
        'x-hop-scoped',
    ]) {
        assert.equal(headers.get(name), null, `${name} must not reach the runtime`)
    }
    assert.equal(headers.get('x-forwarded-for'), '203.0.113.7')
    assert.equal(headers.get(RUNTIME_PROXY_HEADER), 'generated-secret')
    assert.equal(headers.get('x-ritsdev-project'), 'project-id')
})

test('proxy error description surfaces the underlying network cause', () => {
    const error = new TypeError('fetch failed')
    ;(error as {cause?: unknown}).cause = Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'})

    const described = describeError(error)
    assert.match(described, /TypeError: fetch failed/)
    assert.match(described, /cause=Error: connect ECONNREFUSED \(ECONNREFUSED\)/)
})

test('cold-start enqueue only retries terminal jobs under one stable key', async () => {
    const queries: Array<{text: string; values?: unknown[]}> = []
    await enqueueRuntimeStart({
        query: async (text, values) => {
            queries.push({text, values})
            return {}
        },
    }, 'project-id', 'version-id')

    assert.equal(queries.length, 1)
    assert.deepEqual(queries[0].values, [
        'project-id',
        'version-id',
        'start:project-id:version-id',
    ])
    assert.match(queries[0].text, /ON CONFLICT \(idempotency_key\) DO UPDATE/)
    assert.match(queries[0].text, /WHERE jobs\.status IN \('succeeded', 'failed'\)/)
    // The key is reused for the life of the version and the claim increments
    // attempts on every wake, so leaving it alone spent the two retries the
    // executor allows and left every later cold start with none.
    assert.match(queries[0].text, /attempts = 0/)
    assert.match(queries[0].text, /locked_at = NULL/)
    assert.match(queries[0].text, /locked_by = NULL/)
})

test('only an unreachable upstream makes the gateway distrust project_runtime', () => {
    // A row saying `running` with no container behind it is a permanent trap:
    // the wake gate reads `state`, so nothing ever cold-starts it. These are the
    // failures that mean the row, not the function, is wrong.
    const unreachable = (code: string) => {
        const error = new TypeError('fetch failed')
        ;(error as {cause?: unknown}).cause = Object.assign(new Error(code), {code})
        return error
    }
    for (const code of ['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_SOCKET']) {
        assert.equal(isUpstreamUnreachable(unreachable(code)), true, code)
    }
    // A container that answered and then took too long is not evidence against
    // the row, and clearing it would cold-start a runtime that is working.
    const timeout = Object.assign(new Error('The operation was aborted'), {name: 'TimeoutError'})
    assert.equal(isUpstreamUnreachable(timeout), false)
    assert.equal(isUpstreamUnreachable(new Error('handler threw')), false)
    assert.equal(isUpstreamUnreachable(undefined), false)
    // Undici buries the code several levels down.
    const nested = new TypeError('fetch failed')
    ;(nested as {cause?: unknown}).cause = {cause: {cause: {code: 'ECONNREFUSED'}}}
    assert.equal(isUpstreamUnreachable(nested), true)
})

test('the runtime reconcile reads only fully labelled containers', () => {
    const project = '11111111-1111-4111-8111-111111111111'
    const version = '22222222-2222-4222-8222-222222222222'
    assert.deepEqual(parseRuntimeContainers(`${project} ${version}\n`), [
        {projectId: project, versionId: version},
    ])
    // A half-labelled or hand-labelled container would fail the uuid[] cast and
    // take down the pass that is the only way a stuck runtime recovers.
    assert.deepEqual(parseRuntimeContainers(`${project}\n`), [])
    assert.deepEqual(parseRuntimeContainers(`${project} not-a-uuid\n`), [])
    // An empty listing is a real answer — a rebooted host has no runtimes — and
    // must produce an empty live set, not a parse failure.
    assert.deepEqual(parseRuntimeContainers(''), [])
    assert.deepEqual(parseRuntimeContainers(null), [])
})

test('publishing does not chmod what is already at the right mode', async () => {
    // The regression: platform-data-init runs `chown -R $PLATFORM_UID /data` on
    // every `docker compose up`, and the executor drops every capability except
    // DAC_OVERRIDE. It can write into a project's artifact directory but cannot
    // chmod it, because changing the mode of a file you do not own needs
    // CAP_FOWNER. Every build for every pre-existing project then failed at the
    // last step with EPERM, after doing all the work.
    //
    // chown does not change modes, so those paths were already correct. Reading
    // before writing turns the publish into a no-op instead of a failure.
    // chmod bumps ctime, so an unchanged ctime is the evidence that no chmod
    // was issued — which is what the executor cannot afford to issue here.
    const root = await mkdtemp(join(tmpdir(), 'artifact-perms-'))
    const project = join(root, 'project')
    await mkdir(join(project, 'v1'), {recursive: true})
    await writeFile(join(project, 'v1', 'index.html'), '<!doctype html>')
    for (const [path, mode] of [[project, 0o755], [join(project, 'v1'), 0o755],
        [join(project, 'v1', 'index.html'), 0o644]] as Array<[string, number]>) {
        await chmod(path, mode)
    }
    const before = await Promise.all(
        [project, join(project, 'v1'), join(project, 'v1', 'index.html')].map(p => stat(p)))

    await new Promise(resolve => setTimeout(resolve, 20))
    await publishArtifactPermissions(project)

    const after = await Promise.all(
        [project, join(project, 'v1'), join(project, 'v1', 'index.html')].map(p => stat(p)))
    for (const [i, path] of [project, join(project, 'v1'), join(project, 'v1', 'index.html')].entries()) {
        assert.equal(after[i].ctimeMs, before[i].ctimeMs, `${path} was chmod-ed despite already being correct`)
        assert.equal(after[i].mode & 0o777, before[i].mode & 0o777)
    }
    await rm(root, {recursive: true, force: true})
})

test('publishing still fixes a mode that is wrong', async () => {
    // The guard must not turn into "never chmod anything": a freshly created
    // artifact tree is 0700, and the gateway serves static files as another
    // uid that has to traverse it.
    const root = await mkdtemp(join(tmpdir(), 'artifact-perms-fix-'))
    const project = join(root, 'project')
    await mkdir(join(project, 'v1'), {recursive: true, mode: 0o700})
    await writeFile(join(project, 'v1', 'index.html'), '<!doctype html>')
    await chmod(join(project, 'v1', 'index.html'), 0o600)
    await chmod(join(project, 'v1'), 0o700)
    await chmod(project, 0o700)

    await publishArtifactPermissions(project)

    assert.equal((await stat(project)).mode & 0o777, 0o755)
    assert.equal((await stat(join(project, 'v1'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(project, 'v1', 'index.html'))).mode & 0o777, 0o644)
    await rm(root, {recursive: true, force: true})
})

test('a log for a version that no longer exists is dropped, not thrown', () => {
    // pruneVersions deletes version rows and leaves their runtime containers
    // behind, still labelled with the pruned version. A deployment tears those
    // containers down and captures their logs first, so a plain INSERT hit
    // project_logs_version_id_fkey — and it threw after the activation
    // transaction had committed, leaving the site serving the new version
    // while the deployment recorded itself as failed.
    assert.match(PROJECT_LOG_INSERT_SQL, /WHERE \$2::uuid IS NULL OR EXISTS \(SELECT 1 FROM versions WHERE id = \$2::uuid\)/)
    // A SELECT, not a VALUES: the guard is what makes the row conditional.
    assert.match(PROJECT_LOG_INSERT_SQL, /SELECT \$1,\$2,\$3,\$4,\$5/)
    assert.doesNotMatch(PROJECT_LOG_INSERT_SQL, /VALUES/)
})
