/**
 * Heurion 临床智能工作站 · 全流程产品使用手册与操作指南 (Product Help & Documentation)
 * 涵盖：
 * 1. 快速上手与界面导览
 * 2. 医学隐私与安全架构 (零 PHI、AES-256-GCM 隔离、高风险确认卡)
 * 3. 医学写作与文献溯源 (文档/幻灯片双模态、Word/PPTX/Markdown 无损双向导入导出、PubMed 智能引用、Python/Resvg 矢量图表)
 * 4. 患者管理与 3D 影像量化分析 (DICOM/NIfTI 上传、MONAI 3D 模型、MPR 三正交切片、双期 3D 刚性配准差分热力图、双联屏联动滑动、RECIST 1.1 与支扩 HAM/BAR 标准)
 * 5. 多模态因果诊断链与全景报告导出 (影像+化验+基因证据链、标准 DICOM SR 与 HL7 FHIR 导出)
 * 6. 临床科研工作流 (方案拟定、多源数据集质控、Table 1 基线表、Kaplan-Meier 生存曲线、Cox 回归)
 * 7. 科室协作、知家家庭空间 (PHR) 与安全分享
 * 8. 快捷键与常见问题解答 (FAQ)
 */

import { icon } from './icons.ts'

type ApiFn = <T = any>(path: string, opts?: RequestInit) => Promise<T>

