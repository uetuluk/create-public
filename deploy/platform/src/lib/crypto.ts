import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from 'node:crypto'

export function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex')
}

export function base64Url(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
}

export function safeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export class SecretBox {
    private readonly key: Buffer

    constructor(keyMaterial: string) {
        this.key = createHash('sha256').update(keyMaterial).digest()
    }

    encrypt(plaintext: string): string {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', this.key, iv)
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
        return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
    }

    decrypt(encoded: string): string {
        const [version, iv, tag, ciphertext] = encoded.split('.')
        if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('invalid encrypted secret')
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([
            decipher.update(Buffer.from(ciphertext, 'base64url')),
            decipher.final(),
        ]).toString('utf8')
    }
}
