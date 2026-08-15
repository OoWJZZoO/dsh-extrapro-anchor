/**
 * Node half of the extrapro-anchor floating panel companion row.
 *
 * This row exists so the plugin appears as a separate entry in the host
 * Loader AND carries a `dsh.client` package manifest the client-modules node
 * half can scan. The browser half ships through `exports["./client"]`
 * (`panel/client.js`); the node half is deliberately empty — all host-side
 * behavior lives in the main `@deepseek-ai/dsh-extrapro-anchor` row, which also
 * owns the `extraproAnchorConfig` Typert Remote bridge the panel talks to.
 */
export const name = 'extrapro-anchor-panel'

/** Host plugin body — no host-side behavior for this surface row. */
export function apply() {}
