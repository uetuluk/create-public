import {resolve} from 'node:path'
import {readRepoFile} from './repo-files'

/**
 * The platform's own documentation, exposed over MCP.
 *
 * The skill was reachable only over plain HTTP at /skills/*, so an MCP client
 * had no way to read the contract it was expected to follow — including the
 * traps that catch every first-time author. It is served here as MCP resources
 * and, for the many clients that consume tools only, through a `get_skill`
 * tool.
 *
 * The set is an explicit allowlist rather than a path lookup. Traversal safety
 * is already handled by readRepoFile, but an allowlist means this second entry
 * point into the repository mount cannot expose anything the HTTP route
 * deliberately does not.
 */

const MAX_RESOURCE_BYTES = 256 * 1024

export type SkillResource = {
    name: string
    title: string
    description: string
    /** Path relative to the repository root. */
    rel: string
}

export const SKILL_RESOURCES: readonly SkillResource[] = [
    {
        name: 'create-ritsdev',
        title: 'create-ritsdev platform skill',
        description: 'How to build, deploy, and operate a site on this platform, including the traps that catch first-time authors.',
        rel: 'skills/create-ritsdev/SKILL.md',
    },
    {
        name: 'site-contract',
        title: 'Site manifest and runtime contract',
        description: 'The ritsdev.site.json manifest, the function runtime contract, migrations, and resource limits.',
        rel: 'skills/create-ritsdev/references/site-contract.md',
    },
]

/** The public URL of a skill resource, which doubles as its MCP resource URI. */
export function skillResourceUri(publicBaseUrl: string, resource: SkillResource): string {
    return `${publicBaseUrl.replace(/\/+$/, '')}/${resource.rel}`
}

/** Resources that are actually present in this deployment's repository mount. */
export function skillResources(repoRoot: string | undefined, publicBaseUrl: string): Array<Record<string, unknown>> {
    if (!repoRoot) return []
    return SKILL_RESOURCES
        .filter(resource => readRepoFile(resolve(repoRoot), resource.rel) !== null)
        .map(resource => ({
            uri: skillResourceUri(publicBaseUrl, resource),
            name: resource.name,
            title: resource.title,
            description: resource.description,
            mimeType: 'text/markdown',
        }))
}

/** Reads one allowlisted resource by URI or by short name. Null when unknown. */
/**
 * The skill is written once and served by every installation, so it names the
 * platform with placeholders rather than a domain. Both paths that hand it out
 * — the MCP resource below and the /skills route — substitute here, so an agent
 * reading it is told the host it is actually talking to.
 */
export function withPlatformHost(text: string, publicBaseUrl: string): string {
    return text
        .replaceAll('{{PLATFORM_ORIGIN}}', publicBaseUrl)
        .replaceAll('{{PLATFORM_HOST}}', new URL(publicBaseUrl).host)
}

export function readSkillResource(
    repoRoot: string | undefined,
    publicBaseUrl: string,
    key: string,
): {uri: string; mimeType: string; text: string} | null {
    if (!repoRoot) return null
    const resource = SKILL_RESOURCES.find(candidate =>
        candidate.name === key || skillResourceUri(publicBaseUrl, candidate) === key)
    if (!resource) return null
    const file = readRepoFile(resolve(repoRoot), resource.rel)
    if (!file) return null
    let text = withPlatformHost(file.body.toString('utf8'), publicBaseUrl)
    if (text.length > MAX_RESOURCE_BYTES) {
        text = `${text.slice(0, MAX_RESOURCE_BYTES)}\n\n[truncated at ${MAX_RESOURCE_BYTES} characters]\n`
    }
    return {uri: skillResourceUri(publicBaseUrl, resource), mimeType: 'text/markdown', text}
}
