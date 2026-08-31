import {BlockList, isIP} from 'node:net'

/**
 * "Is this visitor on the network?", as one implementation.
 *
 * Lifted out of gateway.ts when the control plane needed the same test for the
 * logged-out gallery. Importing it from there would have been shorter and
 * wrong: gateway.ts ends with an `import.meta.url === process.argv[1]` main
 * check, and esbuild inlines imported modules into the bundle, so that
 * comparison would have become true inside `server.js` and the control plane
 * would have started a second gateway on port 3001 as a side effect of reading
 * two functions.
 *
 * Both callers must agree on what counts as on-network, so there is one
 * implementation and both import it.
 */

export function parseCidrList(raw: string, label: string): BlockList {
    const list = new BlockList()
    const values = raw.split(',').map(value => value.trim()).filter(Boolean)
    if (!values.length) throw new Error(`${label} must include at least one CIDR`)
    for (const value of values) {
        const [address, prefixText] = value.split('/')
        const family = isIP(address)
        if (!family) throw new Error(`invalid ${label} address: ${value}`)
        const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText)
        const max = family === 4 ? 32 : 128
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
            throw new Error(`invalid ${label} prefix: ${value}`)
        }
        list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
    }
    return list
}

export function networkAllowed(list: BlockList, address: string): boolean {
    const family = isIP(address)
    return family ? list.check(address, family === 4 ? 'ipv4' : 'ipv6') : false
}

/** Strips brackets from an IPv6 literal and unwraps an IPv4-mapped address. */
export function normalizeCidrAddress(raw: string): string {
    let address = raw.trim()
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
    if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7)
    return address
}
