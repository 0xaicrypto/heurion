import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import type { Store } from '../store/db.ts'
import type { PatientService } from '../tenancy/patients.ts'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, ...extra }, null, 2) }],
  isError: true,
})

export interface ImagingToolsDeps {
  store: Store
  claims: TokenClaims
  patients?: PatientService
  workerUrl?: string
}

/**
 * 注册 MONAI 医学影像分析 MCP 工具套件：
 * 包含硬件加速探测、临床模型清单、3D 病灶分割、RECIST 1.1 量化与出版级关键切片资产生成。
 */
export function registerImagingTools(server: McpServer, deps: ImagingToolsDeps): void {
  const { store, claims } = deps
  const workerUrl = (deps.workerUrl || process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')

  // 1. 影像微服务状态与计算硬件探测
  server.registerTool('imaging_status', {
    description: '检查 MONAI 医学影像分析微服务的运行状态与底层硬件加速器信息（Apple Silicon Metal MPS / NVIDIA CUDA / CPU 统一显存）。',
    inputSchema: {},
  }, async () => {
    try {
      const resp = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return fail('imaging_worker_error', `影像微服务返回 HTTP ${resp.status}`)
      const data = await resp.json()
      return json(data)
    } catch (err) {
      return fail('imaging_worker_offline', `无法连接 MONAI 影像计算节点 (${workerUrl})：请确认 worker 服务已启动。`, {
        hint: '在本地可执行 uv run --python 3.12 --project apps/imaging-worker uvicorn src.server:app --port 8004 启动微服务。'
      })
    }
  })

  // 2. 临床分割与检测模型清单
  server.registerTool('imaging_models', {
    description: '获取 MONAI 影像计算节点当前支持的临床深度学习模型清单（例如肺结节分割、腹部多器官分割、脑胶质瘤 BraTS 等）。',
    inputSchema: {},
  }, async () => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return fail('imaging_worker_error', `获取模型失败 HTTP ${resp.status}`)
      const data = await resp.json()
      return json(data)
    } catch (err) {
      return fail('imaging_worker_offline', `无法连接 MONAI 影像节点：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 3. 核心工具：3D 影像分析、RECIST 1.1 量化与关键截面插图生成
  server.registerTool('imaging_analyze', {
    description:
      '运行 MONAI 3D 医学影像分析与 RECIST 1.1 肿瘤测量：' +
      '调度硬件加速器（M4 Pro GPU / CUDA）执行 3D 卷积分割，提取最大横截面关键层（Key Slice），' +
      '自动生成带有半透明轮廓、测距卡尺与 5cm 标尺的高清 PNG，并自动保存为当前用户的文档资产。' +
      '返回 asset_id、RECIST 测量指标（长径、短径、体积）以及直接可插入 Markdown 的图片语法。',
    inputSchema: {
      model_id: z.string().optional().describe('指定的临床模型 ID，例如 bronchiectasis_mucus_analyzer (支气管扩张与粘液栓), spleen_segmenter, lung_nodule_segmenter, liver_lesion_segmenter, brain_tumor_brats'),
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct (真实全胸部 HRCT 269层), spleen_test (真实人体腹部 CT 96层) 或 prostate_mri (真实人体前列腺 MRI)'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum']).optional().describe('CT 窗宽窗位预设'),
      benchmark: z.boolean().optional().describe('是否运行 3D 高拟真解剖体素基准测试（未指定 sample_id/file_path 时缺省为 true）'),
      z_slices: z.number().int().min(16).max(256).optional().describe('扫描层数，缺省 48'),
      bar_cutoff: z.number().optional().describe('支气管-伴行动脉比 (BAR) 印戒征扩张切点，缺省 1.10'),
      mucus_min_hu: z.number().optional().describe('常规粘液栓 CT 阈值下限 (HU)，缺省 10.0'),
      mucus_max_hu: z.number().optional().describe('常规粘液栓 CT 阈值上限 (HU)，缺省 75.0'),
      ham_threshold_hu: z.number().optional().describe('高密度粘液栓 (HAM) CT 阈值 (HU)，缺省 70.0 (提示 ABPA)'),
      label: z.string().max(60).optional().describe('生成的图注标签，例如「图 1 基线靶病灶 RECIST 截面」'),
    },
  }, async ({ model_id, sample_id, file_path, window_preset, benchmark, z_slices, bar_cutoff, mucus_min_hu, mucus_max_hu, ham_threshold_hu, label }) => {
    if (!claims.p.includes('write')) return fail('forbidden', '当前令牌没有写入或上传资产权限')
    
    let resultData: any
    try {
      let endpoint = `${workerUrl}/api/v1/analyze/benchmark`
      let reqBody: Record<string, unknown> = {
        model_name: model_id ?? 'lung_nodule_segmenter',
        window_preset: window_preset ?? 'lung',
        z_slices: z_slices ?? 48,
        y_dim: 128,
        x_dim: 128,
        bar_cutoff,
        mucus_min_hu,
        mucus_max_hu,
        ham_threshold_hu,
      }

      if (sample_id) {
        endpoint = `${workerUrl}/api/v1/analyze/sample`
        reqBody = {
          sample_id,
          model_name: model_id,
          window_preset,
          bar_cutoff,
          mucus_min_hu,
          mucus_max_hu,
          ham_threshold_hu,
        }
      } else if (file_path) {
        endpoint = `${workerUrl}/api/v1/analyze/file`
        reqBody = {
          file_path,
          model_name: model_id,
          window_preset,
          bar_cutoff,
          mucus_min_hu,
          mucus_max_hu,
          ham_threshold_hu,
        }
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('inference_failed', `MONAI 推理失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `调用 MONAI 计算节点失败：${err instanceof Error ? err.message : String(err)}`, {
        hint: '请确认微服务已在 8004 端口正常运行。'
      })
    }

    // 提取关键切片 Base64 并转换为二进制 Buffer，保存为资产
    const b64Data = String(resultData.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_image_output', '推理完成但未返回关键切片图像')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const assetName = `${label || 'monai-recist-slice'}.png`
    const asset = store.putAsset({
      owner: claims.u,
      mime: 'image/png',
      name: assetName,
      bytes: pngBuffer,
    })

    const recist = resultData.recist_metrics || {}
    const ld = recist.longest_diameter_mm ?? 0
    const vol = recist.total_volume_cm3 ?? 0
    const sliceIdx = recist.key_slice_index ?? 0
    const figCaption = label || `图 1 目标病灶 RECIST 1.1 关键截面图（长径 ${ld} mm，体积 ${vol} cm³）`
    const figNote = `图 1 3D MONAI CT 肿瘤靶病灶自动分割与最大横截面量化标尺（第 #${sliceIdx} 层，长径 ${ld} mm，短径 ${recist.short_axis_mm ?? 0} mm，总体积 ${vol} cm³）`

    return json({
      status: 'success',
      asset_id: asset.id,
      model_name: resultData.model_name,
      modality: resultData.modality,
      metrics: resultData.metrics,
      accelerator: resultData.accelerator,
      duration_sec: resultData.inference_duration_sec,
      recist_metrics: {
        longest_diameter_mm: ld,
        short_axis_mm: recist.short_axis_mm ?? 0,
        total_volume_cm3: vol,
        key_slice_index: sliceIdx,
      },
      markdown_insert: `![${figCaption}](asset:${asset.id} "${figNote}")`,
      summary: resultData.summary_markdown,
    })
  })

  // 4. 辅助工具：RECIST 1.1 疗效评估（基线 vs 随访评估 CR / PR / SD / PD）
  server.registerTool('imaging_recist_evaluate', {
    description:
      '根据 RECIST 1.1（实体瘤疗效评价标准）评估靶病灶变化等级：' +
      '输入基线长径之和（baseline_sum_mm）与随访长径之和（followup_sum_mm），' +
      '自动计算变化百分比与疗效等级（CR 完全缓解 / PR 部分缓解 / SD 疾病稳定 / PD 疾病进展）。',
    inputSchema: {
      baseline_sum_mm: z.number().min(0.1).describe('基线靶病灶最大长径之和（毫米）'),
      followup_sum_mm: z.number().min(0).describe('本次随访靶病灶最大长径之和（毫米）'),
    },
  }, async ({ baseline_sum_mm, followup_sum_mm }) => {
    const diff = followup_sum_mm - baseline_sum_mm
    const percentChange = round((diff / baseline_sum_mm) * 100, 1)

    let evaluation = 'SD'
    let interpretation = '疾病稳定 (Stable Disease)'

    if (followup_sum_mm === 0) {
      evaluation = 'CR'
      interpretation = '完全缓解 (Complete Response)：所有靶病灶均完全消失。'
    } else if (percentChange <= -30.0) {
      evaluation = 'PR'
      interpretation = `部分缓解 (Partial Response)：靶病灶长径总和缩小 ≥ 30%（当前减少 ${Math.abs(percentChange)}%）。`
    } else if (percentChange >= 20.0 && diff >= 5.0) {
      evaluation = 'PD'
      interpretation = `疾病进展 (Progressive Disease)：靶病灶长径总和增加 ≥ 20% 且绝对值增加 ≥ 5mm（当前增加 ${percentChange}%）。`
    } else {
      evaluation = 'SD'
      interpretation = `疾病稳定 (Stable Disease)：未达到 PR 缩小标准，亦未达到 PD 增大标准（变化率 ${percentChange > 0 ? '+' : ''}${percentChange}%）。`
    }

    return json({
      baseline_sum_mm,
      followup_sum_mm,
      percent_change: `${percentChange > 0 ? '+' : ''}${percentChange}%`,
      recist_category: evaluation,
      interpretation,
      academic_statement: `根据 RECIST 1.1 评价标准，患者靶病灶长径总和由基线 ${baseline_sum_mm} mm 变化至 ${followup_sum_mm} mm（${percentChange > 0 ? '+' : ''}${percentChange}%），疗效评估为 ${evaluation}（${interpretation.split('：')[0]}）。`,
    })
  })

  // 5. 3D 体积几何与空间分布探测 (imaging_volume_info)
  server.registerTool('imaging_volume_info', {
    description:
      '查询 3D 医学影像的几何体素元数据与病灶空间分布：' +
      '返回体素空间维度 (Z/Y/X)、空间分辨率/层厚间距 (dz, dy, dx mm)、' +
      '三大正交切面（轴位 Axial、冠状位 Coronal、矢状位 Sagittal）的总层数与中心推荐层，' +
      '以及病灶的三维空间包围盒 (Bounding Box) 和推荐窗位。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct (全胸部 HRCT 269层), spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
    },
  }, async ({ sample_id, file_path }) => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sample_id || 'chest_lung_ct', file_path }),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_info_failed', `获取 3D 体积信息失败 HTTP ${resp.status}: ${errText}`)
      }
      const data = await resp.json()
      return json({
        status: 'success',
        ...data,
      })
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 6. 3D 多平面重建正交切片提取与资产沉淀 (imaging_mpr_slice)
  server.registerTool('imaging_mpr_slice', {
    description:
      '提取 3D 医学影像的任意正交多平面重建切片 (MPR: 轴位 Axial、冠状位 Coronal、矢状位 Sagittal)：' +
      '支持应用临床窗宽窗位（肺窗 lung、纵隔窗 mediastinum、腹窗 abdomen、骨窗 bone、脑窗 brain）' +
      '与 MONAI 病灶半透明红色遮罩 (Mask Overlay)。切片将自动渲染带有 5cm 标尺、层号 HUD 与物理分辨率的高清图像，' +
      '并直接保存为用户文档资产，返回 asset_id、病灶面积与可直接插入 Markdown 报告的图片语法。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('正交切片平面：axial (轴位/横断面), coronal (冠状位/额状面), sagittal (矢状位/侧面)。缺省为 axial'),
      slice_index: z.number().int().min(0).optional().describe('切片层号索引 (0 到 total_slices - 1)。如不提供，则自动定位至病灶中心切片或正中层'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗宽窗位预设'),
      overlay_mask: z.boolean().optional().describe('是否在切片上叠加 MONAI 自动分割的半透明红色病灶遮罩，缺省为 true'),
      save_asset: z.boolean().optional().describe('是否保存为当前用户的平台文档资产以供报告引用，缺省为 true'),
      label: z.string().max(80).optional().describe('生成的图注标签，例如「图 2 轴位第 115 层支气管扩张病灶」'),
    },
  }, async ({ sample_id, file_path, plane, slice_index, window_preset, overlay_mask, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || 'chest_lung_ct',
          file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          overlay_mask: overlay_mask !== false,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_slice_failed', `提取 MPR 切片失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    const b64Data = String(resultData.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_slice_output', '切片生成成功但未返回图像数据')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const planeNameMap: Record<string, string> = {
      axial: '轴位',
      coronal: '冠状位',
      sagittal: '矢状位',
    }
    const planeZh = planeNameMap[resultData.plane] || resultData.plane
    const hSpacing = resultData.pixel_spacing_mm?.horizontal ?? 1
    const vSpacing = resultData.pixel_spacing_mm?.vertical ?? 1
    const lesionPx = resultData.lesion_pixel_count ?? 0
    const lesionAreaMm2 = round(lesionPx * hSpacing * vSpacing, 2)

    let assetId: string | undefined
    let markdownInsert: string | undefined

    if (save_asset !== false && claims.p.includes('write')) {
      const assetName = `${label || `mpr-${resultData.plane}-slice-${resultData.slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuffer,
      })
      assetId = asset.id

      const figCaption = label || `图 MPR ${planeZh}第 ${resultData.slice_index} 层（共 ${resultData.total_slices} 层）`
      const figNote = `3D MPR ${planeZh}第 ${resultData.slice_index} 层切片（窗宽窗位: ${resultData.window?.preset || '标准'}, 分辨率: ${hSpacing}x${vSpacing} mm${lesionAreaMm2 > 0 ? `, 病灶截面积: ${lesionAreaMm2} mm²` : ''}）`
      markdownInsert = `![${figCaption}](asset:${asset.id} "${figNote}")`
    }

    return json({
      status: 'success',
      plane: resultData.plane,
      slice_index: resultData.slice_index,
      total_slices: resultData.total_slices,
      window: resultData.window,
      dimensions: resultData.dimensions,
      pixel_spacing_mm: resultData.pixel_spacing_mm,
      lesion_present: resultData.lesion_present,
      lesion_pixel_count: lesionPx,
      lesion_area_mm2: lesionAreaMm2,
      asset_id: assetId,
      markdown_insert: markdownInsert,
    })
  })

  // 7. 多期随访 RECIST 1.1 影像对比评估 (imaging_longitudinal_compare)
  server.registerTool('imaging_longitudinal_compare', {
    description:
      '对患者的多期医学影像进行纵向随访对比（RECIST 1.1 实体瘤疗效评估 / 气道粘液栓演变）：' +
      '对比基线检查 (Baseline) 与随访检查 (Follow-up) 的靶病灶最大长径 (LD)、短径与 3D 体积变化率，' +
      '自动评定疗效等级（CR 完全缓解 / PR 部分缓解 / SD 疾病稳定 / PD 疾病进展 / 清除 / 改善），' +
      '生成包含双期影像对照、量化演变表格与临床建议的完整结构化评估报告，并支持选择性将对比报告落库为新的病历记录。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      baseline_record_id: z.string().optional().describe('基线影像记录 ID（如不提供则自动选择最早的基线影像）'),
      followup_record_id: z.string().optional().describe('随访影像记录 ID（如不提供则自动选择最新的随访影像）'),
      save_as_record: z.boolean().optional().describe('是否将对比评估报告保存为患者的新病历记录，缺省为 false'),
    },
  }, async ({ patient_id, baseline_record_id, followup_record_id, save_as_record }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.compareImaging(aiActor, patient_id, {
        baseline_record_id,
        followup_record_id,
        save_as_record,
      })
      return json(result)
    } catch (err: any) {
      return fail('imaging_compare_error', err.message || String(err))
    }
  })

  // 8. 多模态因果诊断证据链分析 (imaging_evidence_chain)
  server.registerTool('imaging_evidence_chain', {
    description:
      '多模态因果诊断证据链分析：' +
      '自动将患者医学影像量化病征（如支气管扩张/高密度粘液栓 HAM、或肺结节占位 RECIST 1.1）' +
      '与患者实际化验检验指标（嗜酸性粒细胞 EOS、血清总 IgE、曲霉特异性 sIgE、肿瘤标志物 CEA/CYFRA21-1、炎症指标 CRP/WBC）' +
      '及既往病史标签进行因果三角校验，评估临床指南确诊符合度（如 ISHAM ABPA 标准、RECIST 1.1），' +
      '输出结构化临床证据矩阵、缺漏待查项目建议与诊断印象 Markdown。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      record_id: z.string().optional().describe('待评估的医学影像记录 ID（如不传则自动选择最新的一份影像分析）'),
      baseline_record_id: z.string().optional().describe('基线影像记录 ID（多期对比场景）'),
      followup_record_id: z.string().optional().describe('随访影像记录 ID（多期对比场景）'),
    },
  }, async ({ patient_id, record_id, baseline_record_id, followup_record_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.getEvidenceChain(aiActor, patient_id, {
        record_id,
        baseline_record_id,
        followup_record_id,
      })
      return json(result)
    } catch (err: any) {
      return fail('imaging_evidence_chain_error', err.message || String(err))
    }
  })

  // 9. 3D 体素刚性配准与差分吸收热力图切片 (imaging_diff_slice)
  server.registerTool('imaging_diff_slice', {
    description:
      '提取两期 3D 纵向随访 CT 之间的体素刚性配准与差分吸收热力图切片 (Difference Heatmap Overlay)：' +
      '将随访 CT 空间三线性插值对齐至基线 CT 坐标系，计算三维体素差分矩阵 (ΔHU = Followup - Baseline)。' +
      '生成叠加差分吸收热力图的切片（🟢 绿色为吸收退缩区域 ΔHU < -thresh，🔴 红色为进展增大/浸润区域 ΔHU > thresh），' +
      '并返回全容积 3D 吸收体素量、新发浸润体素量、净变化体积与总体动态演变趋势。',
    inputSchema: {
      baseline_sample_id: z.string().optional().describe('基线样本 ID，缺省为 chest_lung_ct'),
      followup_sample_id: z.string().optional().describe('随访样本 ID，缺省为 chest_lung_ct'),
      baseline_file_path: z.string().optional().describe('基线 3D 影像本地文件路径'),
      followup_file_path: z.string().optional().describe('随访 3D 影像本地文件路径'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('正交切片平面：axial, coronal, sagittal，缺省为 axial'),
      slice_index: z.number().int().min(0).optional().describe('切片层号索引'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗位预设'),
      threshold_hu: z.number().optional().describe('差分检测灵敏度阈值 (HU)，缺省为 50 HU'),
      save_asset: z.boolean().optional().describe('是否将差分切片保存为资产'),
      label: z.string().max(80).optional().describe('图注说明'),
    },
  }, async ({ baseline_sample_id, followup_sample_id, baseline_file_path, followup_file_path, plane, slice_index, window_preset, threshold_hu, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/diff-slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseline_id: baseline_sample_id || 'chest_lung_ct',
          followup_id: followup_sample_id || 'chest_lung_ct',
          baseline_path: baseline_file_path,
          followup_path: followup_file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          threshold_hu: threshold_hu ?? 50,
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_diff_failed', `计算 3D 差分热力图失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    const b64Data = String(resultData.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_diff_slice_output', '差分切片生成成功但未返回图像数据')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const planeNameMap: Record<string, string> = { axial: '轴位', coronal: '冠状位', sagittal: '矢状位' }
    const planeZh = planeNameMap[resultData.plane] || resultData.plane

    let assetId: string | undefined
    let markdownInsert: string | undefined

    if (save_asset !== false && claims.p.includes('write')) {
      const assetName = `${label || `diff-${resultData.plane}-slice-${resultData.slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuffer,
      })
      assetId = asset.id
      const figCaption = label || `图 3D 差分热力图 ${planeZh}第 ${resultData.slice_index} 层`
      const figNote = `3D 差分热力图（🟢 吸收: ${resultData.statistics_3d?.regressed_volume_cm3} cm³, 🔴 进展: ${resultData.statistics_3d?.progressed_volume_cm3} cm³, 总体演变: ${resultData.statistics_3d?.dominant_trend}）`
      markdownInsert = `![${figCaption}](asset:${asset.id} "${figNote}")`
    }

    return json({
      status: 'success',
      plane: resultData.plane,
      slice_index: resultData.slice_index,
      total_slices: resultData.total_slices,
      window: resultData.window,
      dimensions: resultData.dimensions,
      statistics_3d: resultData.statistics_3d,
      slice_metrics: resultData.slice_metrics,
      asset_id: assetId,
      markdown_insert: markdownInsert,
    })
  })

  // 10. 标准化医学数据交换格式导出 (imaging_export_standard)
  server.registerTool('imaging_export_standard', {
    description:
      '将患者的医学影像量化分析与多模态因果诊断链导出为国际医学行业标准交换格式：' +
      '支持 HL7 FHIR R4 DiagnosticReport (包含 ImagingStudy 与 Observations) 或 ' +
      'DICOM SR (Structured Reporting, SOP Class 1.2.840.10008.5.1.4.1.1.88.22, TID 1500) 结构化 JSON，' +
      '以便无缝对接三甲医院内网 PACS、EMR/HIS 或区域健康信息平台。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      format: z.enum(['fhir', 'dicom-sr']).describe('导出格式：fhir (HL7 FHIR R4) 或 dicom-sr (DICOM Structured Reporting)'),
      record_id: z.string().optional().describe('指定的医学影像记录 ID（如不传则导出最新影像分析记录）'),
    },
  }, async ({ patient_id, format, record_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.exportImagingStandard(aiActor, patient_id, {
        format,
        record_id,
      })
      return json({
        status: 'success',
        format: result.format,
        filename: result.filename,
        mime: result.mime,
        data: result.data,
      })
    } catch (err: any) {
      return fail('imaging_export_error', err.message || String(err))
    }
  })

  // 11. 全景多模态影像诊断报告生成 (imaging_generate_full_report)
  server.registerTool('imaging_generate_full_report', {
    description:
      '根据患者的医学影像资料（MONAI 3D 病灶量化、RECIST 1.1 靶病灶长短径、CT值分布、关键截面切片）' +
      '与实验室化验（总 IgE、嗜酸粒细胞、肿瘤标志物等）及既往病史，一键生成符合三甲医院与国际放射学标准的' +
      '《全景多模态影像诊断报告》，涵盖检查方法、影像学所见、影像诊断印象与鉴别处置建议，并可自动存入患者病历档案。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      record_id: z.string().optional().describe('指定的医学影像记录 ID，缺省为最新影像记录'),
      save_to_records: z.boolean().optional().describe('是否将生成的全景报告自动存入患者病历记录档案中（默认为 true）'),
      title: z.string().optional().describe('自定义报告标题'),
    },
  }, async ({ patient_id, record_id, save_to_records, title }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.generateComprehensiveReport(aiActor, patient_id, {
        record_id,
        save_to_records: save_to_records !== undefined ? save_to_records : true,
        title,
      })
      return json({
        status: 'success',
        patient_id: result.patient_id,
        patient_code: result.patient_code,
        title: result.title,
        exam_date: result.exam_date,
        modality: result.modality,
        urgency: result.urgency,
        saved_record_id: result.saved_record_id,
        findings: result.findings,
        impression: result.impression,
        recommendations: result.recommendations,
        full_report_markdown: result.full_report_markdown,
        metrics: result.metrics,
      })
    } catch (err: any) {
      return fail('imaging_full_report_error', err.message || String(err))
    }
  })

  // 12. 3D 影像组学定量特征抽取 (imaging_radiomics)
  server.registerTool('imaging_radiomics', {
    description:
      '提取 IBSI 标准 3D 影像组学多维定量生物标志物 (Shape 几何形态、一阶直方图统计、GLCM 灰度共生矩阵、GLRLM 灰度游程矩阵)。' +
      '支持从预置样本、本地路径或患者影像中提取 46 项量化特征，输出扁平特征行（可直接沉淀为科研数据集行）与排版精美的临床报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      model_name: z.string().optional().describe('用于靶病灶自动分割的模型名称，缺省 lung_nodule_segmenter'),
      num_bins: z.number().int().min(8).max(64).optional().describe('纹理矩阵离散化区间数，缺省 16'),
    },
  }, async ({ sample_id, file_path, model_name, num_bins }) => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/radiomics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          model_name: model_name || 'lung_nodule_segmenter',
          num_bins: num_bins || 16,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('radiomics_failed', `影像组学特征提取失败 HTTP ${resp.status}: ${errText}`)
      }
      const data = await resp.json()
      return json(data)
    } catch (err: any) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 13. 交互式点选万物分割 (imaging_interactive_segment - MONAI VISTA-3D)
  server.registerTool('imaging_interactive_segment', {
    description:
      '运行 MONAI VISTA-3D 范式交互式点选万物分割：' +
      '支持接收前景正样本点（Foreground Positive Click，如病灶中心）与背景负样本点（Background Negative Click，如需剔除的邻近骨质/血管），' +
      '结合 3D 边界框约束即时自适应分割任意非标解剖结构或疑难病灶。' +
      '自动生成带有点击标记与半透明轮廓的高清切片资产，返回 RECIST 测值、3D 体积与可直接插入报告的 Markdown 语法。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      points: z.array(z.object({
        z: z.number().int().describe('层号索引 Z'),
        y: z.number().int().describe('纵坐标 Y'),
        x: z.number().int().describe('横坐标 X'),
        is_positive: z.boolean().optional().describe('true 为正样本前景点，false 为负样本排斥点，缺省 true'),
      })).optional().describe('交互式点选提示集合 (Prompt Points)'),
      bbox: z.object({
        z_min: z.number().int(),
        z_max: z.number().int(),
        y_min: z.number().int(),
        y_max: z.number().int(),
        x_min: z.number().int(),
        x_max: z.number().int(),
      }).optional().describe('3D 空间外接包围盒提示 (Bounding Box)'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗宽窗位预设'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('显示平面，缺省 axial'),
      slice_index: z.number().int().optional().describe('指定渲染切片层号（缺省自动对齐至点击层或最大截面）'),
      save_asset: z.boolean().optional().describe('是否将带轮廓切片保存为用户文档资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 3 VISTA-3D 交互点选分割截面」'),
    },
  }, async ({ sample_id, file_path, points, bbox, window_preset, plane, slice_index, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/interactive-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          points: points || [{ z: 115, y: 256, x: 256, is_positive: true }],
          bbox,
          window_preset: window_preset || 'lung',
          plane: plane || 'axial',
          slice_index,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('interactive_segment_failed', `交互式分割失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.slice_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.slice_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const assetName = `${label || `vista3d-interactive-slice-${resultData.key_slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `MONAI VISTA-3D 交互分割 #${resultData.key_slice_index}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 14. TotalSegmentator 全身体素 104 类解剖分割与肌少症量化 (imaging_whole_body_segment)
  server.registerTool('imaging_whole_body_segment', {
    description:
      '运行 TotalSegmentator 全身体素 104 类解剖结构分割与 L3 断面肌少症 (Sarcopenia) 量化评估：' +
      '提取骨骼肌面积 (SMA cm²)、骨骼肌质量指数 (SMI cm²/m²)、Prado 诊断阈值分层、内脏脂肪 (VAT) 与皮下脂肪 (SAT)、' +
      'VAT/SAT 比值、肌肉衰减密度 (HU，评估肌脂肪浸润 Myosteatosis) 以及全腹部与胸腔主要器官 (肝/脾/肾/肺/骨骼) 3D 容积。' +
      '自动生成多组织颜色编码切片与出版级 Markdown 分析报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      patient_sex: z.enum(['M', 'F']).optional().describe('患者性别 (M/F)，用于肌少症切点分层（男性 52.4 cm²/m²，女性 38.5 cm²/m²），缺省 M'),
      patient_height_m: z.number().positive().optional().describe('患者身高（米），用于计算 SMI，缺省 1.72'),
      patient_weight_kg: z.number().positive().optional().describe('患者体重（千克），缺省 68.0'),
      l3_slice_index: z.number().int().optional().describe('指定第三腰椎 L3 椎体横截面层号（缺省由算法自动依据骨骼体素峰值识别）'),
      save_asset: z.boolean().optional().describe('是否将带颜色编码的切片图保存为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 4 L3 层面骨骼肌与内脏脂肪量化」'),
    },
  }, async ({ sample_id, file_path, patient_sex, patient_height_m, patient_weight_kg, l3_slice_index, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/whole-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          patient_sex: patient_sex || 'M',
          patient_height_m: patient_height_m || 1.72,
          patient_weight_kg: patient_weight_kg || 68.0,
          l3_slice_index,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('whole_body_failed', `全身体素分割失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.key_slice_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.key_slice_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const sliceIdx = resultData.l3_vertebra_slice_index ?? 0
      const assetName = `${label || `totalsegmentator-l3-slice-${sliceIdx}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `TotalSegmentator L3 体成分分析切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
