import type { Context, Hono } from 'hono'
import type { Documents } from '../../model/runtime.ts'
import type { Store } from '../../store/db.ts'
import type { PatientService, Actor } from '../../tenancy/patients.ts'
import type { Access } from '../../research/access.ts'

export interface ImagingRouteContext {
  store: Store
  docs: Documents
  access: Access
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
}

/**
 * 注册 MONAI 医学影像微服务与患者影像量化分析相关路由：
 * 包含硬件状态、模型列表、样本查看、正交 MPR/3D 差分热力图、
 * 全身解剖 L3/肌少症分割、靶病灶 RECIST 1.1 自动量化评估与报告生成。
 */
export function registerImagingRoutes(
  app: Hono<{ Variables: { user: string } }>,
  ctx: ImagingRouteContext
): void {
  const { store, me, pt, patientFailure } = ctx
  const imagingWorkerUrl = (process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')

  app.get('/api/imaging/status', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error', status: 'error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message, status: 'offline' }, 503)
    }
  })

  app.get('/api/imaging/models', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.get('/api/imaging/samples', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/samples`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  async function ensureVolumeOnWorker(c: any, patientId: string, recordIdOrFileId?: string | null): Promise<string | null> {
    if (!patientId) return null
    try {
      const user = me(c)
      const detail = pt(c).read(user, patientId)
      let fileId: string | null = null
      let fileName = 'volume.zip'

      if (recordIdOrFileId) {
        const rec = detail.records.find((r: any) => r.id === recordIdOrFileId)
        if (rec) {
          const imgData = (rec.imaging_data || {}) as Record<string, any>
          fileId = imgData.raw_file_id || rec.file_id || null
          fileName = imgData.raw_file_name || rec.title || 'volume.zip'
        } else {
          fileId = recordIdOrFileId
        }
      } else {
        const imgRec = detail.records.find((r: any) => r.kind === 'imaging')
        if (imgRec) {
          const imgData = (imgRec.imaging_data || {}) as Record<string, any>
          fileId = imgData.raw_file_id || imgRec.file_id || null
          fileName = imgData.raw_file_name || imgRec.title || 'volume.zip'
        }
      }

      if (!fileId) return null

      const volumeId = `pt_${patientId}_${fileId}`

      // 快速检查 Worker 内存中是否已有该体素缓存
      try {
        const checkResp = await fetch(`${imagingWorkerUrl}/api/v1/volume/${encodeURIComponent(volumeId)}/status`, {
          signal: AbortSignal.timeout(3000),
        })
        if (checkResp.ok) {
          const status = await checkResp.json()
          if (status.ready) return volumeId
        }
      } catch {}

      // 从机构租户库解密患者原始扫描序列文件并流式上传至 Worker 预热
      const f = pt(c).file(user, patientId, fileId)
      if (!f || !f.bytes || f.bytes.byteLength === 0) return null

      const formData = new FormData()
      formData.append('volume_id', volumeId)
      const blob = new Blob([new Uint8Array(f.bytes)], { type: f.mime || 'application/octet-stream' })
      formData.append('file', blob, f.name || fileName)

      const uploadResp = await fetch(`${imagingWorkerUrl}/api/v1/volume/upload`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60000),
      })
      if (!uploadResp.ok) {
        const errText = await uploadResp.text()
        console.error(`[imaging] Failed to upload patient volume to worker: ${errText}`)
        return null
      }
      return volumeId
    } catch (err) {
      console.error('[imaging] ensureVolumeOnWorker error:', err)
      return null
    }
  }

  app.get('/api/imaging/samples/:id/file', async c => {
    try {
      const id = c.req.param('id')
      if (id.startsWith('pt_')) {
        const parts = id.split('_')
        if (parts.length >= 3 && parts[1] && parts[2]) {
          const ptId = parts[1]
          const fId = parts[2]
          const f = pt(c).file(me(c), ptId, fId)
          return c.body(new Uint8Array(f.bytes), 200, {
            'Content-Type': f.mime || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`,
          })
        }
      }

      const resp = await fetch(`${imagingWorkerUrl}/api/v1/samples/${id}/file`, { signal: AbortSignal.timeout(20000) })
      if (!resp.ok) return c.json({ error: 'sample_not_found' }, 404)
      const mime = resp.headers.get('content-type') || 'application/gzip'
      return c.body(new Uint8Array(await resp.arrayBuffer()), 200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${id}.nii.gz"`,
      })
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.get('/api/imaging/mpr/info', async c => {
    try {
      const patientId = c.req.query('patient_id')
      const recordId = c.req.query('record_id') || c.req.query('file_id')
      let sampleId = c.req.query('sample_id') || 'chest_lung_ct'
      const filePath = c.req.query('file_path') || undefined
      const modelName = c.req.query('model_name') || undefined

      if (patientId) {
        const volId = await ensureVolumeOnWorker(c, patientId, recordId)
        if (volId) sampleId = volId
      }

      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, file_path: filePath, model_name: modelName }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return c.json({ error: 'mpr_info_failed' }, resp.status as any)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/mpr/info', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      if (body.patient_id) {
        const volId = await ensureVolumeOnWorker(c, body.patient_id, body.record_id || body.file_id)
        if (volId) body.sample_id = volId
      }
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return c.json({ error: 'mpr_info_failed' }, resp.status as any)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/mpr/slice', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      if (body.patient_id) {
        const volId = await ensureVolumeOnWorker(c, body.patient_id, body.record_id || body.file_id)
        if (volId) body.sample_id = volId
      }
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) return c.json({ error: 'mpr_slice_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && (body.custom_png_base64 || data.slice_png_base64)) {
        const u = c.get('user' as any) || 'u1'
        const rawB64 = String(body.custom_png_base64 || data.slice_png_base64 || '')
        const b64Data = rawB64.replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const planeName = data.plane || 'mpr'
        const sliceIdx = data.slice_index ?? 0
        const assetName = `${body.label || `mpr-${planeName}-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `MPR ${planeName} 切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/mpr/diff-slice', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      if (body.patient_id) {
        if (body.baseline_record_id || body.baseline_file_id) {
          const bVolId = await ensureVolumeOnWorker(c, body.patient_id, body.baseline_record_id || body.baseline_file_id)
          if (bVolId) body.baseline_id = bVolId
        }
        if (body.followup_record_id || body.followup_file_id) {
          const fVolId = await ensureVolumeOnWorker(c, body.patient_id, body.followup_record_id || body.followup_file_id)
          if (fVolId) body.followup_id = fVolId
        }
      }
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/diff-slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'mpr_diff_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && data.slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const planeName = data.plane || 'mpr'
        const sliceIdx = data.slice_index ?? 0
        const assetName = `${body.label || `diff-${planeName}-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `3D 差分热力图 ${planeName} 切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/radiomics', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/radiomics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'radiomics_failed' }, resp.status as any)
      const data = await resp.json()
      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/interactive-segment', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/interactive-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'interactive_segment_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && data.slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `interactive-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `MONAI VISTA-3D 交互分割 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/whole-body', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/whole-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'whole_body_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && data.key_slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.l3_vertebra_slice_index ?? 0
        const assetName = `${body.label || `totalsegmentator-l3-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `TotalSegmentator L3 体成分分析切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/registration/deformable', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/registration/deformable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'deformable_registration_failed' }, resp.status as any)
      const data = await resp.json()
      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/registration/pet-ct-fusion', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/registration/pet-ct-fusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'pet_ct_fusion_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && data.fusion_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.fusion_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `pet-ct-fusion-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `PET-CT 代谢融合切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/rtstruct/delineate', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/rtstruct/delineate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return c.json({ error: 'rtstruct_delineate_failed' }, resp.status as any)
      const data = await resp.json()

      if (body.save_asset && data.rtstruct_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.rtstruct_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `rtstruct-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `放疗靶区 (GTV/CTV/PTV) 勾画切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/patients/:ptid/imaging/analyze', async c => {
    try {
      const contentType = c.req.header('content-type') || ''
      let sampleId: string | undefined
      let modelId: string | undefined
      let windowPreset: string | undefined
      let barCutoff: number | undefined
      let mucusMinHu: number | undefined
      let mucusMaxHu: number | undefined
      let hamThresholdHu: number | undefined
      let reportDate: string | undefined
      let title: string | undefined
      let autoTag = true
      let fileBuffer: Buffer | null = null
      let fileName = ''

      const parseSafeNum = (v: any): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined
        const n = Number(String(v).replace(',', '.'))
        return isNaN(n) ? undefined : n
      }

      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.parseBody()
        sampleId = typeof form.sample_id === 'string' ? form.sample_id : undefined
        modelId = typeof form.model_id === 'string' ? form.model_id : undefined
        windowPreset = typeof form.window_preset === 'string' ? form.window_preset : undefined
        barCutoff = parseSafeNum(form.bar_cutoff)
        mucusMinHu = parseSafeNum(form.mucus_min_hu)
        mucusMaxHu = parseSafeNum(form.mucus_max_hu)
        hamThresholdHu = parseSafeNum(form.ham_threshold_hu)
        reportDate = typeof form.report_date === 'string' ? form.report_date : undefined
        title = typeof form.title === 'string' ? form.title : undefined
        if (form.auto_tag !== undefined) autoTag = String(form.auto_tag) !== 'false'
        if (form.file instanceof File) {
          fileName = form.file.name
          fileBuffer = Buffer.from(await form.file.arrayBuffer())
        }
      } else {
        const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
        sampleId = body.sample_id
        modelId = body.model_id
        windowPreset = body.window_preset
        barCutoff = parseSafeNum(body.bar_cutoff)
        mucusMinHu = parseSafeNum(body.mucus_min_hu)
        mucusMaxHu = parseSafeNum(body.mucus_max_hu)
        hamThresholdHu = parseSafeNum(body.ham_threshold_hu)
        reportDate = body.report_date
        title = body.title
        if (body.auto_tag !== undefined) autoTag = Boolean(body.auto_tag)
      }

      const patientId = c.req.param('ptid')
      pt(c).assertEditable(me(c), patientId)

      let resultData: any
      if (fileBuffer) {
        const formData = new FormData()
        const blob = new Blob([new Uint8Array(fileBuffer)], { type: 'application/octet-stream' })
        formData.append('file', blob, fileName || 'scan.nii.gz')
        formData.append('model_name', modelId || 'bronchiectasis_mucus_analyzer')
        if (windowPreset) formData.append('window_preset', windowPreset)
        if (barCutoff !== undefined && !isNaN(barCutoff)) formData.append('bar_cutoff', String(barCutoff))
        if (mucusMinHu !== undefined && !isNaN(mucusMinHu)) formData.append('mucus_min_hu', String(mucusMinHu))
        if (mucusMaxHu !== undefined && !isNaN(mucusMaxHu)) formData.append('mucus_max_hu', String(mucusMaxHu))
        if (hamThresholdHu !== undefined && !isNaN(hamThresholdHu)) formData.append('ham_threshold_hu', String(hamThresholdHu))

        const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/upload`, {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(60000),
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          return c.json({ error: 'imaging_inference_failed', message: `影像推理失败 HTTP ${resp.status}: ${errText}` }, 502)
        }
        resultData = await resp.json()
      } else if (sampleId) {
        const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/sample`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sample_id: sampleId,
            model_name: modelId,
            window_preset: windowPreset,
            bar_cutoff: barCutoff,
            mucus_min_hu: mucusMinHu,
            mucus_max_hu: mucusMaxHu,
            ham_threshold_hu: hamThresholdHu,
          }),
          signal: AbortSignal.timeout(60000),
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          return c.json({ error: 'imaging_inference_failed', message: `影像样本推理失败 HTTP ${resp.status}: ${errText}` }, 502)
        }
        resultData = await resp.json()
      } else {
        const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/benchmark`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model_name: modelId || 'bronchiectasis_mucus_analyzer',
            window_preset: windowPreset || 'lung',
            bar_cutoff: barCutoff,
            mucus_min_hu: mucusMinHu,
            mucus_max_hu: mucusMaxHu,
            ham_threshold_hu: hamThresholdHu,
          }),
          signal: AbortSignal.timeout(60000),
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          return c.json({ error: 'imaging_inference_failed', message: `模拟推理失败 HTTP ${resp.status}: ${errText}` }, 502)
        }
        resultData = await resp.json()
      }

      const b64Data = String(resultData.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
      if (!b64Data) return c.json({ error: 'no_image_output', message: '影像计算未返回切片图像' }, 500)
      const pngBuffer = Buffer.from(b64Data, 'base64')

      const rawMetrics = resultData.metrics || {}
      const rm = resultData.recist_metrics
      const barRatio = rawMetrics.broncho_arterial_ratio ?? rawMetrics.bar_ratio
      const hasSignet = barRatio !== undefined ? barRatio > (barCutoff || 1.10) : Boolean(rawMetrics.signet_ring_sign)
      const hamVol = rawMetrics.high_attenuation_mucus_cm3 ?? rawMetrics.ham_volume_mm3 ?? 0
      const hasHam = hamVol > 0 || Boolean(rawMetrics.high_attenuation_mucus_ham)
      const mucusVol = rawMetrics.total_mucus_volume_cm3 ?? rawMetrics.mucus_plug_volume_mm3 ?? 0
      const occlusionRate = rawMetrics.airway_occlusion_rate_pct ?? rawMetrics.airway_mucus_occlusion_pct ?? 0
      const hasTreeInBud = Boolean(rawMetrics.tree_in_bud_volume_cm3 > 0 || rawMetrics.tree_in_bud_sign)

      const normalizedMetrics = {
        ...rawMetrics,
        bar_ratio: barRatio,
        signet_ring_sign: hasSignet,
        total_mucus_volume_cm3: mucusVol,
        high_attenuation_mucus_cm3: hamVol,
        high_attenuation_mucus_ham: hasHam,
        airway_occlusion_rate_pct: occlusionRate,
        longest_diameter_mm: rm?.longest_diameter_mm ?? rawMetrics.bronchus_caliber_mm ?? 0,
        short_axis_mm: rm?.short_axis_mm ?? rawMetrics.artery_caliber_mm ?? 0,
        total_volume_cm3: rm?.total_volume_cm3 ?? mucusVol,
        key_slice_index: resultData.key_slice_index ?? rm?.key_slice_index ?? 0,
        lung_rads: rm?.lung_rads,
        has_lesion: rm?.has_lesion,
      }

      const findings: string[] = []
      const tagsToAdd: string[] = []

      if (barRatio !== undefined) {
        if (hasSignet) {
          findings.push(`印戒征阳性 (BAR ${barRatio.toFixed(2)} > ${barCutoff || 1.10})`)
          tagsToAdd.push('支气管扩张')
        }
        if (hasHam) {
          findings.push(`高密度粘液栓 (HAM) 阳性 (${hamVol} cm³，提示 ABPA 变应性支气管肺曲霉病)`)
          tagsToAdd.push('ABPA疑诊')
        }
        if (mucusVol > 0) {
          findings.push(`支气管管腔粘液栓体积 ${mucusVol} cm³ (管腔阻塞率 ${occlusionRate}%)`)
        }
        if (hasTreeInBud) {
          findings.push('树芽征 (Tree-in-Bud) 细支气管炎表现阳性')
        }
      } else if (rm && (rm.has_lesion === false || rm.longest_diameter_mm === 0)) {
        findings.push(`胸部 CT 扫描未检出 ≥ 3 mm 实质性肺结节`)
        findings.push(`临床评级: Lung-RADS 1 类 (阴性，恶性风险 < 1%)`)
        findings.push(`随访指引: 建议 12 个月后常规安排低剂量胸部 CT (LDCT) 复查`)
        tagsToAdd.push('Lung-RADS 1类(阴性)')
      } else if (rm && rm.longest_diameter_mm > 0) {
        findings.push(`RECIST 1.1 靶病灶最大截面长径 ${rm.longest_diameter_mm} mm (短径 ${rm.short_axis_mm} mm)`)
        findings.push(`3D 病灶体积 ${rm.total_volume_cm3} cm³ (关键截面第 #${rm.key_slice_index} 层)`)
        if (rm.lung_rads) {
          findings.push(`临床评级: ${rm.lung_rads.name} (${rm.lung_rads.description})`)
          findings.push(`随访指引: ${rm.lung_rads.recommendation}`)
          tagsToAdd.push(rm.lung_rads.name)
        } else {
          tagsToAdd.push('局灶性结节')
        }
      }

      const defaultTitle = modelId === 'bronchiectasis_mucus_analyzer' || resultData.model_name?.includes('bronchiectasis')
        ? '胸部 HRCT 支气管扩张与粘液栓定量分析'
        : (rm?.has_lesion === false || rm?.longest_diameter_mm === 0)
        ? '胸部 CT 平扫筛查 (Lung-RADS 1类 阴性)'
        : `${resultData.modality || 'CT'} 3D 靶病灶 RECIST 1.1 量化分析`

      let rawVolume: { name: string; bytes: Uint8Array; mime?: string } | undefined
      if (fileBuffer) {
        rawVolume = {
          name: fileName || 'scan.nii.gz',
          bytes: new Uint8Array(fileBuffer),
          mime: fileName.endsWith('.dcm') ? 'application/dicom' : 'application/gzip',
        }
      } else if (sampleId) {
        try {
          const sResp = await fetch(`${imagingWorkerUrl}/api/v1/samples/${sampleId}/file`, { signal: AbortSignal.timeout(10000) })
          if (sResp.ok) {
            const buf = await sResp.arrayBuffer()
            rawVolume = {
              name: `${sampleId}.nii.gz`,
              bytes: new Uint8Array(buf),
              mime: 'application/gzip',
            }
          }
        } catch (e) {
          console.warn('[sample-download-warning]', e)
        }
      }

      const saved = pt(c).addImagingRecord(me(c), patientId, {
        title: title || defaultTitle,
        report_date: reportDate || new Date().toISOString().slice(0, 10),
        model_id: modelId || resultData.model_name || 'bronchiectasis_mucus_analyzer',
        sample_id: sampleId || null,
        modality: resultData.modality || 'Chest HRCT',
        metrics: normalizedMetrics,
        findings,
        key_slice_png: pngBuffer,
        raw_volume_file: rawVolume,
        add_tags: autoTag && tagsToAdd.length > 0 ? tagsToAdd : undefined,
      })

      return c.json({
        ok: true,
        record: saved.record,
        asset_id: saved.asset_id,
        file_id: saved.file_id,
        raw_file_id: saved.raw_file_id,
        metrics: saved.record.imaging_data?.metrics,
        findings,
        tags_added: autoTag ? tagsToAdd : [],
      }, 201)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.post('/api/patients/:ptid/imaging/compare', async c => {
    try {
      const patientId = c.req.param('ptid')
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
      const result = pt(c).compareImaging(me(c), patientId, {
        baseline_record_id: typeof body.baseline_record_id === 'string' ? body.baseline_record_id : undefined,
        followup_record_id: typeof body.followup_record_id === 'string' ? body.followup_record_id : undefined,
        save_as_record: Boolean(body.save_as_record),
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/evidence-chain', c => {
    try {
      const patientId = c.req.param('ptid')
      const recordId = c.req.query('record_id') || undefined
      const baselineId = c.req.query('baseline_record_id') || undefined
      const followupId = c.req.query('followup_record_id') || undefined
      const result = pt(c).getEvidenceChain(me(c), patientId, {
        record_id: recordId,
        baseline_record_id: baselineId,
        followup_record_id: followupId,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/export', c => {
    try {
      const patientId = c.req.param('ptid')
      const format = (c.req.query('format') || 'fhir') as 'fhir' | 'dicom-sr'
      const recordId = c.req.query('record_id') || undefined
      const isDownload = c.req.query('download') === '1'
      const res = pt(c).exportImagingStandard(me(c), patientId, { format, record_id: recordId })
      if (isDownload) {
        c.header('Content-Type', res.mime)
        c.header('Content-Disposition', `attachment; filename="${res.filename}"`)
      }
      return c.json(res.data)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.post('/api/patients/:ptid/imaging/full-report', async c => {
    try {
      const patientId = c.req.param('ptid')
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
      const result = pt(c).generateComprehensiveReport(me(c), patientId, {
        record_id: typeof body.record_id === 'string' ? body.record_id : undefined,
        save_to_records: body.save_to_records !== undefined ? Boolean(body.save_to_records) : true,
        title: typeof body.title === 'string' ? body.title : undefined,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/full-report', c => {
    try {
      const patientId = c.req.param('ptid')
      const recordId = c.req.query('record_id') || undefined
      const result = pt(c).generateComprehensiveReport(me(c), patientId, {
        record_id: recordId,
        save_to_records: false,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })
}
