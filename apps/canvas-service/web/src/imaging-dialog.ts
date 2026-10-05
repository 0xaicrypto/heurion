/**
 * MONAI 医学影像分析交互对话框：
 * 支持选择临床分割模型、真实患者胸部 HRCT/腹部 CT/前列腺 MRI 样本或高拟真体素，
 * 支气管扩张 (Bronchiectasis) 与粘液栓 (Mucus Plug) 放射学参数实时微调，
 * 触发 M4 Pro Metal (MPS) GPU 毫秒级推理，实时展示带三色掩膜与卡尺的关键切片，
 * 并支持一键插入当前幻灯片 / 在线文档。
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export interface ImagingResult {
  asset_id: string
  image_url: string
  accelerator: string
  inference_duration_sec: number
  model_name: string
  modality: string
  recist_metrics: {
    longest_diameter_mm: number
    short_axis_mm: number
    total_volume_cm3: number
    key_slice_index: number
  }
  metrics?: Record<string, any>
  summary_markdown?: string
  markdown?: string
}

export async function openImagingDialog(
  api: (path: string, options?: RequestInit) => Promise<any>,
  onInsert: (result: ImagingResult) => Promise<void>
): Promise<void> {
  const dlg = document.getElementById('dialog')!
  let statusInfo: any = null
  let models: any[] = []
  let samples: any[] = []
  let currentResult: ImagingResult | null = null

  try {
    statusInfo = await api('/api/imaging/status').catch(() => null)
    const modelsData = await api('/api/imaging/models').catch(() => ({ models: [] }))
    models = modelsData.models || []
    const samplesData = await api('/api/imaging/samples').catch(() => ({ samples: [] }))
    samples = samplesData.samples || []
  } catch (err) {
    console.warn('获取影像微服务状态失败:', err)
  }

  const isOnline = statusInfo && statusInfo.status === 'healthy'
  const acceleratorLabel = isOnline
    ? (statusInfo.device?.accelerator || 'GPU 加速已激活') + (statusInfo.device?.total_unified_ram_gb ? ` · ${statusInfo.device.total_unified_ram_gb}GB 统一内存` : '')
    : '计算节点未连接 (端口 8004 离线)'

  // 默认优先选中真实全胸部 HRCT 扫描
  const hasChestSample = samples.some(s => s.id === 'chest_lung_ct')
  let selectedSource = hasChestSample ? 'sample:chest_lung_ct' : (samples[0]?.id ? `sample:${samples[0].id}` : 'sample:spleen_test')
  let selectedModel = hasChestSample ? 'bronchiectasis_mucus_analyzer' : (models[0]?.id || 'spleen_segmenter')
  let selectedWindow = hasChestSample ? 'lung' : 'abdomen'

  // 支气管扩张与粘液栓算法调参变量
  let barCutoff = 1.10
  let mucusMinHu = 10
  let mucusMaxHu = 75
  let hamThreshHu = 70

  const close = () => {
    dlg.hidden = true
    dlg.innerHTML = ''
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  const render = () => {
    const isBronchiectasis = selectedModel === 'bronchiectasis_mucus_analyzer'

    dlg.innerHTML = `
      <div class="dialog-card" style="max-width: 860px; width: 94%; max-height: 90vh; overflow-y: auto;" role="dialog" aria-modal="true">
        <div class="dialog-head" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding:12px 18px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <h2 style="font-size:16px; margin:0; font-weight:700; color:#0f172a;">🩺 MONAI 3D 医学影像与量化工作台</h2>
            <span style="font-size:11.5px; padding:2px 8px; border-radius:12px; background:${isOnline ? '#ecfdf5; color:#047857;' : '#fef2f2; color:#b91c1c;'} font-weight:600;">
              ${isOnline ? '🟢 ' + esc(acceleratorLabel) : '🔴 ' + esc(acceleratorLabel)}
            </span>
          </div>
          <button class="quiet" data-close aria-label="关闭" style="border:none; background:transparent; font-size:18px; cursor:pointer;">✕</button>
        </div>

        <div class="dialog-body" style="padding:16px 20px;">
          <!-- 1. 扫描源与模型配置 -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-bottom:12px;">
            <div>
              <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:5px;">影像数据源</label>
              <select id="selImagingSource" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; background:#fff;">
                ${samples.map(s => `
                  <option value="sample:${s.id}" ${selectedSource === `sample:${s.id}` ? 'selected' : ''}>
                    ${esc(s.name)} (${s.size_mb} MB)
                  </option>
                `).join('')}
                <option value="benchmark" ${selectedSource === 'benchmark' ? 'selected' : ''}>
                  🔬 高拟真 3D 解剖 CT 体素基准 (合成 48 层)
                </option>
              </select>
            </div>

            <div>
              <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:5px;">MONAI 临床分析模型</label>
              <select id="selImagingModel" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; background:#fff;">
                ${models.map(m => `
                  <option value="${m.id}" ${selectedModel === m.id ? 'selected' : ''}>
                    ${esc(m.name)} · [${esc(m.modality)}]
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <!-- 2. 支气管扩张微调控制面板 (Fleischner 准则与密度阈值) -->
          ${isBronchiectasis ? `
            <div style="background:#f1f5f9; border:1px solid #cbd5e1; border-radius:8px; padding:12px 14px; margin-bottom:12px;">
              <div style="font-size:12px; font-weight:700; color:#1e293b; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                <span>🎛️ 支气管扩张与粘液栓定量微调参数 (Fleischner Criteria)</span>
                <span style="font-size:11px; font-weight:normal; color:#64748b;">实时调节并触发重算</span>
              </div>
              <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px;">
                <div>
                  <label style="font-size:11px; color:#475569; display:block; margin-bottom:4px;">
                    印戒征切点 (BAR Cutoff): <b id="valBarCutoff" style="color:#0284c7;">${barCutoff.toFixed(2)}</b>
                  </label>
                  <input type="range" id="rngBarCutoff" min="1.00" max="1.60" step="0.05" value="${barCutoff}" style="width:100%;" />
                  <div style="font-size:10px; color:#94a3b8; display:flex; justify-content:space-between;">
                    <span>1.00 (敏感)</span><span>1.10 (标准)</span><span>1.60 (特异)</span>
                  </div>
                </div>

                <div>
                  <label style="font-size:11px; color:#475569; display:block; margin-bottom:4px;">
                    常规粘液栓 HU 范围: <b id="valMucusRange" style="color:#ef4444;">${mucusMinHu} ~ ${mucusMaxHu} HU</b>
                  </label>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <input type="number" id="inpMucusMin" value="${mucusMinHu}" style="width:60px; padding:3px 6px; font-size:11px; border:1px solid #cbd5e1; border-radius:4px;" />
                    <span style="font-size:11px; color:#64748b;">至</span>
                    <input type="number" id="inpMucusMax" value="${mucusMaxHu}" style="width:60px; padding:3px 6px; font-size:11px; border:1px solid #cbd5e1; border-radius:4px;" />
                  </div>
                </div>

                <div>
                  <label style="font-size:11px; color:#475569; display:block; margin-bottom:4px;">
                    高密度粘液 (HAM) 阈值: <b id="valHamThresh" style="color:#c026d3;">≥ ${hamThreshHu} HU</b>
                  </label>
                  <input type="number" id="inpHamThresh" value="${hamThreshHu}" style="width:75px; padding:3px 6px; font-size:11px; border:1px solid #cbd5e1; border-radius:4px;" />
                  <span style="font-size:10px; color:#94a3b8; margin-left:4px;">ABPA 筛查特征</span>
                </div>
              </div>
            </div>
          ` : ''}

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <div style="font-size:12px; color:#64748b;">
              💡 采用 <b>Apple Silicon Metal (MPS) GPU</b> 与胸腔自动包络提取技术，无感剔除检查床与机架噪点，高精度量化各叶段。
            </div>
            <button id="btnRunInference" class="primary" style="background:#0284c7; color:#fff; border:none; padding:8px 18px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">
              ⚡ 运行 GPU 分析
            </button>
          </div>

          <div id="inferenceLoading" style="display:none; text-align:center; padding:20px 0; color:#0284c7; font-size:13.5px; font-weight:600;">
            ⏳ 正在调度 M4 Pro Metal (MPS) GPU 执行高分辨率体素推理与气道量化追踪...
          </div>

          <!-- 3. 分析结果与可视化呈现 -->
          <div id="resultContainer" style="${currentResult ? 'display:block;' : 'display:none;'} background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:14px;">
            ${currentResult ? `
              <div style="display:grid; grid-template-columns: 360px 1fr; gap:16px; align-items:start;">
                <!-- 左侧切片图 -->
                <div>
                  <div style="font-size:12px; font-weight:600; color:#334155; margin-bottom:6px; display:flex; justify-content:space-between;">
                    <span>📷 最大横截面关键层 (Key Slice #${currentResult.recist_metrics.key_slice_index})</span>
                    <span style="font-size:11px; color:#0284c7; font-weight:bold;">${currentResult.modality}</span>
                  </div>
                  <img src="${esc(currentResult.image_url)}" alt="Key Slice" style="width:100%; border-radius:6px; border:1px solid #cbd5e1; background:#000; display:block;" />
                  <div style="font-size:11px; color:#64748b; margin-top:5px; line-height:1.4;">
                    图例：青色=通畅气道 · 深红=常规粘液栓 · 品红=高密度粘液栓 (HAM) · 黄色=BAR卡尺
                  </div>
                </div>

                <!-- 右侧指标看板 -->
                <div>
                  <div style="font-size:12px; font-weight:700; color:#0f172a; margin-bottom:8px;">
                    ${currentResult.model_name === 'bronchiectasis_mucus_analyzer'
                      ? '🫁 支气管扩张与粘液嵌顿 (Mucus Plug) 临床量化指标'
                      : '📊 RECIST 1.1 肿瘤量化评估指标'}
                  </div>

                  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:10px;">
                    ${currentResult.model_name === 'bronchiectasis_mucus_analyzer' && currentResult.metrics ? `
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">支气管-伴行动脉比 (BAR)</div>
                        <div style="font-size:17px; font-weight:700; color:#0284c7;">
                          ${currentResult.metrics.broncho_arterial_ratio} <span style="font-size:11px; color:#059669; font-weight:normal;">(标准 ≤1.0)</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">粘液栓总体积 (Mucus Plug)</div>
                        <div style="font-size:17px; font-weight:700; color:#ef4444;">
                          ${currentResult.metrics.total_mucus_volume_cm3} <span style="font-size:11px; font-weight:normal;">cm³ (mL)</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">高密度粘液栓 (HAM)</div>
                        <div style="font-size:17px; font-weight:700; color:#c026d3;">
                          ${currentResult.metrics.high_attenuation_mucus_cm3 || 0} <span style="font-size:11px; font-weight:normal;">cm³ (≥70HU)</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">气道管腔阻塞率</div>
                        <div style="font-size:17px; font-weight:700; color:#d97706;">
                          ${currentResult.metrics.airway_occlusion_rate_pct} <span style="font-size:11px; font-weight:normal;">%</span>
                        </div>
                      </div>
                    ` : `
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">RECIST 1.1 最大长径</div>
                        <div style="font-size:17px; font-weight:700; color:#0284c7;">
                          ${currentResult.recist_metrics.longest_diameter_mm} <span style="font-size:11px;">mm</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">垂直短径 (Short Axis)</div>
                        <div style="font-size:17px; font-weight:700; color:#0f172a;">
                          ${currentResult.recist_metrics.short_axis_mm} <span style="font-size:11px;">mm</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">脏器 / 病灶总体积</div>
                        <div style="font-size:17px; font-weight:700; color:#059669;">
                          ${currentResult.recist_metrics.total_volume_cm3} <span style="font-size:11px;">cm³</span>
                        </div>
                      </div>
                      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:9px;">
                        <div style="font-size:11px; color:#64748b;">GPU 计算耗时</div>
                        <div style="font-size:17px; font-weight:700; color:#7c3aed;">
                          ${currentResult.inference_duration_sec} <span style="font-size:11px;">s</span>
                        </div>
                      </div>
                    `}
                  </div>

                  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px; font-size:12px; color:#334155; line-height:1.6;">
                    • <b>计算硬件</b>：<code>${esc(currentResult.accelerator)}</code> (${currentResult.inference_duration_sec}s)<br>
                    • <b>分析模型</b>：<code>${esc(currentResult.model_name)}</code><br>
                    ${currentResult.metrics ? `
                      • <b>形态学分型</b>：<span style="color:#0284c7; font-weight:600;">${esc(currentResult.metrics.morphological_phenotype)}</span><br>
                      • <b>严重度分级</b>：<span style="color:#b91c1c; font-weight:600;">${esc(currentResult.metrics.severity_classification)}</span><br>
                      • <b>Bhalla / Reiff 评分</b>：${esc(currentResult.metrics.bhalla_mucoid_score)} · Reiff: <b>${currentResult.metrics.reiff_score}/18</b><br>
                      • <b>检出征象</b>：<div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">
                        ${(currentResult.metrics.signs_detected || []).map((s: string) => `
                          <span style="background:#eff6ff; color:#1d4ed8; padding:2px 6px; border-radius:4px; font-size:11px; border:1px solid #bfdbfe;">
                            ✓ ${esc(s)}
                          </span>
                        `).join('')}
                      </div>
                    ` : ''}
                    • <b>资产编号</b>：<code>${esc(currentResult.asset_id)}</code>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- 4. 底部操作按钮 -->
          <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid #e2e8f0; padding-top:14px;">
            <button data-close style="padding:8px 16px; border:1px solid #cbd5e1; background:#fff; border-radius:6px; font-size:13px; cursor:pointer;">
              关闭
            </button>
            <button id="btnInsertCanvas" class="primary" style="background:#059669; color:#fff; border:none; padding:8px 20px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; ${currentResult ? '' : 'opacity:0.5; pointer-events:none;'}" title="将关键截面图与 RECIST 指标插入当前页面">
              📌 插入当前页面 (幻灯片/文档)
            </button>
          </div>
        </div>
      </div>
    `
    dlg.hidden = false

    // 绑定事件
    const selSrc = dlg.querySelector<HTMLSelectElement>('#selImagingSource')
    if (selSrc) {
      selSrc.onchange = () => {
        selectedSource = selSrc.value
        if (selectedSource === 'sample:chest_lung_ct') {
          selectedModel = 'bronchiectasis_mucus_analyzer'
          selectedWindow = 'lung'
        } else if (selectedSource === 'sample:spleen_test') {
          selectedModel = 'spleen_segmenter'
          selectedWindow = 'abdomen'
        } else if (selectedSource === 'sample:prostate_mri') {
          selectedModel = 'liver_lesion_segmenter'
          selectedWindow = 'abdomen'
        }
        render()
      }
    }

    const selMod = dlg.querySelector<HTMLSelectElement>('#selImagingModel')
    if (selMod) {
      selMod.onchange = () => {
        selectedModel = selMod.value
        render()
      }
    }

    // 微调滑块与输入监听
    const rngBar = dlg.querySelector<HTMLInputElement>('#rngBarCutoff')
    if (rngBar) {
      rngBar.oninput = () => {
        barCutoff = parseFloat(rngBar.value)
        const v = dlg.querySelector('#valBarCutoff')
        if (v) v.textContent = barCutoff.toFixed(2)
      }
    }

    const inpMin = dlg.querySelector<HTMLInputElement>('#inpMucusMin')
    const inpMax = dlg.querySelector<HTMLInputElement>('#inpMucusMax')
    if (inpMin && inpMax) {
      const updateRange = () => {
        mucusMinHu = parseFloat(inpMin.value) || 10
        mucusMaxHu = parseFloat(inpMax.value) || 75
        const v = dlg.querySelector('#valMucusRange')
        if (v) v.textContent = `${mucusMinHu} ~ ${mucusMaxHu} HU`
      }
      inpMin.onchange = updateRange
      inpMax.onchange = updateRange
    }

    const inpHam = dlg.querySelector<HTMLInputElement>('#inpHamThresh')
    if (inpHam) {
      inpHam.onchange = () => {
        hamThreshHu = parseFloat(inpHam.value) || 70
        const v = dlg.querySelector('#valHamThresh')
        if (v) v.textContent = `≥ ${hamThreshHu} HU`
      }
    }

    const btnRun = dlg.querySelector<HTMLButtonElement>('#btnRunInference')
    if (btnRun) {
      btnRun.onclick = async () => {
        const loading = dlg.querySelector<HTMLElement>('#inferenceLoading')
        if (loading) loading.style.display = 'block'
        btnRun.disabled = true

        try {
          let reqBody: Record<string, unknown> = {
            model_id: selectedModel,
            window_preset: selectedWindow,
            label: selectedModel === 'bronchiectasis_mucus_analyzer' ? 'HRCT-支气管扩张粘液栓分析' : 'RECIST 肿瘤截面',
            bar_cutoff: barCutoff,
            mucus_min_hu: mucusMinHu,
            mucus_max_hu: mucusMaxHu,
            ham_threshold_hu: hamThreshHu,
          }

          if (selectedSource.startsWith('sample:')) {
            reqBody.sample_id = selectedSource.replace('sample:', '')
          } else {
            reqBody.benchmark = true
            reqBody.z_slices = 48
          }

          const res = await api('/api/imaging/analyze', {
            method: 'POST',
            body: JSON.stringify(reqBody),
          })

          if (res.status === 'success' && res.asset_id) {
            currentResult = {
              asset_id: res.asset_id,
              image_url: res.image_url || `/api/assets/${res.asset_id}`,
              accelerator: res.accelerator,
              inference_duration_sec: res.inference_duration_sec,
              model_name: res.model_name,
              modality: res.modality || (selectedModel === 'bronchiectasis_mucus_analyzer' ? 'Chest HRCT' : 'CT'),
              recist_metrics: res.recist_metrics,
              metrics: res.metrics,
              summary_markdown: res.summary_markdown,
              markdown: res.markdown,
            }
          } else {
            alert(`分析失败: ${res.message || '未知错误'}`)
          }
        } catch (err: any) {
          alert(`调用影像微服务失败: ${err.message}`)
        } finally {
          render()
        }
      }
    }

    const btnInsert = dlg.querySelector<HTMLButtonElement>('#btnInsertCanvas')
    if (btnInsert && currentResult) {
      btnInsert.onclick = async () => {
        if (!currentResult) return
        btnInsert.disabled = true
        btnInsert.textContent = '正在插入...'
        try {
          await onInsert(currentResult)
          close()
        } catch (err: any) {
          alert(`插入失败: ${err.message}`)
          btnInsert.disabled = false
          btnInsert.textContent = '📌 插入当前页面'
        }
      }
    }

    // 关闭按钮
    dlg.querySelectorAll('[data-close]').forEach(b => {
      ;(b as HTMLElement).onclick = close
    })
  }

  render()
}