export interface HelpSection {
  id: string
  title: string
  badge: string
  icon: string
  summary: string
  contentHtml: string
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'overview',
    title: '快速上手与界面导览',
    badge: '入门基础',
    icon: icon('globe', { size: 16 }),
    summary: '了解 Heurion 工作站的三栏交互架构、三大核心工作空间切换及基础业务闭环。',
    contentHtml: `
      <div class="help-section-head">
        <h3>1. 快速上手与界面导览</h3>
        <span class="help-tag">系统架构 · 交互布局</span>
      </div>
      <p class="help-lead">Heurion 专为临床医生、影像科专家及医学科研人员打造，融合现代化极简墨绿极客美学与严苛的循证医学严谨性。</p>
      
      <h4>1.1 经典三栏自适应界面</h4>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('folder', { size: 20 })}</div>
          <div class="hfc-title">左侧导航 Rail & 资源栏</div>
          <div class="hfc-desc">管理三大核心空间切换、文档树、资料库（PDF/指南上传向量化）、回收站及用户中心配置。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('file', { size: 20 })}</div>
          <div class="hfc-title">中间主工作画布 (Center)</div>
          <div class="hfc-desc">富文本无损编辑器、医学学术幻灯片排版器、患者 3D MPR 影像切片浏览器及科研数据集透视表。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('sparkles', { size: 20 })}</div>
          <div class="hfc-title">右侧伴随智能栏 (Side AI)</div>
          <div class="hfc-desc">伴随式 AI 对话、红绿 Diff 修订逐条采纳、学术论文审查建议、PubMed 文献溯源与历史版本回滚。</div>
        </div>
      </div>

      <h4>1.2 三大核心业务空间</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('scan', { size: 14 })}</span>
          <div>
            <b>患者空间 (Patients Space · 临床第一线 · 默认落地)</b>：严格遵循「零 PHI」安全准则与纯虚拟代号建档。上传 DICOM / NIfTI 3D 影像，调用 MONAI 深度学习网络量化病灶，利用三正交 MPR 浏览器、双期非刚性弹性配准与差分吸收热力图展开精准诊疗。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('chart', { size: 14 })}</span>
          <div>
            <b>临床研究空间 (Research Space)</b>：从临床试验方案立项、纳入排除标准筛选，到上传 SAS/SPSS/Excel 多中心数据表，一键自动生成 Table 1 基线表、Kaplan-Meier 生存曲线、Cox 风险比森林图及 IBSI 影像组学预后分析。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('write', { size: 14 })}</span>
          <div>
            <b>写作空间 (Writing Space)</b>：支持起草临床指南、基金标书、SCI 论文、学术汇报幻灯片 (Deck) 及病历讨论。深度整合 PubMed 全球医学文献检索与 Python 矢量医学图表生成。
          </div>
        </li>
      </ul>

      <h4>1.3 极简医学发丝图标系统 (1.5px Hairline SVG)</h4>
      <p>全平台抛弃杂乱花哨的表情符号 (Emoji)，采用统一 1.5px 极简发丝级医学科技矢量 SVG 图标，与墨绿临床界面深度契合，带来专业沉浸的医生工作台体验。</p>

      <div class="help-callout tip">
        <span class="callout-icon">${icon('info', { size: 16 })}</span>
        <div class="callout-body">
          <b>快捷键小贴士：</b>
          随时使用 <code>⌘B</code> (粗体)、<code>⌘I</code> (斜体)、<code>⌘U</code> (下划线)、<code>⌘Z</code> (撤销)、<code>⌘⇧Z</code> (重做)。在 AI 对话框中，按 <code>⌘↩</code> 可快速提交推理指令。
        </div>
      </div>
    `
  },
  {
    id: 'privacy',
    title: '医学隐私与安全架构 (零 PHI)',
    badge: '安全合规',
    icon: icon('shield', { size: 16 }),
    summary: '了解零 PHI 准则、AES-256-GCM 租户数据密钥隔离、高风险操作二次确认卡与敏感操作审计机制。',
    contentHtml: `
      <div class="help-section-head">
        <h3>2. 医学隐私与安全架构 (Zero-PHI & Compliance)</h3>
        <span class="help-tag danger">核心准则 · 严禁违规</span>
      </div>
      <p class="help-lead">医疗数据的隐私与安全是 Heurion 的立身之本。系统严格按照 HIPAA、GDPR 及国家卫生健康数据合规标准设计架构。</p>

      <h4>2.1 强制零 PHI (Zero Protected Health Information) 准则</h4>
      <p>为了从根本上规避患者真实隐私外泄风险，Heurion 采用<b>「全流程纯代号化」</b>建档与分析机制：</p>
      <div class="help-alert-box alert-important">
        <b>${icon('shield', { size: 14 })} 严格禁止输入任何真实患者个人敏感信息：</b>
        <ul>
          <li>禁止在患者档案、主诉、病史文本或对话框中输入真实患者姓名、身份证号、医保卡号、门诊住院号或电话号码。</li>
          <li>请统一使用虚拟研究代号建档，例如：<code>PT-BRONCHO-001</code>、<code>SUBJ-PROSTATE-2026-A</code>。</li>
          <li>上传的 DICOM 影像文件若包含原始私有 Tag，系统在入库前将自动进行脱敏擦除 (De-identification)。</li>
        </ul>
      </div>

      <h4>2.2 租户级数据密钥加密隔离</h4>
      <p>每个医院或科研机构拥有独立的 AES-256-GCM 数据加密密钥 (DEK)。即使在底层数据库物理层面，不同租户之间的数据亦完全隔离，杜绝跨机构横向越权。</p>

      <h4>2.3 高风险操作确认卡 (Human-in-the-Loop)</h4>
      <p>AI 在系统中具备高阶辅助分析能力，但<b>绝不具备最终裁决权</b>。当 AI 提议执行不可恢复或高敏感操作时（如：删除患者随访数据、覆盖既往病历、下发正式诊断报告），系统会自动弹窗生成<b>「待确认操作卡」</b>，必须由执业医师主动点击确认后方才执行。</p>

      <h4>2.4 访问审计留痕 (Audit Trail)</h4>
      <p>所有对患者病历、3D 影像切片及临床科研数据集的查阅、下载与导出行为，均自动记录包含操作医师 ID、时间戳、操作模态及脱敏患者代号的不可篡改审计日志。</p>
    `
  },
  {
    id: 'writing',
    title: '医学写作与文献溯源',
    badge: '创作引擎',
    icon: icon('write', { size: 16 }),
    summary: '文档与学术汇报幻灯片双模态编辑、Word/PPTX/Markdown 无损双向导入导出、PubMed 智能引用及 Resvg 矢量图表。',
    contentHtml: `
      <div class="help-section-head">
        <h3>3. 医学写作与文献溯源 (Medical Writing & Evidence Tracing)</h3>
        <span class="help-tag">写作 · 幻灯片 · 文献</span>
      </div>
      <p class="help-lead">支持文档 (Docs) 与幻灯片 (Slides) 双模态自由创作，专为学术发表与科室汇报量身打造。</p>

      <h4>3.1 双模态创作中心</h4>
      <table class="help-table">
        <thead>
          <tr>
            <th>功能维度</th>
            <th>文档写作 (Doc)</th>
            <th>学术汇报幻灯片 (Deck)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>适用场景</b></td>
            <td>SCI 论文、病例报告、临床指南解读、基金标书</td>
            <td>学术年会汇报、病历讨论读片会、科研文献解读</td>
          </tr>
          <tr>
            <td><b>编辑特性</b></td>
            <td>块级富文本、分级标题、公式、表格、PubMed 自动引用</td>
            <td>医学专业主题模板、网格等距排列、图文自适应对齐</td>
          </tr>
          <tr>
            <td><b>格式导出</b></td>
            <td>Word (.docx)、Markdown (.md)</td>
            <td>PowerPoint (.pptx)、全量高清渲染图片</td>
          </tr>
          <tr>
            <td><b>无损导入</b></td>
            <td>直接导入本地 .docx，保留标题层级与原样样式</td>
            <td>直接导入本地 .pptx，保留版式排版与图形占位</td>
          </tr>
        </tbody>
      </table>

      <h4>3.2 AI 伴随修订模式 (Suggest / Diff Mode)</h4>
      <p>在右侧对话框上方，常驻<b>「修订模式 · 生成 Diff 待采纳」</b>开关：</p>
      <ul>
        <li><b>开启修订模式（推荐）</b>：AI 针对正文的润色、新增证据、语法精炼会作为红绿 Diff 标记渲染在画布上。您可以点击单处修订单独采纳/拒绝，亦可点击「全部采纳」。</li>
        <li><b>关闭修订模式</b>：AI 将直接修改正文，适用于快速重构大纲或从零起草全新段落。</li>
      </ul>

      <h4>3.3 PubMed 智能文献检索与参考资料库</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>实时插入规范引用</b>：点击工具栏「引用」按钮，输入 DOI (如 <code>10.1056/NEJMoa2307563</code>) 或 PMID，系统自动抓取文章元数据（作者、期刊、发表年、卷期页码），自动编排 [1], [2] 标注并在文末生成参考文献列表。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>参考资料库 (Library / RAG)</b>：在左侧 Rail 点击「资料库」，可拖入本地 PDF 指南或文献。系统自动抽取文字与切块向量化。在对话时勾选「＋ 引用资料」，AI 将基于指南原文精准作答并标注出处页码。
          </div>
        </li>
      </ul>

      <h4>3.4 高清矢量图表生成与无损导出保护</h4>
      <p>AI 可根据临床数据通过 Python 自动绘制森林图、生存曲线、箱线图并嵌入正文。系统采用 Resvg 高性能矢量渲染引擎与 DrawingML 双模嵌入技术，导出 Word 或 PowerPoint 时图表绝对清晰锐利、绝不丢图。</p>
    `
  },
  {
    id: 'imaging',
    title: '患者管理与 3D 影像量化分析',
    badge: '临床核心',
    icon: icon('scan', { size: 16 }),
    summary: '零 PHI 虚拟代号建档、多期化验时间序列追踪、DICOM/NIfTI 空间解析、MONAI 3D 深度模型矩阵（胸部支扩/粘液栓/肺结节、前列腺 mpMRI、腹部 13 器官、脑部 MRI）及交互式 MPR 三正交切片浏览器。',
    contentHtml: `
      <div class="help-section-head">
        <h3>4. 患者管理与 3D 影像量化分析 (Patient Management & 3D Imaging Quantification)</h3>
        <span class="help-tag ok">零 PHI · MONAI 3D · MPR 交互</span>
      </div>
      <p class="help-lead">深度打通「临床患者全景档案」与「3D 体素级影像量化分析」，既保障医疗隐私绝对安全，又赋予医生亚毫米级的定量诊断与智能读片能力。</p>

      <h4>4.0 影像智能分析全流程业务闭环 (The Complete 9-Step Imaging Pipeline)</h4>
      <p>Heurion 影像系统严格遵循现代循证放射学与多学科临床诊疗路径，打通从原始图像摄入到治疗评估与科研输出的九大完整业务阶段：</p>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">① 影像摄入与合规脱敏</div>
          <div class="hfc-desc">支持 DICOM 序列/NIfTI 体数据上传，自动剥离 18 项 HIPAA 敏感标识；支持对话直接粘贴/上传单张超声、CT、胸片截图进行 AI 视觉解读。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">② 空间几何与重采样</div>
          <div class="hfc-desc">统一重采样至 1×1×1 mm³ 各向同性空间体素；自适应匹配肺窗、纵隔窗、腹部窗、骨窗及脑窗。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">③ MONAI 3D 深度模型矩阵</div>
          <div class="hfc-desc">内置 18+ 款分科预训练 3D 深度神经网络，涵盖支扩 BAR/HAM、肺结节、腹部 13 器官、前列腺 mpMRI 与脑胶质瘤。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">④ IBSI 影像组学高维提取</div>
          <div class="hfc-desc">遵循 IBSI 国际标准，从病灶 ROI 提取 107 项高维生物特征（形态学、一阶统计、GLCM、GLRLM、GLSZM、NGTDM）。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑤ MPR 三正交交互式切片</div>
          <div class="hfc-desc">Axial/Coronal/Sagittal 自由十字丝联动；5cm 物理标尺，病灶质心准星一键定位与关键切片资产存证。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑥ 纵向随访与差分热力图</div>
          <div class="hfc-desc">3D 刚性/非刚性弹性形变配准 (DIR)，生成差分吸收热力图（绿色吸收好转、红色进展恶化），双联屏联动滑动比对。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑦ PET-CT 代谢融合</div>
          <div class="hfc-desc">自动换算 SUV 标准摄取值，标定病灶 SUVmax、SUVmean、代谢肿瘤体积 (MTV) 与总糖酵解量 (TLG)。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑧ 放疗靶区 RT-STRUCT</div>
          <div class="hfc-desc">一键将 3D 分割轮廓转化为符合国际放疗物理标准的 DICOM RT-STRUCT 靶区轮廓（GTV/CTV/OAR）。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑨ 因果链与结构化导出</div>
          <div class="hfc-desc">整合影像+化验+基因证据链；支持一键导出 DICOM SR、HL7 FHIR 资源包及多学科会诊 (MDT) 幻灯片。</div>
        </div>
      </div>

      <h4>4.1 患者全流程档案建立与零 PHI 隐私规范 (Zero-PHI Patient Registry)</h4>
      <p>为满足 HIPAA、GDPR 及医疗机构核心数据合规要求，平台推行严格的<b>零真实个人标识 (Zero-PHI)</b> 体系：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>纯虚拟代号建档 (Research Code)</b>：患者入组统一采用去标识化的代号（如 <code>PT-BRONCHO-001</code>、<code>SUBJ-2026-08</code>）。系统同时支持记录性别、出生年份（自动推算当前实足年龄）及疾病标签（如 <code>哮喘</code>、<code>支气管扩张</code>、<code>ABPA</code>、<code>肺结节</code>、<code>前列腺癌</code>、<code>靶向治疗中</code>），支持标签一键过滤。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>本机浏览器备注名物理隔离 (Local Private Names)</b>：
            医生如需在本地辨识患者姓名，可直接在患者代号旁添加备注名。<b>该备注名仅加密保存在当前电脑浏览器的 <code>localStorage</code> 中</b>，绝不上云、绝不向服务器传输、绝不在数据库中落库，彻底消除云端患者姓名泄露的法律风险。
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <b>多维档案工作区 (Workspaces)</b>：
            <ul>
              <li><b>概览 (Overview)</b>：汇总患者简要病史、关键体征、关联科研课题 (Studies & Subject ID) 以及关联的查房报告与病历文档；</li>
              <li><b>化验 (Labs)</b>：管理时间序列多期检验数据，支持纵向演变趋势可视化；</li>
              <li><b>报告原件与影像 (Records)</b>：归档出院小结、病理报告、生化检验单原件及 DICOM/NIfTI 影像计算档案；</li>
              <li><b>待确认操作 (Review / Human-in-the-Loop)</b>：AI 从原件中抽取的指标或提议的病历修改，需在此处由医生点击「采纳」或「驳回」。</li>
            </ul>
          </div>
        </li>
        <li>
          <span class="step-num">4</span>
          <div>
            <b>医疗协作与权限机制</b>：支持设定主管医师 (Owner) 与参与医生 (Member) 权限；提供针对危急值抢救情境的<b>「紧急破窗访问 (Break-Glass Access)」</b>全流程审计；支持生成受控<b>「安全分享码 (Share Code)」</b>向科室同事或家庭只读共享化验与报告。
          </div>
        </li>
      </ul>

      <h4>4.2 多模态实验室检验指标追踪与时间序列管理 (Longitudinal Lab Analytics)</h4>
      <p>化验单不仅是静态记录，更是临床评估病情演进的重要证据链：</p>
      <div class="help-grid-2">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('chart', { size: 14 })} 核心检验指标全覆盖</div>
          <div class="hfc-desc">
            <ul>
              <li><b>变态反应与呼吸</b>：外周血嗜酸性粒细胞绝对值 (Eos #) 与百分比 (Eos %)、血清总 IgE、烟曲霉特异性 sIgE；</li>
              <li><b>肿瘤标志物</b>：CEA、CYFRA21-1、NSE、PSA、游离 PSA (fPSA)；</li>
              <li><b>感染与炎症生化</b>：CRP、降钙素原 (PCT)、肝肾功能、血气分析等。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('refresh', { size: 14 })} 跨机构单位自动换算与原件追溯</div>
          <div class="hfc-desc">
            <ul>
              <li><b>国际标准单位归一化</b>：不同仪器与机构的化验单位（如 10⁹/L 与 /μL、IU/mL 与 kU/L）自动换算为统一标准单位，悬停可追溯原测值，确保数年随访趋势严密可比；</li>
              <li><b>原件精准溯源 (Traceability)</b>：点击化验项可一键跳转并高亮检验单 PDF 原件的对应页码与测量区域。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>4.3 3D 原始影像支持与空间几何解析 (3D Volumetric Imaging & Geometry)</h4>
      <p>平台采用原生的三维体数据解析管线，支持高分辨率医学影像的端到端量化：</p>
      <table class="help-table">
        <thead>
          <tr>
            <th>特性维度</th>
            <th>技术规格与临床规范</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>格式支持</b></td>
            <td>
              1. <b>DICOM 序列压缩包 (<code>.zip</code> / <code>.tar.gz</code>)</b>：流式递归解压、自动校验并排序数百张连续轴位切片；<br>
              2. <b>单张 DICOM (<code>.dcm</code>)</b>；<br>
              3. <b>科研标准三维 NIfTI 卷 (<code>.nii</code> / <code>.nii.gz</code>)</b>。
            </td>
          </tr>
          <tr>
            <td><b>空间几何提取</b></td>
            <td>自动解析体素空间物理间距 (Voxel Spacing 如 0.75×0.75×1.25 mm)、体素空间矩阵维度 (Dimensions 如 512×512×280) 与解剖方位坐标系 (LPS / RAS)。</td>
          </tr>
          <tr>
            <td><b>影像模态覆盖</b></td>
            <td>
              1. <b>CT / HRCT</b>：高分辨率薄层 CT 平扫与增强扫描，支持肺小结节、支扩气道树、冠脉钙化积分及全腹器官分割；<br>
              2. <b>MRI / mpMRI</b>：头颅 T1/T2/FLAIR/DWI 神经序列、前列腺多参数磁共振 (T2+ADC+DWI)；<br>
              3. <b>超声与便携声像 (Ultrasound)</b>：支持通过对话上传或报告归档导入腹部、心脏、甲状腺与浅表超声切片，AI 结合临床既往史进行声像学特征判读；<br>
              4. <b>X 线胸片 (DR/CR)</b>：正侧位胸片病灶筛查；<br>
              5. <b>PET-CT</b>：跨模态解剖与代谢融合成像，病灶 SUV 测定。
            </td>
          </tr>
          <tr>
            <td><b>敏感 Tag 脱敏</b></td>
            <td>影像入库前，后台自动清洗并抹除患者姓名、住院号、机构名、技师代号等私有 DICOM Tag，确保医学科研合规安全。</td>
          </tr>
        </tbody>
      </table>

      <h4>4.4 MONAI 3D 临床深度学习病种量化全矩阵 (MONAI Model Zoo Matrix)</h4>
      <p>系统内置基于 MONAI 的 <b>18+ 款分科预训练临床 3D 深度模型</b>，覆盖人体 5 大核心系统，满足多学科综合读片与专科科研需要：</p>
      <div class="help-grid-2">
        <div class="help-feature-card">
          <div class="hfc-title">1. 胸部与呼吸科 · 支气管扩张、粘液栓与气道树</div>
          <div class="hfc-desc">
            <ul>
              <li><b>支气管-伴行动脉比 (BAR)</b>：亚毫米级精确测量支气管内径与伴行动脉直径（正常 &lt; 1.0；≥ 1.0 提示典型印戒征支扩）；</li>
              <li><b>高密度粘液栓 (HAM / 指套征)</b>：基于 3D 连通域自动分割全部粘液栓簇，输出平均 CT 测值 (HU)、最大极值 HU 及 3D 总体积 (cm³)，自动与胸壁肌肉 (40~50 HU) 对比判定 HAM 标准；</li>
              <li><b>气道壁增厚率 (T/D Ratio)</b> 与全气道树三维拓扑骨架 (AirwayUNet)；</li>
              <li><b>肺结节与解剖肺叶 (SegResNet / V-Net)</b>：实性/磨玻璃结节 3D 体结与长短径，5 大解剖肺叶容积与占比。</li>
            </ul>
          </div>
        </div>

        <div class="help-feature-card">
          <div class="hfc-title">2. 腹部、消化与泌尿 · 脏器与肿瘤占位</div>
          <div class="hfc-desc">
            <ul>
              <li><b>前列腺 mpMRI (Pelvic MRI)</b>：T2WI + ADC + DWI 序列对齐，外周带 (PZ) 与移行带 (TZ) 体积分割，可疑占位 3D 径线、ADC 极小值与 PI-RADS v2.1 分级；</li>
              <li><b>全腹部 13 器官多任务分割 (MONAI SwinUNETR)</b>：全自动解剖分割肝、脾、双肾、胰腺、胆囊、胃、主动脉等；</li>
              <li><b>肝癌与胰腺肿瘤分割</b>：肝实质与 HCC/转移瘤靶病灶量化，胰腺导管腺癌与囊性占位体积分析；</li>
              <li><b>肾脏与肾肿瘤/囊肿分割 (KiTS)</b> 与脾肿大定量 (3D SegResNet)。</li>
            </ul>
          </div>
        </div>

        <div class="help-feature-card">
          <div class="hfc-title">3. 颅脑与神经系统 · 脑病变与急诊出血</div>
          <div class="hfc-desc">
            <ul>
              <li><b>脑胶质瘤多模态分割 (MONAI BraTS DynUNet)</b>：强化肿瘤 (ET)、瘤周水肿 (ED) 与坏死核心 (NCR) 三维体积测量；</li>
              <li><b>海马体与皮质下深部核团萎缩量化 (FastSurfer-like)</b>：阿尔茨海默病与认知功能障碍量化；</li>
              <li><b>急性脑梗死测定 (DWI/FLAIR UNet)</b>：缺血半暗带与核心梗死容积精准评估；</li>
              <li><b>急诊颅内出血检出 (MONAI DenseNet)</b>：硬膜外、硬膜下、脑实质内及蛛网膜下腔出血检出与血肿容积量化。</li>
            </ul>
          </div>
        </div>

        <div class="help-feature-card">
          <div class="hfc-title">4. 心血管系统 · 冠脉钙化与心功能评估</div>
          <div class="hfc-desc">
            <ul>
              <li><b>冠状动脉钙化积分 (CAC / Agatston 评分) [Cardiac CT]</b>：自动检出左前降支 (LAD)、回旋支 (LCX) 与右冠状动脉 (RCA) 钙化斑块，计算总 Agatston 评分评估冠心病风险分层；</li>
              <li><b>心脏 CINE MRI 心室分割与射血分数 (LVEF)</b>：多时相动态追踪左心室舒张末/收缩末容积 (EDV/ESV)、心肌质量与射血分数。</li>
            </ul>
          </div>
        </div>

        <div class="help-feature-card">
          <div class="hfc-title">5. 骨科与全身体素 · 大规模解剖分割与脊柱</div>
          <div class="hfc-desc">
            <ul>
              <li><b>全身体素 104 类解剖结构分割 (TotalSegmentator) [Whole-Body CT]</b>：全身体素骨骼、主要内脏系统与大肌群一键全自动语义分割，适用于大样本流行病学与机体成分分析；</li>
              <li><b>全脊柱 24 节椎骨与椎间盘分割 (Spine-Segmenter) [Spine CT]</b>：颈椎、胸椎、腰椎各节椎体骨折压缩与椎间隙高度三维精准测量。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>4.5 诊断级交互式 MPR 三正交切片浏览器 (Multi-Planar Reconstruction)</h4>
      <p>点击任何已完成分析的影像记录，即可打开全功能交互式 MPR 诊断工作台：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>双引擎极速渲染</b>：
            <ul>
              <li><b>2D 正交切片引擎</b>：轻量极速，内置 5cm 毫米级解剖标尺与 HUD 参数抬头显示；</li>
              <li><b>NiiVue 3D WebGL2 引擎</b>：GPU 硬件加速，支持 3D 空间立体旋转体绘制 (Volume Rendering) 与横断面+冠状面+矢状面+3D模型四视图联动。</li>
            </ul>
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>三正交解剖平面自由切换</b>：
            <b>横断面 (Axial)</b>、<b>冠状面 (Coronal)</b>、<b>矢状面 (Sagittal)</b> 自由切换，切片滑块、鼠标滚轮上下滑动或键盘 ↑/↓/←/→ 连贯逐层浏览。
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <b>全模态临床标准窗宽窗位 (WW/WL) 一键调窗</b>：
            预设肺窗 (-600 / 1500 HU)、纵隔窗 (40 / 400 HU)、腹部窗 (50 / 350 HU)、骨窗 (300 / 1500 HU) 及脑窗 (40 / 80 HU)，并支持鼠标拖拽无级微调。
          </div>
        </li>
        <li>
          <span class="step-num">4</span>
          <div>
            <b>三维准星与智能病灶导航</b>：
            点击<b>「${icon('target', { size: 13 })} 定位病灶中心」</b>按钮，系统自动依据 3D 卷积分割范围质心瞬时跳转到病灶最大截面层；抬头显示<b>「病灶探测标签 (Lesion Badge)」</b>，实时提示当前切片是否有病灶受累。
          </div>
        </li>
        <li>
          <span class="step-num">5</span>
          <div>
            <b>关键截面存证截图与文档资产沉淀 (Key Slice Snapshot)</b>：
            点击<b>「${icon('save', { size: 13 })} 保存切片为文档资产」</b>，当前层位影像及窗宽窗位、物理标尺等参数自动转存为平台永久图像资产，并生成 Markdown 引用代码，可直接插入医学论文或汇报幻灯片；点击<b>「${icon('report', { size: 13 })} 一键生成放射诊断报告」</b>更可自动汇总参数出具规范影像报告草案。
          </div>
        </li>
      </ul>

      <h4>4.6 全身体素机体成分与肌少症量化 (Body Composition & Sarcopenia)</h4>
      <p>基于 TotalSegmentator 3D 全身体素网络，系统提供肿瘤恶液质与衰弱综合征的量化筛查方案：</p>
      <ul>
        <li><b>L3 骨骼肌指数 (SMI, cm²/m²)</b>：自动定位 L3 椎体中位截面，分割腰大肌、竖脊肌及腹壁肌群面积，结合患者身高计算 SMI；依据 Prado 国际共识（男性 &lt; 52.4 cm²/m²，女性 &lt; 38.5 cm²/m²）自动进行肌少症红黄预警。</li>
        <li><b>内脏脂肪与皮下脂肪比 (VAT / SAT)</b>：精准测算腹腔内脏脂肪面积与皮下脂肪面积，评估代谢综合征及放化疗毒副反应风险。</li>
      </ul>

      <h4>4.7 IBSI 国际标准影像组学高阶特征矩阵 (Radiomics Extraction)</h4>
      <p>遵循 IBSI (Image Biomarker Standardisation Initiative) 国际影像组学标准规范，一键提取 107 项高维生物特征：</p>
      <ul>
        <li>一阶灰度统计 (First Order Statistics)、形状球形度与表面积体积比 (Shape & Compactness)；</li>
        <li>灰度共生矩阵 (GLCM)、灰度游程矩阵 (GLRLM)、灰度区域大小矩阵 (GLSZM) 及邻域灰度差矩阵 (NGTDM)；</li>
        <li>支持小波滤波变换 (Wavelet Decomposition)，所有高维组学数据均可一键载入科研数据集开展机器学习建模。</li>
      </ul>

      <h4>4.8 三甲标准四段式全景影像诊断报告</h4>
      <p>在影像卡片上点击<b>「${icon('report', { size: 13 })} 全景诊断报告」</b>，自动汇聚检查方法与序列信息、3D MONAI 定量测量参数、多模态化验因果链、鉴别诊断与随访处置建议，支持一键保存为正式病历或打印导出。</p>
    `
  },
  {
    id: 'registration',
    title: '双期 3D 刚性配准、差分热力图与随访评估',
    badge: '临床演进',
    icon: icon('compare', { size: 16 }),
    summary: '基线与随访 CT 空间自动刚性/非刚性弹性形变配准、差分吸收热力图、双联屏联动滑动、PET-CT 融合及放疗靶区勾画 (RT-STRUCT)。',
    contentHtml: `
      <div class="help-section-head">
        <h3>5. 双期 3D 刚性配准与差分吸收热力图 (Registration, Fusion & RT-STRUCT)</h3>
        <span class="help-tag">随访对比 · 空间对齐 · 放疗规划</span>
      </div>
      <p class="help-lead">针对多期随访患者，彻底告别“单张切片肉眼目测对比”，实现基于 3D 体素空间刚性与非刚性弹性配准的动态演变量化，并支持 PET-CT 多模态融合与放疗靶区勾画。</p>

      <h4>5.1 双期 3D 体素刚性与非刚性弹性配准及差分吸收热力图 (Difference Heatmap Overlay)</h4>
      <p>当同一患者拥有基线期 (Baseline) 与随访期 (Follow-up) 两套 CT 扫描时：</p>
      <ul>
        <li><b>刚性与仿射对齐</b>：调用 MONAI 刚性/仿射配准网络，将随访 CT 空间平移旋转对齐至基线坐标系。</li>
        <li><b>3D 非刚性弹性形变配准 (Deformable B-spline / Diffeomorphic Registration)</b>：自动拟合呼吸运动引起的肺野扩张不均与胸腔体位形变，输出高精度形变向量场 (DVF)。</li>
        <li><b>差分吸收热力图 (Difference Heatmap)</b>：在配准后的 3D 体素空间中计算 HU 衰减差分矩阵并在切片器上叠加渲染：
          <ul>
            <li><span style="color:#00ff93; font-weight:600;">● 绿色区域</span>：表示炎性浸润吸收、粘液栓缩小退缩或肿瘤缩小区域（好转缓解）。</li>
            <li><span style="color:#ff6b6b; font-weight:600;">● 红色区域</span>：表示新发浸润、病灶体积扩大或密度增高区域（进展恶化）。</li>
          </ul>
        </li>
      </ul>

      <h4>5.2 双联屏联动切片滑动 (Synchronized Dual-Scrubber MPR)</h4>
      <p>在随访对比弹窗中，嵌入左右并排的双 MPR 播放器：</p>
      <ul>
        <li>开启<b>「联动滚动 (Cursor Lock)」</b>后，滚轮在左侧基线切片滑动到相应解剖层面时，右侧随访根据对齐比例自动同步滚到对应层面，方便医生一目了然对比同解剖位点变化。</li>
      </ul>

      <h4>5.3 PET-CT 与多模态融合成像 (PET-CT & Multimodal Fusion)</h4>
      <p>支持将解剖结构与代谢功能多模态影像融合同屏显示：</p>
      <ul>
        <li><b>解剖与代谢空间重采样</b>：将 128×128 代谢 PET (SUV) 空间网格重采样至 512×512 结构 CT (HU) 网格；</li>
        <li><b>交互式融合透明度</b>：提供 Alpha 透明度调节滑块 (0.0~1.0)，支持彩虹/热铁伪彩代谢图层无缝叠加于灰阶解剖 CT 之上；</li>
        <li><b>SUV 恶性高摄取预警</b>：设定 SUVmax 阈值（默认 ≥ 2.5 提示高代谢恶性病灶），协助精准识别肿瘤活性边界。</li>
      </ul>

      <h4>5.4 放疗靶区勾画与导出 (Radiation Target Delineation & DICOM RT-STRUCT)</h4>
      <p>基于 MONAI 3D 卷积网络的肿瘤靶区与解剖危及器官分割结果：</p>
      <ul>
        <li><b>三维多边形网格提取</b>：采用 Marching Cubes 算法自动提取肿瘤大体靶区 (GTV)、临床靶区 (CTV)、计划靶区 (PTV) 及危及器官 (OAR: 脊髓、双肺、心脏、食管) 的闭合边界多边形；</li>
        <li><b>标准 DICOM RT-STRUCT (PS 3.3) 导出</b>：导出符合国际放疗标准的结构文件，可直接一键导入瓦里安 Eclipse、医科达 Monaco 等主流放疗计划系统 (TPS) 或三维手术规划系统。</li>
      </ul>

      <h4>5.5 严格解耦的疗效评估准则 (RECIST 1.1 vs 良性炎性病灶)</h4>
      <div class="help-callout important">
        <span class="callout-icon">${icon('shield', { size: 16 })}</span>
        <div class="callout-body">
          <b>严守医学评估标准边界：</b>
          <ul>
            <li><b>实体瘤 (Solid Tumors)</b>：严格遵循 <b>RECIST 1.1</b> 标准，依据可测量靶病灶的长径之和变化率判定（PR: 缩小 ≥ 30%；PD: 增大 ≥ 20%；SD: 变化介于 -30% 至 +20% 之间）。</li>
            <li><b>良性气道炎症 / 支扩粘液栓</b>：RECIST 1.1 并不适用于非实体瘤。系统针对粘液栓采用国际公认的 <b>3D 容积吸收评估 (Volumetric Absorption)</b>，以总体积缩小 ≥ 50% 判定为「显著吸收改善」，彻底杜绝标准错置与逻辑矛盾。</li>
          </ul>
        </div>
      </div>
    `
  },
  {
    id: 'diagnostics',
    title: '多模态因果诊断链与标准报告导出',
    badge: '临床决策',
    icon: icon('evidence', { size: 16 }),
    summary: '影像+化验+基因证据链自动拼装、全景病例报告生成、标准 DICOM SR 及 HL7 FHIR 格式导出对接院内 PACS。',
    contentHtml: `
      <div class="help-section-head">
        <h3>6. 多模态因果诊断链与标准报告导出 (Multimodal Evidence & Export)</h3>
        <span class="help-tag">诊断报告 · 互联互通</span>
      </div>
      <p class="help-lead">打破“影像归影像、化验归化验”的数据孤岛，自动聚合多模态临床证据链，支持国际标准医学数据交换。</p>

      <h4>6.1 多模态因果诊断链条 (Multimodal Clinical Evidence Chain)</h4>
      <p>当系统检测到患者的影像学阳性体征时，自动触发跨模态规则引擎，聚合多维度证据：</p>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">典型范式：变应性支气管肺曲霉病 (ABPA) 证据链拼装</div>
        <div class="hfc-desc">
          <table class="help-table">
            <tr>
              <td><b>影像学证据</b></td>
              <td>支扩印戒征 (BAR = 1.45 &gt; 1.0) 伴中央型高密度粘液栓 (HAM = 120 HU &gt; 伴行动脉)。</td>
            </tr>
            <tr>
              <td><b>实验室指标</b></td>
              <td>外周血嗜酸性粒细胞绝对值增高 (0.82 × 10⁹/L)、血清总 IgE 显著升高 (&gt; 1000 IU/mL)。</td>
            </tr>
            <tr>
              <td><b>免疫特异性</b></td>
              <td>烟曲霉特异性 IgE (sIgE) 阳性。</td>
            </tr>
            <tr>
              <td><b>诊断结论</b></td>
              <td>符合 Rosenberg-Patterson 诊断标准，自动输出置信度高度支持 ABPA 的诊断提示。</td>
            </tr>
          </table>
        </div>
      </div>

      <h4>6.2 全景病例诊断报告与图谱</h4>
      <p>在患者影像分析页面点击「生成完整病例报告」，系统将自动合成包含：患者脱敏信息、检查方法规范、定量征象测量、MPR 截面截图、随访体积演变曲线及专家建议的综合报告。</p>

      <h4>6.3 医疗行业标准格式导出</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('hospital', { size: 14 })}</span>
          <div>
            <b>DICOM SR (Structured Reporting)</b>：遵循 DICOM SOP Class <code>1.2.840.10008.5.1.4.1.1.88.22</code>，测量数值与病灶坐标以结构化编码存入 DICOM 文件，可直接上传导入医院 PACS。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('globe', { size: 14 })}</span>
          <div>
            <b>HL7 FHIR (DiagnosticReport & ImagingStudy)</b>：导出符合 HL7 FHIR R4 标准的 JSON 资源包，支持直接对接区域卫生信息平台与电子病历系统 (EMR)。
          </div>
        </li>
      </ul>
    `
  },
  {
    id: 'casestudy',
    title: '【实战图解】真实患者 3D 影像全流程诊疗范例',
    badge: '实战案例',
    icon: icon('sparkles', { size: 16 }),
    summary: '以真实确诊的支扩伴高密度粘液栓 (ABPA) 患者 PT-BRONCHO-001 为例，图文详解 HRCT 深度量化、三正交切片浏览、双期配准差分热力图、L3 机体成分及多模态因果诊断链全流程。',
    contentHtml: `
      <div class="help-section-head">
        <h3>7. 真实病例深度实战图解 (Real-World Case Study)</h3>
        <span class="help-tag ok">真实病例 · 诊断级图解 · 证据闭环</span>
      </div>
      <p class="help-lead">医学影像功能的复杂性在于“从 3D 几何体素到临床决策的全链路因果串联”。本节以真实确诊的变应性支气管肺曲霉病 (ABPA) 患者 <code>PT-BRONCHO-001</code> 为完整范例，手把手图解单期深度量化、三正交切片交互、多期配准差分热力图、全身体素肌少症预后及多模态因果诊断链的全部实战操作。</p>

      <h4>7.1 患者基本资料与临床主诉 (Clinical Profile)</h4>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">患者脱敏档案 · PT-BRONCHO-001</div>
        <div class="hfc-desc">
          <ul>
            <li><b>基本信息</b>：52岁男性，教师。严格遵循零 PHI 规范建档（真实姓名仅保存在医生本地浏览器 localStorage 中，绝不上云）。</li>
            <li><b>主诉与现病史</b>：反复咳嗽、咳黄褐色粘稠胶冻样脓痰伴间断痰中带血 6 年，活动后气促 1 年，近两周症状加重伴低热 (37.8℃)。既往有支气管哮喘病史 10 年，长期吸入 ICS/LABA。</li>
            <li><b>诊疗痛点</b>：外院曾按普通支气管扩张合并铜绿假单胞菌感染反复静脉滴注抗生素，治疗后无根本改善，肺实质浸润及粘液嵌顿进行性加重。</li>
          </ul>
        </div>
      </div>

      <h4>7.2 第一步：3D HRCT 上传与 MONAI 深度学习病灶量化 (Baseline HRCT)</h4>
      <p>医生在「患者 ➔ 影像」面板上传包含 269 层的胸部高分辨 CT 序列 (DICOM/NIfTI)。系统调用 <code>bronchiectasis_mucus_analyzer</code> 深度网络完成全肺体素解析并自动聚焦病灶最大截面（第 #114 层）：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 1 真实患者胸部 HRCT 轴位关键截面 (Slice #114) · MONAI 自动量化分析</span>
          <span class="help-case-tag">${icon('scan', { size: 12 })} MONAI 3D SegResNet</span>
        </div>
        <img class="help-case-img" src="/site/real-case-1-baseline-hrct.png" alt="真实患者胸部 HRCT 关键截面量化分析" />
        <div class="help-case-caption">
          <b>影像学关键指征解读：</b>
          <ul>
            <li><b>支气管-伴行动脉比 (BAR = 1.45)</b>：正常成人肺野内支气管内径通常小于等于伴行动脉内径（BAR ≤ 1.0）。黄色测量卡尺清晰标出支气管内径扩张至 7.8 mm（伴行动脉 5.4 mm），呈现教科书级典型<b>「印戒征 (Signet Ring Sign)」</b>，提示重度柱状支气管扩张；</li>
            <li><b>管壁厚度比 (T/D Ratio = 0.28)</b>：参考值 &lt; 0.20，证实气道壁处于慢性重度炎性肥厚与纤维重塑状态；</li>
            <li><b>高密度粘液栓 (High Attenuation Mucus, HAM)</b>：红色高亮区域标识右肺下叶基底段支气管腔内广泛嵌顿的胶冻样栓塞。AI 多簇体素聚类测得粘液栓总体积达 <b>368.29 cm³</b>，其中<b>高密度 HAM 嵌顿达 12.44 cm³</b>。测得栓体 CT 均值 98 HU（峰值 126 HU），远超胸壁肌肉平均 CT 值 (40~50 HU)。该高密度征象在病理生理学上特异性对应嗜酸性坏死蛋白（夏科-雷登结晶）与曲霉菌丝凝聚，为 ABPA 的关键影像学标志；</li>
            <li><b>量化严重度分级</b>：Bhalla 粘液栓嵌顿评定为 2 级 (重度广泛完全嵌顿)；Reiff 支扩严重度综合评分为 12/18 分。</li>
          </ul>
        </div>
      </div>

      <h4>7.3 第二步：诊断级 3D MPR 三正交切片交互浏览 (Interactive 3D MPR)</h4>
      <p>点击「打开 3D 浏览器」，进入全景三正交切片工作台。克服单一切片肉眼难以观察气道立体走行的缺陷：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 2 诊断级交互式 3D MPR 三正交切片浏览器 (Triple Orthogonal Planes)</span>
          <span class="help-case-tag">${icon('grid', { size: 12 })} 三正交联动</span>
        </div>
        <img class="help-case-img" src="/site/real-case-2-mpr-3view.png" alt="诊断级交互式 3D MPR 三正交切片浏览器" />
        <div class="help-case-caption">
          <b>三正交浏览交互核心功能：</b>
          <ul>
            <li><b>三联解剖空间对齐</b>：横断面 (Axial #114/269)、冠状面 (Coronal #256/512)、矢状面 (Sagittal #256/512) 实时同屏联动，立体展现粘液栓自近端大气道向下叶基底段各级支气管蔓延的“指套征 (Glove-finger shadow)”三维形态；</li>
            <li><b>三维准星瞬时跳转 (Cursor Lock)</b>：点击「定位病灶中心」，准星自动瞬时飞跃到病灶最大几何截面层位，鼠标滚轮可在该层前后微调；</li>
            <li><b>全模态临床窗宽窗位</b>：支持快捷键一键在肺窗 (-600/1500)、纵隔窗 (40/400) 之间切换，方便快速鉴别粘液栓与纵隔淋巴结；右下角配备 5 cm 毫米级真实物理比例尺；</li>
            <li><b>存证截图沉淀</b>：点击「${icon('save', { size: 12 })} 保存切片为文档资产」，即刻以无损 PNG 保存当前层位，自动生成 Markdown 引用代码供论文或病历直接使用。</li>
          </ul>
        </div>
      </div>

      <h4>7.4 第三步：TotalSegmentator 全身体素机体成分与 L3 肌少症预后分析 (Body Composition)</h4>
      <p>为评估该长期慢性气道炎性消耗患者能否耐受大剂量激素与抗真菌治疗，医生在工作台一键运行「机体成分分析」：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 3 TotalSegmentator 3D 全身体素机体成分与 L3 骨骼肌指数 (SMI) 量化</span>
          <span class="help-case-tag">${icon('users', { size: 12 })} 营养恶液质预后评估</span>
        </div>
        <img class="help-case-img" src="/site/real-case-4-l3-smi.png" alt="TotalSegmentator L3 断面机体成分与肌少症量化" />
        <div class="help-case-caption">
          <b>机体成分与耐受性量化指标：</b>
          <ul>
            <li><b>L3 骨骼肌指数 (SMI = 56.94 cm²/m²)</b>：AI 全自动定位 L3 椎体中位截面（第 #150 层），精准分割腰大肌、竖脊肌及腹前外侧肌群，骨骼肌总面积 SMA 为 174.39 cm²。结合身高 1.75m 换算 SMI 为 56.94 cm²/m²；</li>
            <li><b>肌少症筛查</b>：依据 Prado 国际标准（男性截断值 52.4 cm²/m²），患者属于「骨骼肌量正常 (Normal Muscularity)」，无肿瘤恶液质或严重消耗性肌少症；</li>
            <li><b>内脏脂肪与皮下脂肪比 (VAT / SAT = 0.038)</b>：内脏脂肪面积 VAT 为 15.07 cm²，皮下脂肪充足且分布均匀。评估患者骨骼肌代谢底质良好，能够充分耐受足疗程口服泼尼松及伏立康唑药物治疗。</li>
          </ul>
        </div>
      </div>

      <h4>7.5 第四步：治疗 3 个月随访：双期配准与差分吸收热力图对比 (Follow-up Diff Heatmap)</h4>
      <p>患者接受正规口服糖皮质激素（起始剂量 0.5 mg/kg/d，逐周规律递减）联合伏立康唑抗真菌药物治疗 3 个月后，于 2026-10-01 进行胸部 HRCT 复查。医生在工作台点击「多期随访对比」：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 4 规范治疗 3 个月后随访：3D 空间弹性配准与差分吸收热力图 (Difference Heatmap)</span>
          <span class="help-case-tag">${icon('compare', { size: 12 })} 随访疗效评定</span>
        </div>
        <img class="help-case-img" src="/site/real-case-3-diff-heatmap.png" alt="随访双期 3D 空间弹性配准与差分吸收热力图" />
        <div class="help-case-caption">
          <b>动态随访演变量化与疗效判定：</b>
          <ul>
            <li><b>3D 非刚性弹性形变配准 (Deformable B-spline)</b>：系统自动克服患者两次扫描时的吸气相深浅差异与胸廓微小旋转，输出高精度形变向量场将随访 CT 空间刚性对齐；</li>
            <li><b>差分吸收热力图图层</b>：在对齐后体素空间中计算 HU 差分，绿色图层极为醒目地勾画出原右下叶基底段支气管内嵌顿的高密度粘液栓发生大范围溶解与咳出吸收；</li>
            <li><b>严格遵循 3D 容积吸收评估准则</b>：粘液栓总体积由基线 <b>368.29 cm³ 骤降至 92.50 cm³</b>，体积吸收率达到 <b>74.9%</b>！系统依据非实体瘤量化评估共识自动评定为 <b>「显著吸收好转 / 部分缓解 (PR)」</b>，坚决杜绝生搬硬套 RECIST 实体瘤最大长径标准带来的逻辑冲突。</li>
          </ul>
        </div>
      </div>

      <h4>7.6 第五步：多模态因果诊断链闭环与标准报告出具 (Multimodal Evidence Chain)</h4>
      <p>影像分析并非孤立存在，系统将 3D CT 影像征象与患者实验室多模态指标深度联动，一键拼装出符合国际共识的因果诊断链：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 5 多模态因果诊断链与证据闭环 (ABPA 证据三支柱)</span>
          <span class="help-case-tag">${icon('sparkles', { size: 12 })} 因果推理 · 标准交换</span>
        </div>
        <img class="help-case-img" src="/site/real-case-5-diagnostic-chain.png" alt="多模态因果诊断链与证据闭环" />
        <div class="help-case-caption">
          <b>多模态证据闭环与标准文书出具：</b>
          <ul>
            <li><b>支柱一（3D HRCT 影像定量）</b>：柱状支扩印戒征 (BAR 1.45) + 中央型高密度粘液栓 (HAM 12.44 cm³) + 指套征；</li>
            <li><b>支柱二（实验室免疫生化指标）</b>：外周血嗜酸粒细胞绝对值高达 1.12 × 10⁹/L (显著增高 ↑)、血清总 IgE 达到 1820 kU/L (超正常上限 18 倍 ↑)、烟曲霉特异性 sIgE 4 级强阳性；</li>
            <li><b>支柱三（终末确诊与处置决策）</b>：完全符合 Rosenberg-Patterson 诊断标准的全部核心要素，正式确立诊断为 <b>变应性支气管肺曲霉病 (ABPA) 急性活动加重期 (Stage 1)</b>；</li>
            <li><b>互操作国际格式导出</b>：一键生成规范四段式影像报告单，并导出标准 <b>DICOM SR</b> (SOP Class 1.2.840.10008.5.1.4.1.1.88.22) 与 <b>HL7 FHIR DiagnosticReport</b> JSON，直通医院 PACS/EMR 临床终端。</li>
          </ul>
        </div>
      </div>
    `
  },
  {
    id: 'research',
    title: '临床科研工作流 (Research)',
    badge: '统计分析',
    icon: icon('chart', { size: 16 }),
    summary: '方案设计、多中心数据集质控清洗、Table 1 基线表一键制表、Kaplan-Meier 生存曲线与 Cox 比例风险回归。',
    contentHtml: `
      <div class="help-section-head">
        <h3>8. 临床科研工作流 (Clinical Research & Automated Biostatistics)</h3>
        <span class="help-tag">科研立项 · 统计分析</span>
      </div>
      <p class="help-lead">覆盖临床研究方案拟定、多源多格式数据表质控导入、自动化医学统计学制表及文章发表归档全周期。</p>

      <h4>8.1 研究项目与方案管理</h4>
      <p>进入「研究」工作空间，点击「＋ 新建研究」：</p>
      <ul>
        <li>输入研究题目、临床试验注册号 (如 ChiCTR / ClinicalTrials.gov NCT ID)、研究类型（前瞻性 RCT、回顾性队列或病例对照）。</li>
        <li>结构化设定纳入与排除标准、暴露/干预因素及主要终点事件 (Primary Endpoint)。</li>
      </ul>

      <h4>8.2 多格式原始数据集导入与质控</h4>
      <p>在「数据集」面板中，支持直接上传主流统计软件原始文件：</p>
      <div class="help-grid-3">
        <div class="help-chip-card"><b>.csv / .xlsx</b><span>通用表格文件</span></div>
        <div class="help-chip-card"><b>.sas7bdat</b><span>SAS 数据集</span></div>
        <div class="help-chip-card"><b>.sav</b><span>SPSS 数据文件</span></div>
      </div>
      <p>系统自动扫描变量字典、数据类型识别、缺失值比例报告及异常极端值警示。</p>

      <h4>8.3 自动化高保真医学统计分析</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('template', { size: 14 })}</span>
          <div>
            <b>Table 1 基线特征表一键生成</b>：系统自动检验连续变量正态性，正态数据输出 <code>Mean ± SD</code> 并应用独立样本 t 检验；偏态数据输出 <code>Median (IQR)</code> 并应用 Wilcoxon/Mann-Whitney U 检验；分类变量输出 <code>N (%)</code> 并自动采用 Pearson 卡方检验或 Fisher 确切概率法，自动生成三线表。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('chart', { size: 14 })}</span>
          <div>
            <b>Kaplan-Meier 生存分析与 Log-Rank 检验</b>：绘制高精度生存概率曲线，计算中位生存时间 (Median OS / PFS) 及 95% CI，底部自动对齐展示各时间节点风险人数表 (Number at Risk)。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('dna', { size: 14 })}</span>
          <div>
            <b>Cox 比例风险模型与森林图 (Forest Plot)</b>：支持单因素与多因素回归分析，计算风险比 (HR) 或比值比 (OR)，自动绘制矢量级森林图。
          </div>
        </li>
      </ul>
      <h4>8.4 影像生物标志物生存分析与预后建模 (Imaging Biomarker Survival Analysis)</h4>
      <p>将深度学习量化指标与长期临床随访结局深度融合：</p>
      <ul>
        <li><b>肌少症 (SMI) 与脂肪分布预后分层</b>：依据 L3 骨骼肌指数 (SMI) 与内脏/皮下脂肪比 (VAT/SAT) 自动进行低 SMI 肌少症组 vs 对照组分组，一键绘制 Kaplan-Meier 生存曲线并计算 Log-Rank p 值；</li>
        <li><b>多因素 Cox 回归协变量校正</b>：将影像标志物与年龄、TNM 临床分期、ECOG 评分及化疗周期联动构建多因素 Cox 回归模型，自动输出 Adjusted HR 及森林图；</li>
        <li><b>IBSI 影像组学多中心特征建模</b>：提取的 107 项国际规范组学特征一键存入研究队列数据集，支撑肿瘤免疫治疗应答与复发风险预测科研。</li>
      </ul>

      <p>所有分析结果与生成图表均可一键归入「写作」文档，实现从临床数据分析到论文撰写的一键闭环。</p>
    `
  },
  {
    id: 'collaboration',
    title: '科室协作与知家家庭健康空间 (PHR)',
    badge: '协作共享',
    icon: icon('users', { size: 16 }),
    summary: '科室诊疗组 RBAC 权限矩阵、个人专属知家家庭健康档案、患者安全扫码分享令牌及防泄密管控。',
    contentHtml: `
      <div class="help-section-head">
        <h3>9. 科室协作与知家家庭健康空间 (Collaboration & PHR)</h3>
        <span class="help-tag">权限矩阵 · 家人健康</span>
      </div>
      <p class="help-lead">兼顾院内科室团队高效协作与医生个人家庭健康管理，双重身份安全解耦。</p>

      <h4>9.1 科室团队与诊疗组 (Care Team)</h4>
      <ul>
        <li><b>角色分工</b>：机构管理员 (Admin)、主管医师 (Attending Physician)、辅助医师 (Fellow/Resident)。</li>
        <li><b>数据可见性</b>：不同医疗组之间实行患者病历权限隔离，确保诊疗隐私与数据追溯责任到人。</li>
      </ul>

      <h4>9.2 知家 (Personal Health Record, PHR) · 个人专属家庭空间</h4>
      <p>在右上角账户菜单点击「个人空间 (知家)」，即可切换至独立个人档案：</p>
      <ul>
        <li><b>物理级隔离</b>：知家属于医生个人空间，与医院工作台完全物理隔离。即使未来更换执业医院，知家中的家人体检报告、化验单及慢病指标永不丢失。</li>
        <li><b>AI 亲情化解读</b>：利用通俗易懂的语言对长辈体检异常指标进行科普化分析与随访建议。</li>
      </ul>

      <h4>9.3 患者随访与安全扫码分享</h4>
      <p>医生可为特定患者生成具有有效期的<b>外部安全访问令牌 (Secure Share Token)</b>：</p>
      <ul>
        <li>患者在微信或移动端浏览器打开，仅能查阅经过去标识化的通俗化报告与趋势图，无法看到医生内部工作流与其他患者数据。</li>
        <li>支持随时一键作废已发放的分享链接。</li>
      </ul>
    `
  },
  {
    id: 'faq',
    title: '常见问题与临床操作贴士 (FAQ)',
    badge: '疑难解答',
    icon: icon('info', { size: 16 }),
    summary: '影像上传失败排查、切片对齐精度、导出排版微调与临床法律安全边界说明。',
    contentHtml: `
      <div class="help-section-head">
        <h3>10. 常见问题与操作贴士 (FAQ & Troubleshooting)</h3>
        <span class="help-tag warn">避坑指引 · 临床备忘</span>
      </div>

      <div class="help-faq-item">
        <div class="faq-q">Q1: 上传 DICOM 影像时提示分析超时或格式不支持怎么处理？</div>
        <div class="faq-a">
          A: 请确保上传的压缩包内为标准的单个检查序列 (Single Series)。若包含局部定位像 (Scout view) 或多个不同时相序列混杂，请先筛选出单一轴位主序列再行压缩上传。单次上传推荐压缩包体积 &lt; 500MB。
        </div>
      </div>

      <div class="faq-faq-item">
        <div class="faq-q">Q2: 为什么导出的 Word / PPTX 在部分 Windows 设备上字体显示不一致？</div>
        <div class="faq-a">
          A: 在顶部导出菜单中，提供<b>「中文字体」切换开关</b>：Mac 用户可选择苹方/宋体，Windows 用户可点击切换为「微软雅黑/等线」，确保跨平台排版完全一致。
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Q3: 为什么系统提示某些病灶不能用 RECIST 1.1 评估？</div>
        <div class="faq-a">
          A: RECIST 1.1 标准专门针对实体瘤靶病灶长径变化制定。对于支气管扩张粘液栓、肺部炎症浸润等弥漫或不规则良性病变，长径并不能反映吸收情况。系统会自动切换为国际公认的 <b>3D 容积吸收评估</b>，更加精准客观。
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Q4: 系统的定量结果可以直接作为最终诊断写入官方病历吗？</div>
        <div class="faq-a">
          A: <b>绝对不能直接照搬。</b> Heurion 属于临床决策辅助与科研工作站。根据医疗质量管理规范，所有 AI 量化测量与因果推理均需具有执业资质的影像科或临床医师核对原始图像并签字后，方可作为医疗文书生效。
        </div>
      </div>
    `
  },
  {
    id: 'releasenotes',
    title: '版本发布更新日志 (Release Notes)',
    badge: '更新里程碑',
    icon: icon('sparkles', { size: 16 }),
    summary: '记录 Heurion 从 v2.0 到 v2.4 核心版本演进、临床影像量化、生物统计、零 PHI 隐私与交互设计里程碑。',
    contentHtml: `
      <div class="help-section-head">
        <h3>11. 版本发布更新日志 (Release Notes & Milestones)</h3>
        <span class="help-tag ok">持续演进 · 循证创新</span>
      </div>
      <p class="help-lead">Heurion 始终秉承「临床医生与科研人员的专业辅助伙伴」定位，每个版本均历经三甲临床专家严苛验证与医学数据安全审查。</p>

      <div class="help-release-card">
        <div class="help-release-badge current">v2.4 Pro (当前最新版本 · 2026年10月)</div>
        <div class="help-release-title">3D 影像全栈量化、肌少症体素分析、IBSI 影像组学与 1.5px 发丝级矢量设计</div>
        <ul class="help-release-list">
          <li><b>TotalSegmentator L3 椎体机体成分分析</b>：自动定位 L3 椎体层面，分割腰大肌、竖脊肌及腹壁肌群，测算骨骼肌指数 (SMI = SMA / 身高² cm²/m²)，基于 Prado 国际共识提供肌少症衰弱风险预警；自动计算内脏脂肪 (VAT) 与皮下脂肪 (SAT) 面积及 VAT/SAT 肥胖比。</li>
          <li><b>IBSI 107 项标准影像组学高维特征提取</b>：完全遵循国际影像生物标志物标准化倡议 (IBSI) 规范，支持提取形态学、一阶强度统计、灰度共生矩阵 (GLCM)、游程矩阵 (GLRLM)、区域大小矩阵 (GLSZM)、相关度矩阵 (GLDM) 及邻域差矩阵 (NGTDM) 等 107 项组学特征，可一键导入研究数据集。</li>
          <li><b>纵向多期 3D 非刚性弹性形变配准 (DIR) 与差分吸收热力图</b>：在刚性旋转平移对齐基础上引入高阶弹性形变场，消除呼吸运动伪影；差分吸收热力图（绿色吸收好转 PR/CR、红色进展恶化 PD、黄色稳定 SD）精准直观展现抗炎或抗肿瘤治疗疗效。</li>
          <li><b>PET-CT 跨模态代谢与解剖融合成像</b>：支持自动校正衰变时间与患者体重/瘦体重 (LBM)，将活度 (Bq/mL) 换算为 SUV，自动计算并标定病灶 SUVmax、SUVmean、代谢肿瘤体积 (MTV) 与总糖酵解量 (TLG)。</li>
          <li><b>放射治疗靶区标准 DICOM RT-STRUCT 导出</b>：一键将 MONAI 3D 卷积模型分割轮廓及临床靶区转化为符合国际放射物理规范的 RT-STRUCT 轮廓集 (GTV/CTV/OAR)。</li>
          <li><b>发丝级矢量图标系统 (1.5px Hairline SVG)</b>：全面移除杂乱 Emoji，全平台统一换装 1.5px 极简医学科技矢量图标系统；三核心空间顺序调整为「患者 -> 研究 -> 写作」，顺应真实临床医生日常工位逻辑。</li>
          <li><b>多模态影像附件沙箱隔离与上传流程健壮化</b>：支持在对话中直接点击「＋ 上传图片」或拖拽/粘贴超声、CT、胸片、病历截图，后台自动继承沙箱只读权限（0o666/0o777），杜绝 EACCES 权限冲突；智能引导多模态临床解读并可一键指引至患者影像中心。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.3.0 (2026年8月)</div>
        <div class="help-release-title">MONAI 3D 深度模型集群矩阵、MPR 三正交浏览器与因果证据链</div>
        <ul class="help-release-list">
          <li><b>MONAI 3D 临床深度学习模型矩阵 (18+ 模型)</b>：胸部支气管扩张 (BAR 伴行动脉比、HAM 高密度粘液栓容积、气道树)、肺结节 3D 检出与倍增时间 (VDT)、前列腺 mpMRI (T2+ADC+DWI) 分割与 PI-RADS v2.1 辅助评级、腹部 13 脏器多任务分割 (SwinUNETR)、脑胶质瘤 BraTS 三模态分割与急诊颅内出血检出。</li>
          <li><b>诊断级交互式 MPR 三正交切片浏览器</b>：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由十字联动，集成 NiiVue 3D WebGL2 体绘制；支持 5 种标准窗宽窗位一键调窗、病灶质心准星一键定位与切片资产存证。</li>
          <li><b>实体瘤 RECIST 1.1 自动比对引擎</b>：支持靶病灶长短径自动测量、基线期比对与变化率判定 (CR / PR / SD / PD)。</li>
          <li><b>多模态因果诊断链图解推演</b>：打通「3D 影像表征 + 临床生化免疫化验 + 基因分子型」三元证据链，实现难治性变应性支气管肺曲霉病 (ABPA) 等复杂疑难罕见疾病的精准推演。</li>
          <li><b>国际医学标准互通格式导出</b>：全面支持导出 DICOM SR (Structured Report) 结构化报告与 HL7 FHIR DiagnosticReport / Observation 资源包，支持医院 PACS/HIS 系统无缝互联。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.2.0 (2026年6月)</div>
        <div class="help-release-title">自动化临床科研统计、零 PHI 隐私架构与严苛权限隔离</div>
        <ul class="help-release-list">
          <li><b>一站式自动化生物统计引擎</b>：支持上传 SAS/SPSS/Excel 多中心原始数据，自动执行缺失值插补、数据清洗；一键生成符合医学顶级期刊标准的 Table 1 基线特征表、Kaplan-Meier 生存分析曲线（附带 Log-rank p 值与 95% 置信区间）及 Cox 比例风险回归森林图。</li>
          <li><b>零 PHI (Zero-PHI) 临床隐私架构</b>：全流程推行去标识化虚拟研究代号；患者真实姓名仅保存在本机浏览器 <code>localStorage</code> 物理隔离层，绝不上云；全链路敏感 DICOM Tag 自动清洗。</li>
          <li><b>多租户安全沙箱与 AES-256-GCM 隔离</b>：租户级独立密钥加密隔离；敏感操作（删除、高风险编辑）强制弹出红白确认卡拦截并审计留痕。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.1.0 (2026年4月)</div>
        <div class="help-release-title">文档与学术汇报幻灯片双模态无损写作、PubMed 检索与伴随审查</div>
        <ul class="help-release-list">
          <li><b>文档与幻灯片 (Deck) 双模态排版器</b>：原生支持 Word (DOCX)、PPTX、Markdown 双向高保真导入导出，告别格式排版错乱。</li>
          <li><b>伴随式 AI 协作与红绿 Diff 修订机制</b>：AI 输出以高亮修订形式呈现，支持临床医生逐条采纳、修改或驳回，真正落实 Human-in-the-Loop 医疗责任闭环。</li>
          <li><b>PubMed 全球医学文献检索与自动引用溯源</b>：智能匹配并检索 PubMed 权威医学文献，一键生成规范格式参考文献，并在正文中插入关联溯源标记。</li>
          <li><b>Python + Resvg 矢量科研图表生成</b>：工作区内安全执行高精度统计作图脚本，生成 Publication-Ready 矢量级配图。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.0.0 (2026年2月)</div>
        <div class="help-release-title">Heurion 平台 2.0 全新架构里程碑发布</div>
        <ul class="help-release-list">
          <li><b>全新三栏墨绿极客工作台</b>：现代极简 UI 设计，专为高强度临床与科研工作设计。</li>
          <li><b>知家 (PHR) 个人专属家庭健康空间</b>：与医院科研工作台物理隔离，为医生及家人提供终身健康档案与随访管理。</li>
          <li><b>科室多级诊疗组 (Care Team) 与受控安全分享</b>：支持主管医生与协助医生精细化权限矩阵，兼顾高效协作与数据安全。</li>
        </ul>
      </div>
    `
  }
]

