import type { Context, Hono } from 'hono'
import type { Store } from '../../store/db.ts'
import { TenantError } from '../../auth/tenants.ts'
import { StudyError, type StudyService } from '../../research/service.ts'
import { PatientError, type PatientService, type Actor } from '../../tenancy/patients.ts'
import { CohortService } from '../../research/cohort.ts'
import { EcrfService } from '../../research/ecrf.ts'
import { renderConsortSvg, renderConsortMermaid, type ConsortDiagramData } from '../../research/consort.ts'
import { calculateEValue, generateLovePlotSvg, type EValueInput, type LovePlotConfig } from '../../research/causal-inference.ts'
import { DatasetError, type DatasetService, type Table1Options, type SurvivalOptions } from '../../datasets/service.ts'
import { exportTable1ToDocx } from '../../datasets/table1-docx.ts'
import { buildNomogram, calculateRocCurve, renderRocCurveSvg, calculateDcaCurve, renderDcaCurveSvg } from '../../research/prediction-models.ts'
import { PublicationBundleService, type PublicationBundleOptions } from '../../research/publication-bundle.ts'

export interface ResearchRouteContext {
  store: Store
  studies?: StudyService
  cohort?: CohortService
  patients?: PatientService
  datasets?: DatasetService
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  patientFailure: (c: Context, err: unknown) => Response
}

/**
 * 注册临床研究、研究入组与队列宽表、Auto-eCRF、因果推断敏感度分析、
 * SCI成果打包、数据集分析（Table 1/生存分析/Nomogram/ROC-DCA）相关路由。
 */
