import {z} from 'zod'

const relativePath = z.string().min(1).max(200)
    .refine(v => !v.startsWith('/') && !v.split('/').includes('..'), 'must be a project-relative path')
const buildOutputPath = relativePath.refine(v => v !== '.', 'build output must be a subdirectory')

export const siteManifestSchema = z.object({
    schemaVersion: z.literal(1),
    build: z.object({
        command: z.string().min(1).max(300),
        output: buildOutputPath,
        spa: z.boolean().default(false),
        // Omitted keeps the default: `npm ci` runs first whenever package.json
        // is present, and a lockfile is then required. `false` skips installing
        // entirely; a string replaces the install step with that command. The
        // reproducibility guardrail stays the default, but opting out is now
        // possible and is recorded in the manifest rather than being impossible.
        install: z.union([z.literal(false), z.string().min(1).max(300)]).optional(),
    }).optional(),
    functions: z.object({
        entrypoint: relativePath,
        mount: z.literal('/api').default('/api'),
    }).optional(),
    database: z.object({
        migrations: relativePath,
    }).optional(),
    resources: z.object({
        postgres: z.boolean().default(false),
        storage: z.boolean().default(false),
        llm: z.boolean().default(false),
    }).default({postgres: false, storage: false, llm: false}),
}).superRefine((manifest, ctx) => {
    if (!manifest.build && !manifest.functions) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: 'a build or functions entrypoint is required'})
    }
    if (manifest.database && !manifest.resources.postgres) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: 'database migrations require resources.postgres'})
    }
})

export type SiteManifest = z.infer<typeof siteManifestSchema>