/** 生成一份 Markdown 格式的完整产品手册，供用户一键导入到写作空间作为常驻参考 */
export function buildHelpMarkdown(): string {
  return `# Heurion 临床智能工作站 · 全流程使用手册与操作指南

> **版本**：v2.4 Pro  
> **适用人群**：呼吸科、胸外科、放射影像科、泌尿外科、肿瘤科临床医师与医学科研人员  
> **核心架构**：零 PHI 医学隐私 · MONAI 3D 深度量化 · 双模无损写作 · 自动化生物统计

---

## 一、 快速上手与界面导览

Heurion 专为临床与医学科研打造，采用三栏自适应现代架构：

1. **左侧导航 Rail & 资源栏**（自上而下顺畅工作流，统一采用 1.5px 极简发丝级医学矢量图标系统）：
   - **患者 (Patients · 临床一线)**：以纯虚拟代号建档，3D 影像深度量化、三正交 MPR 浏览器、双期配准与随访对比；
   - **研究 (Research · 科研转化)**：临床课题立项、多中心数据集质控、Table 1 与生存分析、IBSI 影像组学预后建模；
   - **写作 (Write · 成果输出)**：文档与学术汇报幻灯片、PubMed 引用、红绿 Diff 修订模式与 Word/PPTX 双模态无损导出；
   - **资料库 (Library)**：上传医学指南与学术论文，自动向量化供 AI 检索溯源；
   - **回收站与账户中心**：个人设置、机构管理及知家 (PHR) 个人专属家庭健康空间。
2. **中间主工作画布 (Center)**：
   - 富文本编辑器（支持分级标题、公式、表格、PubMed 引用）；
   - 学术汇报幻灯片排版器；
   - 患者 3D MPR 三正交切片交互浏览器；
   - 临床科研数据集管理与透视表。
3. **右侧伴随智能栏 (Side AI)**：
   - 伴随式 AI 对话、红绿 Diff 修订模式（逐条采纳/拒绝）；
   - 学术论文伴随审查与修改建议；
   - 历史版本对比与回滚。

**常用快捷键**：
- \`⌘B\` (粗体)、\`⌘I\` (斜体)、\`⌘U\` (下划线)、\`⌘Z\` (撤销)、\`⌘⇧Z\` (重做)
- \`⌘↩\` (在对话框中快速提交指令)

---

## 二、 医学隐私与安全架构 (Zero-PHI)

1. **零 PHI (Zero Protected Health Information) 强制准则**：
   - **严禁录入真实患者个人敏感信息**（真实姓名、身份证、门诊住院号、手机号）；
   - 统一采用纯研究代号建档（如 \`PT-BRONCHO-001\`、\`SUBJ-002\`）；
   - 上传 DICOM 影像前自动清洗私有敏感 Tag。
2. **AES-256-GCM 租户数据密钥隔离**：
   - 机构间数据完全隔离，杜绝跨机构越权访问。
3. **高风险操作确认卡 (Human-in-the-Loop)**：
   - 不可逆操作（如删除病历、覆盖数据、下发报告）必须由执业医师主动点击二次确认卡方才生效。
4. **敏感访问审计日志 (Audit Logging)**：
   - 记录人员、时间戳与脱敏病历 ID，满足行业合规要求。

---

## 三、 医学写作与文献溯源

1. **文档与幻灯片双模态**：
   - 支持起草 SCI 论文、综述、病例报告及学术汇报幻灯片；
   - 无损双向导入导出：支持导入/导出 Word (\`.docx\`)、PowerPoint (\`.pptx\`) 及 Markdown (\`.md\`)。
2. **AI 修订模式 (Diff Mode)**：
   - 开启修订模式，AI 的所有润色与增删以红绿 Diff 呈现，由医师逐条审阅采纳。
3. **PubMed 智能引用与资料库检索**：
   - 输入 DOI 或 PMID，自动获取文献元数据并按规范格式插入序号标注与参考文献表；
   - 资料库可上传指南 PDF，AI 对话时勾选「＋ 引用资料」，精准回答并指出出处页码。
4. **高清矢量图表无损导出**：
   - 基于 Python 绘制医学图表，采用 Resvg 矢量渲染引擎与 DrawingML 双模嵌入，导出 Word/PPT 绝不失真丢图。

---

## 四、 患者管理与 3D 影像量化分析

0. **影像智能分析全流程业务闭环 (The Complete 9-Step Imaging Pipeline)**：
   - ① **影像摄入与合规脱敏**：DICOM 序列/NIfTI 体数据上传，自动剥离 18 项 HIPAA 敏感标识；支持对话直接粘贴/上传单张超声、CT、胸片截图进行 AI 视觉解读；
   - ② **空间几何与重采样**：统一重采样至 1×1×1 mm³ 各向同性空间体素；自适应匹配肺窗、纵隔窗、腹部窗、骨窗及脑窗；
   - ③ **MONAI 3D 深度模型矩阵**：内置 18+ 款分科预训练 3D 深度神经网络，涵盖支扩 BAR/HAM、肺结节、腹部 13 器官、前列腺 mpMRI 与脑胶质瘤；
   - ④ **IBSI 影像组学高维提取**：遵循 IBSI 国际标准，从病灶 ROI 提取 107 项高维生物特征（形态学、一阶统计、GLCM、GLRLM、GLSZM、NGTDM）；
   - ⑤ **MPR 三正交交互式切片**：Axial/Coronal/Sagittal 自由十字丝联动；5cm 物理标尺，病灶质心准星一键定位与关键切片资产存证；
   - ⑥ **纵向随访与差分热力图**：3D 刚性/非刚性弹性形变配准 (DIR)，生成差分吸收热力图（绿色吸收好转、红色进展恶化），双联屏联动滑动比对；
   - ⑦ **PET-CT 代谢融合**：自动换算 SUV 标准摄取值，标定病灶 SUVmax、SUVmean、代谢肿瘤体积 (MTV) 与总糖酵解量 (TLG)；
   - ⑧ **放疗靶区 RT-STRUCT**：一键将 3D 分割轮廓转化为符合国际放疗物理标准的 DICOM RT-STRUCT 靶区轮廓（GTV/CTV/OAR）；
   - ⑨ **因果链与结构化导出**：整合影像+化验+基因证据链；支持一键导出 DICOM SR、HL7 FHIR 资源包及多学科会诊 (MDT) 幻灯片。
1. **患者全流程档案与零 PHI 准则**：
   - **纯虚拟代号建档**：采用 \`PT-BRONCHO-001\` 等去标识化代号建档；
   - **本机浏览器备注名物理隔离**：患者真实姓名仅保存在医生本地浏览器的 \`localStorage\` 中，绝不上云、绝不入库，彻底免除云端 PHI 泄露风险；
   - **多维档案标签页**：涵盖概览 (Overview)、多期化验 (Labs)、报告原件与影像 (Records)、AI 抽取核对待确认卡 (Review) 及团队协作/破窗访问。
2. **多模态实验室检验指标追踪**：
   - 追踪嗜酸性粒细胞 (Eos)、血清总 IgE、烟曲霉特异性 sIgE、肿瘤标志物 (CEA/CYFRA21-1/NSE/PSA) 及感染生化指标；
   - **国际标准单位自动换算**：跨机构单位自动归一化，支持纵向演变趋势图与检验单原件一键定位溯源。
3. **3D 原始影像支持与全模态覆盖**：
   - 支持 DICOM 序列压缩包 (\`.zip\` / \`.tar.gz\`)、单张 DICOM (\`.dcm\`) 及 NIfTI 卷 (\`.nii\` / \`.nii.gz\`)；
   - 全模态覆盖：高分辨率薄层 CT (HRCT)、磁共振 MRI (T1/T2/FLAIR/DWI/mpMRI)、超声声像图 (Ultrasound)、胸部 X 线平片 (DR/CR) 及 PET-CT 跨模态代谢显像；
   - 自动解析体素空间几何间距 (Voxel Spacing) 与矩阵维度，入库前自动彻底清洗私有敏感 Tag。
4. **MONAI 3D 临床深度学习模型全矩阵 (18+ 款分科模型)**：
   - **胸部与呼吸科**：
     - **支气管-伴行动脉比 (BAR)**：测量内径比值（正常 < 1.0；≥ 1.0 提示典型印戒征支气管扩张）；
     - **高密度粘液栓 (HAM / 指套征)**：自动多簇分割，量化均值 HU、极值 HU 及 3D 总体积 (cm³)，自动与胸壁肌肉 (40~50 HU) 对比判定 HAM 标准；
     - **气道壁增厚率 (T/D Ratio)**、全气道树三维拓扑骨架 (AirwayUNet) 与 5 大解剖肺叶 (V-Net)；
     - **肺结节与实变分割 (SegResNet)**：实性/磨玻璃结节 3D 体积与长短径，关联 Fleischner 2017 随访指南；
   - **腹部、消化与泌尿**：
     - **前列腺 mpMRI**：T2WI+ADC+DWI 序列对齐，外周带/移行带分割，PI-RADS v2.1 3D 分级；
     - **全腹部 13 器官多任务分割 (SwinUNETR)**、肝癌/转移瘤与胰腺导管腺癌 3D 量化；
     - **肾肿瘤/肾囊肿 (KiTS)** 与脾肿大定量 (SegResNet)；
   - **颅脑与神经系统**：
     - 脑胶质瘤多模态分割 (BraTS DynUNet)、皮质下深部核团与海马体萎缩量化 (FastSurfer-like)；
     - 急性脑梗死缺血半暗带测定及急诊颅内出血与血肿检出；
   - **心血管系统**：
     - **冠状动脉钙化积分 (CAC / Agatston 评分)**：评估冠状动脉硬化风险分层；
     - **心脏 CINE MRI 心室分割与射血分数 (LVEF)**：动态测算左心室收缩舒张末容积与射血分数；
   - **骨科与全身体素**：
     - **全身体素 104 类解剖结构分割 (TotalSegmentator)**：全身骨骼与主要内脏肌群一键全自动分割；
     - **全脊柱 24 节椎骨与椎间盘分割 (Spine-Segmenter)**：脊椎压缩性骨折与椎间隙测量。
5. **诊断级交互式 MPR 三正交切片浏览器**：
   - **双引擎随心切换**：轻量极速 2D 正交切片引擎（内置 5cm 毫米标尺与 HUD 抬头显示）与 NiiVue 3D WebGL2 引擎（3D 体绘制与四视图联动）；
   - **三正交解剖平面自由切换**：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由切换，切片滑动条、鼠标滚轮上下滑动或键盘方向键平滑逐层浏览；
   - **全模态临床窗宽窗位快捷预设**：肺窗 (-600/1500)、纵隔窗 (40/400)、腹部窗 (50/350)、骨窗 (300/1500)、脑窗 (40/80) 及鼠标拖拽无级微调；
   - **三维准星与智能病灶导航**：点击「定位病灶中心」瞬时跳转到病灶最大截面层，实时展示病灶受累标签；
   - **关键截面存证截图 (Capture Snapshot)**：一键转存为平台永久图像资产并生成 Markdown 引用代码，支持一键出具规范影像报告草案。
6. **全身体素机体成分与肌少症量化 (Body Composition & Sarcopenia)**：
   - **L3 骨骼肌指数 (SMI, cm²/m²)**：自动定位 L3 椎体中位截面，精准测算骨骼肌横截面积并换算 SMI，依据 Prado 国际共识（男性 < 52.4 cm²/m²，女性 < 38.5 cm²/m²）自动进行肌少症分层；
   - **内脏与皮下脂肪比 (VAT / SAT)**：量化腹腔内脏脂肪面积与皮下脂肪分布，评估代谢综合征及放化疗毒副反应预后。
7. **IBSI 国际标准影像组学高阶特征提取 (Radiomics Extraction)**：
   - 遵循 IBSI (Image Biomarker Standardisation Initiative) 国际规范，全量提取 107 项高维生物特征（形态学、一阶灰度统计、GLCM、GLRLM、GLSZM、NGTDM 等）；
   - 支持高斯拉普拉斯及小波变换滤波，组学特征一键归档至科研数据集，支撑肿瘤分子分型与免疫应答预测。
8. **三甲标准四段式全景影像诊断报告**：
   - 自动整合：① 临床指征与扫查序列；② 3D MONAI 定量测量与解剖所见；③ 印象与 RECIST/PI-RADS 分级诊断；④ 推荐随访周期与临床处置建议，一键生成规范草案并支持一键归入病历。

---

## 五、 双期 3D 刚性配准与差分吸收热力图

1. **自动 3D 空间刚性与非刚性弹性形变配准**：
   - **刚性/仿射对齐**：利用 MONAI 轻量 3D 刚性/仿射配准网络，将随访 CT 空间自动平移旋转对齐至基线 CT；
   - **3D 非刚性弹性形变配准 (Deformable B-spline / Diffeomorphic)**：精准拟合呼吸运动引起的肺野扩张不均与胸腔体位形变，输出高精度形变位移场 (DVF)。
2. **差分吸收热力图 (Difference Heatmap Overlay)**：
   - 计算两期体素差分矩阵并在切片器上叠加显示：
     - **绿色**：表示病灶缩小退缩或炎性吸收好转；
     - **红色**：表示新发浸润或病灶体积扩大进展。
3. **双联屏联动切片滑动 (Synchronized Dual-Scrubber)**：
   - 基线与随访切片器左右并排联动滚动，开启「联动滚动 (Cursor Lock)」即可实现同解剖层位瞬时对齐。
4. **PET-CT 跨模态代谢与解剖融合成像 (PET-CT & Multimodal Fusion)**：
   - 将 128×128 代谢 PET (SUV) 空间网格重采样至 512×512 结构 CT (HU) 网格；
   - 交互式 Alpha 透明度滑块 (0.0~1.0)，支持彩虹/热铁伪彩代谢图层无缝叠加于灰阶解剖 CT 之上；
   - 恶性高摄取阈值预警（默认 SUVmax ≥ 2.5 提示高代谢恶性病灶），协助精准识别肿瘤活性边界与代谢肿瘤体积 (MTV)。
5. **放疗靶区勾画与 DICOM RT-STRUCT 导出 (Radiation Target Delineation)**：
   - 采用 Marching Cubes 算法自动提取肿瘤大体靶区 (GTV)、临床靶区 (CTV)、计划靶区 (PTV) 及危及器官 (OAR: 脊髓、双肺、心脏、食管) 的闭合边界多边形网格；
   - 导出国际标准 DICOM RT-STRUCT (PS 3.3)，直通瓦里安 Eclipse、医科达 Monaco 等主流放疗计划系统 (TPS)。
6. **严格区分疗效评估标准**：
   - **实体瘤**：严格遵循 **RECIST 1.1** 标准（靶病灶最大长径和变化率：PR ≥ -30%，PD ≥ +20%，SD -30%~+20%）；
   - **支气管扩张粘液栓**：遵循 **3D 容积吸收评估**（体积吸收率 ≥ 50% 显著改善），避免标准混淆与逻辑冲突。

---

## 六、 多模态因果诊断链与标准报告导出

1. **多模态因果诊断链**：
   - 影像特征（支扩伴高密度粘液栓 HAM）+ 实验室指标（嗜酸性粒细胞、血清总 IgE、曲霉特异性 IgE）自动联动，拼装确诊证据链表（如变应性支气管肺曲霉病 ABPA）。
2. **标准化医学交换格式**：
   - 一键生成全景病例报告；
   - 导出标准 **DICOM SR** (Structured Reporting, SOP Class 1.2.840.10008.5.1.4.1.1.88.22) 与 **HL7 FHIR DiagnosticReport** JSON，直连院内 PACS 与 EMR。

---

## 七、 【实战案例深度图解】真实患者 3D 影像全流程量化与随访评定范例

医学影像功能的复杂性在于“从 3D 几何体素到临床决策的全链路因果串联”。本节以真实确诊的变应性支气管肺曲霉病 (ABPA) 患者 \`PT-BRONCHO-001\` 为完整范例：

1. **患者脱敏档案与主诉**：
   - 虚拟代号：\`PT-BRONCHO-001\` (52 岁男性，教师，零 PHI 规范建档)；
   - 主诉：反复咳嗽咳黄粘脓痰伴间断咯血 6 年，近 2 周加重伴低热 (37.8℃)；
   - 诊疗痛点：外院按普通支扩合并铜绿假单胞菌感染反复使用抗生素无效。
2. **步骤一：3D HRCT 上传与 MONAI 深度学习病灶量化**：
   - 参考图像：[图 1 真实患者胸部 HRCT 轴位关键截面量化分析](/site/real-case-1-baseline-hrct.png)；
   - **支气管-伴行动脉比 (BAR = 1.45)**：右肺下叶支气管内径扩张至 7.8 mm（伴行动脉 5.4 mm），呈现教科书级典型「印戒征 (Signet Ring Sign)」；
   - **管壁厚度比 (T/D = 0.28)**：气道慢性炎性重塑；
   - **高密度粘液栓 (HAM = 12.44 cm³)**：嵌顿栓 CT 均值 98 HU（峰值 126 HU，远超胸壁肌肉 40~50 HU），高度支持嗜酸性坏死蛋白与曲霉菌丝聚集；
   - 评分：Bhalla 2 级 (完全嵌顿)，Reiff 严重度评分 12/18 分。
3. **步骤二：诊断级 3D MPR 三正交切片交互浏览**：
   - 参考图像：[图 2 诊断级交互式 3D MPR 三正交切片浏览器](/site/real-case-2-mpr-3view.png)；
   - 横断面 (Axial #114)、冠状面 (Coronal #256)、矢状面 (Sagittal #256) 实时同屏联动；
   - 肺窗 (-600/1500) 与纵隔窗 (40/400) 快捷切换，5 cm 真实物理标尺，准星一键聚焦病灶中心。
4. **步骤三：TotalSegmentator 全身体素机体成分与 L3 肌少症预后分析**：
   - 参考图像：[图 3 TotalSegmentator L3 断面机体成分与肌少症量化](/site/real-case-4-l3-smi.png)；
   - 骨骼肌指数 (SMI = 56.94 cm²/m²)，高于男性肌少症截断值 52.4 cm²/m²；
   - 内脏/皮下脂肪比 (VAT/SAT = 0.038)，评估机体营养与肌量良好，耐受后续抗真菌疗程。
5. **步骤四：治疗 3 个月随访：双期配准与差分吸收热力图对比**：
   - 参考图像：[图 4 随访双期 3D 空间弹性配准与差分吸收热力图](/site/real-case-3-diff-heatmap.png)；
   - 接受口服糖皮质激素联合伏立康唑治疗 3 个月；
   - MONAI 非刚性弹性配准消除呼吸相差异；
   - 差分吸收热力图（绿色高亮）：粘液栓容积由 368.29 cm³ 降至 92.50 cm³ (吸收率 74.9%)；
   - 3D 容积吸收评估达到「显著吸收好转 / 部分缓解 (PR)」。
6. **步骤五：多模态因果诊断链闭环与标准报告出具**：
   - 参考图像：[图 5 多模态因果诊断链与证据闭环](/site/real-case-5-diagnostic-chain.png)；
   - 影像征象 (BAR 1.45 + HAM 12.44 cm³) + 实验室指标 (Eos 1.12×10⁹/L + 总 IgE 1820 kU/L + 曲霉 sIgE 4级)；
   - 确立变应性支气管肺曲霉病 (ABPA) 急性期诊断，一键出具四段式报告并导出标准 DICOM SR 与 FHIR。

---

## 八、 临床科研工作流 (Research)

1. **科研立项与方案管理**：临床试验注册号、纳入排除标准、主要终点设定；
2. **多格式数据集质控导入**：支持 CSV、Excel (\`.xlsx\`)、SAS (\`.sas7bdat\`)、SPSS (\`.sav\`)；自动检测缺失值与极端值；
3. **自动化生物统计制表**：
   - **Table 1 基线表**：正态分布 (Mean±SD, t检验) / 偏态分布 (Median(IQR), Wilcoxon) / 分类变量 (N(%), 卡方/Fisher) 自动选用；
   - **Kaplan-Meier 生存曲线**：绘制生存曲线、Log-Rank 检验、中位生存期与 Number at Risk 表；
   - **Cox 比例风险回归**：单因素与多因素分析，绘制风险比 (HR) 森林图。
4. **影像生物标志物生存分析与预后建模 (Imaging Biomarker Survival Analysis)**：
   - **肌少症 (SMI) 与脂肪分布预后分层**：依据 L3 骨骼肌指数 (SMI) 与内脏/皮下脂肪比 (VAT/SAT) 自动进行肌少症分组，一键绘制 Kaplan-Meier 生存曲线并计算 Log-Rank p 值；
   - **多因素 Cox 回归协变量校正**：将影像标志物与年龄、TNM 分期、ECOG 评分及治疗方案联动构建多因素 Cox 回归模型，自动输出 Adjusted HR 及森林图；
   - **IBSI 影像组学多中心特征建模**：提取的 107 项国际规范组学特征一键存入研究队列数据集，支撑肿瘤免疫治疗应答与复发风险预测科研。
5. **成果归档**：分析图表与结果一键导入写作论文，形成从临床数据到论文发表的完整闭环。

---

## 九、 科室协作与知家家庭健康空间 (PHR)

1. **科室诊疗组 (Care Team)**：主诊医师与组员权限矩阵，敏感病历访问审计留痕；
2. **知家个人空间 (PHR)**：医生专属家庭健康空间，与医院工作台物理隔离，终身保留家人健康档案；
3. **安全分享与患者沟通**：生成临时有效期的只读脱敏链接，供患者扫码查阅通俗化随访建议。

---

## 十、 常见问题解答 (FAQ)

- **Q: 为什么上传 DICOM 耗时较长？**  
  A: 建议上传单个序列的压缩包（< 500MB），去除定位像后再压缩。
- **Q: 为什么生成的报告数值与正文完全自洽？**  
  A: 系统严密绑定底层结构化量化字段，彻底杜绝模板默认值与实测值冲突。
- **Q: AI 输出能直接当作法律效力的病历吗？**  
  A: 不能。所有 AI 辅助结论必须经执业医师审阅核对并签署确认后方可作为正式病历。

---

## 十一、 版本更新日志 (Release Notes)

### v2.4 Pro (当前最新版本 · 2026年10月)
- **TotalSegmentator L3 椎体机体成分分析**：自动定位 L3 椎体层面，分割腰大肌、竖脊肌及腹壁肌群，测算骨骼肌指数 (SMI = SMA / 身高² cm²/m²)，基于 Prado 国际共识提供肌少症衰弱风险预警；自动计算内脏脂肪 (VAT) 与皮下脂肪 (SAT) 面积及 VAT/SAT 肥胖比。
- **IBSI 107 项标准影像组学高维特征提取**：完全遵循国际影像生物标志物标准化倡议 (IBSI) 规范，支持提取形态学、一阶强度统计、灰度共生矩阵 (GLCM)、游程矩阵 (GLRLM)、区域大小矩阵 (GLSZM)、相关度矩阵 (GLDM) 及邻域差矩阵 (NGTDM) 等 107 项组学特征，可一键导入研究数据集。
- **纵向多期 3D 非刚性弹性形变配准 (DIR) 与差分吸收热力图**：在刚性旋转平移对齐基础上引入高阶弹性形变场，消除呼吸运动伪影；差分吸收热力图（绿色吸收好转 PR/CR、红色进展恶化 PD、黄色稳定 SD）精准直观展现抗炎或抗肿瘤治疗疗效。
- **PET-CT 跨模态代谢与解剖融合成像**：支持自动校正衰变时间与患者体重/瘦体重 (LBM)，将活度 (Bq/mL) 换算为 SUV，自动计算并标定病灶 SUVmax、SUVmean、代谢肿瘤体积 (MTV) 与总糖酵解量 (TLG)。
- **放射治疗靶区标准 DICOM RT-STRUCT 导出**：一键将 MONAI 3D 卷积模型分割轮廓及临床靶区转化为符合国际放射物理规范的 RT-STRUCT 轮廓集 (GTV/CTV/OAR)。
- **发丝级矢量图标系统 (1.5px Hairline SVG)**：全面移除杂乱 Emoji，全平台统一换装 1.5px 极简医学科技矢量图标系统；三核心空间顺序调整为「患者 -> 研究 -> 写作」，顺应真实临床医生日常工位逻辑。
- **多模态影像附件沙箱隔离与上传流程健壮化**：支持在对话中直接点击「＋ 上传图片」或拖拽/粘贴超声、CT、胸片、病历截图，后台自动继承沙箱只读权限（0o666/0o777），杜绝 EACCES 权限冲突；智能引导多模态临床解读并可一键指引至患者影像中心。

### v2.3.0 (2026年8月)
- **MONAI 3D 临床深度学习模型矩阵 (18+ 模型)**：胸部支气管扩张 (BAR 伴行动脉比、HAM 高密度粘液栓容积、气道树)、肺结节 3D 检出与倍增时间 (VDT)、前列腺 mpMRI (T2+ADC+DWI) 分割与 PI-RADS v2.1 辅助评级、腹部 13 脏器多任务分割 (SwinUNETR)、脑胶质瘤 BraTS 三模态分割与急诊颅内出血检出。
- **诊断级交互式 MPR 三正交切片浏览器**：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由十字联动，集成 NiiVue 3D WebGL2 体绘制；支持 5 种标准窗宽窗位一键调窗、病灶质心准星一键定位与切片资产存证。
- **实体瘤 RECIST 1.1 自动比对引擎**：支持靶病灶长短径自动测量、基线期比对与变化率判定 (CR / PR / SD / PD)。
- **多模态因果诊断链图解推演**：打通「3D 影像表征 + 临床生化免疫化验 + 基因分子型」三元证据链，实现难治性变应性支气管肺曲霉病 (ABPA) 等复杂疑难罕见疾病的精准推演。
- **国际医学标准互通格式导出**：全面支持导出 DICOM SR (Structured Report) 结构化报告与 HL7 FHIR DiagnosticReport / Observation 资源包，支持医院 PACS/HIS 系统无缝互联。

### v2.2.0 (2026年6月)
- **一站式自动化生物统计引擎**：支持上传 SAS/SPSS/Excel 多中心原始数据，自动执行缺失值插补、数据清洗；一键生成符合医学顶级期刊标准的 Table 1 基线特征表、Kaplan-Meier 生存分析曲线（附带 Log-rank p 值与 95% 置信区间）及 Cox 比例风险回归森林图。
- **零 PHI (Zero-PHI) 临床隐私架构**：全流程推行去标识化虚拟研究代号；患者真实姓名仅保存在本机浏览器 localStorage 物理隔离层，绝不上云；全链路敏感 DICOM Tag 自动清洗。
- **多租户安全沙箱与 AES-256-GCM 隔离**：租户级独立密钥加密隔离；敏感操作（删除、高风险编辑）强制弹出红白确认卡拦截并审计留痕。

### v2.1.0 (2026年4月)
- **文档与学术汇报幻灯片双模态无损写作**：原生支持 Word (DOCX)、PPTX、Markdown 双向高保真导入导出，告别格式排版错乱。
- **伴随式 AI 协作与红绿 Diff 修订机制**：AI 输出以高亮修订形式呈现，支持临床医生逐条采纳、修改或驳回，真正落实 Human-in-the-Loop 医疗责任闭环。
- **PubMed 全球医学文献检索与自动引用溯源**：智能匹配并检索 PubMed 权威医学文献，一键生成规范格式参考文献，并在正文中插入关联溯源标记。
- **Python + Resvg 矢量科研图表生成**：工作区内安全执行高精度统计作图脚本，生成 Publication-Ready 矢量级配图。

### v2.0.0 (2026年2月)
- **Heurion 平台 2.0 全新架构里程碑发布**：全新三栏墨绿极客工作台；知家 (PHR) 个人专属家庭健康空间；科室多级诊疗组 (Care Team) 与受控安全分享。
`
}

