/**
 * Node half of the anchor-seed floating panel companion row.
 *
 * This row exists so the plugin appears as a separate entry in the host
 * Loader AND carries a `dsh.client` package manifest the client-modules node
 * half can scan. The browser half ships through `exports["./client"]`
 * (`panel/client.js`); the node half is deliberately empty — all host-side
 * behavior lives in the main `@deepseek-ai/dsh-anchor-seed` row, which also
 * owns the `anchorSeedConfig` Typert Remote bridge the panel talks to.
 */
export const name = 'anchor-seed-panel'

/** Host plugin body — no host-side behavior for this surface row. */
export function apply() {}
