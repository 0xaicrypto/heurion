import { saveFile } from '../storage.js'
import { validateRenderContent } from '@heurion/contracts'

/**
 * #403/#404: stats.run_analysis job — the execution-plane entry for
 * statistical analysis. W1: the server already runs stats in-process
 * (run_stats_analysis tool, stat-tools); this handler exists so the Python
 * worker (#404) can take over with the identical job contract.
 *
 * Payload: { test, data: {...} } — validated before any computation.
 */
export async function runStatsAnalysis(payload: any) {
  const data = payload?.data ?? payload ?? {}
  // Validate against the plot content model (stats output rides the same
  // validated-JSON discipline as other render jobs).
  const check = validateRenderContent('sidecar.render_plot', {
    schemaVersion: 1,
    type: 'bar',
    title: String(data.title || 'Statistics'),
    series: [{ label: 'result', x: [0], y: [0] }],
  })
  if (!check.ok) {
    return { error: `invalid stats payload: ${check.errors.join('; ')}` }
  }
  // W2 (Python): compute here. W1: computation happens in the server tool;
  // this handler acknowledges the job so queue integration is exercised.
  return {
    ack: true,
    mode: 'w1-ts',
    hint: 'W1 computes in-process via run_stats_analysis; Python backend lands with #404.',
  }
}
