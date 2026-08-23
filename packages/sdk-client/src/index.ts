// @heurion/sdk — pure types package.
//
// #654: the runtime client (HttpTransport / HeurionClient / SSE parser) had
// no consumers in the monorepo — the web app owns its own ApiClient (#458)
// and SSE parser (#457). Only the shared type surface is kept here; the web
// re-exports what it needs (lib/types.ts).
export * from './types.js'
