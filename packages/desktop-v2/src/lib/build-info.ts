/**
 * Frontend build identity — populated at build time by Vite via
 * `VITE_NEXUS_*` env vars set by scripts/build-macos.sh.
 *
 * In `pnpm dev` (no build script), the env vars are absent and we
 * fall back to "dev" placeholders so the UI still renders.
 *
 * Mirrors what packages/server/nexus_server/__build_info__.py records
 * on the backend side — the two should always match for a single .dmg.
 */

interface ImportMetaEnvShim {
  VITE_NEXUS_BUILD_ID?: string;
  VITE_NEXUS_VERSION?: string;
  VITE_NEXUS_GIT_SHA?: string;
  VITE_NEXUS_BUILD_TIME?: string;
}

const env =
  (import.meta as unknown as { env?: ImportMetaEnvShim }).env ?? {};

export const BUILD_ID:   string = env.VITE_NEXUS_BUILD_ID   ?? 'dev';
export const VERSION:    string = env.VITE_NEXUS_VERSION    ?? '0.0.0-dev';
export const GIT_SHA:    string = env.VITE_NEXUS_GIT_SHA    ?? 'unknown';
export const BUILD_TIME: string = env.VITE_NEXUS_BUILD_TIME ?? 'unknown';
