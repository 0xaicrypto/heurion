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
    icon: '🚀',
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
          <div class="hfc-icon">📂</div>
          <div class="hfc-title">左侧导航 Rail & 资源栏</div>
          <div class="hfc-desc">管理三大核心空间切换、文档树、资料库（PDF/指南上传向量化）、回收站及用户中心配置。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">📄</div>
          <div class="hfc-title">中间主工作画布 (Center)</div>
          <div class="hfc-desc">富文本无损编辑器、医学学术幻灯片排版器、患者 3D MPR 影像切片浏览器及科研数据集透视表。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">✨</div>
          <div class="hfc-title">右侧伴随智能栏 (Side AI)</div>
          <div class="hfc-desc">伴随式 AI 对话、红绿 Diff 修订逐条采纳、学术论文审查建议、PubMed 文献溯源与历史版本回滚。</div>
        </div>
      </div>

      <h4>1.2 三大核心业务空间</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">✍️</span>
          <div>
            <b>写作空间 (Writing Space)</b>：支持起草临床指南、基金标书、SCI 论文、学术汇报幻灯片及病历讨论。深度整合 PubMed 全球医学文献检索与 Python 矢量医学图表生成。
          </div>
        </li>
        <li>
          <span class="step-num">🩻</span>
          <div>
            <b>患者空间 (Patients Space)</b>：严格遵循「零 PHI」安全建档。上传 DICOM / NIfTI 3D 影像，调用 MONAI 深度学习网络量化病灶，利用三正交 MPR 浏览器与双期差分热力图展开精准诊疗。
          </div>
        </li>
        <li>
          <span class="step-num">📊</span>
          <div>
            <b>临床研究空间 (Research Space)</b>：从临床试验方案立项、纳入排除标准筛选，到上传 SAS/SPSS/Excel 多中心数据表，一键自动生成 Table 1 基线表、Kaplan-Meier 生存曲线及 Cox 多因素森林图。
          </div>
        </li>
      </ul>

      <div class="help-callout tip">
        <span class="callout-icon">💡</span>
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
    icon: '🛡️',
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
        <b>⚠️ 严格禁止输入任何真实患者个人敏感信息：</b>
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
    icon: '✍️',
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
    title: '3D 影像量化分析与 MPR 浏览器',
    badge: '临床核心',
    icon: '🩻',
    summary: 'DICOM/NIfTI 上传、MONAI 3D 深度模型、BAR 支气管伴行动脉比、HAM 粘液栓分割与 MPR 三正交切片交互。',
    contentHtml: `
      <div class="help-section-head">
        <h3>4. 患者管理与 3D 影像量化分析 (3D Imaging & MONAI Quantification)</h3>
        <span class="help-tag ok">MONAI 深度学习 · 3D 体素</span>
      </div>
      <p class="help-lead">集成 MONAI 临床深度学习架构，支持全肺 HRCT、前列腺 mpMRI 等多模态影像的三维体素级精准分割与定量参数提取。</p>

      <h4>4.1 影像数据格式与上传规范</h4>
      <p>进入「患者」工作空间，选中患者代号后即可上传影像：</p>
      <ul>
        <li><b>支持格式</b>：DICOM 序列压缩包 (<code>.zip</code> 或 <code>.tar.gz</code>)、标准科研 NIfTI 卷 (<code>.nii</code> 或 <code>.nii.gz</code>)。</li>
        <li><b>元数据提取</b>：上传后后台自动解析体素几何间距 (Spacing 如 0.75mm)、空间维度 (512×512×N) 以及窗宽窗位标定。</li>
      </ul>

      <h4>4.2 MONAI 3D 深度学习病种量化能力</h4>
      <div class="help-grid-2">
        <div class="help-feature-card">
          <div class="hfc-title">🫁 胸部 HRCT · 支扩与粘液栓分析</div>
          <div class="hfc-desc">
            <ul>
              <li><b>支气管-伴行动脉比 (BAR)</b>：自动测量支气管内径与伴行动脉直径之比（正常 &lt; 1.0；&gt; 1.0 提示典型印戒征支扩）。</li>
              <li><b>高密度粘液栓 (HAM / 指套征)</b>：自动分割全部粘液栓簇，统计平均 CT 测值 (HU)、最大极值 HU 及 3D 总体积 (cm³)。</li>
              <li><b>气道壁增厚</b>：按管壁厚度与外径比率精确评估慢性炎症。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">🎯 前列腺 mpMRI · PI-RADS 3D 分割</div>
          <div class="hfc-desc">
            <ul>
              <li><b>解剖带分割</b>：T2WI 轴位精准分割移行带 (Transition Zone, TZ) 与外周带 (Peripheral Zone, PZ) 并测算体积。</li>
              <li><b>多参数融合</b>：融合 ADC 弥散受限图与 DWI 高 b 值序列，对可疑占位病灶标注 3D 径线与 PI-RADS 分级。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>4.3 交互式 MPR 三正交切片浏览器 (Multi-Planar Reconstruction)</h4>
      <p>点击任何已完成分析的影像，即可呼出全屏 MPR 诊断级浏览器：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>三视角即时切换</b>：支持<b>横断面 (Axial)</b>、<b>冠状面 (Coronal)</b>、<b>矢状面 (Sagittal)</b> 自由切换，通过切片滑块或鼠标滚轮逐层浏览。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>临床窗宽窗位 (WW/WL) 一键调窗</b>：预设肺窗 (-600 / 1500 HU)、纵隔窗 (40 / 400 HU)、骨窗 (300 / 1500 HU)、脑窗 (40 / 80 HU) 及软组织窗 (50 / 350 HU)，支持鼠标拖拽无级微调。
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <b>关键截面存证截图 (Capture Snapshot)</b>：点击「截取当前切片」，当前层位影像及窗宽窗位参数将自动沉淀为患者报告资产，在生成诊断报告时直接嵌入。
          </div>
        </li>
      </ul>
    `
  },
  {
    id: 'registration',
    title: '双期 3D 刚性配准、差分热力图与随访评估',
    badge: '临床演进',
    icon: '🔄',
    summary: '基线与随访 CT 空间自动刚性配准、差分吸收热力图图层、双联屏联动滑动及严谨的 RECIST 1.1 疗效评估规则。',
    contentHtml: `
      <div class="help-section-head">
        <h3>5. 双期 3D 刚性配准与差分吸收热力图 (Registration & RECIST Evaluation)</h3>
        <span class="help-tag">随访对比 · 空间对齐</span>
      </div>
      <p class="help-lead">针对多期随访患者，彻底告别“单张切片肉眼目测对比”，实现真正基于 3D 体素空间刚性配准的动态演变量化。</p>

      <h4>5.1 双期 3D 体素刚性配准与差分吸收热力图 (Difference Heatmap Overlay)</h4>
      <p>当同一患者拥有基线期 (Baseline) 与随访期 (Follow-up) 两套 CT 扫描时：</p>
      <ul>
        <li><b>自动空间校准</b>：调用 MONAI 刚性/仿射配准网络，将随访 CT 空间自动校准平移旋转对齐至基线坐标系。</li>
        <li><b>差分吸收热力图 (Difference Heatmap)</b>：计算两期三维体素的 HU 密度变化矩阵并在切片器上叠加显示：
          <ul>
            <li><span style="color:#00ff93; font-weight:600;">🟢 绿色区域</span>：表示炎性浸润吸收、粘液栓缩小退缩区域（好转缓解）。</li>
            <li><span style="color:#ff6b6b; font-weight:600;">🔴 红色区域</span>：表示新发浸润、病灶体积扩大或密度增高区域（进展恶化）。</li>
          </ul>
        </li>
      </ul>

      <h4>5.2 双联屏联动切片滑动 (Synchronized Dual-Scrubber MPR)</h4>
      <p>在随访对比弹窗中，嵌入左右并排的双 MPR 播放器：</p>
      <ul>
        <li>开启<b>「联动滚动 (Cursor Lock)」</b>后，滚轮在左侧基线切片滑动到相应解剖层面时，右侧随访根据对齐比例自动同步滚到对应层面，方便医生一目了然对比同解剖位点变化。</li>
      </ul>

      <h4>5.3 严格解耦的疗效评估准则 (RECIST 1.1 vs 良性炎性病灶)</h4>
      <div class="help-callout important">
        <span class="callout-icon">⚖️</span>
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
    icon: '🧬',
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
        <div class="hfc-title">💡 典型范式：变应性支气管肺曲霉病 (ABPA) 证据链拼装</div>
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
          <span class="step-num">🏥</span>
          <div>
            <b>DICOM SR (Structured Reporting)</b>：遵循 DICOM SOP Class <code>1.2.840.10008.5.1.4.1.1.88.22</code>，测量数值与病灶坐标以结构化编码存入 DICOM 文件，可直接上传导入医院 PACS。
          </div>
        </li>
        <li>
          <span class="step-num">🌐</span>
          <div>
            <b>HL7 FHIR (DiagnosticReport & ImagingStudy)</b>：导出符合 HL7 FHIR R4 标准的 JSON 资源包，支持直接对接区域卫生信息平台与电子病历系统 (EMR)。
          </div>
        </li>
      </ul>
    `
  },
  {
    id: 'research',
    title: '临床科研工作流 (Research)',
    badge: '统计分析',
    icon: '📊',
    summary: '方案设计、多中心数据集质控清洗、Table 1 基线表一键制表、Kaplan-Meier 生存曲线与 Cox 比例风险回归。',
    contentHtml: `
      <div class="help-section-head">
        <h3>7. 临床科研工作流 (Clinical Research & Automated Biostatistics)</h3>
        <span class="help-tag">科研立项 · 统计分析</span>
      </div>
      <p class="help-lead">覆盖临床研究方案拟定、多源多格式数据表质控导入、自动化医学统计学制表及文章发表归档全周期。</p>

      <h4>7.1 研究项目与方案管理</h4>
      <p>进入「研究」工作空间，点击「＋ 新建研究」：</p>
      <ul>
        <li>输入研究题目、临床试验注册号 (如 ChiCTR / ClinicalTrials.gov NCT ID)、研究类型（前瞻性 RCT、回顾性队列或病例对照）。</li>
        <li>结构化设定纳入与排除标准、暴露/干预因素及主要终点事件 (Primary Endpoint)。</li>
      </ul>

      <h4>7.2 多格式原始数据集导入与质控</h4>
      <p>在「数据集」面板中，支持直接上传主流统计软件原始文件：</p>
      <div class="help-grid-3">
        <div class="help-chip-card"><b>.csv / .xlsx</b><span>通用表格文件</span></div>
        <div class="help-chip-card"><b>.sas7bdat</b><span>SAS 数据集</span></div>
        <div class="help-chip-card"><b>.sav</b><span>SPSS 数据文件</span></div>
      </div>
      <p>系统自动扫描变量字典、数据类型识别、缺失值比例报告及异常极端值警示。</p>

      <h4>7.3 自动化高保真医学统计分析</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">📋</span>
          <div>
            <b>Table 1 基线特征表一键生成</b>：系统自动检验连续变量正态性，正态数据输出 <code>Mean ± SD</code> 并应用独立样本 t 检验；偏态数据输出 <code>Median (IQR)</code> 并应用 Wilcoxon/Mann-Whitney U 检验；分类变量输出 <code>N (%)</code> 并自动采用 Pearson 卡方检验或 Fisher 确切概率法，自动生成三线表。
          </div>
        </li>
        <li>
          <span class="step-num">📈</span>
          <div>
            <b>Kaplan-Meier 生存分析与 Log-Rank 检验</b>：绘制高精度生存概率曲线，计算中位生存时间 (Median OS / PFS) 及 95% CI，底部自动对齐展示各时间节点风险人数表 (Number at Risk)。
          </div>
        </li>
        <li>
          <span class="step-num">🌲</span>
          <div>
            <b>Cox 比例风险模型与森林图 (Forest Plot)</b>：支持单因素与多因素回归分析，计算风险比 (HR) 或比值比 (OR)，自动绘制矢量级森林图。
          </div>
        </li>
      </ul>

      <p>所有分析结果与生成图表均可一键归入「写作」文档，实现从临床数据分析到论文撰写的一键闭环。</p>
    `
  },
  {
    id: 'collaboration',
    title: '科室协作与知家家庭健康空间 (PHR)',
    badge: '协作共享',
    icon: '👥',
    summary: '科室诊疗组 RBAC 权限矩阵、个人专属知家家庭健康档案、患者安全扫码分享令牌及防泄密管控。',
    contentHtml: `
      <div class="help-section-head">
        <h3>8. 科室协作与知家家庭健康空间 (Collaboration & PHR)</h3>
        <span class="help-tag">权限矩阵 · 家人健康</span>
      </div>
      <p class="help-lead">兼顾院内科室团队高效协作与医生个人家庭健康管理，双重身份安全解耦。</p>

      <h4>8.1 科室团队与诊疗组 (Care Team)</h4>
      <ul>
        <li><b>角色分工</b>：机构管理员 (Admin)、主管医师 (Attending Physician)、辅助医师 (Fellow/Resident)。</li>
        <li><b>数据可见性</b>：不同医疗组之间实行患者病历权限隔离，确保诊疗隐私与数据追溯责任到人。</li>
      </ul>

      <h4>8.2 知家 (Personal Health Record, PHR) · 个人专属家庭空间</h4>
      <p>在右上角账户菜单点击「个人空间 (知家)」，即可切换至独立个人档案：</p>
      <ul>
        <li><b>物理级隔离</b>：知家属于医生个人空间，与医院工作台完全物理隔离。即使未来更换执业医院，知家中的家人体检报告、化验单及慢病指标永不丢失。</li>
        <li><b>AI 亲情化解读</b>：利用通俗易懂的语言对长辈体检异常指标进行科普化分析与随访建议。</li>
      </ul>

      <h4>8.3 患者随访与安全扫码分享</h4>
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
    icon: '❓',
    summary: '影像上传失败排查、切片对齐精度、导出排版微调与临床法律安全边界说明。',
    contentHtml: `
      <div class="help-section-head">
        <h3>9. 常见问题与操作贴士 (FAQ & Troubleshooting)</h3>
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

1. **左侧导航 Rail & 资源栏**：
   - **写作 (Write)**：文档与学术汇报幻灯片；
   - **患者 (Patients)**：以纯虚拟代号建档，3D 影像量化分析与多期随访；
   - **研究 (Research)**：临床课题立项、数据集质控与自动化统计制表；
   - **资料库 (Library)**：上传医学指南与论文，自动向量化供 AI 检索溯源；
   - **回收站与账户中心**：支持个人设置与医院机构管理。
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

## 四、 3D 影像量化分析与 MPR 浏览器

1. **影像上传规范**：
   - 支持 DICOM 序列压缩包 (\`.zip\` / \`.tar.gz\`) 与 NIfTI (\`.nii\` / \`.nii.gz\`)；
   - 自动解析体素空间间距 (Spacing) 与尺寸。
2. **MONAI 3D 深度模型**：
   - **胸部 HRCT**：
     - **支气管-伴行动脉比 (BAR)**：测量内径比值（正常 < 1.0；支气管扩张典型印戒征）；
     - **高密度粘液栓 (HAM / 指套征)**：自动多簇分割，量化均值 HU、极值 HU 及 3D 总体积 (cm³)；
     - **气道壁增厚率**。
   - **前列腺 mpMRI**：
     - T2WI + ADC + DWI 序列对齐；
     - 移行带 (TZ) 与外周带 (PZ) 体积精确分割；
     - PI-RADS 3D 病灶表征与体积勾画。
3. **交互式 MPR 三正交切片浏览器**：
   - 横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 三视角实时联动；
   - 窗宽窗位快捷切换：肺窗 (-600/1500)、纵隔窗 (40/400)、骨窗 (300/1500)、脑窗 (40/80)、软组织窗 (50/350)；
   - 关键切片一键存证截图 (Capture Snapshot)。

---

## 五、 双期 3D 刚性配准与差分吸收热力图

1. **自动 3D 空间配准**：
   - 利用 MONAI 轻量 3D 刚性/仿射配准网络，将随访 CT 空间自动平移旋转对齐至基线 CT。
2. **差分吸收热力图 (Difference Heatmap Overlay)**：
   - 计算两期体素差分矩阵并在切片器上叠加显示：
     - **绿色**：表示病灶缩小退缩或炎性吸收好转；
     - **红色**：表示新发浸润或病灶体积扩大进展。
3. **双联屏联动切片滑动 (Synchronized Dual-Scrubber)**：
   - 基线与随访切片器左右并排联动滚动，解剖结构精准对齐。
4. **严格区分疗效评估标准**：
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

## 七、 临床科研工作流 (Research)

1. **科研立项与方案管理**：临床试验注册号、纳入排除标准、主要终点设定；
2. **多格式数据集质控导入**：支持 CSV、Excel (\`.xlsx\`)、SAS (\`.sas7bdat\`)、SPSS (\`.sav\`)；自动检测缺失值与极端值；
3. **自动化生物统计制表**：
   - **Table 1 基线表**：正态分布 (Mean±SD, t检验) / 偏态分布 (Median(IQR), Wilcoxon) / 分类变量 (N(%), 卡方/Fisher) 自动选用；
   - **Kaplan-Meier 生存曲线**：绘制生存曲线、Log-Rank 检验、中位生存期与 Number at Risk 表；
   - **Cox 比例风险回归**：单因素与多因素分析，绘制风险比 (HR) 森林图。
4. **成果归档**：分析图表与结果一键导入写作论文。

---

## 八、 科室协作与知家家庭健康空间 (PHR)

1. **科室诊疗组 (Care Team)**：主诊医师与组员权限矩阵，敏感病历访问审计留痕；
2. **知家个人空间 (PHR)**：医生专属家庭健康空间，与医院工作台物理隔离，终身保留家人健康档案；
3. **安全分享与患者沟通**：生成临时有效期的只读脱敏链接，供患者扫码查阅通俗化随访建议。

---

## 九、 常见问题解答 (FAQ)

- **Q: 为什么上传 DICOM 耗时较长？**  
  A: 建议上传单个序列的压缩包（< 500MB），去除定位像后再压缩。
- **Q: 为什么生成的报告数值与正文完全自洽？**  
  A: 系统严密绑定底层结构化量化字段，彻底杜绝模板默认值与实测值冲突。
- **Q: AI 输出能直接当作法律效力的病历吗？**  
  A: 不能。所有 AI 辅助结论必须经执业医师审阅核对并签署确认后方可作为正式病历。
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
          <h2>📖 Heurion 临床智能工作站 · 全流程使用手册</h2>
          <span class="help-version-pill">v2.4 Pro</span>
        </div>
        <div class="help-head-actions">
          <div class="help-search-wrap">
            <input type="search" id="helpFilterInput" placeholder="搜索手册章节或关键词..." autocomplete="off">
          </div>
          <button id="helpImportDocBtn" class="primary small-btn" title="在您的工作区新建一份完整手册文档，方便随时查阅与边写边看">📥 导入为参考文档</button>
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
            <div class="hsf-tip">💡 提示：按 <code>Esc</code> 键可快速关闭手册。</div>
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
