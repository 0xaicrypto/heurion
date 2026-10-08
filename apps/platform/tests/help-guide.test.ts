import { describe, it, expect } from 'vitest'
import { HELP_SECTIONS, buildHelpMarkdown } from '../web/src/help.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { schema } from '../src/model/schema.ts'

describe('产品使用手册与操作指南 (Product Help & Documentation)', () => {
  it('1. 手册章节结构完整且覆盖所有核心业务模块', () => {
    expect(HELP_SECTIONS.length).toBeGreaterThanOrEqual(10)
    const ids = HELP_SECTIONS.map(s => s.id)
    expect(ids).toContain('overview')
    expect(ids).toContain('concepts')
    expect(ids).toContain('privacy')
    expect(ids).toContain('writing')
    expect(ids).toContain('imaging')
    expect(ids).toContain('registration')
    expect(ids).toContain('diagnostics')
    expect(ids).toContain('casestudy')
    expect(ids).toContain('research')
    expect(ids).toContain('collaboration')
    expect(ids).toContain('citations')
    expect(ids).toContain('faq')
    expect(ids).toContain('releasenotes')

    for (const sec of HELP_SECTIONS) {
      expect(sec.id).toBeTruthy()
      expect(sec.title).toBeTruthy()
      expect(sec.badge).toBeTruthy()
      expect(sec.icon).toBeTruthy()
      expect(sec.summary).toBeTruthy()
      expect(sec.contentHtml.length).toBeGreaterThan(100)
    }
  })

  it('2. 核心临床规范与技术指标真实落地', () => {
    const allHtml = HELP_SECTIONS.map(s => s.contentHtml).join('\n')
    
    // 通俗概念通识课
    expect(allHtml).toContain('医学影像与核心逻辑通俗通识课')
    expect(allHtml).toContain('生活化比喻')
    expect(allHtml).toContain('体素 (Voxel)')
    expect(allHtml).toContain('亨氏单位 (HU)')
    expect(allHtml).toContain('MPR 三正交切片')
    expect(allHtml).toContain('隐匿性肌少症')

    // 零 PHI 与患者档案安全准则
    expect(allHtml).toContain('零 PHI')
    expect(allHtml).toContain('纯虚拟代号建档')
    expect(allHtml).toContain('本机浏览器备注名物理隔离')
    expect(allHtml).toContain('AES-256-GCM')
    expect(allHtml).toContain('待确认操作卡')
    
    // 多模态化验与单位归一化
    expect(allHtml).toContain('国际标准单位归一化')
    expect(allHtml).toContain('原件精准溯源')
    
    // 影像量化指标与 MONAI 模型矩阵
    expect(allHtml).toContain('BAR')
    expect(allHtml).toContain('高密度粘液栓')
    expect(allHtml).toContain('MONAI')
    expect(allHtml).toContain('SegResNet')
    expect(allHtml).toContain('PI-RADS')
    expect(allHtml).toContain('Agatston')
    expect(allHtml).toContain('TotalSegmentator')
    expect(allHtml).toContain('骨骼肌指数 (SMI')
    expect(allHtml).toContain('肌少症')
    expect(allHtml).toContain('IBSI')
    expect(allHtml).toContain('全景诊断报告')
    expect(allHtml).toContain('MPR')
    expect(allHtml).toContain('横断面 (Axial)')
    expect(allHtml).toContain('NiiVue 3D WebGL2')
    expect(allHtml).toContain('定位病灶中心')
    expect(allHtml).toContain('保存切片为文档资产')
    
    // 双期 3D 刚性/非刚性配准、差分热力图、PET-CT 融合与 RT-STRUCT
    expect(allHtml).toContain('刚性与仿射对齐')
    expect(allHtml).toContain('3D 非刚性弹性形变配准')
    expect(allHtml).toContain('差分吸收热力图')
    expect(allHtml).toContain('双联屏联动切片滑动')
    expect(allHtml).toContain('PET-CT')
    expect(allHtml).toContain('SUVmax')
    expect(allHtml).toContain('DICOM RT-STRUCT')
    expect(allHtml).toContain('RECIST 1.1')
    
    // 多模态因果诊断链与国际标准导出
    expect(allHtml).toContain('变应性支气管肺曲霉病')
    expect(allHtml).toContain('DICOM SR')
    expect(allHtml).toContain('HL7 FHIR')
    
    // 临床科研、影像组学生存分析与知家
    expect(allHtml).toContain('Table 1')
    expect(allHtml).toContain('Kaplan-Meier')
    expect(allHtml).toContain('影像生物标志物生存分析')
    expect(allHtml).toContain('知家')
    expect(allHtml).toContain('1.5px 极简发丝级医学科技矢量 SVG 图标')
  })

  it('3. Markdown 手册生成与文档块结构解析验证', () => {
    const md = buildHelpMarkdown()
    expect(md).toContain('# Heurion 临床智能工作站 · 全流程使用手册与操作指南')
    expect(md).toContain('## 一、 快速上手与界面导览')
    expect(md).toContain('## 二、 医学影像与核心逻辑通俗通识课 (零基础必读)')
    expect(md).toContain('## 三、 医学隐私与安全架构 (Zero-PHI)')
    expect(md).toContain('## 四、 医学写作与文献溯源')
    expect(md).toContain('## 五、 患者管理与 3D 影像量化分析')
    expect(md).toContain('## 六、 双期 3D 刚性配准与差分吸收热力图')
    expect(md).toContain('## 七、 多模态因果诊断链与标准报告导出')
    expect(md).toContain('## 八、 【实战案例深度图解】真实患者 3D 影像全流程量化与随访评定范例')
    expect(md).toContain('## 九、 临床科研工作流 (Research)')
    expect(md).toContain('## 十、 科室协作与知家家庭健康空间 (PHR)')
    expect(md).toContain('## 十一、 引用文献真伪校验与学术论断核验指南 (Reference Verification & Claims Validation)')
    expect(md).toContain('## 十二、 常见问题解答 (FAQ)')
    expect(md).toContain('## 十三、 版本更新日志 (Release Notes)')
    expect(md).toContain('纯虚拟代号建档')
    expect(md).toContain('支气管-伴行动脉比 (BAR)')
    expect(md).toContain('NiiVue 3D WebGL2')
    expect(md).toContain('L3 骨骼肌指数 (SMI')
    expect(md).toContain('IBSI (Image Biomarker Standardisation Initiative)')
    expect(md).toContain('PET-CT 跨模态代谢与解剖融合成像')
    expect(md).toContain('DICOM RT-STRUCT')
    expect(md).toContain('影像生物标志物生存分析与预后建模')
    
    // 验证 parseBlocks 能够顺利将生成的 markdown 转换成 ProseMirror 节点
    const blocks = parseBlocks(md)
    expect(blocks.length).toBeGreaterThan(10)
    
    const docNode = schema.node('doc', null, blocks)
    expect(docNode).toBeDefined()
    expect(docNode.type.name).toBe('doc')
    expect(docNode.childCount).toBeGreaterThan(10)
  })

  it('4. 真实患者病例实战图解与高清影像证据链完整覆盖', () => {
    const caseSec = HELP_SECTIONS.find(s => s.id === 'casestudy')
    expect(caseSec).toBeDefined()
    expect(caseSec?.title).toContain('真实患者 3D 影像全流程诊疗范例')
    const html = caseSec!.contentHtml

    // 16 张关键临床真实截图落地 (4 大案例完整覆盖)
    // 案例一：ABPA
    expect(html).toContain('/site/real-case-1-baseline-hrct.png')
    expect(html).toContain('/site/real-case-2-mpr-3view.png')
    expect(html).toContain('/site/real-case-3-diff-heatmap.png')
    expect(html).toContain('/site/real-case-4-l3-smi.png')
    expect(html).toContain('/site/real-case-5-diagnostic-chain.png')
    // 案例二：NSCLC
    expect(html).toContain('/site/real-case-nsclc-1-baseline-recist.png')
    expect(html).toContain('/site/real-case-nsclc-2-mpr-3view.png')
    expect(html).toContain('/site/real-case-nsclc-3-diff-heatmap.png')
    expect(html).toContain('/site/real-case-nsclc-4-radiomics-feature.png')
    expect(html).toContain('/site/real-case-nsclc-5-diagnostic-chain.png')
    // 案例三：PT-ABDOMEN-003 全腹平扫 CT 与肌少症评估
    expect(html).toContain('/site/real-case-sarco-1-l3-muscle-fat.png')
    expect(html).toContain('/site/real-case-sarco-2-pk-toxicity-risk.png')
    expect(html).toContain('/site/real-case-sarco-3-diagnostic-chain.png')
    // 案例四：PT-PROSTATE-004 盆腔前列腺 T2-MRI
    expect(html).toContain('/site/real-case-prostate-1-t2-mri.png')

    // 临床病理生理机制与量化指标深度自洽
    expect(html).toContain('PT-BRONCHO-001')
    expect(html).toContain('印戒征 (Signet Ring Sign)')
    expect(html).toContain('BAR = 1.45')
    expect(html).toContain('高密度粘液栓 (High Attenuation Mucus, HAM)')
    expect(html).toContain('368.29 cm³')
    expect(html).toContain('12.44 cm³')
    expect(html).toContain('夏科-雷登结晶')
    expect(html).toContain('Bhalla')
    expect(html).toContain('Reiff')
    expect(html).toContain('L3 骨骼肌指数 (SMI = 56.94')
    expect(html).toContain('Prado')
    expect(html).toContain('差分吸收热力图')
    expect(html).toContain('3D 容积吸收评估')
    expect(html).toContain('74.9%')
    expect(html).toContain('变应性支气管肺曲霉病 (ABPA)')
    expect(html).toContain('Rosenberg-Patterson')
    expect(html).toContain('DICOM SR')
    expect(html).toContain('HL7 FHIR')
  })

  it('5. 版本更新日志 (Release Notes) 与九步影像完整业务流程闭环验证', () => {
    const relSec = HELP_SECTIONS.find(s => s.id === 'releasenotes')
    expect(relSec).toBeDefined()
    expect(relSec?.title).toContain('版本发布更新日志')
    
    const html = relSec!.contentHtml
    expect(html).toContain('v2.6 Pro')
    expect(html).toContain('v2.5 Pro')
    expect(html).toContain('v2.4 Pro')
    expect(html).toContain('v2.3.0')
    expect(html).toContain('v2.2.0')
    expect(html).toContain('v2.1.0')
    expect(html).toContain('v2.0.0')
    expect(html).toContain('TotalSegmentator L3 椎体机体成分分析')
    expect(html).toContain('IBSI 107 项标准影像组学')
    expect(html).toContain('3D 非刚性弹性形变配准')
    expect(html).toContain('PET-CT 跨模态代谢与解剖融合成像')
    expect(html).toContain('DICOM RT-STRUCT')
    expect(html).toContain('发丝级矢量图标系统')

    // 验证九步全流程影像闭环在手册中完整陈述
    const imgSec = HELP_SECTIONS.find(s => s.id === 'imaging')
    expect(imgSec?.contentHtml).toContain('影像智能分析全流程业务闭环')
    expect(imgSec?.contentHtml).toContain('① 影像摄入与合规脱敏')
    expect(imgSec?.contentHtml).toContain('② 空间几何与重采样')
    expect(imgSec?.contentHtml).toContain('③ MONAI 3D 深度模型矩阵')
    expect(imgSec?.contentHtml).toContain('④ IBSI 影像组学高维提取')
    expect(imgSec?.contentHtml).toContain('⑤ MPR 三正交交互式切片')
    expect(imgSec?.contentHtml).toContain('⑥ 纵向随访与差分热力图')
    expect(imgSec?.contentHtml).toContain('⑦ PET-CT 代谢融合')
    expect(imgSec?.contentHtml).toContain('⑧ 放疗靶区 RT-STRUCT')
    expect(imgSec?.contentHtml).toContain('⑨ 因果链与结构化导出')

    // 验证 Markdown 手册中同样包含 Release Notes 与 9 步闭环
    const md = buildHelpMarkdown()
    expect(md).toContain('## 十三、 版本更新日志 (Release Notes)')
    expect(md).toContain('### v2.6 Pro')
    expect(md).toContain('### v2.5 Pro')
    expect(md).toContain('### v2.4 Pro')
    expect(md).toContain('### v2.3.0')
    expect(md).toContain('The Complete 9-Step Imaging Pipeline')
  })

  it('6. 非医学专业通俗通识概念课与通俗比喻全面覆盖', () => {
    const conceptSec = HELP_SECTIONS.find(s => s.id === 'concepts')
    expect(conceptSec).toBeDefined()
    expect(conceptSec?.title).toContain('通俗通识课')
    
    const html = conceptSec!.contentHtml
    // 验证 14 个概念的比喻与核心逻辑
    expect(html).toContain('西瓜用极薄的刀切成几百片')
    expect(html).toContain('跳舞并产生共振')
    expect(html).toContain('海豚或军用潜艇的声呐雷达')
    expect(html).toContain('像灯泡一样发光')
    expect(html).toContain('平面贴纸')
    expect(html).toContain('乐高积木')
    expect(html).toContain('各向异性 Anisotropy')
    expect(html).toContain('亨氏单位 (Hounsfield Unit, HU)')
    expect(html).toContain('偏光太阳镜')
    expect(html).toContain('切长方体吐司面包')
    expect(html).toContain('一对形影不离的搭档')
    expect(html).toContain('印戒征 (Signet Ring Sign)')
    expect(html).toContain('夏科-雷登结晶')
    expect(html).toContain('揉皱的面团或丝巾')
    expect(html).toContain('实体瘤疗效评价标准')
    expect(html).toContain('隐匿性肌少症')
    expect(html).toContain('第 3 腰椎')
    expect(html).toContain('影像组学特征 (Radiomics Features)')
    expect(html).toContain('狂欢派对')
    expect(html).toContain('大体肿瘤体积')
    expect(html).toContain('危及器官')
    expect(html).toContain('因果推演图谱')
    expect(html).toContain('localStorage')
  })

  it('7. 4 大典型临床标杆案例库与量化决策闭环完整覆盖', () => {
    const caseSec = HELP_SECTIONS.find(s => s.id === 'casestudy')
    expect(caseSec).toBeDefined()
    const html = caseSec!.contentHtml

    // 案例一：ABPA 变态反应性支气管肺曲霉病
    expect(html).toContain('PT-BRONCHO-001')
    expect(html).toContain('BAR = 1.45')
    expect(html).toContain('12.44 cm³')
    expect(html).toContain('HAM')
    expect(html).toContain('3D 容积吸收评估')
    expect(html).toContain('74.9%')
    expect(html).toContain('Rosenberg-Patterson')

    // 案例二：NSCLC 晚期肺腺癌 EGFR 突变奥希替尼靶向 RECIST 1.1 评估
    expect(html).toContain('PT-NSCLC-002')
    expect(html).toContain('EGFR 19 号外显子缺失突变')
    expect(html).toContain('奥希替尼')
    expect(html).toContain('60.0 mm')
    expect(html).toContain('33.0 mm')
    expect(html).toContain('-45.0%')
    expect(html).toContain('部分缓解 (PR)')
    expect(html).toContain('RECIST 1.1')
    expect(html).toContain('-78.2%')

    // 案例三：PT-ABDOMEN-003 王伟 全腹部平扫 CT 脾脏显著肿大合并肌少症隐匿风险
    expect(html).toContain('PT-ABDOMEN-003')
    expect(html).toContain('TotalSegmentator L3')
    expect(html).toContain('29.92 cm²/m²')
    expect(html).toContain('52.4 cm²/m²')
    expect(html).toContain('26.4 HU')
    expect(html).toContain('肌脂肪变性 (Myosteatosis)')
    expect(html).toContain('680.0 cm³')
    expect(html).toContain('脾脏显著肿大')
    expect(html).toContain('MDT 审慎评估')
    expect(html).toContain('营养支持')

    // 案例四：PT-PROSTATE-004 张敏 盆腔前列腺 T2 靶向高分辨 MRI
    expect(html).toContain('PT-PROSTATE-004')
    expect(html).toContain('PI-RADS')
    expect(html).toContain('移行区 (TZ)')
    expect(html).toContain('外周带 (PZ)')
    expect(html).toContain('48.60 cm³')
    expect(html).toContain('28.20 cm³')
    expect(html).toContain('0.58')
    expect(html).toContain('良性前列腺增生 (BPH)')
    expect(html).toContain('规避非必要经直肠有创穿刺活检 (TRUS)')

    // Markdown 版本验证
    const md = buildHelpMarkdown()
    expect(md).toContain('PT-NSCLC-002')
    expect(md).toContain('/site/real-case-nsclc-1-baseline-recist.png')
    expect(md).toContain('/site/real-case-nsclc-2-mpr-3view.png')
    expect(md).toContain('/site/real-case-nsclc-3-diff-heatmap.png')
    expect(md).toContain('/site/real-case-nsclc-4-radiomics-feature.png')
    expect(md).toContain('/site/real-case-nsclc-5-diagnostic-chain.png')
    expect(md).toContain('-45.0%')
    expect(md).toContain('PT-ABDOMEN-003')
    expect(md).toContain('/site/real-case-sarco-1-l3-muscle-fat.png')
    expect(md).toContain('/site/real-case-sarco-2-pk-toxicity-risk.png')
    expect(md).toContain('/site/real-case-sarco-3-diagnostic-chain.png')
    expect(md).toContain('29.92 cm²/m²')
    expect(md).toContain('680.0 cm³')
    expect(md).toContain('PT-PROSTATE-004')
    expect(md).toContain('/site/real-case-prostate-1-t2-mri.png')
    expect(md).toContain('48.60 cm³')
    expect(md).toContain('0.58')
    expect(md).toContain('4 大典型临床案例多模态指标与决策对照矩阵表')
  })

  it('8. 诊断级 3D MPR 前端轻量标注交互与物理量化算法章节验证', () => {
    const conceptSec = HELP_SECTIONS.find(s => s.id === 'concepts')
    expect(conceptSec).toBeDefined()
    expect(conceptSec!.contentHtml).toContain('2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺')
    expect(conceptSec!.contentHtml).toContain('微型发光灯泡')
    expect(conceptSec!.contentHtml).toContain('物理体素标定 (Voxel Spacing)')
    expect(conceptSec!.contentHtml).toContain('双层 Canvas 交互系统')

    const imgSec = HELP_SECTIONS.find(s => s.id === 'imaging')
    expect(imgSec).toBeDefined()
    const html = imgSec!.contentHtml

    // 5.6 完整功能设计
    expect(html).toContain('5.6 诊断级 3D MPR 前端轻量标注与卡尺交互量化系统')
    expect(html).toContain('5.6.1 完整功能设计 (Full Functional Design)')
    expect(html).toContain('浏览模式 (Browse Mode)')
    expect(html).toContain('游标卡尺测距模式 (Caliper Mode)')
    expect(html).toContain('矩形剖面 ROI 面积模式 (ROI Area Mode)')
    expect(html).toContain('清除标注 (Clear)')
    expect(html).toContain('双图层复合无损存证 (Composite Snapshot Export)')
    expect(html).toContain('自动化诊断报告草案动态注入 (Diagnostic Report Draft Injection)')

    // 5.6.2 交互实现架构
    expect(html).toContain('5.6.2 交互实现架构 (Interactive Implementation Architecture)')
    expect(html).toContain('双层 Canvas DOM 覆盖架构')
    expect(html).toContain('mprImg')
    expect(html).toContain('mprAnnotCanvas')
    expect(html).toContain('pointer-events')
    expect(html).toContain('pointerdown')
    expect(html).toContain('pointermove')
    expect(html).toContain('pointerup')
    expect(html).toContain('requestAnimationFrame')
    expect(html).toContain('devicePixelRatio')

    // 5.6.3 算法量化原理与物理标定
    expect(html).toContain('5.6.3 算法量化原理与物理标定 (Algorithm & Physics Calibration)')
    expect(html).toContain('PixelSpacing')
    expect(html).toContain('D_{\\text{mm}}')
    expect(html).toContain('A_{\\text{mm}^2}')
    expect(html).toContain('CompositeCanvas')

    // Markdown 导出一致性验证
    const md = buildHelpMarkdown()
    expect(md).toContain('2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺')
    expect(md).toContain('6. **诊断级 3D MPR 前端轻量标注与卡尺交互量化系统 (Frontend Lightweight Annotation & Caliper Engine)**')
    expect(md).toContain('游标卡尺测距 (Caliper mm)')
    expect(md).toContain('矩形剖面 ROI 面积 (ROI Area)')
    expect(md).toContain('双层 Canvas DOM 覆盖')
    expect(md).toContain('mprAnnotCanvas')
    expect(md).toContain('D_{\\text{mm}}')
    expect(md).toContain('CompositeCanvas')
  })

  it('9. 临床科研工作流 (Research) 完整使用方法与真实世界 SGLT2i 队列研究标杆案例验证', () => {
    const resSec = HELP_SECTIONS.find(s => s.id === 'research')
    expect(resSec).toBeDefined()
    expect(resSec?.title).toContain('临床科研工作流')
    const html = resSec!.contentHtml

    // 9.1 ~ 9.5 操作方法全覆盖
    expect(html).toContain('9.1 科研课题立项与研究方案结构化起草')
    expect(html).toContain('PICO 框架结构化方案制定')
    expect(html).toContain('Population/目标患病人群')
    expect(html).toContain('Intervention/干预暴露因素')
    expect(html).toContain('Comparator/对照方案')
    expect(html).toContain('Outcome/研究终点事件')
    expect(html).toContain('IRB-2017-MED-0428')
    expect(html).toContain('ChiCTR2600098712')
    expect(html).toContain('NCT03036124')
    expect(html).toContain('样本量与统计功效前置估算')

    // 9.2 数据集导入与零 PHI 敏感数据脱敏
    expect(html).toContain('9.2 多源临床数据表导入、智能字典解析与零 PHI 脱敏')
    expect(html).toContain('.sas7bdat')
    expect(html).toContain('.sav / .dta')
    expect(html).toContain('零 PHI 敏感信息红标拦截与前端物理脱敏')
    expect(html).toContain('S001, S002')
    expect(html).toContain('变量字典与数据类型智能推断')
    expect(html).toContain('MICE')
    expect(html).toContain('3-Sigma')

    // 9.3 患者库多维条件筛选入组
    expect(html).toContain('9.3 患者库多维条件筛选入组与动态队列生成')
    expect(html).toContain('多维逻辑布尔检索')
    expect(html).toContain('3D 影像表型智能联动')
    expect(html).toContain('列式 Parquet 格式数据集')

    // 9.4 隔离沙箱自动化统计
    expect(html).toContain('9.4 隔离受限沙箱自动化医学统计分析')
    expect(html).toContain('Table 1 基线三线表')
    expect(html).toContain('倾向评分匹配 (PSM)')
    expect(html).toContain('标准化均数差 (SMD)')
    expect(html).toContain('Kaplan-Meier 生存分析')
    expect(html).toContain('Number at Risk')
    expect(html).toContain('Cox 比例风险与森林图')
    expect(html).toContain('Adjusted HR')
    expect(html).toContain('Schoenfeld 残差检验')

    // 9.5 影像生物标志物生存分析与预后建模 & 9.6 成果闭环
    expect(html).toContain('9.5 影像生物标志物生存分析与预后建模')
    expect(html).toContain('9.6 论文稿件与学术幻灯片成果闭环')
    expect(html).toContain('{{research.table1}}')
    expect(html).toContain('{{research.km_curve}}')

    // 真实科研标杆案例与 5 张高清真实图表 (DAPA-HF 里程碑 RCT + 前瞻性队列)
    expect(html).toContain('DAPA-HF')
    expect(html).toContain('NCT03036124')
    expect(html).toContain('2016-003290-34')
    expect(html).toContain('NEJM 2019')
    expect(html).toContain('McMurray')
    expect(html).toContain('Solomon')
    expect(html).toContain('/site/real-case-research-1-protocol-cohort.png')
    expect(html).toContain('/site/real-case-research-2-table1-baseline.png')
    expect(html).toContain('/site/real-case-research-3-km-survival.png')
    expect(html).toContain('/site/real-case-research-4-cox-forest.png')
    expect(html).toContain('/site/real-case-research-5-research-loop.png')

    // 案例数据与统计指标深度自洽 (4,744 RCT + 1,420 PSM)
    expect(html).toContain('5,640 例')
    expect(html).toContain('排除 896 例')
    expect(html).toContain('4,744 例')
    expect(html).toContain('达格列净组 2,373 例 vs 安慰剂组 2,371 例')
    expect(html).toContain('1,420 例')
    expect(html).toContain('达格列净组 710 例 vs GDMT 对照组 710 例')
    expect(html).toContain('SMD &lt; 0.05')
    expect(html).toContain('16.3%')
    expect(html).toContain('21.2%')
    expect(html).toContain('HR = 0.74')
    expect(html).toContain('0.65 - 0.85')
    expect(html).toContain('p &lt; 0.001')
    expect(html).toContain('NNT = 21')
    expect(html).toContain('Adjusted HR = 0.74')
    expect(html).toContain('伴低 SMI 肌少症表型')
    expect(html).toContain('9.12 临床科研全流程操作与规范对照矩阵表')

    // 每个步骤均包含横向指标徽章栏 (help-case-metrics)
    expect(html).toContain('help-case-metrics')

    // 包含量化基线表与预设亚组对照表
    expect(html).toContain('DAPA-HF 国际多中心试验基线特征与 1:1 PSM 队列实测对照表')
    expect(html).toContain('DAPA-HF 预设亚组多因素 Cox 回归与效应同质性对照表')

    // Markdown 导出完整性与解析一致性
    const md = buildHelpMarkdown()
    expect(md).toContain('## 九、 临床科研工作流 (Research)')
    expect(md).toContain('DAPA-HF')
    expect(md).toContain('NCT03036124')
    expect(md).toContain('4,744 例')
    expect(md).toContain('HR = 0.74')
    expect(md).toContain('NNT = 21')
    expect(md).toContain('/site/real-case-research-1-protocol-cohort.png')
    expect(md).toContain('/site/real-case-research-2-table1-baseline.png')
    expect(md).toContain('/site/real-case-research-3-km-survival.png')
    expect(md).toContain('/site/real-case-research-4-cox-forest.png')
    expect(md).toContain('/site/real-case-research-5-research-loop.png')
    expect(md).toContain('PICO 方案拟定与 CONSORT 入组筛选流向图')
    expect(md).toContain('Table 1 倾向评分匹配前后基线特征三线表与 SMD 平衡')
    expect(md).toContain('主要终点 MACE 24 个月 Kaplan-Meier 累积无事件生存分析')
    expect(md).toContain('多因素 Cox 比例风险回归与预设亚组分析森林图')
    expect(md).toContain('端到端科研证据闭环与 SCI 顶刊论文一键生成')
    expect(md).toContain('临床科研全流程操作与规范对照矩阵表')

    // 验证 Markdown 解析为文档块后节点结构有效
    const blocks = parseBlocks(md)
    expect(blocks.length).toBeGreaterThan(15)
    const docNode = schema.node('doc', null, blocks)
    expect(docNode.childCount).toBeGreaterThan(15)
  })

  it('10. 引用文献真伪校验与学术论断核验指南章节完整性验证', () => {
    const citeSec = HELP_SECTIONS.find(s => s.id === 'citations')
    expect(citeSec).toBeDefined()
    expect(citeSec?.title).toContain('引用文献真伪校验与学术论断核验')
    expect(citeSec?.badge).toContain('循证质控')
    expect(citeSec?.summary).toContain('权威官方 API 检索')
    expect(citeSec?.summary).toContain('PMC 开放获取全文与结构化表格')

    const html = citeSec!.contentHtml
    // 验证核心标题与导言
    expect(html).toContain('11. 引用文献真伪校验与学术论断核验 (Reference Verification & Claims Validation)')
    expect(html).toContain('杜绝大模型「虚构文献」')
    expect(html).toContain('解决「张冠李戴」断言脱节')
    expect(html).toContain('破除「摘要信息茧房」与盲区')

    // 验证五道防线技术落地
    expect(html).toContain('权威数据库实时检索校验')
    expect(html).toContain('NCBI E-utilities (PubMed)')
    expect(html).toContain('guardCitations')
    expect(html).toContain('[@c:citation_id]')
    expect(html).toContain('严禁注入任何未经注册登记的非法代币或裸文本假引用')

    expect(html).toContain('&lt;table-wrap&gt; 表格深度解析')
    expect(html).toContain('&lt;fig&gt; 图注与因果证据图解')
    expect(html).toContain('多级语义证据切片匹配')

    expect(html).toContain('支持 (Supported)')
    expect(html).toContain('不支持 (Unsupported)')
    expect(html).toContain('无法判断 (Unclear)')
    expect(html).toContain('缺少出处 (Missing Citation)')
    expect(html).toContain('临床经验豁免 (Exempted)')

    expect(html).toContain('【建议修改为】：')
    expect(html).toContain('一键替换正文')
    expect(html).toContain('标为临床经验')
    expect(html).toContain("status: 'exempted'")
    expect(html).toContain('雷达波脉冲扫描动效')

    // 验证 Markdown 手册生成
    const md = buildHelpMarkdown()
    expect(md).toContain('## 十一、 引用文献真伪校验与学术论断核验指南 (Reference Verification & Claims Validation)')
    expect(md).toContain('### 11.1 全链路真实文献登记与操作层写屏障 (`guardCitations`)')
    expect(md).toContain('### 11.2 PMC XML 开放获取全文与结构化表格提取 (RCT 表格与图注突破)')
    expect(md).toContain('### 11.3 细粒度命题级论断核查与五大判定状态 (`verify_claims`)')
    expect(md).toContain('### 11.4 AI 纠错修改建议与「一键替换正文」 (One-Click Quick Patch)')
    expect(md).toContain('### 11.5 专家「临床经验豁免」机制 (Clinical Experience Exemption)')
    expect(md).toContain('### 11.6 临床雷达扫描与批注卡片联动')
    expect(md).toContain('[@c:citation_id]')
    expect(md).toContain('<table-wrap>')
    expect(md).toContain('【建议修改为】：')
    expect(md).toContain('一键替换正文')
    expect(md).toContain('标为临床经验')
  })
})