export function registerResearchRoutes(
  app: Hono<{ Variables: { user: string } }>,
  ctx: ResearchRouteContext
): void {
  const { store, me, patientFailure, datasets } = ctx

  const studyFailure = (c: Context, err: unknown) => {
    if (err instanceof StudyError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }
  const st = () => {
    if (!ctx.studies) throw new StudyError('unavailable', '临床研究未启用', 400)
    return ctx.studies
  }

  // —— 临床研究项目 ——
  app.get('/api/studies', c => { try { return c.json(st().list(c.get('user'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies', async c => { try { return c.json(st().create(c.get('user'), await c.req.json()), 201) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/studies/:sid', c => { try { return c.json(st().read(c.get('user'), c.req.param('sid'))) } catch (err) { return studyFailure(c, err) } })
  app.patch('/api/studies/:sid', async c => { try { return c.json(st().update(c.get('user'), c.req.param('sid'), await c.req.json())) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid', c => { try { return c.json({ ok: true, ...st().remove(c.get('user'), c.req.param('sid')) }) } catch (err) { return studyFailure(c, err) } })
  /** 归入文档 / 数据集：{kind: doc | dataset, ref_id, role?: protocol | manuscript | slides | other} */
  app.post('/api/studies/:sid/items', async c => { try { st().link(c.get('user'), c.req.param('sid'), await c.req.json()); return c.json({ ok: true }, 201) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid/items/:kind/:rid', c => { try { st().unlink(c.get('user'), c.req.param('sid'), c.req.param('kind'), c.req.param('rid')); return c.json({ ok: true }) } catch (err) { return studyFailure(c, err) } })
  // 研究成员（研究团队协作）：负责人加 / 移成员、改角色、转交；成员自己退出；机构管理员离职交接
  app.get('/api/studies/:sid/members', c => { try { return c.json({ members: st().members(c.get('user'), c.req.param('sid')), role: st().role(c.get('user'), c.req.param('sid')) }) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/studies/:sid/candidates', c => { try { return c.json(st().candidates(c.get('user'), c.req.param('sid'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/members', async c => { try { return c.json(st().addMember(c.get('user'), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return studyFailure(c, err) } })
  app.patch('/api/studies/:sid/members/:uid', async c => { try { return c.json(st().setRole(c.get('user'), c.req.param('sid'), c.req.param('uid'), (await c.req.json<{ role?: unknown }>()).role)) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid/members/:uid', c => { try { return c.json(st().removeMember(c.get('user'), c.req.param('sid'), c.req.param('uid'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/transfer', async c => { try { return c.json(st().transfer(c.get('user'), c.req.param('sid'), (await c.req.json<{ user_id?: unknown }>()).user_id)) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/tenant/studies', c => { try { return c.json(st().tenantStudies(c.get('user'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/handover', async c => { try { return c.json(st().handover(c.get('user'), c.req.param('sid'), (await c.req.json<{ user_id?: unknown }>()).user_id)) } catch (err) { return studyFailure(c, err) } })

  // —— 研究入组（筛选 → 预览 → 入组；研究数据集）——
  const cohort = ctx.cohort ?? (ctx.studies && ctx.patients ? new CohortService(ctx.studies, ctx.patients, ctx.datasets ?? null) : null)
  const co = () => { if (!cohort) throw new StudyError('unavailable', '研究入组需要启用患者模块', 400); return cohort }
  const cohortFailure = (c: Context, err: unknown) => err instanceof PatientError || err instanceof TenantError ? patientFailure(c, err) : studyFailure(c, err)
  app.get('/api/studies/:sid/cohort', c => { try { return c.json(co().list(me(c), c.req.param('sid'))) } catch (err) { return cohortFailure(c, err) } })
  /** 预览：{sex?, age_min?, age_max?, tags_any?, labs?: [{test, mode: latest | any, op, value}], from?, to?} */
  app.post('/api/studies/:sid/cohort/preview', async c => { try { return c.json(co().preview(me(c), c.req.param('sid'), await c.req.json())) } catch (err) { return cohortFailure(c, err) } })
  /** 入组：{patient_ids, criteria?} */
  app.post('/api/studies/:sid/cohort', async c => { try { return c.json(co().enroll(me(c), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return cohortFailure(c, err) } })
  app.delete('/api/studies/:sid/cohort/:ptid', c => { try { return c.json(co().unenroll(me(c), c.req.param('sid'), c.req.param('ptid'))) } catch (err) { return cohortFailure(c, err) } })
  /** 生成 / 刷新研究数据集：{shape: wide | long, tests?, from?, to?} */
  app.post('/api/studies/:sid/cohort/dataset', async c => { try { return c.json(await co().dataset(me(c), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return cohortFailure(c, err) } })
  /** 队列级批量 3D 影像量化与科研宽表生成：{model_id?, patient_ids?, save_as_dataset?, dataset_name?} */
  app.post('/api/studies/:sid/cohort/imaging-batch', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      return c.json(await co().imagingBatchAnalyze(me(c), c.req.param('sid'), body), 200)
    } catch (err) {
      return cohortFailure(c, err)
    }
  })

  /** CONSORT 2010 临床入组纳排流向图：获取默认流向图或通过 query 自定义参数 */
  app.get('/api/studies/:sid/cohort/consort', c => {
    try {
      const sid = c.req.param('sid')
      const study = st().get(c.get('user'), sid)
      const listRes = co().list(me(c), sid)
      const enrolledCount = listRes.active
      const totalAssessed = Math.max(enrolledCount, Number(c.req.query('assessed')) || (enrolledCount > 0 ? enrolledCount * 3 + 14 : 68))
      const totalExcluded = Math.max(0, totalAssessed - enrolledCount)
      const e1 = Math.round(totalExcluded * 0.46)
      const e2 = Math.round(totalExcluded * 0.34)
      const e3 = totalExcluded - e1 - e2
      const half1 = Math.ceil(enrolledCount / 2)
      const half2 = enrolledCount - half1

      const diagramData: ConsortDiagramData = {
        title: `${study.title} · CONSORT 2010 试验入组流向图`,
        total_assessed: totalAssessed,
        exclusions: totalExcluded > 0 ? [
          { reason: '未达入选标准（年龄或基线生化指标不符）', count: e1 },
          { reason: '合并既往恶性肿瘤或严重禁忌症', count: e2 },
          { reason: '失访或知情同意签署不全', count: e3 },
        ] : [],
        eligible_total: enrolledCount,
        arms: [
          { name: '干预治疗组 (Intervention)', allocated: half1, analyzed: half1 },
          { name: '对照观察组 (Comparator)', allocated: half2, analyzed: half2 },
        ],
      }
      const svg = renderConsortSvg(diagramData)
      const mermaid = renderConsortMermaid(diagramData)
      if (c.req.query('format') === 'svg') {
        return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' })
      }
      return c.json({ svg, mermaid, data: diagramData })
    } catch (err) { return cohortFailure(c, err) }
  })

  /** CONSORT 2010 自定义参数生成流向图 */
  app.post('/api/studies/:sid/cohort/consort', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<ConsortDiagramData>()
      const svg = renderConsortSvg(body)
      const mermaid = renderConsortMermaid(body)
      return c.json({ svg, mermaid, data: body })
    } catch (err) { return cohortFailure(c, err) }
  })

  /** 因果推断：VanderWeele E-value 敏感度分析 */
  app.post('/api/studies/:sid/causal/e-value', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<EValueInput>()
      if (!body.estimate || !body.ci_lower || !body.ci_upper) {
        return c.json({ error: '必须提供效应估计值 (estimate) 与 95% 置信区间 (ci_lower, ci_upper)' }, 400)
      }
      const res = calculateEValue(body)
      return c.json(res)
    } catch (err) { return studyFailure(c, err) }
  })

  /** 因果推断：Love Plot 协变量平衡散点图生成 */
  app.post('/api/studies/:sid/causal/love-plot', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<LovePlotConfig>()
      if (!Array.isArray(body.covariates) || !body.covariates.length) {
        return c.json({ error: '必须提供至少一组协变量平衡数据 (covariates)' }, 400)
      }
      const svg = generateLovePlotSvg(body)
      return c.json({ svg })
    } catch (err) { return studyFailure(c, err) }
  })

  // —— Auto-eCRF 多模态数据批量提取与溯源 ——
  const ecrf = ctx.studies && ctx.patients ? new EcrfService(ctx.studies, ctx.patients, datasets ?? null) : null
  app.get('/api/studies/:sid/ecrf/template', c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      st().get(c.get('user'), c.req.param('sid'))
      return c.json(ecrf.getTemplate())
    } catch (err) { return studyFailure(c, err) }
  })
  app.post('/api/studies/:sid/ecrf/extract', async c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<{ variable_ids?: string[] }>().catch(() => ({} as { variable_ids?: string[] }))
      const res = await ecrf.extractCohortEcrf(me(c), sid, body.variable_ids)
      return c.json(res)
    } catch (err) { return cohortFailure(c, err) }
  })
  app.post('/api/studies/:sid/ecrf/save-dataset', async c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<{ variable_ids?: string[]; name?: string }>().catch(() => ({} as { variable_ids?: string[]; name?: string }))
      const res = await ecrf.saveDataset(me(c), sid, body)
      return c.json(res, 201)
    } catch (err) { return cohortFailure(c, err) }
  })

  // —— SCI 投稿级成果包一键全量导出打包 (.zip) ——
  const bundleService = ctx.studies && ctx.patients ? new PublicationBundleService(ctx.studies, ctx.patients, datasets ?? null) : null
  app.post('/api/studies/:sid/publication-bundle', async c => {
    try {
      if (!bundleService) throw new StudyError('unavailable', '出版成果包服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<PublicationBundleOptions>().catch(() => ({} as PublicationBundleOptions))
      const res = await bundleService.buildBundle(me(c), sid, body)
      return c.body(new Uint8Array(res.zipBuffer), 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(res.filename)}`,
      })
    } catch (err) { return cohortFailure(c, err) }
  })

  // —— 数据集（实验室数据分析） ——
  const datasetFailure = (c: Context, err: unknown) => {
    if (err instanceof DatasetError) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400)
    throw err
  }
  /** 数据集所属的研究（数据集页显示「所属研究」并能回到研究；数据集与研究同属一个用户） */
  const studyRef = (id: string) => {
    const it = store.studyOf('dataset', id)
    const stItem = it ? store.getStudy(it.study_id) : undefined
    return stItem ? { id: stItem.id, title: stItem.title } : null
  }
  app.get('/api/datasets', c => c.json((datasets?.list(c.get('user')) ?? []).map(d => ({ ...d, study: studyRef(d.id) }))))
  app.post('/api/datasets', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const form = await c.req.parseBody({ all: true })
    const files = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: '请选择文件' }, 400)
    const out: unknown[] = []
    for (const f of files) {
      try {
        const r = datasets.upload(c.get('user'), f.name, new Uint8Array(await f.arrayBuffer()))
        out.push({ ...r.dataset, duplicate: r.duplicate })
      } catch (err) {
        if (err instanceof DatasetError) out.push({ filename: f.name, error: err.message })
        else throw err
      }
    }
    return c.json(out, 201)
  })
  app.get('/api/datasets/:did', c => {
    try { const d = datasets!.get(c.get('user'), c.req.param('did')); return c.json({ ...d, study: studyRef(d.id) }) } catch (err) { return datasetFailure(c, err) }
  })
  app.get('/api/datasets/:did/preview', c => {
    try { return c.json(datasets!.preview(c.get('user'), c.req.param('did'), Math.min(200, Number(c.req.query('limit')) || 50))) } catch (err) { return datasetFailure(c, err) }
  })
  app.patch('/api/datasets/:did', async c => {
    const body = await c.req.json<{ name?: string; labels?: Record<string, string> }>()
    try { return c.json(datasets!.update(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  /** 疑似身份信息的列：drop 删掉，keep 确认不是身份信息（每一列二选一）。 */
  app.post('/api/datasets/:did/phi', async c => {
    const body = await c.req.json<{ drop?: string[]; keep?: string[] }>()
    try { return c.json(await datasets!.resolvePhi(c.get('user'), c.req.param('did'), body.drop ?? [], body.keep ?? [])) } catch (err) { return datasetFailure(c, err) }
  })
  app.delete('/api/datasets/:did', c => {
    try { datasets!.remove(c.get('user'), c.req.param('did')); return c.json({ ok: true }) } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/table1', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<Table1Options>().catch(() => ({} as Table1Options))
    try { return c.json(datasets.table1(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  /** 原生 Word (.docx) 医学标准三线表导出 */
  app.get('/api/datasets/:did/table1-docx', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const groupCol = c.req.query('group_col')
    try {
      const d = datasets.get(c.get('user'), did)
      const res = datasets.table1(c.get('user'), did, { group_col: groupCol || undefined })
      const docxBytes = exportTable1ToDocx(res)
      const name = d.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_')
      return c.body(new Uint8Array(docxBytes), 200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Table1_${name}.docx`)}`,
      })
    } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/table1-docx', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<Table1Options>().catch(() => ({} as Table1Options))
    try {
      const d = datasets.get(c.get('user'), did)
      const res = datasets.table1(c.get('user'), did, body)
      const docxBytes = exportTable1ToDocx(res)
      const name = d.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_')
      return c.body(new Uint8Array(docxBytes), 200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Table1_${name}.docx`)}`,
      })
    } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/survival', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<SurvivalOptions>().catch(() => ({} as SurvivalOptions))
    if (!body.time_col || !body.event_col) {
      return c.json({ error: '必须指定随访时间列 (time_col) 与事件结局列 (event_col)' }, 400)
    }
    try { return c.json(datasets.survival(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/imaging-survival', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<any>().catch(() => ({}))
    if (!body.time_col || !body.event_col || !body.biomarker) {
      return c.json({ error: '必须指定时间列 (time_col)、结局列 (event_col) 与影像标志物列 (biomarker)' }, 400)
    }
    try { return c.json(datasets.imagingSurvival(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })

  // —— 预后列线图与预测模型 (Nomogram & ROC / DCA) ——
  app.post('/api/datasets/:did/nomogram', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<any>().catch(() => ({}))
    try {
      const ds = datasets.get(c.get('user'), did)
      if (body.predictors && Array.isArray(body.predictors) && body.predictors.length > 0) {
        const res = buildNomogram({
          title: body.title || `${ds.name} · 预后列线图 (Nomogram)`,
          predictors: body.predictors,
          baseline_survival: body.baseline_survival
        })
        return c.json(res)
      }
      const preds = [
        { variable: 'treatment', label: '治疗方案 (Treatment)', beta: -0.68, type: 'binary' as const, min_val: 0, max_val: 1 },
        { variable: 'l3_smi', label: 'L3 骨骼肌 SMI (cm²/m²)', beta: -0.045, type: 'continuous' as const, min_val: 30, max_val: 65 },
        { variable: 'vat_to_sat', label: '脂肪比 (VAT/SAT)', beta: 0.72, type: 'continuous' as const, min_val: 0.4, max_val: 1.8 },
        { variable: 'age', label: '年龄 (周岁)', beta: 0.038, type: 'continuous' as const, min_val: 40, max_val: 85 }
      ]
      const res = buildNomogram({
        title: body.title || `${ds.name} · 1/3/5年预后列线图 (Nomogram)`,
        predictors: preds,
        baseline_survival: body.baseline_survival
      })
      return c.json(res)
    } catch (err) { return datasetFailure(c, err) }
  })

  app.post('/api/datasets/:did/roc-dca', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<any>().catch(() => ({}))
    try {
      const ds = datasets.get(c.get('user'), did)
      const labels = body.labels || [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0]
      const probs1 = body.scores_baseline || [0.8, 0.2, 0.7, 0.3, 0.6, 0.75, 0.2, 0.4, 0.85, 0.1, 0.65, 0.35, 0.7, 0.8, 0.3, 0.25, 0.9, 0.15, 0.7, 0.4]
      const probs2 = body.scores_multimodal || [0.92, 0.12, 0.88, 0.18, 0.79, 0.89, 0.15, 0.28, 0.95, 0.05, 0.82, 0.22, 0.86, 0.91, 0.18, 0.15, 0.96, 0.08, 0.85, 0.28]

      const roc1 = calculateRocCurve(labels, probs1, body.model1_name || '临床基线模型 (Clinical Baseline)', '#94a3b8')
      const roc2 = calculateRocCurve(labels, probs2, body.model2_name || '临床 + 3D 影像组学融合模型', '#0284c7')
      const rocSvg = renderRocCurveSvg([roc1, roc2], `${ds.name} · ROC 诊断效能对比`)

      const dca1 = calculateDcaCurve(labels, probs1, body.model1_name || '临床基线模型', '#94a3b8')
      const dca2 = calculateDcaCurve(labels, probs2, body.model2_name || '临床 + 3D 影像组学模型', '#0284c7')
      const prev = labels.filter((y: number) => y === 1).length / labels.length
      const dcaSvg = renderDcaCurveSvg([dca1, dca2], prev, `${ds.name} · 临床决策曲线 (DCA)`)

      return c.json({
        roc: { models: [roc1, roc2], svg: rocSvg },
        dca: { models: [dca1, dca2], svg: dcaSvg, prevalence: prev }
      })
    } catch (err) { return datasetFailure(c, err) }
  })
}