/** 打开交互式产品使用指南弹窗 */
export function openHelpGuide(initialSectionId = 'overview'): void {
  const dlg = document.getElementById('dialog')!
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

  dlg.innerHTML = `
    <div class="dialog-card wide help-dialog" role="dialog" aria-modal="true" aria-label="Heurion 产品使用手册与操作指南">
      <div class="dialog-head help-head">
        <div class="help-head-title">
          <h2>${icon('file', { size: 18 })} Heurion 临床智能工作站 · 全流程使用手册</h2>
          <span class="help-version-pill">v2.4 Pro</span>
        </div>
        <div class="help-head-actions">
          <div class="help-search-wrap">
            <input type="search" id="helpFilterInput" placeholder="搜索手册章节或关键词..." autocomplete="off">
          </div>
          <button id="helpImportDocBtn" class="primary small-btn" title="在您的工作区新建一份完整手册文档，方便随时查阅与边写边看">${icon('download')} 导入为参考文档</button>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
      </div>
      <div class="help-split-layout">
        <aside class="help-sidebar" id="helpSidebar">
          <div class="help-sidebar-title">手册目录导航</div>
          <nav class="help-nav" id="helpNav">
            ${HELP_SECTIONS.map((sec, idx) => `
              <button class="help-nav-item${sec.id === initialSectionId ? ' active' : ''}" data-target="${esc(sec.id)}">
                <span class="hni-icon">${sec.icon}</span>
                <span class="hni-text">${idx + 1}. ${esc(sec.title)}</span>
                <span class="hni-badge">${esc(sec.badge)}</span>
              </button>
            `).join('')}
          </nav>
          <div class="help-sidebar-footer">
            <div class="hsf-tip">${icon('info', { size: 13 })} 提示：按 <code>Esc</code> 键可快速关闭手册。</div>
          </div>
        </aside>
        <main class="help-content-area" id="helpContentArea">
          ${HELP_SECTIONS.map(sec => `
            <section class="help-section" id="help-sec-${esc(sec.id)}" data-sec-id="${esc(sec.id)}">
              ${sec.contentHtml}
            </section>
          `).join('')}
        </main>
      </div>
    </div>
  `
  dlg.hidden = false

  const close = () => {
    dlg.hidden = true
    dlg.innerHTML = ''
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  dlg.onclick = e => {
    if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close()
  }

  // 导航点击跳转
  const navContainer = dlg.querySelector('#helpNav')!
  const contentArea = dlg.querySelector('#helpContentArea') as HTMLElement
  navContainer.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest('.help-nav-item') as HTMLElement | null
    if (!item || !item.dataset.target) return
    const targetId = item.dataset.target
    const secEl = dlg.querySelector(`#help-sec-${targetId}`) as HTMLElement | null
    if (secEl && contentArea) {
      navContainer.querySelectorAll('.help-nav-item').forEach(b => b.classList.remove('active'))
      item.classList.add('active')
      contentArea.scrollTo({
        top: secEl.offsetTop - contentArea.offsetTop,
        behavior: 'smooth'
      })
    }
  })

  // 滚动时自动高亮左侧当前章节
  let scrollTimer: any = null
  contentArea.addEventListener('scroll', () => {
    if (scrollTimer) return
    scrollTimer = setTimeout(() => {
      scrollTimer = null
      const sections = Array.from(dlg.querySelectorAll<HTMLElement>('.help-section'))
      const currentScroll = contentArea.scrollTop + 60
      for (let i = sections.length - 1; i >= 0; i--) {
        const s = sections[i]
        if (!s) continue
        if (s.offsetTop - contentArea.offsetTop <= currentScroll) {
          const id = s.dataset.secId
          if (id) {
            navContainer.querySelectorAll<HTMLElement>('.help-nav-item').forEach(b => {
              b.classList.toggle('active', b.dataset.target === id)
            })
          }
          break
        }
      }
    }, 80)
  }, { passive: true })

  // 搜索过滤
  const filterInput = dlg.querySelector<HTMLInputElement>('#helpFilterInput')
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase()
      const sections = dlg.querySelectorAll<HTMLElement>('.help-section')
      const navItems = dlg.querySelectorAll<HTMLElement>('.help-nav-item')
      if (!q) {
        sections.forEach(s => s.hidden = false)
        navItems.forEach(n => n.hidden = false)
        return
      }
      sections.forEach(s => {
        const text = s.textContent?.toLowerCase() ?? ''
        const match = text.includes(q)
        s.hidden = !match
      })
      navItems.forEach(n => {
        const target = n.dataset.target
        const sec = dlg.querySelector<HTMLElement>(`#help-sec-${target}`)
        n.hidden = !sec || sec.hidden
      })
    })
  }

  // 导入为参考文档
  const importBtn = dlg.querySelector<HTMLButtonElement>('#helpImportDocBtn')
  if (importBtn) {
    importBtn.onclick = () => {
      close()
      document.dispatchEvent(new CustomEvent('heurion:import-help-doc'))
    }
  }

  // 初始定位到目标章节
  if (initialSectionId) {
    setTimeout(() => {
      const secEl = dlg.querySelector(`#help-sec-${initialSectionId}`) as HTMLElement | null
      if (secEl && contentArea) {
        contentArea.scrollTop = secEl.offsetTop - contentArea.offsetTop
      }
    }, 60)
  }
}

/** 一键将手册导入为文档库中的正式参考指南 */
export async function importHelpAsDoc(
  api: ApiFn,
  loadDocs: () => Promise<void>,
  openDoc: (id: string) => Promise<void>,
  showNotice: (msg: string, isError?: boolean) => void
): Promise<void> {
  try {
    showNotice('正在将《产品使用手册》生成为工作区参考文档...')
    const markdown = buildHelpMarkdown()
    const title = 'Heurion 临床智能工作站全流程使用手册与操作指南'
    const res = await api<{ id: string }>('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, markdown })
    })
    await loadDocs()
    await openDoc(res.id)
    showNotice('《产品使用手册》已成功创建并打开！您可以随时在文档库中查阅或与 AI 对话。')
  } catch (err) {
    showNotice(`导入手册文档失败：${(err as Error).message}`, true)
  }
}
