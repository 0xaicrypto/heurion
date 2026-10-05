/**
 * MONAI 医学影像分析交互对话框：
 * 支持选择临床分割模型、真实患者 CT/MRI 样本或高拟真体素，
 * 触发 M4 Pro Metal (MPS) GPU 毫秒级推理，实时展示带标尺与轮廓的关键切片，
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

  let selectedSource = 'sample:spleen_test'
  let selectedModel = models[0]?.id || 'spleen_segmenter'
  let selectedWindow = 'abdomen'

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
    dlg.innerHTML = `
      <div class="dialog-card" style="max-width: 820px; width: 92%; max-height: 90vh; overflow-y: auto;" role="dialog" aria-modal="true">
        <div class="dialog-head" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding:12px 18px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <h2 style="font-size:16px; margin:0; font-weight:700; color:#0f172a;">🩺 MONAI 3D 医学影像与 RECIST 1.1 量化</h2>
            <span style="font-size:11.5px; padding:2px 8px; border-radius:12px; background:${isOnline ? '#ecfdf5; color:#047857;' : '#fef2f2; color:#b91c1c;'} font-weight:600;">
              ${isOnline ? '🟢 ' + esc(acceleratorLabel) : '🔴 ' + esc(acceleratorLabel)}
            </span>
          </div>
          <button class="quiet" data-close aria-label="关闭" style="border:none; background:transparent; font-size:18px; cursor:pointer;">✕</button>
        </div>

        <div class="dialog-body" style="padding:16px 20px;">
          <!-- 1. 扫描源与模型配置 -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-bottom:14px;">
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
              <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:5px;">MONAI 临床分割模型</label>
              <select id="selImagingModel" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; background:#fff;">
                ${models.map(m => `
                  <option value="${m.id}" ${selectedModel === m.id ? 'selected' : ''}>
                    ${esc(m.name)} · [${esc(m.modality)}]
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <div style="font-size:12px; color:#64748b;">
              💡 采用 <b>Convex Hull 凸包加速算法</b> 与 M4 Pro Metal GPU 零拷贝流水线，全卷推理与测距通常在 0.3 秒内完成。
            </div>
            <button id="btnRunInference" class="primary" style="background:#0284c7; color:#fff; border:none; padding:8px 16px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">
              ⚡ 运行 GPU 分析
            </button>
          </div>

          <div id="inferenceLoading" style="display:none; text-align:center; padding:24px 0; color:#0284c7; font-size:14px; font-weight:600;">
            ⏳ 正在调度 M4 Pro Metal (MPS) GPU 执行 3D 卷积分割与 RECIST 1.1 测距...
          </div>

          <!-- 2. 分析结果与可视化呈现 -->
          <div id="resultContainer" style="${currentResult ? 'display:block;' : 'display:none;'} background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:14px;">
            ${currentResult ? `
              <div style="display:grid; grid-template-columns: 340px 1fr; gap:16px; align-items:start;">
                <!-- 左侧切片图 -->
                <div>
                  <div style="font-size:12px; font-weight:600; color:#334155; margin-bottom:6px;">
                    📷 最大横截面关键层 (Key Slice #${currentResult.recist_metrics.key_slice_index})
                  </div>
                  <img src="${esc(currentResult.image_url)}" alt="Key Slice" style="width:100%; border-radius:6px; border:1px solid #cbd5e1; background:#000; display:block;" />
                  <div style="font-size:11px; color:#64748b; margin-top:4px;">
                    图注：珊瑚红掩膜 + 青色 RECIST 测距卡尺 + 5cm 标尺
                  </div>
                </div>

                <!-- 右侧指标看板 -->
                <div>
                  <div style="font-size:12px; font-weight:600; color:#334155; margin-bottom:8px;">
                    📊 RECIST 1.1 肿瘤量化评估指标
                  </div>
                  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:12px;">
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
                      <div style="font-size:11px; color:#64748b;">RECIST 1.1 最大长径</div>
                      <div style="font-size:18px; font-weight:700; color:#0284c7;">
                        ${currentResult.recist_metrics.longest_diameter_mm} <span style="font-size:12px;">mm</span>
                      </div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
                      <div style="font-size:11px; color:#64748b;">垂直短径 (Short Axis)</div>
                      <div style="font-size:18px; font-weight:700; color:#0f172a;">
                        ${currentResult.recist_metrics.short_axis_mm} <span style="font-size:12px;">mm</span>
                      </div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
                      <div style="font-size:11px; color:#64748b;">脏器 / 病灶总体积</div>
                      <div style="font-size:18px; font-weight:700; color:#059669;">
                        ${currentResult.recist_metrics.total_volume_cm3} <span style="font-size:12px;">cm³</span>
                      </div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px;">
                      <div style="font-size:11px; color:#64748b;">GPU 计算耗时</div>
                      <div style="font-size:18px; font-weight:700; color:#7c3aed;">
                        ${currentResult.inference_duration_sec} <span style="font-size:12px;">s</span>
                      </div>
                    </div>
                  </div>

                  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px; font-size:12px; color:#334155; line-height:1.6;">
                    • <b>计算硬件</b>：<code>${esc(currentResult.accelerator)}</code><br>
                    • <b>分析模型</b>：<code>${esc(currentResult.model_name)}</code><br>
                    • <b>资产编号</b>：<code>${esc(currentResult.asset_id)}</code> (已写入平台云端资产库)
                  </div>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- 3. 底部操作按钮 -->
          <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid #e2e8f0; padding-top:14px;">
            <button data-close style="padding:8px 16px; border:1px solid #cbd5e1; background:#fff; border-radius:6px; font-size:13px; cursor:pointer;">
              关闭
            </button>
            <button id="btnInsertCanvas" class="primary" style="background:#059669; color:#fff; border:none; padding:8px 18px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; ${currentResult ? '' : 'opacity:0.5; pointer-events:none;'}" title="将关键截面图与 RECIST 指标插入当前页面">
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
        // 自动联动模型与窗位
        if (selectedSource === 'sample:spleen_test') {
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
            label: 'RECIST 肿瘤截面',
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
              modality: res.modality || 'CT',
              recist_metrics: res.recist_metrics,
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
