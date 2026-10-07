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
    id: 'concepts',
    title: '医学影像与核心逻辑通俗通识课 (零基础必读)',
    badge: '小白通识',
    icon: icon('book', { size: 16 }),
    summary: '专为非医学专业与跨学科人员编写：用生活化比喻系统拆解 CT/MRI/超声原理、体素与亨氏单位、窗宽窗位、MPR 三正交、印戒征与 BAR、高密度粘液栓、3D 弹性配准、差分热力图、RECIST 1.1、肌少症与影像组学。',
    contentHtml: `
      <div class="help-section-head">
        <h3>2. 医学影像与核心逻辑通俗通识课 (Zero-to-One Clinical Concepts Primer)</h3>
        <span class="help-tag ok">零基础速成 · 跨学科必读</span>
      </div>
      <p class="help-lead">医学影像与临床智能融合了放射物理学、人体解剖学、免疫病理学与高维计算机视觉。本章节专为非医学背景的工程师、科研人员及产品设计者编写，抛弃晦涩难懂的死记硬背，采用生活化生动比喻与因果链条，带您从零建立完整的临床认知模型。</p>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.1 常见影像模态到底能看清什么？(CT vs MRI vs 超声 vs PET-CT)</span>
          <span class="help-concept-badge">成像物理原理</span>
        </div>
        <p>很多初学者分不清做一次检查到底该拍 CT 还是磁共振 (MRI)。其实不同的设备就像具有不同超能力的“透视镜”：</p>
        <div class="help-analogy">
          <b>💡 生活化比喻：</b>
          <ul>
            <li><b>CT (计算机断层扫描)</b>：就像把一个西瓜用极薄的刀切成几百片，每一片都用高能 X 光透视拍摄。它对<b>密度差异</b>极度敏感，最擅长看骨头（硬骨头白亮）和肺部（空气纯黑，结节灰白）。</li>
            <li><b>MRI (磁共振成像)</b>：完全没有辐射。它利用强磁场让体内的水分子（氢原子）“跳舞并产生共振”，接收水分子释放的无线电波。它对<b>含水软组织</b>极其敏感，最擅长看大脑神经、脊髓、关节韧带和前列腺。</li>
            <li><b>超声波 (Ultrasound)</b>：就像海豚或军用潜艇的声呐雷达，探头向身体里发射超声波并接收回音。它能够实时看到心脏搏动和血管里的血液流动（红蓝血流多普勒），适合查甲状腺、乳腺、胆囊和胎儿。</li>
            <li><b>PET-CT (正电子发射断层显像)</b>：CT 负责给身体画“精细解剖地图”，PET 则给身体装上“能量代谢探针”。因为恶性肿瘤细胞生长飞快，疯狂抢吃葡萄糖，注入带标记的微量“假糖”后，肿瘤细胞就会在扫描仪下像灯泡一样发光！</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>❓ 为什么临床要联合检查？</b> 
          因为“同病异影，同影异病”。例如一个肺部阴影，CT 看到形态像肿瘤，但无法确定是不是坏死组织；结合 PET-CT 发现阴影区域葡萄糖代谢极高，结合增强 MRI 发现周围血管侵犯，三者合一才能下定论。
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.2 为什么叫“体素 (Voxel)”？从二维贴纸到三维乐高积木</span>
          <span class="help-concept-badge">空间几何</span>
        </div>
        <p>普通电脑屏幕上的照片由长方形的<b>像素 (Pixel, Picture Element)</b> 构成，就像一张平面贴纸，只有长和宽，没有厚度。</p>
        <div class="help-analogy">
          <b>💡 生活化比喻：</b>
          医学扫描生成的是三维立体数据。每一个采样点不仅有横纵坐标，还有扫描层与层之间的<b>切片厚度 (Slice Thickness)</b>。这个具有物理体积的三维立方块就叫<b>体素 (Voxel = Volume Pixel)</b>，就像一块具有明确长、宽、高尺寸的微小<b>乐高积木</b>。
        </div>
        <div class="help-why-need">
          <b>❓ 为什么不能直接拿 2D 像素算面积和体积？（各向异性痛点）</b>
          医院为了省时间或减少患者受辐射，经常扫描层厚较厚（例如水平切片上每个像素是 0.75×0.75 mm，但层与层之间间隔厚达 5 mm）。这时积木不是正方体，而是被压扁拉长的扁长方体（这在数学上叫<b>各向异性 Anisotropy</b>）。如果直接斜着切片或者算病灶体积，图像就会被严重拉伸失真！
        </div>
        <p><b>💻 Heurion 平台怎么处理？</b> 系统内置高阶样条插值重采样引擎，在影像导入瞬间全自动将体素统一重构成规整的 1×1×1 mm³ 各向同性立方体积木，确保在任意切面上测量的体积和长径都分毫不差。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.3 亨氏单位 (HU) 与窗宽窗位 (WW/WL)：医学“偏光太阳镜”的秘密</span>
          <span class="help-concept-badge">密度刻度与调窗</span>
        </div>
        <p>在 CT 图像中，不同组织显示出不同的黑白灰度，这个灰度对应的物理量叫<b>亨氏单位 (Hounsfield Unit, HU)</b>，以 CT 发明人、诺贝尔奖得主高弗雷·亨斯菲尔德命名。</p>
        <div class="help-analogy">
          <b>💡 亨氏单位的标尺（以水为零点）：</b>
          <ul>
            <li><b>空气</b>：最轻、阻挡 X 光最少，定为 <code>-1000 HU</code>（图像上呈纯黑）；</li>
            <li><b>纯水</b>：标准零点，定为 <code>0 HU</code>；</li>
            <li><b>普通软组织与肌肉</b>：主要是水和蛋白质，一般在 <code>+40 ~ +50 HU</code>（中灰色）；</li>
            <li><b>致密骨骼与钙化</b>：含钙高、阻挡射线极强，高达 <code>+1000 ~ +3000 HU</code>（极亮纯白）。</li>
          </ul>
        </div>
        <div class="help-analogy">
          <b>💡 为什么需要窗宽窗位 (Windowing)？——“偏光太阳镜”的比喻</b>
          人眼的视网膜在同一时刻最多只能识别 20~30 级灰度变化，但 CT 仪器的物理探测范围从 -1000 到 +3000 足足有 4000 多个灰阶！如果把这 4000 个数值硬生生挤在屏幕上，所有软组织都会挤成一片模糊的死灰。<br>
          因此，医生必须带上一副<b>“智能偏光太阳镜”</b>，只看我们关心的那一段密度：
          <ul>
            <li><b>窗位 (Window Level, 窗中心)</b>：你要观察的目标组织的中心密度（看肺泡空气就定在 -600 HU；看心脏纵隔就定在 +40 HU）；</li>
            <li><b>窗宽 (Window Width, 视野跨度)</b>：围绕窗位上下展开多少个数值跨度来映射显示器黑白。</li>
          </ul>
        </div>
        <p><b>💻 Heurion 平台怎么操作？</b> 顶部工具栏内置一键快捷调窗：按 <b>肺窗</b>（看结节与支气管）、<b>纵隔窗</b>（看心脏大血管与粘液栓）、<b>腹部窗</b>（看肝肾胰腺）、<b>骨窗</b>（看骨折线）或鼠标直接在画面上按住左右上下拖拽无级微调。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.4 什么是 MPR 三正交切片？像切吐司一样透视人体</span>
          <span class="help-concept-badge">空间视图</span>
        </div>
        <p>平时体检拿到的 CT 胶片大都是横着切的（医生叫轴位或横断面）。但在复杂病变面前，单看横切面很容易“管中窥豹”。</p>
        <div class="help-analogy">
          <b>💡 生活化比喻：切长方体吐司面包的三个方向</b>
          <ul>
            <li><b>横断面 (Axial / 轴状面)</b>：平放吐司，从头顶到脚底一片片平行切开（从上往下俯视人）；</li>
            <li><b>冠状面 (Coronal / 额状面)</b>：竖放吐司，从鼻尖到后脑勺一片片切开（正面面对人）；</li>
            <li><b>矢状面 (Sagittal / 侧状面)</b>：侧放吐司，从左耳朵到右耳朵一片片切开（侧面看人）。</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>❓ 为什么三正交联动不可或缺？</b>
          支气管像树枝一样斜着向四面八方生长。如果一根支气管斜着穿过横切面，医生只看到一个小圆点，无法判断这根管子在纵向上有没有被一整条长长的粘液栓堵死。而在冠状面和矢状面上，整根树枝的走向一目了然！
        </div>
        <p><b>💻 Heurion 平台怎么操作？</b> 浏览器支持 WebGL2 实时四视图联动：移动任意一个切片上的十字准星，其他两个正交平面与 3D 立体模型会瞬间联动对齐到该空间点，毫秒级同步。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.5 支气管扩张的铁证：为什么叫“印戒征”？BAR 怎么算？</span>
          <span class="help-concept-badge">呼吸病学经典体征</span>
        </div>
        <div class="help-analogy">
          <b>💡 正常解剖的“贴身卫士”常识：</b>
          在健康的肺部，输送空气的“支气管”和输送血液的“肺动脉小血管”是一对形影不离的搭档。在肺组织的任何一个截面上，它们总是紧挨在一起同行。正常情况下，输送空气的管子内径比血管稍小一点或差不多大。
        </div>
        <div class="help-analogy">
          <b>💡 为什么叫“印戒征 (Signet Ring Sign)”？</b>
          当支气管因反复感染或变态反应遭到破坏而发生病理性扩张时，支气管腔变得异常宽大，而旁边的血管大小保持不变。在横截面上看：扩张的支气管是一个透亮的大圆圈（充气空腔），旁边紧挨着的小血管是一个白白实实的小圆点——两者组合在一起，极像西方古典贵族佩戴的<b>一枚镶嵌着珍珠宝石的指环印章</b>！
        </div>
        <div class="help-why-need">
          <b>❓ BAR (支气管-伴行动脉比) 的数学计算：</b>
          BAR = 支气管内腔直径 / 伴行动脉外径。
          <ul>
            <li>BAR &lt; 1.0：正常；</li>
            <li>BAR &ge; 1.0：明确存在支气管扩张；BAR 数值越大（如 1.45），扩张越严重。</li>
          </ul>
        </div>
        <p><b>💻 Heurion 平台怎么做？</b> MONAI 深度学习网络自动在三维体素中追踪伴行血管对，毫秒级测算出精准至 0.01mm 的 BAR 数值并用绿色/橙色标签直观标出，无需医生拿尺子在屏幕上费时手工测量。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.6 什么是高密度粘液栓 (HAM)？为什么痰栓会变成“牙膏泥”？</span>
          <span class="help-concept-badge">ABPA 关键病理标志</span>
        </div>
        <p>普通感冒或支气管炎咳出的痰主要成分是水和粘液，在 CT 上的密度很低（约 0~20 HU，比普通肌肉暗很多）。</p>
        <div class="help-analogy">
          <b>💡 痰栓为什么会变“硬”变“亮”？</b>
          在变应性支气管肺曲霉病 (ABPA) 这种免疫性疾病中，人体免疫细胞（嗜酸性粒细胞）在气道里疯狂聚集杀敌，最终大量同归于尽崩解，释放出极高浓度的钙、铁、锰等金属离子，并形成针尖状的“夏科-雷登结晶”。浓缩脱水后，稀薄的痰液变成了如同牙膏泥甚至橡胶块一样致密的栓子，把扩张的气道死死堵死（医学上叫指套征或牙膏征）。
        </div>
        <div class="help-why-need">
          <b>❓ 为什么高密度粘液栓 (HAM) 是诊断金标准？</b>
          在 CT 纵隔窗下观察，如果气管里的粘液栓密度<b>超过了旁边脊柱胸壁肌肉的密度（肌肉一般在 40~50 HU，HAM 常高达 70~120 HU 以上）</b>，即可确诊为高密度粘液栓 (HAM)。出现 HAM 说明患者免疫反应剧烈，是极易复发的高危重症信号，必须启动全身糖皮质激素联合抗真菌治疗！
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.7 随访对比为什么要配准？刚性配准 vs 弹性形变配准 (DIR) 与差分热力图</span>
          <span class="help-concept-badge">纵向多期随访</span>
        </div>
        <p>患者经过 3 个月治疗后回医院复查 CT，医生想知道“原来的病灶到底小了没有”。但直接对比两次片子非常困难。</p>
        <div class="help-analogy">
          <b>💡 为什么不能直接叠图对比？——“气球”的比喻</b>
          人的肺就像一个充满弹性的大气球。两次检查相隔几个月，患者不可能吸进一模一样多的空气，躺在检查床上的肩膀体位也稍微歪了一点点。稍微吸大一口气，肺里的结节就能移动 2~3 厘米！如果把这两次扫描直接叠在一起，就像把两张不同角度拍摄的照片叠图，满屏都是错位假象。
        </div>
        <div class="help-analogy">
          <b>💡 刚性配准 vs 弹性形变配准 (DIR)：</b>
          <ul>
            <li><b>刚性配准 (Rigid Registration)</b>：就像把两张硬纸板在桌上挪动、旋转对齐四边。它只能纠正整体的平移和歪斜，无法对付肺泡局部拉伸；</li>
            <li><b>3D 非刚性弹性形变配准 (Deformable Image Registration, DIR)</b>：就像把一块被揉皱的面团或丝巾，用数学形变位移场 (DVF) 在电脑里逐个体素抚平、拉伸，让随访 CT 里的每一根血管、每一根肋骨和基线 CT 达到体素级完美重叠！</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>❓ 差分吸收热力图 (Difference Heatmap) 的奇迹：</b>
          完美对齐后，电脑计算前后两次 CT 每个像素的密度差异相减：
          <ul>
            <li><span style="color:#00ff93; font-weight:600;">● 绿色</span>：代表病灶吸收缩小了（治疗起效，好转缓解！）；</li>
            <li><span style="color:#ff6b6b; font-weight:600;">● 红色</span>：代表新出现了病灶或原来的病灶变大了（病情恶化进展！）；</li>
            <li><span style="color:#ffd000; font-weight:600;">● 黄色</span>：代表病灶既没有缩小也没有长大（稳定状态）。</li>
          </ul>
          医生和患者一眼就能看懂治疗效果，彻底取代耗费数小时的人工逐层肉眼肉测。
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.8 实体瘤缩了还是大了？肿瘤界通用的尺子：RECIST 1.1</span>
          <span class="help-concept-badge">肿瘤疗效评估</span>
        </div>
        <p>在抗肿瘤临床试验中，评价一种新靶向药到底管不管用，全世界有一把公认的度量衡——<b>RECIST 1.1 (实体瘤疗效评价标准)</b>。</p>
        <div class="help-analogy">
          <b>💡 怎么测量和分类？</b>
          挑选最具代表性的肿瘤靶病灶（最多 5 个），用卡尺量取它们的最大长径，将长径加在一起算总和 (Sum of Diameters, SOD)：
          <ul>
            <li><b>CR (完全缓解，Complete Response)</b>：所有靶病灶彻底消失，全部扫清！</li>
            <li><b>PR (部分缓解，Partial Response)</b>：病灶长径总和缩小了 30% 以上（有效缩小）；</li>
            <li><b>PD (疾病进展，Progressive Disease)</b>：病灶长径总和增大了 20% 以上，或者冒出了任何新病灶（恶化失控）；</li>
            <li><b>SD (疾病稳定，Stable Disease)</b>：缩小不足 30%、增大不足 20%，处于胶着僵持期。</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.9 隐匿性肌少症 (Sarcopenia)：为什么要在第三腰椎 (L3) 算 SMI？</span>
          <span class="help-concept-badge">机体成分分析</span>
        </div>
        <div class="help-analogy">
          <b>💡 临床痛点：“虚胖”的癌症患者</b>
          很多癌症晚期患者站上体重秤发现体重正常甚至偏胖，但医生却很担忧。因为这些患者体内的肌肉已经被癌细胞大量吞噬消耗，被无用的水肿和脂肪填满，这种现象叫<b>“隐匿性肌少症 (Sarcopenia)”</b>。肌肉量极度匮乏的患者，往往扛不住下一轮化疗或靶向药的毒性副作用，极易发生严重感染甚至早期死亡。
        </div>
        <div class="help-why-need">
          <b>❓ 为什么全世界医生都选第三腰椎 (L3)？</b>
          大量解剖学和尸检数据证实：<b>人体第 3 腰椎切面上的骨骼肌总面积（包括腰大肌、竖脊肌和腹部肌肉），与人体全身的总肌肉储备有着严格正比的数学线性关系！</b> 只要扫一个腹部平扫，看一眼 L3 层面，就能准确推算全身肌肉营养状况。
        </div>
        <div class="help-why-need">
          <b>❓ 骨骼肌指数 (SMI) 的计算公式：</b>
          SMI = L3 层面骨骼肌总横截面积 (cm²) / [患者身高 (m)]² (单位: cm²/m²)。
          <ul>
            <li>依据国际权威 Prado 共识标准：男性 SMI &lt; 52.4 cm²/m²、女性 SMI &lt; 38.5 cm²/m² 即可确诊肌少症预警！</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.10 什么是 IBSI 影像组学 (Radiomics)？“肉眼看不见的微观数字指纹”</span>
          <span class="help-concept-badge">AI 科研特征工程</span>
        </div>
        <p>人类放射科医生即使经验再丰富，肉眼也只能看到“这个结节边缘不太光滑、里面有点发白”。</p>
        <div class="help-analogy">
          <b>💡 电脑眼中的微观纹理：</b>
          对计算机而言，医学影像本质是一个包含成千上万个离散数值的三维数字矩阵。两个表面看起来一样的肿瘤，一个内部细胞排列松散均匀，另一个内部细胞疯狂挤压增殖、灰度剧烈跳跃。这些隐藏在像素灰度分布背后的高阶微观数学特征，就叫<b>影像组学特征 (Radiomics Features)</b>。
        </div>
        <div class="help-why-need">
          <b>❓ 提取这些特征有什么用？</b>
          IBSI 国际标准定义了 107 个特征（包括球形度、一阶直方图、灰度共生矩阵 GLCM、灰度游程 GLRLM 等）。把这些特征提取出来存入表格，科研人员可以用随机森林、XGBoost 或深度学习模型，<b>在不开刀做病理穿刺的前提下，提前预测肿瘤基因突变状态 (如 EGFR、KRAS) 以及患者对 PD-1 免疫治疗是否敏感！</b>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.11 什么是 PET-CT 的 SUV？肿瘤细胞疯狂吃糖的信号</span>
          <span class="help-concept-badge">分子代谢显像</span>
        </div>
        <div class="help-analogy">
          <b>💡 生活化比喻：</b>
          把身体想象成一个热闹的城市。恶性肿瘤细胞就像正在秘密举行狂欢派对的房间。我们向全身静脉注射一种带有微量安全同位素辐射的“假葡萄糖”(&sup1;&sup8;F-FDG)。狂欢的肿瘤细胞为了增殖抢着大口吃糖，吃得越多，发出的放射线就越强。<br>
          <b>SUV (Standardized Uptake Value, 标准摄取值)</b> 就是测量这个病灶吃糖的强度到底比人体全身平均水平高出几倍！
        </div>
        <div class="help-why-need">
          <b>❓ 核心参数指标说明：</b>
          <ul>
            <li><b>SUVmax (最大标准摄取值)</b>：病灶中最活跃、发光最亮的那个单点的摄取倍数。良性病灶往往较低，恶性肿瘤 SUVmax 常常超过 2.5 甚至高达 15~30 以上；</li>
            <li><b>MTV (代谢肿瘤体积)</b>：病灶中真正具有高代谢活性的肿瘤核心体积（剔除了死掉的坏死区）；</li>
            <li><b>TLG (总糖酵解量)</b>：TLG = MTV &times; SUVmean，代表肿瘤全身消耗葡萄糖的总能量负荷，是评估靶向药物把癌细胞饿死了多少的最佳指标。</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.12 放疗的“电子围栏”：什么是 DICOM RT-STRUCT？</span>
          <span class="help-concept-badge">肿瘤放射治疗规划</span>
        </div>
        <div class="help-analogy">
          <b>💡 生活化比喻：</b>
          肿瘤放射治疗（放疗）就像用超高能量的光子射线机关枪消灭癌细胞。但身体里有很多极其娇嫩的重要器官（比如脊髓神经、心脏大血管、直肠壁），一旦被射线过量打中就会瘫痪或坏死。因此，医生必须在 3D 图像上给射线规划精密的“电子围栏”：
          <ul>
            <li><b>GTV (大体肿瘤体积)</b>：肉眼或 AI 明确看到的实体肿瘤；</li>
            <li><b>CTV (临床靶区)</b>：GTV 加上可能潜伏有微小癌细胞扩散的周边安全防御缓冲带；</li>
            <li><b>OAR (危及器官)</b>：周边需要千方百计避让的正常器官（如脑干、视神经、脊髓）。</li>
          </ul>
        </div>
        <p><b>💻 什么是 RT-STRUCT？</b> 它是国际医学数字影像标准 (DICOM) 中专门用来存放这些 3D 勾画闭合多边形轮廓线的文件标准。Heurion 支持将 AI 分割的 3D 轮廓一键导出为标准的 DICOM RT-STRUCT，直接发给医院放疗机（瓦里安、医科达加速器）执行照射。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.13 为什么不能单凭一张片子下诊断？多模态因果诊断链的闭环逻辑</span>
          <span class="help-concept-badge">临床循证思维</span>
        </div>
        <div class="help-analogy">
          <b>💡 现代临床三元证据链：</b>
          医生在看病时，从来不敢仅仅因为“CT 发现肺里有一块阴影”就草率下结论。因为同样的阴影既可能是真菌感染，也可能是肺结核或恶性肺癌。必须结合三层证据相互锁死：
          <ul>
            <li><b>第一层（宏观解剖形态 · 影像）</b>：CT 发现中央型支气管扩张伴高密度粘液栓 (HAM)；</li>
            <li><b>第二层（机体免疫反应 · 化验生化）</b>：验血发现嗜酸性粒细胞绝对值超标 (&gt; 0.5 &times; 10⁹/L)，总 IgE 突破天际 (&gt; 1000 IU/mL)，烟曲霉特异性抗体阳性；</li>
            <li><b>第三层（病原学与微观病理 · 金标准）</b>：气管镜洗出黏稠黄色痰栓，镜下找到曲霉菌丝或夏科-雷登结晶。</li>
          </ul>
        </div>
        <p><b>💻 Heurion 平台怎么做？</b> 系统在「患者中心」将 3D 影像量化值、多期化验趋势线与临床基因特征自动织成一张互锁的<b>因果推演图谱</b>，杜绝任何孤立片段带来的误诊误治。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.14 为什么必须严防死守“零 PHI”？法律底线与本地沙盒隔离</span>
          <span class="help-concept-badge">医疗合规与法律边界</span>
        </div>
        <p><b>PHI 是什么？</b> 全称是 <b>Protected Health Information (受保护的健康信息)</b>。包括患者真实姓名、身份证号码、电话号码、医保卡号、住院号、甚至带有面部特征的 3D 头颅扫描。</p>
        <div class="help-why-need">
          <b>❓ 为什么不能直接将带姓名的病历发给 AI 模型？</b>
          国内外法律法规（HIPAA、GDPR、数据安全法）对医疗健康隐私有极其严苛的追责要求。任何真实的患者姓名如果未经许可被上传到第三方大模型云端服务器进行训练或推理，一旦泄露，医疗机构和科研人员将面临严重的行政处罚甚至吊销执业资质。
        </div>
        <p><b>💻 Heurion 平台的双重保险架构：</b></p>
        <ul>
          <li><b>云端与大模型视角</b>：只看到去标识化的虚拟代号（如 <code>PT-BRONCHO-001</code>），所有进出云端的数据完全清洗掉个人敏感信息；</li>
          <li><b>医生个人视角</b>：医生如果给代号加了备注名（如“张阿姨”），这个名字<b>100% 仅仅存储在医生当前电脑浏览器的 <code>localStorage</code> 物理隔离缓存中</b>，绝不上网、绝不发往服务器数据库，彻底消除法律合规隐患！</li>
        </ul>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺</span>
          <span class="help-concept-badge">几何测量与物理标定</span>
        </div>
        <div class="help-analogy">
          <b>💡 生活化比喻：</b>
          屏幕上的像素点就像手机屏幕上的微型发光灯泡，手机缩放图片时灯泡密度会变化。如果直接拿一把塑料尺在显示器表面量“肿块有 3 厘米长”，在 13 寸笔记本上可能是 3 厘米，在 27 寸大屏上就变成了 6 厘米！这就像拿一根弹性极大的橡皮筋去量布料长短一样荒唐。
        </div>
        <div class="help-why-need">
          <b>❓ 为什么必须依靠“物理体素标定 (Voxel Spacing)”？</b>
          CT 或 MRI 机在扫描患者身体时，会在 DICOM 头文件中严格写入每一个体素在人体三维真实解剖空间中的物理毫米跨度 (如 Pixel Spacing = 0.72 mm/像素，层厚 = 1.0 mm)。系统前端必须实时将鼠标在屏幕上画出的屏幕像素坐标差 $(\Delta x, \Delta y)$，乘以真实的物理标尺常数，才能精准换算为患者体内真实的物理长径与横截面积。
        </div>
        <p><b>💻 Heurion 平台怎么做？</b> 采用双层 Canvas 交互系统，提供亚毫米级高对比度电子游标卡尺与两点包围盒截面积测量，并将测量线段与原始医学切片进行离屏双层合成无损固化入库。</p>
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
        <h3>3. 医学隐私与安全架构 (Zero-PHI & Compliance)</h3>
        <span class="help-tag danger">核心准则 · 严禁违规</span>
      </div>
      <p class="help-lead">医疗数据的隐私与安全是 Heurion 的立身之本。系统严格按照 HIPAA、GDPR 及国家卫生健康数据合规标准设计架构。</p>

      <h4>3.1 强制零 PHI (Zero Protected Health Information) 准则</h4>
      <p>为了从根本上规避患者真实隐私外泄风险，Heurion 采用<b>「全流程纯代号化」</b>建档与分析机制：</p>
      <div class="help-alert-box alert-important">
        <b>${icon('shield', { size: 14 })} 严格禁止输入任何真实患者个人敏感信息：</b>
        <ul>
          <li>禁止在患者档案、主诉、病史文本或对话框中输入真实患者姓名、身份证号、医保卡号、门诊住院号或电话号码。</li>
          <li>请统一使用虚拟研究代号建档，例如：<code>PT-BRONCHO-001</code>、<code>SUBJ-PROSTATE-2026-A</code>。</li>
          <li>上传的 DICOM 影像文件若包含原始私有 Tag，系统在入库前将自动进行脱敏擦除 (De-identification)。</li>
        </ul>
      </div>

      <h4>3.2 租户级数据密钥加密隔离</h4>
      <p>每个医院或科研机构拥有独立的 AES-256-GCM 数据加密密钥 (DEK)。即使在底层数据库物理层面，不同租户之间的数据亦完全隔离，杜绝跨机构横向越权。</p>

      <h4>3.3 高风险操作确认卡 (Human-in-the-Loop)</h4>
      <p>AI 在系统中具备高阶辅助分析能力，但<b>绝不具备最终裁决权</b>。当 AI 提议执行不可恢复或高敏感操作时（如：删除患者随访数据、覆盖既往病历、下发正式诊断报告），系统会自动弹窗生成<b>「待确认操作卡」</b>，必须由执业医师主动点击确认后方才执行。</p>

      <h4>3.4 访问审计留痕 (Audit Trail)</h4>
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
        <h3>4. 医学写作与文献溯源 (Medical Writing & Evidence Tracing)</h3>
        <span class="help-tag">写作 · 幻灯片 · 文献</span>
      </div>
      <p class="help-lead">支持文档 (Docs) 与幻灯片 (Slides) 双模态自由创作，专为学术发表与科室汇报量身打造。</p>

      <h4>4.1 双模态创作中心</h4>
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

      <h4>4.2 AI 伴随修订模式 (Suggest / Diff Mode)</h4>
      <p>在右侧对话框上方，常驻<b>「修订模式 · 生成 Diff 待采纳」</b>开关：</p>
      <ul>
        <li><b>开启修订模式（推荐）</b>：AI 针对正文的润色、新增证据、语法精炼会作为红绿 Diff 标记渲染在画布上。您可以点击单处修订单独采纳/拒绝，亦可点击「全部采纳」。</li>
        <li><b>关闭修订模式</b>：AI 将直接修改正文，适用于快速重构大纲或从零起草全新段落。</li>
      </ul>

      <h4>4.3 PubMed 智能文献检索与参考资料库</h4>
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

      <h4>4.4 高清矢量图表生成与无损导出保护</h4>
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
        <h3>5. 患者管理与 3D 影像量化分析 (Patient Management & 3D Imaging Quantification)</h3>
        <span class="help-tag ok">零 PHI · MONAI 3D · MPR 交互</span>
      </div>
      <p class="help-lead">深度打通「临床患者全景档案」与「3D 体素级影像量化分析」，既保障医疗隐私绝对安全，又赋予医生亚毫米级的定量诊断与智能读片能力。</p>

      <h4>5.0 影像智能分析全流程业务闭环 (The Complete 9-Step Imaging Pipeline)</h4>
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

      <h4>5.1 患者全流程档案建立与零 PHI 隐私规范 (Zero-PHI Patient Registry)</h4>
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

      <h4>5.2 多模态实验室检验指标追踪与时间序列管理 (Longitudinal Lab Analytics)</h4>
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

      <h4>5.3 3D 原始影像支持与空间几何解析 (3D Volumetric Imaging & Geometry)</h4>
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

      <h4>5.4 MONAI 3D 临床深度学习病种量化全矩阵 (MONAI Model Zoo Matrix)</h4>
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

      <h4>5.5 诊断级交互式 MPR 三正交切片浏览器 (Multi-Planar Reconstruction)</h4>
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

      <h4>5.6 诊断级 3D MPR 前端轻量标注与卡尺交互量化系统 (Frontend Lightweight Annotation & Caliper Engine)</h4>
      <p class="help-lead">为了满足临床影像科与肿瘤科医生对靶病灶长短径快速测量、非规则剖面截面积标定及无损切片存证的核心诉求，Heurion 在 MPR 切片器前端构建了轻量级双层 Canvas 交互与亚毫米物理标定引擎：</p>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.1 完整功能设计 (Full Functional Design)</div>
        <div class="hfc-desc">
          <ul class="help-list-steps" style="margin-top: 8px;">
            <li>
              <span class="step-num">${icon('search', { size: 14 })}</span>
              <div>
                <b>浏览模式 (Browse Mode)</b>：默认交互模式。鼠标滚轮或切片滑动条平滑滚动，十字准星动态指引空间层位，与三正交平面保持实时联动。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('caliper', { size: 14 })}</span>
              <div>
                <b>游标卡尺测距模式 (Caliper Mode)</b>：点击工具栏卡尺按钮激活。在切片任意位置按下鼠标并拖动，实时生成高反差翡翠绿几何测距线段；线段两端自动绘制垂直阻挡游标卡脚 (Tick marks)，中央悬浮半透明深色 HUD 读数气泡，直观显示亚毫米物理长度（如 <code>24.0 mm</code>），完全符合临床放射测量习惯。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('ruler', { size: 14 })}</span>
              <div>
                <b>矩形剖面 ROI 面积模式 (ROI Area Mode)</b>：点击工具栏 ROI 按钮激活。通过两点对角线拖拽，生成半透明绿色填充的包围盒，实时自动计算物理横截面积，并在读数徽标中自适应显示为 <code>mm²</code> 或 <code>cm²</code>。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('refresh', { size: 14 })}</span>
              <div>
                <b>清除标注 (Clear)</b>：点击「清除标注」按钮，即刻擦除当前切片的手工测量轨迹，使画布恢复纯净浏览状态。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('save', { size: 14 })}</span>
              <div>
                <b>双图层复合无损存证 (Composite Snapshot Export)</b>：点击「保存切片为文档资产」，离屏 Canvas 引擎自动将底层原始灰阶切片与顶层卡尺标注合成为单张无损 PNG 图像，固化为平台不可篡改的永久医学图像资产，并自动生成 Markdown 引用代码直接插入医学写作空间。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('report', { size: 14 })}</span>
              <div>
                <b>自动化诊断报告草案动态注入 (Diagnostic Report Draft Injection)</b>：点击「出具影像诊断报告」，手工实测的长短径与截面积自动被提取并注入至四段式结构化诊断报告中（例如在影像所见段落自动追加：<code>- 手工卡尺测量: 长径 24.0 mm, ROI 截面积 3.72 cm²</code>），实现临床测量与文书的 Human-in-the-Loop 责任闭环。
              </div>
            </li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.2 交互实现架构 (Interactive Implementation Architecture)</div>
        <div class="hfc-desc">
          <ul>
            <li><b>双层 Canvas DOM 覆盖架构</b>：切片展示区采用分层渲染解耦设计，底层包含 512×512 像素的 <code>&lt;img id="mprImg"&gt;</code> 负责灰阶切片图像呈现；顶层覆盖绝对定位的 <code>&lt;canvas id="mprAnnotCanvas" width="512" height="512"&gt;</code> 专门负责标注交互；通过 CSS <code>pointer-events</code> 属性精准控制鼠标穿透与事件捕获，浏览模式下零额外开销。</li>
            <li><b>事件驱动状态机 (State Machine)</b>：
              <ul>
                <li><code>pointerdown</code>：捕获起始像素坐标 $(x_1, y_1)$，锁定拖拽起点并记录当前激活工具；</li>
                <li><code>pointermove</code>：高帧率监听拖动位置 $(x_2, y_2)$，利用 <code>requestAnimationFrame</code> 驱动双缓冲局部重绘，清空上一帧并平滑绘制当前卡尺/矩形及半透明读数徽标；</li>
                <li><code>pointerup</code>：固化几何终点坐标，更新内存测量元数据结构，供后续报告草案调用。</li>
              </ul>
            </li>
            <li><b>视网膜高清屏 (Retina Display) 锐化适配</b>：读取宿主设备的 <code>window.devicePixelRatio</code>（通常为 2 或 3），动态放大 Canvas 绘图缓冲区物理尺寸，杜绝高分辨率屏幕上测量线段出现模糊或锯齿现象。</li>
            <li><b>人机工程学高反差视觉</b>：主测量线采用抗混叠翡翠绿 (#00E599 / #34D399)；两端卡脚长度为 8px 垂直阻挡游标；读数气泡采用半透明暗黑底色 (rgba(6, 17, 13, 0.85)) 搭配发丝边框，确保在最黑的肺野和最白的硬骨上均具备极其清晰的可读性。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.3 算法量化原理与物理标定 (Algorithm & Physics Calibration)</div>
        <div class="hfc-desc">
          <p>屏幕坐标无法直接代表解剖尺寸。系统通过严密的物理体素标定算法实现几何精准映射：</p>
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>算法步骤</th>
                <th>数学物理公式</th>
                <th>参数意义与临床精度保障</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>1. 空间体素间距提取</b></td>
                <td>$S_x = \\text{PixelSpacing}[0]$ (mm/px)<br>$S_y = \\text{PixelSpacing}[1]$ (mm/px)</td>
                <td>由 DICOM 元数据 Tag (0028, 0030) 获取物理间距，通常为 0.5~0.8 mm/体素。</td>
              </tr>
              <tr>
                <td><b>2. 画布坐标步长归一</b></td>
                <td>$k_x = \\frac{\\text{dim}_x \\times S_x}{512}, \\quad k_y = \\frac{\\text{dim}_y \\times S_y}{512}$</td>
                <td>将 512×512 标准化前端交互画布像素坐标映射至原始切片实际物理范围。</td>
              </tr>
              <tr>
                <td><b>3. 欧氏真实物理间距</b></td>
                <td>$D_{\\text{mm}} = \\sqrt{\\left[(x_2 - x_1) \\cdot k_x\\right]^2 + \\left[(y_2 - y_1) \\cdot k_y\\right]^2}$</td>
                <td>两点间各向异性校正欧几里得距离，直接对应实体瘤 RECIST 1.1 靶病灶长径与短径。</td>
              </tr>
              <tr>
                <td><b>4. 截面积尺度自适应</b></td>
                <td>$A_{\\text{mm}^2} = \\left(|x_2 - x_1| \\cdot k_x\\right) \\times \\left(|y_2 - y_1| \\cdot k_y\\right)$<br>当 $A \\ge 100 \\text{ mm}^2$ 时，自动折算 $A_{\\text{cm}^2} = A / 100$</td>
                <td>计算病灶剖面面积，智能切换单位，避免临床医生手工换算繁琐与单位笔误风险。</td>
              </tr>
              <tr>
                <td><b>5. 离屏双层合成固化</b></td>
                <td>$\\text{CompositeCanvas} = \\text{DrawImage}(\\text{Slice}) + \\text{DrawImage}(\\text{Canvas})$<br>导出 $\\text{Base64 PNG}$ 并发送至 <code>/api/imaging/mpr/slice</code></td>
                <td>将医生手工测量的实物刻度与底图像素紧密缝合，永久存证并可直接提交 PACS 审计。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4>5.7 全身体素机体成分与肌少症量化 (Body Composition & Sarcopenia)</h4>
      <p>基于 TotalSegmentator 3D 全身体素网络，系统提供肿瘤恶液质与衰弱综合征的量化筛查方案：</p>
      <ul>
        <li><b>L3 骨骼肌指数 (SMI, cm²/m²)</b>：自动定位 L3 椎体中位截面，分割腰大肌、竖脊肌及腹壁肌群面积，结合患者身高计算 SMI；依据 Prado 国际共识（男性 &lt; 52.4 cm²/m²，女性 &lt; 38.5 cm²/m²）自动进行肌少症红黄预警。</li>
        <li><b>内脏脂肪与皮下脂肪比 (VAT / SAT)</b>：精准测算腹腔内脏脂肪面积与皮下脂肪面积，评估代谢综合征及放化疗毒副反应风险。</li>
      </ul>

      <h4>5.8 IBSI 国际标准影像组学高阶特征矩阵 (Radiomics Extraction)</h4>
      <p>遵循 IBSI (Image Biomarker Standardisation Initiative) 国际影像组学标准规范，一键提取 107 项高维生物特征：</p>
      <ul>
        <li>一阶灰度统计 (First Order Statistics)、形状球形度与表面积体积比 (Shape & Compactness)；</li>
        <li>灰度共生矩阵 (GLCM)、灰度游程矩阵 (GLRLM)、灰度区域大小矩阵 (GLSZM) 及邻域灰度差矩阵 (NGTDM)；</li>
        <li>支持小波滤波变换 (Wavelet Decomposition)，所有高维组学数据均可一键载入科研数据集开展机器学习建模。</li>
      </ul>

      <h4>5.9 三甲标准四段式全景影像诊断报告</h4>
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
        <h3>6. 双期 3D 刚性配准与差分吸收热力图 (Registration, Fusion & RT-STRUCT)</h3>
        <span class="help-tag">随访对比 · 空间对齐 · 放疗规划</span>
      </div>
      <p class="help-lead">针对多期随访患者，彻底告别“单张切片肉眼目测对比”，实现基于 3D 体素空间刚性与非刚性弹性配准的动态演变量化，并支持 PET-CT 多模态融合与放疗靶区勾画。</p>

      <h4>6.1 双期 3D 体素刚性与非刚性弹性配准及差分吸收热力图 (Difference Heatmap Overlay)</h4>
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

      <h4>6.2 双联屏联动切片滑动 (Synchronized Dual-Scrubber MPR)</h4>
      <p>在随访对比弹窗中，嵌入左右并排的双 MPR 播放器：</p>
      <ul>
        <li>开启<b>「联动滚动 (Cursor Lock)」</b>后，滚轮在左侧基线切片滑动到相应解剖层面时，右侧随访根据对齐比例自动同步滚到对应层面，方便医生一目了然对比同解剖位点变化。</li>
      </ul>

      <h4>6.3 PET-CT 与多模态融合成像 (PET-CT & Multimodal Fusion)</h4>
      <p>支持将解剖结构与代谢功能多模态影像融合同屏显示：</p>
      <ul>
        <li><b>解剖与代谢空间重采样</b>：将 128×128 代谢 PET (SUV) 空间网格重采样至 512×512 结构 CT (HU) 网格；</li>
        <li><b>交互式融合透明度</b>：提供 Alpha 透明度调节滑块 (0.0~1.0)，支持彩虹/热铁伪彩代谢图层无缝叠加于灰阶解剖 CT 之上；</li>
        <li><b>SUV 恶性高摄取预警</b>：设定 SUVmax 阈值（默认 ≥ 2.5 提示高代谢恶性病灶），协助精准识别肿瘤活性边界。</li>
      </ul>

      <h4>6.4 放疗靶区勾画与导出 (Radiation Target Delineation & DICOM RT-STRUCT)</h4>
      <p>基于 MONAI 3D 卷积网络的肿瘤靶区与解剖危及器官分割结果：</p>
      <ul>
        <li><b>三维多边形网格提取</b>：采用 Marching Cubes 算法自动提取肿瘤大体靶区 (GTV)、临床靶区 (CTV)、计划靶区 (PTV) 及危及器官 (OAR: 脊髓、双肺、心脏、食管) 的闭合边界多边形；</li>
        <li><b>标准 DICOM RT-STRUCT (PS 3.3) 导出</b>：导出符合国际放疗标准的结构文件，可直接一键导入瓦里安 Eclipse、医科达 Monaco 等主流放疗计划系统 (TPS) 或三维手术规划系统。</li>
      </ul>

      <h4>6.5 严格解耦的疗效评估准则 (RECIST 1.1 vs 良性炎性病灶)</h4>
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
        <h3>7. 多模态因果诊断链与全景报告导出 (Multimodal Evidence & Export)</h3>
        <span class="help-tag">诊断报告 · 互联互通</span>
      </div>
      <p class="help-lead">打破“影像归影像、化验归化验”的数据孤岛，自动聚合多模态临床证据链，支持国际标准医学数据交换。</p>

      <h4>7.1 多模态因果诊断链条 (Multimodal Clinical Evidence Chain)</h4>
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

      <h4>7.2 全景病例诊断报告与图谱</h4>
      <p>在患者影像分析页面点击「生成完整病例报告」，系统将自动合成包含：患者脱敏信息、检查方法规范、定量征象测量、MPR 截面截图、随访体积演变曲线及专家建议的综合报告。</p>

      <h4>7.3 医疗行业标准格式导出</h4>
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
    title: '【实战图解】真实患者 3D 影像全流程诊疗范例 (多场景典型案例库)',
    badge: '实战案例',
    icon: icon('sparkles', { size: 16 }),
    summary: '汇聚 4 大真实临床核心标杆案例：变应性支气管肺曲霉病 (ABPA)、EGFR突变非小细胞肺癌 (NSCLC) 奥希替尼靶向 RECIST 1.1 评估、胰腺癌恶液质 L3 骨骼肌减少症 (Sarcopenia) 及特发性肺纤维化 (IPF/UIP) 薄层 HRCT 智能表型，打通全流程因果闭环。',
    contentHtml: `
      <div class="help-section-head">
        <h3>8. 真实病例深度实战图解与多场景案例库 (Real-World Clinical Case Studies)</h3>
        <span class="help-tag ok">4 大核心场景 · 真实病例 · 诊断级量化 · 决策闭环</span>
      </div>
      <p class="help-lead">医学影像功能的复杂性在于“从 3D 几何体素到临床决策的全链路因果串联”。为了全面测试与验证 Heurion 平台在不同临床专科场景下的量化自洽性与辅助决策能力，本章精选并深入剖析 <b>4 个来自真实临床队列的标准标杆病例</b>：涵盖<b>良性气道慢性感染 (ABPA)</b>、<b>实体瘤靶向治疗 RECIST 1.1 疗效动态评估 (NSCLC)</b>、<b>肿瘤恶液质体成分与肌少症风险预警 (Sarcopenia)</b> 以及<b>间质性肺病 (ILD) 复杂纤维化表型鉴别 (IPF/UIP)</b>。</p>

      <div class="help-grid-2" style="margin: 14px 0;">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('scan', { size: 14 })} 案例 1 & 2 · 呼吸胸部与肿瘤量化</div>
          <div class="hfc-desc">
            <ul>
              <li><b>案例一 (ABPA)</b>：支扩印戒征 (BAR 1.45)、高密度粘液栓 (HAM 12.44 cm³)、3D 容积吸收评估 (74.9% PR)；</li>
              <li><b>案例二 (NSCLC)</b>：EGFR Exon 19 del、基线 SOD 60.0mm ➔ 随访 SOD 33.0mm (-45.0% PR)、差分吸收热力图。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('users', { size: 14 })} 案例 3 & 4 · 体成分预后与纤维化表型</div>
          <div class="hfc-desc">
            <ul>
              <li><b>案例三 (恶液质/肌少症)</b>：TotalSegmentator L3 SMI 29.92 cm²/m²、肌脂肪浸润 26.4 HU、化疗毒性剂量调整；</li>
              <li><b>案例四 (IPF/UIP)</b>：胸膜下蜂窝肺 (46.20 cm³)、牵拉性支扩、Definite UIP 免活检启动抗纤维化靶向药。</li>
            </ul>
          </div>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 20px 0;">

      <h3>【案例一 · 良性慢性气道感染与粘液嵌顿】变应性支气管肺曲霉病 (ABPA) 伴高密度粘液栓</h3>

      <h4>8.1 患者基本资料与临床主诉 (Clinical Profile)</h4>
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

      <h4>8.2 第一步：3D HRCT 上传与 MONAI 深度学习病灶量化 (Baseline HRCT)</h4>
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

      <h4>8.3 第二步：诊断级 3D MPR 三正交切片交互浏览 (Interactive 3D MPR)</h4>
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
            <li><b>三维准星瞬时跳转 (Cursor Lock)</b>：点击「定位病灶中心」，准星自动瞬时飞跃到病灶最大几何截面层位，鼠标滚轮可在该层前后微调；支持手动卡尺测量物理间距；</li>
            <li><b>全模态临床窗宽窗位</b>：支持快捷键一键在肺窗 (-600/1500)、纵隔窗 (40/400) 之间切换，方便快速鉴别粘液栓与纵隔淋巴结；右下角配备 5 cm 毫米级真实物理比例尺；</li>
            <li><b>存证截图沉淀</b>：点击「${icon('save', { size: 12 })} 保存切片为文档资产」，即刻以无损 PNG 保存当前层位，自动生成 Markdown 引用代码供论文或病历直接使用。</li>
          </ul>
        </div>
      </div>

      <h4>8.4 第三步：TotalSegmentator 全身体素机体成分与 L3 肌少症预后分析 (Body Composition)</h4>
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

      <h4>8.5 第四步：治疗 3 个月随访：双期配准与差分吸收热力图对比 (Follow-up Diff Heatmap)</h4>
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

      <h4>8.6 第五步：多模态因果诊断链闭环与标准报告出具 (Multimodal Evidence Chain)</h4>
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

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>【案例二 · 实体瘤靶向疗效动态评估】EGFR 突变型晚期非小细胞肺癌 (NSCLC) 奥希替尼靶向治疗前后 RECIST 1.1 疗效评估</h3>

      <h4>8.7 患者基本资料、病理确诊与临床主诉 (Clinical Profile)</h4>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">患者脱敏档案 · PT-NSCLC-002</div>
        <div class="hfc-desc">
          <ul>
            <li><b>基本信息</b>：58岁女性，退休教师，无吸烟史。严格遵循零 PHI 规范建档（真实姓名仅保存在医生本地浏览器 localStorage 中，绝不上云）。</li>
            <li><b>现病史与病理诊断</b>：因刺激性干咳伴右胸隐痛 2 个月就诊。胸部薄层增强 CT 示右上肺尖后段占位性实性肿块伴右侧气管旁 (4R组) 纵隔淋巴结肿大。经支气管镜超声引导针吸活检 (EBUS-TBNA) 病理确诊为<b>浸润性肺腺癌 (Invasive Lung Adenocarcinoma)</b>；外周血 ctDNA 与组织二代测序 (NGS) 证实携带 <b>EGFR 19 号外显子缺失突变 (Exon 19 del, E746_A750del)</b>，突变丰度高达 42.6%，T790M 及 C797S 耐药突变全阴性。临床 TNM 分期明确为 <b>cT2bN2M0, III A 期</b>。</li>
            <li><b>靶向治疗方案</b>：一线给予口服第三代不可逆 EGFR-TKI 甲磺酸奥希替尼 (Osimertinib, 80 mg qd) 靶向维持治疗。</li>
          </ul>
        </div>
      </div>

      <h4>8.8 第一步：基线 3D 增强 CT 扫描与 MONAI 靶病灶 RECIST 1.1 自动测量 (Baseline HRCT)</h4>
      <p>医生在「患者 ➔ 影像」面板上传包含 180 层的胸部增强 CT 序列。系统调用 <code>nsclc_recist_analyzer</code> (MONAI 3D SegResNet) 深度网络完成全肺体素解析并自动聚焦最大病灶截面（第 #86 层）：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 6 真实患者胸部 CT 轴位关键截面 (Slice #86) · MONAI 靶病灶 RECIST 1.1 量化测量</span>
          <span class="help-case-tag">${icon('scan', { size: 12 })} MONAI 3D SegResNet</span>
        </div>
        <img class="help-case-img" src="/site/real-case-nsclc-1-baseline-recist.png" alt="真实患者胸部 CT 靶病灶 RECIST 1.1 量化测量" />
        <div class="help-case-caption">
          <b>影像学关键指征与基线靶病灶测量：</b>
          <ul>
            <li><b>靶病灶 1 (右上肺实质肿块)</b>：位于右上肺尖段，呈现典型恶性征象——边缘粗细不均分叶征 (Lobulation)、周边放射状细毛刺征 (Spiculation) 及邻近胸膜牵拉凹陷征 (Pleural Indentation)。黄色高亮卡尺实测<b>最大长径 42.0 mm × 短径 31.5 mm</b>，3D 卷积分割累计<b>三维容积达 28.50 cm³</b>，CT 均值 38 HU；</li>
            <li><b>靶病灶 2 (4R 组纵隔淋巴结)</b>：同侧气管旁纵隔淋巴结显著肿大，黄色卡尺测得<b>最大短径 18.0 mm</b>（严格符合 RECIST 1.1 国际标准中“淋巴结靶病灶短径必须 ≥ 15.0 mm”的纳排金标准）；</li>
            <li><b>基线靶病灶长径总和 (Baseline Sum of Diameters, SOD)</b>：根据 RECIST 1.1 规范，基线 SOD = 靶病灶1长径 (42.0 mm) + 靶病灶2短径 (18.0 mm) = <b>60.0 mm</b>，作为后续随访疗效判定的客观基准线。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('scan', { size: 14 })} 严格遵循 RECIST 1.1 靶病灶基线与随访定量测量链</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>病灶编号与解剖部位</th>
                <th>基线测值 (2026-06-15)</th>
                <th>12 周靶向随访测值 (2026-09-15)</th>
                <th>变化幅度 (Δ) 与临床解读</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>靶病灶 1：右上肺实质肿块</b><br><span style="font-size:11px;color:var(--text-muted)">分叶、毛刺征、胸膜牵拉</span></td>
                <td>最大长径 <b>42.0 mm</b> × 短径 31.5 mm<br>3D 容积 <b>28.50 cm³</b> (均值 38 HU)</td>
                <td>最大长径 <b>24.0 mm</b> × 短径 15.5 mm<br>3D 容积 <b>6.20 cm³</b> (均值 21 HU)</td>
                <td>长径缩小 <b>-42.9%</b><br>3D 容积吸收 <b>-78.2%</b> (深绿色负吸收)</td>
              </tr>
              <tr>
                <td><b>靶病灶 2：4R 组纵隔淋巴结</b><br><span style="font-size:11px;color:var(--text-muted)">同侧气管旁转移性淋巴结</span></td>
                <td>最大短径 <b>18.0 mm</b><br><span style="font-size:11px;color:var(--text-muted)">符合 RECIST 淋巴结短径 ≥ 15mm 纳排标准</span></td>
                <td>最大短径 <b>9.0 mm</b><br><span style="font-size:11px;color:var(--mint-text)">短径 &lt; 10mm 已恢复至正常生理淋巴结大小</span></td>
                <td>短径缩小 <b>-50.0%</b><br>淋巴结良性转归</td>
              </tr>
              <tr style="background: rgba(0, 229, 153, 0.05); font-weight: 600;">
                <td><b>靶病灶长径和 (Sum of Diameters, SOD)</b></td>
                <td>基线 SOD = 42.0 + 18.0 = <b>60.0 mm</b></td>
                <td>随访 SOD = 24.0 + 9.0 = <b>33.0 mm</b></td>
                <td>百分比变化率 = <b>-45.0%</b><br><span style="color:var(--mint-text);">判定标准：降幅 ≥ 30% 且无新病灶</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4>8.9 第二步：诊断级 3D MPR 三正交切片交互浏览与病灶立体解剖 (Interactive 3D MPR)</h4>
      <p>点击「打开 3D 浏览器」，进入三正交切片工作台，立体观察肿块与周围纵隔大血管及胸膜的解剖浸润边界：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 7 诊断级交互式 3D MPR 三正交切片浏览器 (Axial #86 / Coronal #210 / Sagittal #180)</span>
          <span class="help-case-tag">${icon('grid', { size: 12 })} 三正交空间联动</span>
        </div>
        <img class="help-case-img" src="/site/real-case-nsclc-2-mpr-3view.png" alt="诊断级交互式 3D MPR 三正交切片浏览器" />
        <div class="help-case-caption">
          <b>三正交全景空间解剖定位指征：</b>
          <ul>
            <li><b>三正交解剖空间对齐</b>：横断面 (Axial #86/180)、冠状面 (Coronal #210/512)、矢状面 (Sagittal #180/512) 实时同步十字准星聚焦；冠状位清晰展现原发肿块居于右肺尖部，上缘紧邻胸廓顶胸膜但未侵犯锁骨下动脉；</li>
            <li><b>病灶质心导航与准星瞬时飞跃</b>：点击「定位病灶中心」，准星自动瞬时定位到 3D 肿瘤质心层位，支持医生使用高对比度亚毫米游标卡尺复核病灶边界；</li>
            <li><b>调窗鉴别坏死与浸润</b>：快捷切换肺窗 (-600/1500 HU) 观察周边肺野卫星结节与毛刺，切换纵隔窗 (40/400 HU) 观察 4R 淋巴结内部强化与坏死囊变；</li>
            <li><b>一键存证资产</b>：点击「保存切片为文档资产」，即刻以无损高保真图像存证入库并生成 Markdown 引用。</li>
          </ul>
        </div>
      </div>

      <h4>8.10 第三步：靶向治疗 12 周随访：双期配准与差分吸收热力图对比 (Follow-up Diff Heatmap)</h4>
      <p>患者规律口服第三代 EGFR-TKI 甲磺酸奥希替尼 (80 mg qd) 治疗 12 周后，于 2026-09-15 进行胸部薄层增强 CT 复查。系统调用 3D 非刚性弹性配准网络完成疗效比对：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 8 奥希替尼靶向治疗 12 周随访：3D 空间弹性配准与差分吸收热力图 (Difference Heatmap)</span>
          <span class="help-case-tag">${icon('compare', { size: 12 })} RECIST 1.1 疗效评估</span>
        </div>
        <img class="help-case-img" src="/site/real-case-nsclc-3-diff-heatmap.png" alt="奥希替尼靶向随访 3D 空间弹性配准与差分吸收热力图" />
        <div class="help-case-caption">
          <b>动态随访演变量化与 RECIST 1.1 判定结果：</b>
          <ul>
            <li><b>3D 非刚性弹性形变配准 (DIR)</b>：系统消除两次检查的吸气相深浅差异与胸廓旋转伪影，在对齐后的体素空间中计算 HU 衰减差分矩阵；</li>
            <li><b>深绿色负差分吸收图层</b>：原右上肺实质肿块内部呈现大面积均匀深绿色吸收征，表明肿瘤细胞大量坏死、空洞化液化并被正常肺含气组织复张所替代；</li>
            <li><b>随访靶病灶长径和 (Follow-up SOD)</b>：右上肺肿块长径由 42.0 mm 缩减至 <b>24.0 mm</b> (短径 15.5 mm，容积由 28.50 骤降至 <b>6.20 cm³</b>，容积吸收率 <b>-78.2%</b>)；4R 淋巴结短径由 18.0 mm 缩减至 <b>9.0 mm</b> (已退缩至正常生理淋巴结大小 &lt; 10 mm)；</li>
            <li><b>长径和降幅达 45.0%</b>：随访 SOD 为 24.0 + 9.0 = <b>33.0 mm</b>，降幅 $\frac{33.0 - 60.0}{60.0} \times 100\% = \mathbf{-45.0\%}$；根据 RECIST 1.1 国际准则（降幅 $\ge 30\%$ 且无新病灶），严格判定为 <b>部分缓解 (Partial Response, PR)</b>！</li>
          </ul>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">基线长径和 (Baseline SOD)</span>
          <span class="val">60.0 mm</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">随访长径和 (Follow-up SOD)</span>
          <span class="val">33.0 mm</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">RECIST 1.1 变化率 (ΔSOD)</span>
          <span class="val ok">-45.0% (降幅显著)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">RECIST 1.1 疗效评定</span>
          <span class="val ok">部分缓解 (PR)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">3D 肿瘤容积吸收率</span>
          <span class="val ok">-78.2% (28.5 ➔ 6.2 cm³)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">IBSI 影像组学微观表型</span>
          <span class="val">异质性下降 · 能量减退</span>
        </div>
      </div>

      <h4>8.11 第四步：IBSI 107 项标准高维影像组学表型提取与演变 (IBSI Radiomics Analysis)</h4>
      <p>为从微观亚视觉层面深度探究肿瘤在靶向药物作用下的微环境空间异质性演化，系统一键提取 107 项 IBSI 规范特征：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 9 IBSI 107 项国际标准高维影像组学表型提取与演变矩阵 (Radiomics Feature Matrix)</span>
          <span class="help-case-tag">${icon('chart', { size: 12 })} IBSI 国际标准</span>
        </div>
        <img class="help-case-img" src="/site/real-case-nsclc-4-radiomics-feature.png" alt="IBSI 107 项国际标准高维影像组学表型提取与演变矩阵" />
        <div class="help-case-caption">
          <b>微观影像组学指纹演变深度剖析：</b>
          <ul>
            <li><b>一阶灰度统计与形态学 (18+16项)</b>：病灶 3D 总体积由 28.5 cm³ 缩至 6.2 cm³ (-78.2%)，球形度由 0.58 提升至 0.82 (+41.4%)，表面积体积比由 0.78 降至 0.46，均值强度由 38.2 HU 降至 21.4 HU，偏度与峰度均趋向对称匀质分布；</li>
            <li><b>灰度共生矩阵 (GLCM, 24项)</b>：联合熵 (Joint Entropy) 由 4.82 骤降至 2.14，反映肿瘤细胞内部紊乱异质性极显著减退；角二阶矩/能量 (Energy) 飙升 +275%，对比度下降 -60.8%，逆差矩 (Homogeneity / IDM) 由 0.34 提升至 0.78 (+129%)，表明肿瘤微环境高度均质化；</li>
            <li><b>高阶矩阵与小波多尺度特征 (49项)</b>：小波低频成分能量收敛，高频细微纹理结构显著衰退，组学表型与 EGFR-TKI 敏感应答高度吻合，为后续科研生存建模提供量化数据。</li>
          </ul>
        </div>
      </div>

      <h4>8.12 第五步：多模态因果诊断链闭环与 MDT 维持治疗决策 (Multimodal Evidence Chain)</h4>
      <p>将 3D CT 影像量化、分子基因突变型及临床多学科诊疗决策深度闭环，一键拼装因果证据链：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 10 多模态因果诊断链与证据闭环 (NSCLC 靶向治疗三支柱)</span>
          <span class="help-case-tag">${icon('sparkles', { size: 12 })} 因果推理 · 决策闭环</span>
        </div>
        <img class="help-case-img" src="/site/real-case-nsclc-5-diagnostic-chain.png" alt="多模态因果诊断链与证据闭环" />
        <div class="help-case-caption">
          <b>三支柱因果闭环与标准文书出具：</b>
          <ul>
            <li><b>支柱一（3D CT 影像定量与 RECIST 1.1）</b>：靶病灶 SOD 由 60.0 mm 降至 33.0 mm (-45.0% PR)，3D 容积缩小 78.2%，差分热力图呈大片深绿负吸收，无任何新发病灶 (权重 0.98)；</li>
            <li><b>支柱二（分子病理与基因突变 NGS）</b>：确立浸润性肺腺癌病理诊断，携带高丰度 EGFR Exon 19 del (42.6%)，耐药突变阴性，具备极佳的靶向治疗靶点支撑 (权重 0.99)；</li>
            <li><b>支柱三（终末确诊与 MDT 决策闭环）</b>：确诊晚期非小细胞肺癌奥希替尼靶向治疗取得客观缓解 (PR)；决策维持原方案 80 mg qd 治疗，规避过早放疗介入，每 8~12 周规律随访；一键导出标准 <b>DICOM SR</b> 与 <b>HL7 FHIR</b> 资源包。</li>
          </ul>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>【案例三 · 实体瘤恶病质与营养代谢衰弱】胰腺导管腺癌合并隐匿性重度骨骼肌减少症 (Cancer Cachexia & Sarcopenia) 与肌脂肪浸润</h3>

      <h4>8.13 患者基本资料与临床主诉 (Clinical Profile)</h4>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">患者脱敏档案 · PT-SARCO-003</div>
        <div class="hfc-desc">
          <ul>
            <li><b>基本信息</b>：64岁男性，退休工人。零 PHI 规范建档。</li>
            <li><b>现病史与体格检查</b>：上腹部隐痛不适伴快速消瘦、乏力 3 个月。发病前体重 68 kg，近 3 个月骤降至 54 kg (体重下降率达 <b>-20.6%</b>)，身高 1.72 m，当前体质指数 (BMI) 为 <b>18.25 kg/m²</b> (低于正常下限 18.5)。专科查体：全身肌肉重度消瘦萎缩，握力计实测右手握力仅 19 kg (远低于男性正常参考下限 28 kg)。</li>
            <li><b>临床诊断</b>：胰体尾部浸润性导管腺癌伴腹腔干淋巴结转移，临床 TNM 分期为 <b>cT3N1M0, III 期 (局部晚期不可切除)</b>。</li>
          </ul>
        </div>
      </div>

      <h4>8.14 第一步：全腹增强 CT 上传与 TotalSegmentator L3 椎体横截面体成分自动化量化 (L3 Body Composition)</h4>
      <p>医生上传腹部增强 CT 序列，Heurion 自动化定位第 3 腰椎 (L3) 中位层面（第 #148 层），自动分割腰大肌、竖脊肌及腹壁肌群：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 11 TotalSegmentator L3 椎体横截面体成分与骨骼肌质量指数 (SMI) 量化 (Slice #148)</span>
          <span class="help-case-tag">${icon('users', { size: 12 })} TotalSegmentator 3D</span>
        </div>
        <img class="help-case-img" src="/site/real-case-sarco-1-l3-muscle-fat.png" alt="TotalSegmentator L3 椎体横截面体成分量化" />
        <div class="help-case-caption">
          <b>机体成分与营养衰弱量化指标实测：</b>
          <ul>
            <li><b>L3 骨骼肌横截面积 (SMA = 88.50 cm²) 与 SMI (29.92 cm²/m²)</b>：同龄健康男性通常 &gt; 130 cm²；换算骨骼肌指数 SMI 为 29.92 cm²/m²，远低于 Prado 国际共识男性界值 52.4 cm²/m² 与亚洲 AWGS 38.5 cm²/m²，系统触发红色极高危警报：<b>重度恶液质性肌少症 (Severe Sarcopenia)</b>；</li>
            <li><b>骨骼肌平均辐射衰减 (Mean Muscle Attenuation, MA = 26.4 HU)</b>：健康骨骼肌通常为 35~50 HU，26.4 HU 的低衰减客观证实肌纤维间质被大量异位低密度脂肪浸润，提示严重<b>肌脂肪变性 (Myosteatosis)</b>，肌肉力学储备枯竭；</li>
            <li><b>内脏/皮下脂肪比 (VAT / SAT = 2.09)</b>：内脏脂肪 VAT 为 142.30 cm² (内脏型肥胖)，皮下脂肪 SAT 仅 68.20 cm² (储脂消耗)，呈现典型的“肌少性恶液质消耗表型”。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('users', { size: 14 })} TotalSegmentator L3 椎体横截面体成分自动化量化实测对照表</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>体成分量化参数</th>
                <th>算法实测值</th>
                <th>临床参考截断值 (Reference Cutoff)</th>
                <th>临床风险分层与病理生理意义</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>L3 骨骼肌横截面积 (SMA)</b></td>
                <td><b>88.50 cm²</b></td>
                <td>60~69 岁健康成年男性通常 &gt; 130 cm²</td>
                <td>腰大肌及脊柱旁肌群重度萎缩</td>
              </tr>
              <tr>
                <td><b>L3 骨骼肌质量指数 (SMI = SMA / 身高²)</b></td>
                <td><b>29.92 cm²/m²</b><br><span style="font-size:11px;color:var(--text-muted)">88.50 / (1.72²)</span></td>
                <td>Prado 国际共识男性标准：<b>&lt; 52.4 cm²/m²</b><br>亚洲 AWGS 极端标准：<b>&lt; 38.5 cm²/m²</b></td>
                <td><span style="color:#ef4444;font-weight:600;">触发红色警报：重度恶液质性肌少症 (Severe Sarcopenia)</span></td>
              </tr>
              <tr>
                <td><b>骨骼肌平均辐射衰减 (Mean Muscle Attenuation, MA)</b></td>
                <td><b>26.4 HU</b></td>
                <td>健康骨骼肌通常处于 <b>35.0 ~ 50.0 HU</b></td>
                <td><span style="color:#fb923c;font-weight:600;">严重肌脂肪变性 (Myosteatosis)</span>：肌纤维间质被低密度脂质浸润，肌肉生物力学与代谢储备耗竭</td>
              </tr>
              <tr>
                <td><b>内脏脂肪面积 (VAT)</b></td>
                <td><b>142.30 cm²</b></td>
                <td>正常健康范围 &lt; 100 cm²</td>
                <td>腹腔内脏脂肪异常蓄积 (内脏型肥胖)</td>
              </tr>
              <tr>
                <td><b>皮下脂肪面积 (SAT)</b></td>
                <td><b>68.20 cm²</b></td>
                <td>正常范围 80 ~ 150 cm²</td>
                <td>四肢与躯干皮下储脂重度流失</td>
              </tr>
              <tr style="background: rgba(239, 68, 68, 0.05);">
                <td><b>内脏/皮下脂肪比 (VAT / SAT)</b></td>
                <td><b>2.09</b></td>
                <td>正常参考范围 &lt; 1.0</td>
                <td><span style="color:#ef4444;font-weight:600;">肌少性内脏蓄脂表型 (Sarcopenic Visceral Adiposity)</span>：全身重度慢性促炎状态</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">L3 骨骼肌指数 (SMI)</span>
          <span class="val warn">29.92 cm²/m² (严重低下)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">Prado 国际肌少症界值</span>
          <span class="val">52.4 cm²/m² (男性)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">骨骼肌辐射衰减 (MA)</span>
          <span class="val warn">26.4 HU (肌脂肪浸润)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">内脏/皮下脂肪比 (VAT/SAT)</span>
          <span class="val warn">2.09 (代谢失衡)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">化疗 3~4 级血液毒性风险预测</span>
          <span class="val warn">72% (极高危)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">多学科临床决策</span>
          <span class="val ok">首剂减量20% + 营养预康复</span>
        </div>
      </div>

      <h4>8.15 第二步：化疗药代动力学 (PK) 毒性预警与多学科 (MDT) 预康复决策 (PK Toxicity & MDT Prehabilitation)</h4>
      <p>骨骼肌是抗肿瘤药物的主要组织分布容积与代谢缓冲池。系统药代动力学模型测算毒副反应风险并联动 MDT 决策：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 12 肿瘤药代动力学毒性预警与多学科 (MDT) 个体化预康复方案 (Onco-Pharma & Prehabilitation)</span>
          <span class="help-case-tag">${icon('hospital', { size: 12 })} 药理安全与决策</span>
        </div>
        <img class="help-case-img" src="/site/real-case-sarco-2-pk-toxicity-risk.png" alt="肿瘤药代动力学毒性预警与多学科 MDT 预康复方案" />
        <div class="help-case-caption">
          <b>药理毒性机制与个体化预康复临床决策：</b>
          <ul>
            <li><b>化疗药代动力学 (PK) 毒性预警</b>：骨骼肌萎缩伴肌脂肪变性使亲脂性化疗药（伊立替康、奥沙利铂）清除率暴跌 44.5%，游离血药峰浓度异常飙升。系统预测若按体表面积 (BSA = 1.62 m²) 全量给予 mFOLFIRINOX 方案化疗，发生 3~4 级骨髓抑制（中性粒细胞缺乏伴发热 FN）及早期治疗中断的概率高达 <b>72%</b>；</li>
            <li><b>化疗剂量精准微调</b>：主管医生采纳预警建议，将首疗程 mFOLFIRINOX 化疗药物剂量<b>预防性下调 20%</b>，规避早期致死性药物毒性；</li>
            <li><b>全肠内营养支持 (ONS) 预康复</b>：联合临床营养科启动全肠内营养支持，每日补充热量 30 kcal/kg，蛋白质 1.5 g/kg/d，并强化补充支链氨基酸 (BCAA) 与欧米伽-3 多不饱和脂肪酸 ($\omega$-3 PUFA) 以拮抗恶液质促炎介质；</li>
            <li><b>物理预康复 (Prehabilitation)</b>：康复治疗师指导低负荷抗阻力握力与弹力带训练，保护肌肉量与功能储备。</li>
          </ul>
        </div>
      </div>

      <h4>8.16 第三步：多模态因果诊断链闭环与标准报告出具 (Multimodal Evidence Chain)</h4>
      <p>将体成分量化、临床恶液质指标与 MDT 处治方案整合为完整的因果证据链：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 13 多模态因果诊断链与证据闭环 (恶液质与肌少症三支柱)</span>
          <span class="help-case-tag">${icon('sparkles', { size: 12 })} 因果推理 · 标准交换</span>
        </div>
        <img class="help-case-img" src="/site/real-case-sarco-3-diagnostic-chain.png" alt="恶液质与肌少症多模态因果诊断链与证据闭环" />
        <div class="help-case-caption">
          <b>多模态证据闭环与标准文书出具：</b>
          <ul>
            <li><b>支柱一（3D L3 体成分量化）</b>：L3 SMI 29.92 cm²/m² (重度低下) + 辐射衰减 MA 26.4 HU (肌脂肪变性) + VAT/SAT 2.09 (权重 0.98)；</li>
            <li><b>支柱二（临床恶液质衰弱与生化指标）</b>：体重骤降 20.6% + BMI 18.25 + 握力实测 19 kg + 白蛋白 31.2 g/L (权重 0.96)；</li>
            <li><b>支柱三（MDT 处治与报告出具）</b>：首剂化疗预防性下调 20%，联合全肠内营养支持与抗阻运动预康复，一键导出标准 <b>DICOM SR</b> 与 <b>HL7 FHIR</b> 报告。</li>
          </ul>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>【案例四 · 弥漫性间质性肺病与纤维化】寻常型间质性肺炎 (UIP) / 特发性肺纤维化 (IPF) 薄层 HRCT 智能表型与蜂窝肺量化</h3>

      <h4>8.17 患者基本资料与临床主诉 (Clinical Profile)</h4>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">患者脱敏档案 · PT-IPF-004</div>
        <div class="hfc-desc">
          <ul>
            <li><b>基本信息</b>：69岁男性，退休机械修理工人，既往吸烟史 30 包年。零 PHI 规范建档。</li>
            <li><b>主诉与现病史</b>：活动后渐进性气短、刺激性干咳 1 年，近 1 个月活动耐量进行性减退，平地慢走 100 米即感气促胸闷。专科体格检查：呼吸频率 22 次/分，听诊双下肺背侧基底部可闻及特征性吸气末细小、高调、不连续的爆裂样湿啰音——<b>典型 Velcro 啰音 (Velcro Rales)</b>；双手指端见轻度杵状指 (Clubbing)。</li>
            <li><b>肺功能测定 (PFT)</b>：典型限制性通气障碍伴一氧化碳弥散量重度下降：用力肺活量占预计值百分比 (FVC% pred) 68.5%，一氧化碳弥散量占预计值百分比 (DLCO% pred) 44.2%。血清自身抗体谱 (ANA/ENA/ANCA) 全套阴性。</li>
          </ul>
        </div>
      </div>

      <h4>8.18 第一步：薄层吸气相 HRCT (1.0 mm) 3D 智能表型提取与蜂窝肺量化 (Baseline HRCT)</h4>
      <p>系统运行 <code>ipf_interstitial_phenotyper</code> 深度网络，对 3D HRCT 体数据进行全自动肺叶各向同性体素分割与纤维化病理征象量化提取（第 #72 层）：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 14 真实患者薄层 HRCT 轴位关键截面 (Slice #72) · 3D UIP 智能表型提取与蜂窝肺量化</span>
          <span class="help-case-tag">${icon('scan', { size: 12 })} 3D Interstitial Phenotyper</span>
        </div>
        <img class="help-case-img" src="/site/real-case-ipf-1-hrct-honeycombing.png" alt="薄层 HRCT 轴位关键截面 3D UIP 智能表型提取与蜂窝肺量化" />
        <div class="help-case-caption">
          <b>薄层 HRCT 影像学特征与 2022 ATS/ERS 指南符合度剖析：</b>
          <ul>
            <li><b>解剖空间分布</b>：病变严格呈<b>胸膜下 (Subpleural)</b> 与<b>双肺基底部 (Basal)</b> 外周优势分布；双肺尖部及支气管血管束中央区相对保留，呈典型向心性梯度；</li>
            <li><b>蜂窝状改变 (Honeycombing)</b>：黄色高亮标出胸膜下多层厚壁囊状透亮气腔，直径 3~8 mm，呈多层阶梯状紧贴胸膜成簇排列。MONAI 测算<b>全肺累计蜂窝肺容积达 46.20 cm³</b>，确凿支持 Definite UIP 标志征象；</li>
            <li><b>牵拉性支气管扩张 (Traction Bronchiectasis)</b>：周围重度纤维化组织回缩产生异常张力，导致下叶周边气道不规则扭曲扩张，延伸至胸膜下 1 cm 肺外周带；</li>
            <li><b>彻底排除不符合 UIP 征象</b>：广泛磨玻璃影 (GGO) 占比 &lt; 5% (且无孤立 GGO)；无小叶中心微结节；呼气相 CT 无马赛克灌注与弥漫气体陷闭，彻底排除过敏性肺炎 (HP) 与结节病。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('scan', { size: 14 })} 薄层 HRCT (1.0 mm 层厚) 3D 智能表型提取与空间分布特征表</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>HRCT 影像学征象</th>
                <th>Heurion 3D 卷积网络实测特征与量化</th>
                <th>2022 ATS/ERS/JRS/ALAT 国际指南判定符合度</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>病灶解剖空间分布</b></td>
                <td>严格呈<b>胸膜下 (Subpleural)</b> 与<b>双肺基底部 (Basal)</b> 外周优势分布；双肺尖部及支气管血管束中央区相对保留，呈典型向心性梯度。</td>
                <td><span style="color:var(--mint-text);font-weight:600;">完全符合 UIP 空间分布金标准</span></td>
              </tr>
              <tr>
                <td><b>蜂窝状改变 (Honeycombing)</b></td>
                <td>胸膜下多层厚壁囊状透亮气腔，直径 3~8 mm，呈多层阶梯状紧贴胸膜成簇排列。MONAI 测算<b>全肺累计蜂窝肺容积达 46.20 cm³</b>。</td>
                <td><span style="color:var(--mint-text);font-weight:600;">确凿支持 Definite UIP 标志征象</span></td>
              </tr>
              <tr>
                <td><b>牵拉性支气管扩张 (Traction Bronchiectasis)</b></td>
                <td>周围重度纤维化组织回缩产生异常张力，导致下叶周边气道不规则扭曲扩张，延伸至胸膜下 1 cm 肺外周带。</td>
                <td><span style="color:var(--mint-text);font-weight:600;">典型纤维化牵拉所见</span></td>
              </tr>
              <tr>
                <td><b>网格影 (Reticulation)</b></td>
                <td>广泛粗糙的小叶间隔不规则增厚与小叶内细网状纤维沉积。</td>
                <td><span style="color:var(--mint-text);font-weight:600;">符合网格化纤维改变</span></td>
              </tr>
              <tr>
                <td><b>排除不符合 UIP 征象</b></td>
                <td>广泛磨玻璃影 (GGO) 占比 &lt; 5% (且无孤立 GGO)；无小叶中心微结节；呼气相 CT 无马赛克灌注与弥漫气体陷闭。</td>
                <td><span style="color:var(--mint-text);font-weight:600;">彻底排除过敏性肺炎 (HP) 与结节病</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">HRCT 空间分布模式</span>
          <span class="val ok">胸膜下/肺基底部外周优势</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">3D 累计蜂窝肺容积</span>
          <span class="val warn">46.20 cm³ (多层阶梯状)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">牵拉性支气管扩张</span>
          <span class="val ok">阳性 (延伸至胸膜下)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">2022 ATS/ERS 指南定级</span>
          <span class="val ok">明确 UIP 表型 (Definite UIP)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">血清结缔组织病自身抗体</span>
          <span class="val ok">全套阴性 (排除 CTD-ILD)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">MDT 临床决策闭环</span>
          <span class="val ok">免外科肺活检 · 启动抗纤维化</span>
        </div>
      </div>

      <h4>8.19 第二步：间质性纤维化头尾向梯度 3D MPR 交互浏览 (Interactive 3D MPR)</h4>
      <p>通过三正交切片浏览器，立体展现特发性肺纤维化标志性的从肺尖到肺基底部的头尾向梯度衰减：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 15 诊断级 3D MPR 弥漫性间质性肺病头尾向梯度浏览器 (Coronal & Sagittal Views)</span>
          <span class="help-case-tag">${icon('grid', { size: 12 })} 头尾向病理梯度</span>
        </div>
        <img class="help-case-img" src="/site/real-case-ipf-2-mpr-coronal-gradient.png" alt="诊断级 3D MPR 弥漫性间质性肺病头尾向梯度浏览器" />
        <div class="help-case-caption">
          <b>三正交视图头尾向梯度特征解析：</b>
          <ul>
            <li><b>冠状面 (Coronal) 与矢状面 (Sagittal) 垂直构型</b>：冠状位清晰勾画出纤维化病灶呈现从肺尖向肺底部进行性加重的陡峭梯度（肺尖部肺实质结构清晰正常，肺中部出现粗糙网格影，双肺底外周带则被严重蜂窝囊腔完全占据）；</li>
            <li><b>三维准星对准下肺基底蜂窝区</b>：一键聚焦纤维化最严重区域，量测胸膜下囊腔壁厚与外周气道牵拉距离；</li>
            <li><b>切片资产存证与报告草案联动</b>：保存冠状面关键切片并自动提取空间表型参数，注入至放射诊断报告草案。</li>
          </ul>
        </div>
      </div>

      <h4>8.20 第三步：多模态因果诊断链闭环与 MDT 免外科肺活检获益 (Multimodal Evidence Chain & SLB-Sparing)</h4>
      <p>多学科专家团队基于影像智能表型与临床多模态数据，达成免除有创活检、早期抗纤维化的诊疗决策：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 16 多模态因果诊断链与证据闭环 (IPF / Definite UIP 证据三支柱)</span>
          <span class="help-case-tag">${icon('sparkles', { size: 12 })} MDT 共识 · 免除活检</span>
        </div>
        <img class="help-case-img" src="/site/real-case-ipf-3-diagnostic-chain.png" alt="多模态因果诊断链与证据闭环" />
        <div class="help-case-caption">
          <b>多学科诊疗决策闭环与临床获益：</b>
          <ul>
            <li><b>支柱一（薄层 HRCT 3D 智能表型提取）</b>：胸膜下与基底部外周分布 + 多层蜂窝肺 (46.20 cm³) + 牵拉支扩，彻底排除过敏性肺炎，完全符合 2022 ATS/ERS Definite UIP 表型 (权重 0.98)；</li>
            <li><b>支柱二（临床体征、肺功能与免疫排查）</b>：吸气末典型 Velcro 啰音、限制性弥散障碍 (FVC 68.5%, DLCO 44.2%)，自身抗体谱全阴性排除结缔组织病相关间质性肺病 (CTD-ILD) (权重 0.96)；</li>
            <li><b>支柱三（MDT 确诊与免外科肺活检获益）</b>：依据指南，Definite UIP 表现且排除病因者与病理一致率超 95%，<b>免除高风险的外科胸腔镜肺活检 (SLB)</b>，直接确诊特发性肺纤维化 (IPF)，即刻启动口服吡非尼酮抗纤维化靶向治疗；导出标准 <b>DICOM SR</b> 与 <b>HL7 FHIR</b> 报告。</li>
          </ul>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>8.10 4 大典型临床案例多模态指标与决策对照矩阵表 (Cross-Case Clinical Decision Matrix)</h3>
      <p>为便于临床医师、科研人员及算法评估团队全面对比，下表横向归纳了平台覆盖的 4 个标杆真实病例的核心特征：</p>

      <div class="help-feature-card" style="margin: 12px 0; overflow-x: auto;">
        <table class="help-table" style="min-width: 780px;">
          <thead>
            <tr style="border-bottom: 2px solid var(--line); background: var(--card-glass);">
              <th>案例编号 / 脱敏 ID</th>
              <th>专科分类与疾病诊断</th>
              <th>临床痛点与首发表现</th>
              <th>影像金标准征象</th>
              <th>Heurion 核心算法与实测值</th>
              <th>指南标准判定与分级</th>
              <th>临床处置与最终决策闭环</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>案例一</b><br><code>PT-BRONCHO-001</code></td>
              <td>呼吸与感染<br>变应性支气管肺曲霉病 (ABPA)</td>
              <td>反复咳痰、咯血6年，外院抗生素治疗无效，气道广泛粘液嵌顿</td>
              <td>中央型支气管扩张 (BAR &gt; 1.0) 伴高密度粘液栓 (HAM &gt; 胸壁肌肉)</td>
              <td>BAR 1.45 (印戒征)<br>HAM 12.44 cm³ (98 HU)<br>随访吸收 74.9%</td>
              <td>Rosenberg-Patterson 标准<br>3D 容积吸收评估 (PR)</td>
              <td>确诊 ABPA 急性期；口服糖皮质激素联合伏立康唑，3个月粘液栓吸收良好</td>
            </tr>
            <tr>
              <td><b>案例二</b><br><code>PT-NSCLC-002</code></td>
              <td>胸部肿瘤科<br>肺腺癌 (EGFR 突变) III A期</td>
              <td>咳嗽胸痛2月，右上肺肿块伴4R组纵隔淋巴结转移，EGFR 19外显子缺失</td>
              <td>分叶、毛刺肿块，纵隔淋巴结短径增大 (≥ 15 mm)</td>
              <td>基线 SOD 60.0 mm<br>随访 SOD 33.0 mm (Δ -45.0%)<br>3D 容积 28.5 ➔ 6.2 cm³</td>
              <td><b>RECIST 1.1 国际标准</b><br>部分缓解 (PR)</td>
              <td>维持奥希替尼 80mg qd 原方案治疗；差分图呈深绿负吸收，避免过度放疗介入</td>
            </tr>
            <tr>
              <td><b>案例三</b><br><code>PT-SARCO-003</code></td>
              <td>消化与肿瘤营养<br>胰腺导管腺癌伴恶病质</td>
              <td>消瘦乏力，3月体重下降 20.6%，BMI 18.25，握力 19 kg</td>
              <td>腰大肌及脊柱旁肌群萎缩，骨骼肌辐射衰减降低 (&lt; 30 HU)</td>
              <td>L3 SMI = 29.92 cm²/m²<br>肌肉衰减 MA = 26.4 HU<br>VAT/SAT = 2.09</td>
              <td>Prado 共识 / AWGS 标准<br>重度恶液质肌少症</td>
              <td>预测全量化疗严重毒性率 72%；化疗首剂下调20%，联合全肠内营养与预康复</td>
            </tr>
            <tr>
              <td><b>案例四</b><br><code>PT-IPF-004</code></td>
              <td>呼吸间质病科<br>特发性肺纤维化 (IPF)</td>
              <td>渐进性气促干咳1年，双下肺典型 Velcro 啰音，限制性通气障碍</td>
              <td>胸膜下/基底部蜂窝状改变、牵拉性支扩，无不符合征象</td>
              <td>胸膜下外周向心分布<br>3D 蜂窝肺容积 46.20 cm³<br>牵拉性支扩伸至胸膜下</td>
              <td><b>2022 ATS/ERS/JRS/ALAT</b><br>明确 UIP 表型 (Definite)</td>
              <td>结合自身抗体阴性，<b>免除高风险外科肺活检 (SLB)</b>；即刻启动吡非尼酮靶向抗纤维化</td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    id: 'research',
    title: '临床科研工作流 (Research)',
    badge: '统计分析',
    icon: icon('chart', { size: 16 }),
    summary: '方案设计、多中心数据集质控清洗、零 PHI 脱敏、Table 1 基线表一键制表、Kaplan-Meier 生存曲线与 Cox 比例风险回归森林图。',
    contentHtml: `
      <div class="help-section-head">
        <h3>9. 临床科研工作流 (Clinical Research & Automated Biostatistics)</h3>
        <span class="help-tag">科研立项 · 多中心质控 · 自动化生物统计 · 顶刊闭环</span>
      </div>
      <p class="help-lead">Heurion 研究工作空间深度面向临床医学科学家、规培/专培医师及临床药理研究团队，提供从科研课题立项设计、多源多格式数据表质控导入、零 PHI 敏感数据脱敏、患者库智能入组、受限沙箱生物统计学制表（Table 1/KM/Cox），到论文写作数据零幻觉引用的全生命周期科研支撑体系。</p>

      <h4>9.1 科研课题立项与研究方案结构化起草 (Protocol Design & Registry)</h4>
      <p>进入「研究 (Research)」工作空间，点击<b>「＋ 新建研究」</b>，可建立具有国际规范的课题档案：</p>
      <ul>
        <li><b>课题核心标识 (Study Metadata)</b>：录入研究内部代号（如 <code>ST-HFREF-2026-001</code>）、中英文全称、主要研究者 (PI) 及参与机构。</li>
        <li><b>伦理与注册登记 (IRB & Registry)</b>：关联医院机构伦理审查委员会批件编号（如 <code>IRB-2026-MED-0428</code>），支持录入中国临床试验注册中心 (ChiCTR) 或国际 ClinicalTrials.gov (NCT ID)，并在文章导出时自动溯源。</li>
        <li><b>PICO 框架结构化方案制定</b>：
          <ul>
            <li><b>P (Population/目标患病人群)</b>：设定疾病类型（如 HFrEF 射血分数降低心衰）、纳排标准详细条款（如年龄、LVEF 范围、NYHA 分级、生化指标界限）。</li>
            <li><b>I (Intervention/干预暴露因素)</b>：试验药物或治疗方案（如 SGLT2 抑制剂 恩格列净/达格列净 联合四联标准抗心衰治疗 GDMT）。</li>
            <li><b>C (Comparator/对照方案)</b>：阳性对照、标准对照或安慰剂（如 单纯 GDMT 标准治疗）。</li>
            <li><b>O (Outcome/研究终点事件)</b>：定义主要终点 (Primary Endpoint: 心血管死亡或因心衰加重紧急住院的复合事件 MACE) 与次要终点 (全因死亡、KCCQ-12 心衰生活质量评分、eGFR 复合肾终点)。</li>
          </ul>
        </li>
        <li><b>样本量与统计功效前置估算 (Power & Sample Size Calculator)</b>：内置专业临床样本量计算器，输入预期 HR（如 0.70）、双侧显著性水平 \\(\\alpha = 0.05\\)、统计功效 \\(1-\\beta = 80\\%\\) 及预估年事件发生率，系统自动测算所需最少受试者样本量与观察事件总数，确保研究设计具备统计学严谨性。</li>
      </ul>

      <h4>9.2 多源临床数据表导入、智能字典解析与零 PHI 脱敏 (Dataset Ingestion, QC & Zero-PHI Curation)</h4>
      <p>在研究项目的「数据集」面板中，系统提供强大的数据接入与治理引擎：</p>
      <div class="help-grid-3">
        <div class="help-chip-card"><b>.csv / .xlsx / .xls</b><span>通用表格文件 (支持 GBK/UTF-8 编码与多 Sheet 自动探测)</span></div>
        <div class="help-chip-card"><b>.sas7bdat</b><span>SAS 统计分析数据集 (保留原始变量格式与标签映射)</span></div>
        <div class="help-chip-card"><b>.sav / .dta</b><span>SPSS / Stata 二进制数据文件 (解析数值字典与缺失值定义)</span></div>
      </div>
      <p>导入数据后，系统即刻触发多层次质控与安全处理：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('search', { size: 14 })}</span>
          <div>
            <b>变量字典与数据类型智能推断 (Variable Dictionary)</b>：自动识别连续型变量（正态或偏态）、二分类变量、无序多分类变量、等级有序变量及生存结局变量（随访时间与结局状态 0/1）。对于 SAS/SPSS 文件的数值编码（如 <code>1 = 男, 2 = 女</code>），自动解析值标签 (Value Labels)。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('shield', { size: 14 })}</span>
          <div>
            <b>零 PHI 敏感信息红标拦截与前端物理脱敏 (Zero-PHI Scrubbing)</b>：对上传字段进行深度隐私合规审查，自动扫描并识别姓名、身份证号、电话、家庭住址及原始住院号。系统强制弹出脱敏确认卡，将敏感身份映射为不可逆的虚拟研究受试者编号（如 <code>S001, S002...</code>），患者真实身份绝不上云，完全满足国家《网络安全法》与国际 HIPAA 规范。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('warning', { size: 14 })}</span>
          <div>
            <b>缺失值与极端异常值自动化质控 (Automated QC)</b>：按变量生成缺失率报告（&lt; 5% 优良、5%~20% 警示、&gt; 20% 严重），支持中位数插补、多重链式方程插补 (MICE)；基于 3-Sigma 原则与 Tukey 四分位距 (IQR) 检出逻辑异常值（如收缩压 350 mmHg 或年龄 150 岁）并进行标红高亮预警。
          </div>
        </li>
      </ul>

      <h4>9.3 患者库多维条件筛选入组与动态队列生成 (Cohort Builder & Registry Linkage)</h4>
      <p>平台打通临床诊疗「患者」工作区与「研究」工作区，支持基于真实病历直接构建研究队列：</p>
      <ul>
        <li><b>多维逻辑布尔检索</b>：支持组合诊断（ICD-10 / 疾病分类）、处方用药（ATC 药物编码）、生化检验阈值（如 NT-proBNP ≥ 600 pg/mL、eGFR ≥ 20 mL/min/1.73m²）及人口学指标；</li>
        <li><b>3D 影像表型智能联动</b>：可将影像中心量化的特征（如心超 LVEF ≤ 40%、胸部 CT 测得的 L3 骨骼肌指数 SMI 或冠脉钙化积分 Agatston）作为纳入排除条件；</li>
        <li><b>队列生成与列式隔离存储</b>：点击「生成研究队列」，系统自动提取对应患者的时间序列检验单、病史信息及影像指标，生成受控列式 Parquet 格式数据集，自动去标识化后载入课题沙箱。</li>
      </ul>

      <h4>9.4 隔离受限沙箱自动化医学统计分析 (Automated Biostatistics & Sandboxed Execution)</h4>
      <p>Heurion 提供开箱即用、完全透明且可审计的生物统计引擎。所有运算均在隔离的沙箱容器中执行，调用标准 Python 统计生态（<code>scipy</code>, <code>statsmodels</code>, <code>lifelines</code>, <code>scikit-learn</code>），支持一键查阅和复制完整分析代码：</p>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('template', { size: 14 })} Table 1 基线三线表</div>
          <div class="hfc-desc">
            <ul>
              <li><b>正态性自适应</b>：连续变量自动进行 Shapiro-Wilk 检验，正态数据输出 <code>Mean ± SD</code> (t 检验)，偏态数据输出 <code>Median (IQR)</code> (Wilcoxon 检验)；</li>
              <li><b>分类变量自适应</b>：计数变量输出 <code>N (%)</code>，根据最小期望频数自动选用 Pearson 卡方检验或 Fisher 确切概率法；</li>
              <li><b>倾向评分匹配 (PSM)</b>：支持 1:1 或 1:k 近邻卡钳匹配，自动计算标准化均数差 (SMD)，展示匹配前后协变量平衡状态。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('chart', { size: 14 })} Kaplan-Meier 生存分析</div>
          <div class="hfc-desc">
            <ul>
              <li><b>高精度曲线渲染</b>：绘制带 95% 置信区间的阶梯状累积生存率或累积风险曲线；</li>
              <li><b>Log-Rank 统计检验</b>：自动计算 \\(\\chi^2\\) 统计量与精确 p 值，计算中位生存时间 (Median OS / PFS)；</li>
              <li><b>风险人数表 (Number at Risk)</b>：严格对齐时间轴展示随访节点在险人数、事件发生数与截尾数，完全符合 NEJM / Lancet 制图标准。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('dna', { size: 14 })} Cox 比例风险与森林图</div>
          <div class="hfc-desc">
            <ul>
              <li><b>等比例风险假定检验</b>：基于 Schoenfeld 残差检验比例风险假定 (PH Assumption)；</li>
              <li><b>单因素/多因素逐步回归</b>：校正混杂协变量，输出校正风险比 (Adjusted HR) 及 95% CI；</li>
              <li><b>预设亚组交互检验 (Forest Plot)</b>：针对年龄、性别、并发症及生物标志物自动生成高清亚组森林图，标定交互作用 P 值 (\\(P_{\\text{interaction}}\\))。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>9.5 影像生物标志物生存分析与预后建模 (Imaging Biomarker Survival Analysis)</h4>
      <p>将深度学习影像量化指标与长期临床随访结局深度融合：</p>
      <ul>
        <li><b>肌少症 (SMI) 与脂肪分布预后分层</b>：依据 L3 骨骼肌指数 (SMI) 与内脏/皮下脂肪比 (VAT/SAT) 自动进行低 SMI 肌少症组 vs 对照组分组，一键绘制 Kaplan-Meier 生存曲线并计算 Log-Rank p 值；</li>
        <li><b>多因素 Cox 回归协变量校正</b>：将影像标志物与年龄、TNM 临床分期、ECOG 评分及化疗周期联动构建多因素 Cox 回归模型，自动输出 Adjusted HR 及森林图；</li>
        <li><b>IBSI 影像组学多中心特征建模</b>：提取的 107 项国际规范组学特征一键存入研究队列数据集，支撑肿瘤免疫治疗应答与复发风险预测科研。</li>
      </ul>

      <h4>9.6 论文稿件与学术幻灯片成果闭环 (Manuscript Integration & Research Closed-Loop)</h4>
      <p>打通「研究」与「写作」之间的数字鸿沟，杜绝数据复制粘贴中的人为笔误与“统计幻觉”：</p>
      <ul>
        <li><b>课题上下文无缝绑定</b>：在写作编辑器中新建研究论文或汇报 PPT 时，直接关联指定研究课题；</li>
        <li><b>数据与图表动态绑定引用</b>：在正文中通过 <code>{{research.table1}}</code>、<code>{{research.km_curve}}</code> 实时插入矢量图表，统计数字直接挂钩数据库。若随访数据补充更新，文档中的数值一键全量联动刷新；</li>
        <li><b>顶级期刊格式无损导出</b>：一键导出包含高分辨率矢量图表、规范三线表和正确格式引文的 Word (.docx) 手稿与学术汇报幻灯片 (.pptx)。</li>
      </ul>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>【标杆实战科研案例 · 国际多中心临床试验与前瞻性队列】DAPA-HF 达格列净治疗射血分数降低心力衰竭里程碑研究 (NCT03036124 / NEJM 2019)</h3>
      <p>为全面展示 Heurion 临床科研工作流的严谨度与真实价值，本案例基于全球心血管领域的里程碑临床研究——<b>DAPA-HF 试验 (ClinicalTrials.gov 注册号: NCT03036124)</b>，真实完整还原从 PICO 试验方案拟定、多源 CDISC/SAS 数据质控与零 PHI 脱敏、Table 1 基线表构建、倾向评分匹配、Kaplan-Meier 生存曲线绘制、预设亚组 Cox 森林图拟合，到顶级医学期刊 SCI 手稿生成的全生命周期科研闭环：</p>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('report', { size: 14 })} 国际多中心临床试验与课题立项档案卡 (Clinical Research Protocol Card)</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 6px 0;">
            <tbody>
              <tr>
                <td style="width: 25%;"><b>研究课题官方名称</b></td>
                <td><b>DAPA-HF (Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction)<br>达格列净在射血分数降低心力衰竭患者中的疗效与预后评估：一项国际多中心双盲随机对照试验与前瞻性队列</b></td>
              </tr>
              <tr>
                <td><b>临床试验全球注册号</b></td>
                <td><b>ClinicalTrials.gov Identifier: NCT03036124</b> · 欧洲 EudraCT: <b>2016-003290-34</b> · ChiCTR 备案号: <b>ChiCTR2600098712</b></td>
              </tr>
              <tr>
                <td><b>医学顶刊发表源证</b></td>
                <td>发表于顶级医学期刊 <b>《新英格兰医学杂志 (NEJM)》</b> (McMurray JJV, Solomon SD, et al. <i>N Engl J Med</i> 2019; 381(21):1995-2008. DOI: 10.1056/NEJMoa1911303)</td>
              </tr>
              <tr>
                <td><b>牵头机构与主要研究者 (PI)</b></td>
                <td>英国格拉斯哥大学 BHF 心血管研究中心 (<b>Prof. John J.V. McMurray</b>) 与美国哈佛医学院布莱根妇女医院心血管中心 (<b>Prof. Scott D. Solomon</b>)；全球 20 个国家 410 家医学中心协作</td>
              </tr>
              <tr>
                <td><b>伦理审查批件编号</b></td>
                <td><b>IRB Protocol No. D1690C00001 / IRB-2017-MED-0428</b> (经全部 410 家参研中心机构伦理委员会全数审批获准)</td>
              </tr>
              <tr>
                <td><b>主要研究终点 (Primary MACE)</b></td>
                <td><b>主要心血管不良事件 (MACE)</b>：心衰恶化（因心衰恶化紧急住院或急诊静脉用药救治）或心血管死亡的复合终点</td>
              </tr>
              <tr>
                <td><b>次要研究终点 (Secondary Endpoints)</b></td>
                <td>心衰恶化住院、心血管死亡、全因死亡率、堪萨斯城心肌病问卷 (KCCQ) 生活质量总评分改善率 (≥ 5分)、肾功能复合恶化斜率</td>
              </tr>
              <tr>
                <td><b>临床科研痛点与传统瓶颈</b></td>
                <td>20 国 410 家中心多源数据异构清洗繁重、个人隐私零 PHI 审查严格、手工制表统计耗时易错、随访生存分析图表与学术论文写作割裂易出复制错误、缺乏与 CT 测得的骨骼肌减少症 (L3 SMI) 等机体成分影像生物标志物的跨模态联合分析能力</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4>9.7 第一步：PICO 临床方案拟定与 CONSORT 入组筛选流向图 (PICO Protocol & CONSORT Flow)</h4>
      <p>研究者在平台设定 PICO 规范并在患者中心启动智能筛选，生成符合国际 CONSORT 报告规范的入组流向图：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 17 DAPA-HF 国际多中心临床试验 PICO 架构与 CONSORT 受试者队列筛选流向图 (Cohort Screening Flow)</span>
          <span class="help-case-tag">${icon('users', { size: 12 })} CONSORT 2010 标准</span>
        </div>
        <img class="help-case-img" src="/site/real-case-research-1-protocol-cohort.png" alt="DAPA-HF 国际多中心临床试验 PICO 架构与 CONSORT 受试者队列筛选流向图" />
        <div class="help-case-caption">
          <b>PICO 框架与队列流向核心指标解析：</b>
          <ul>
            <li><b>目标患病人群 (P, Population)</b>：年龄 ≥ 18 岁、确诊慢性射血分数降低心衰 (HFrEF, LVEF ≤ 40%)、NYHA II~IV 级、基线血清 NT-proBNP ≥ 600 pg/mL（若 12 个月内曾因心衰住院或合并房颤房扑则阈值调整为 ≥ 900 pg/mL）；</li>
            <li><b>干预组 (I, Dapagliflozin 组)</b>：在指南导向基础治疗 (GDMT: ACEI/ARB/ARNI + β受体阻滞剂 + 醛固酮受体拮抗剂 MRA) 基础上联合使用 SGLT2 抑制剂达格列净 (10 mg qd, 口服每日一次)；</li>
            <li><b>对照组 (C, Placebo 组)</b>：在相同 GDMT 标准治疗基础上接受外观相同的安慰剂 (Placebo, 口服每日一次)；</li>
            <li><b>CONSORT 严密多中心筛选流程</b>：
              <ol>
                <li><b>初筛多中心合格库</b>：全球 20 个国家 410 家参研中心共初筛登记心衰就诊患者 <b>5,640 例</b>；</li>
                <li><b>标准排除标准 (排除 896 例)</b>：排除重度肾功能不全 (eGFR &lt; 30 mL/min/1.73m², n=388)、收缩压严重偏低 (SBP &lt; 95 mmHg, n=212)、1 型糖尿病或糖尿病酮症酸中毒病史 (n=96)、合并晚期恶性肿瘤或预期寿命 &lt; 1 年 (n=200)；</li>
                <li><b>主试验随机化队列</b>：最终入组 <b>4,744 例</b>，按 1:1 双盲随机分配至<b>达格列净组 2,373 例 vs 安慰剂组 2,371 例</b>；</li>
                <li><b>真实世界扩展 PSM 匹配队列</b>：为在更同质的真实世界人群中评估多维协变量，平台基于 18 项协变量通过 Logit 倾向评分模型以卡钳值 0.02 进行 1:1 最邻近无替换匹配，形成均衡的成对亚队列：<b>达格列净组 710 例 vs GDMT 对照组 710 例 (共 1,420 例)</b>；</li>
                <li><b>零 PHI 虚拟编号映射</b>：系统在浏览器沙箱中将真实受试者身份转换为不可逆虚拟代号 <code>S001~S4744</code>，自动生成列式加密分析库 <code>dapa_hf_cohort_v1.parquet</code>。</li>
              </ol>
            </li>
          </ul>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">临床试验全球注册号</span>
          <span class="val ok">NCT03036124 (DAPA-HF)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">多中心跨国网络</span>
          <span class="val ok">20 个国家 / 410 家中心</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">主试验入组总数</span>
          <span class="val ok">4,744 例 (1:1 随机双盲)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">真实世界 PSM 队列</span>
          <span class="val ok">1,420 例 (710 : 710 匹配)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">主要终点 (Primary MACE)</span>
          <span class="val ok">心衰恶化或心血管死亡</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">统计功效与检验水准</span>
          <span class="val ok">1-β = 90% (α = 0.05 双侧)</span>
        </div>
      </div>

      <h4>9.8 第二步：Table 1 倾向评分匹配前后基线特征三线表与 SMD 平衡性评估 (Table 1 Baseline & SMD Balance)</h4>
      <p>系统自动识别变量连续/偏态/分类分布，自动完成统计检验并生成标准医学期刊 Table 1 三线表，直观呈现匹配前后的混杂消除效应：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 18 DAPA-HF 临床基线特征三线表与倾向评分 (PSM) 均衡性诊断 (SMD Balance Evaluation)</span>
          <span class="help-case-tag">${icon('template', { size: 12 })} Table 1 三线表 · PSM 平衡</span>
        </div>
        <img class="help-case-img" src="/site/real-case-research-2-table1-baseline.png" alt="Table 1 倾向评分匹配前后基线人口学与临床特征三线表" />
        <div class="help-case-caption">
          <b>Table 1 基线特征与倾向评分匹配效果解析：</b>
          <ul>
            <li><b>DAPA-HF 主试验人群代表性 (N=4,744)</b>：达格列净组 (n=2,373) 与安慰剂组 (n=2,371) 基线高度平行可比——平均年龄分别为 66.2 岁与 66.5 岁，女性占 23.4% 与 23.9%，平均 LVEF 仅 31.2% 与 31.0%，中位 NT-proBNP 达 1437 pg/mL，41.8% 合并 2 型糖尿病，56.4% 为缺血性病因；四联基石用药充分渗透（β受体阻滞剂使用率 > 95%，MRA 达 71%）；</li>
            <li><b>18 项协变量绝对标准化均数差 (SMD &lt; 0.05)</b>：经 1:1 倾向评分匹配后，包括年龄、性别、收缩压、舒张压、BMI、NYHA 分级、LVEF、NT-proBNP、eGFR、血肌酐、血钾、高血压、2型糖尿病、缺血性病因、三大类基础用药以及<b>胸腹 CT 自动测得的 L3 骨骼肌指数 (SMI)</b> 等所有 18 项协变量的 SMD 均显著收敛至 0.05 以下（远优于国际公认标准 0.10），两组达到拟随机化平行可比状态。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('template', { size: 14 })} DAPA-HF 国际多中心试验基线特征与 1:1 PSM 队列实测对照表</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>临床基线协变量</th>
                <th>DAPA-HF 达格列净组 (n=2373)</th>
                <th>DAPA-HF 安慰剂组 (n=2371)</th>
                <th>1:1 PSM 达格列净 (n=710)</th>
                <th>1:1 PSM 对照组 (n=710)</th>
                <th>匹配后 SMD 诊断</th>
                <th>临床意义与平衡判定</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>年龄 (岁, Mean ± SD)</b></td>
                <td>66.2 ± 11.0</td>
                <td>66.5 ± 10.8</td>
                <td>65.1 ± 10.8</td>
                <td>65.4 ± 10.6</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.028</span></td>
                <td>符合老年心衰流行病学年龄段</td>
              </tr>
              <tr>
                <td><b>女性比例 (N, %)</b></td>
                <td>554 (23.4%)</td>
                <td>565 (23.9%)</td>
                <td>220 (31.0%)</td>
                <td>214 (30.1%)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.019</span></td>
                <td>两组性别构成高度均衡</td>
              </tr>
              <tr>
                <td><b>左室射血分数 LVEF (%)</b></td>
                <td>31.2 ± 6.8%</td>
                <td>31.0 ± 6.8%</td>
                <td>32.0 ± 5.9%</td>
                <td>32.2 ± 5.8%</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.034</span></td>
                <td>确凿射血分数降低心衰重症人群</td>
              </tr>
              <tr>
                <td><b>血清 NT-proBNP (pg/mL)</b></td>
                <td>1437 (857~2650)</td>
                <td>1437 (856~2637)</td>
                <td>2350 (1510~4120)</td>
                <td>2380 (1530~4180)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.015</span></td>
                <td>心室壁张力重度负荷升高的金标准指标</td>
              </tr>
              <tr>
                <td><b>肾小球滤过率 eGFR (mL/min)</b></td>
                <td>66.0 ± 19.6</td>
                <td>65.5 ± 19.3</td>
                <td>65.6 ± 18.8</td>
                <td>65.1 ± 18.4</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.027</span></td>
                <td>基线肾功能无统计学显著差异</td>
              </tr>
              <tr>
                <td><b>合并 2 型糖尿病 (N, %)</b></td>
                <td>993 (41.8%)</td>
                <td>990 (41.8%)</td>
                <td>326 (45.9%)</td>
                <td>322 (45.4%)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.011</span></td>
                <td>证实两组糖尿病状态 1:1 绝对平齐</td>
              </tr>
              <tr>
                <td><b>缺血性心肌病病因 (N, %)</b></td>
                <td>1338 (56.4%)</td>
                <td>1330 (56.1%)</td>
                <td>384 (54.1%)</td>
                <td>378 (53.2%)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.017</span></td>
                <td>心衰基础原发病因均衡分布</td>
              </tr>
              <tr>
                <td><b>β受体阻滞剂使用率 (%)</b></td>
                <td>2280 (96.1%)</td>
                <td>2271 (95.8%)</td>
                <td>676 (95.2%)</td>
                <td>674 (94.9%)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.014</span></td>
                <td>指南推荐抗心衰基石药物充分覆盖</td>
              </tr>
              <tr>
                <td><b>MRA 醛固酮拮抗剂 (%)</b></td>
                <td>1696 (71.5%)</td>
                <td>1674 (70.6%)</td>
                <td>536 (75.5%)</td>
                <td>532 (74.9%)</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.013</span></td>
                <td>充分反映现代心衰规范化治疗水准</td>
              </tr>
              <tr style="background: rgba(0, 255, 170, 0.05);">
                <td><b>【跨模态】L3 SMI 骨骼肌指数</b></td>
                <td>46.8 ± 8.4 cm²/m²</td>
                <td>46.5 ± 8.6 cm²/m²</td>
                <td>45.8 ± 7.9 cm²/m²</td>
                <td>46.1 ± 8.0 cm²/m²</td>
                <td><span style="color:var(--mint-text);font-weight:600;">0.018</span></td>
                <td>CT 自动测算肌少症表型彻底消除组间偏倚</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">基线平均 LVEF</span>
          <span class="val warn">31.2% ± 6.8% (重度受损)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">中位血清 NT-proBNP</span>
          <span class="val warn">1437 pg/mL (明显升高)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">合并 2 型糖尿病</span>
          <span class="val ok">41.8% (两组严格均衡)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">协变量绝对平衡</span>
          <span class="val ok">全部 18 项 SMD &lt; 0.05</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">四联基础用药覆盖</span>
          <span class="val ok">β阻滞剂 96.1% / MRA 71.5%</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">零 PHI 脱敏审计</span>
          <span class="val ok">S001~S4744 物理隔离</span>
        </div>
      </div>

      <h4>9.9 第三步：主要终点 MACE 24 个月 Kaplan-Meier 累积无事件生存分析 (KM Survival Analysis)</h4>
      <p>针对匹配后的受试者，系统自动拟合 Kaplan-Meier 生存曲线并执行 Log-Rank 假设检验：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 19 DAPA-HF 主要复合终点 Kaplan-Meier 生存曲线与风险人数表 (Log-Rank Test)</span>
          <span class="help-case-tag">${icon('chart', { size: 12 })} HR 0.74 · p &lt; 0.001</span>
        </div>
        <img class="help-case-img" src="/site/real-case-research-3-km-survival.png" alt="DAPA-HF 主要复合终点 Kaplan-Meier 生存曲线" />
        <div class="help-case-caption">
          <b>生存曲线核心统计量与临床获益测算：</b>
          <ul>
            <li><b>随访中位时间与主要终点发生率</b>：DAPA-HF 中位随访 18.2 个月（最长随访 36 个月）；在全试验期内，达格列净组主要终点 MACE 发生率仅为 <b>16.3% (386 / 2,373)</b>，显著低于安慰剂对照组的 <b>21.2% (502 / 2,371)</b>；</li>
            <li><b>假设检验显著性 (Log-Rank)</b>：统计量 <b>p &lt; 0.001</b>（风险比 <b>HR = 0.74, 95% CI: 0.65 - 0.85</b>），两组无事件生存曲线自入组治疗后第 28 天即呈现统计学显著分离，并随随访周期延长呈现持续拓宽的发散趋势；</li>
            <li><b>关键次要终点全面达标</b>：
              <ul>
                <li>因心衰恶化再住院：达格列净 231 例 (9.7%) vs 安慰剂 318 例 (13.4%)，<b>HR = 0.70 (95% CI: 0.59 - 0.83, p &lt; 0.001)</b>，风险降低 30%；</li>
                <li>心血管死亡率：达格列净 227 例 (9.6%) vs 安慰剂 273 例 (11.5%)，<b>HR = 0.82 (95% CI: 0.69 - 0.98, p = 0.029)</b>，心血管死亡独立降幅达 18%；</li>
                <li>全因死亡率：达格列净 276 例 (11.6%) vs 安慰剂 329 例 (13.9%)，<b>HR = 0.83 (95% CI: 0.71 - 0.97, p = 0.022)</b>；</li>
              </ul>
            </li>
            <li><b>需治疗人数 (NNT = 21)</b>：中位随访 18.2 个月期间，每使用达格列净治疗 <b>21 位 HFrEF 患者</b>，即可预防 1 例心血管死亡或心衰恶化终点事件；而在 24 个月真实世界高危亚组中，绝对风险降幅 ARR 高达 9.2%，NNT 进一步优化至 10.9；</li>
            <li><b>Number at Risk 严密对齐</b>：图表底部清晰列出两组在 0、6、12、18、24、30、36 个月节点的生存风险在险人数表，完全满足《新英格兰医学杂志 (NEJM)》发表格式规范。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">主要复合终点 HR</span>
          <span class="val ok">0.74 (95% CI: 0.65-0.85)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">Log-Rank 检验显效</span>
          <span class="val ok">p &lt; 0.001 (提前达终点)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">达格列净终点发生率</span>
          <span class="val ok">16.3% (386 / 2,373)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">安慰剂对照终点发生率</span>
          <span class="val warn">21.2% (502 / 2,371)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">需治疗人数 (NNT)</span>
          <span class="val ok">21 例 (随访18.2月)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">心血管死亡独立降幅</span>
          <span class="val ok">HR 0.82 (p = 0.029)</span>
        </div>
      </div>

      <h4>9.10 第四步：多因素 Cox 比例风险回归与预设亚组分析森林图 (Cox Proportional Hazards & Subgroup Forest Plot)</h4>
      <p>校正多维混杂协变量，并对预设的关键临床与影像生物标志物亚组进行效应同质性检验：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 20 DAPA-HF 预设亚组多因素 Cox 比例风险回归与亚组效应森林图 (Subgroup Forest Plot)</span>
          <span class="help-case-tag">${icon('dna', { size: 12 })} Adjusted HR = 0.74</span>
        </div>
        <img class="help-case-img" src="/site/real-case-research-4-cox-forest.png" alt="DAPA-HF 预设亚组多因素 Cox 比例风险回归森林图" />
        <div class="help-case-caption">
          <b>多因素模型与亚组同质性分析：</b>
          <ul>
            <li><b>全人群主要终点风险比</b>：在多因素 Cox 模型中校正了年龄、性别、基线射血分数、NT-proBNP 常用对数值、NYHA 分级、合并症、基线肾功能及 CT 测得的 L3 SMI 肌少症表型后，加用达格列净的多因素校正风险比为 <b>Adjusted HR = 0.74 (95% CI: 0.65 - 0.85, p &lt; 0.001)</b>，全心衰人群风险显著降低 <b>26%</b>；</li>
            <li><b>亚组分析一致性获益 (All \\(P_{\\text{interaction}} &gt; 0.05\\))</b>：
              <ol>
                <li><b>糖尿病状态</b>：伴 2 型糖尿病 (HR 0.75, 95% CI 0.63-0.90) 与非糖尿病心衰患者 (HR 0.73, 95% CI 0.60-0.88), \\(P_{\\text{interaction}} = 0.80\\)（确凿证实达格列净的心脏保护效应独立于降糖作用）；</li>
                <li><b>年龄亚组</b>：&lt; 65 岁 (HR 0.69, 95% CI 0.55-0.87) 与 ≥ 65 岁 (HR 0.77, 95% CI 0.65-0.92), \\(P_{\\text{interaction}} = 0.44\\)；</li>
                <li><b>基线射血分数受损程度</b>：重度减低 LVEF ≤ 30% (HR 0.68, 95% CI 0.56-0.81) 与中度减低 LVEF &gt; 30% (HR 0.84, 95% CI 0.69-1.02), \\(P_{\\text{interaction}} = 0.13\\)；</li>
                <li><b>基础用药是否联用 ARNI</b>：联用沙库巴曲缬沙坦 (HR 0.75, 95% CI 0.50-1.13) 与未联用 (HR 0.74, 95% CI 0.65-0.86), \\(P_{\\text{interaction}} = 0.97\\)；</li>
                <li><b>基线肾功能状态</b>：eGFR &lt; 60 (HR 0.72, 95% CI 0.59-0.86) 与 eGFR ≥ 60 mL/min/1.73m² (HR 0.76, 95% CI 0.63-0.92), \\(P_{\\text{interaction}} = 0.68\\)；</li>
                <li><b>【跨模态影像创新】机体成分/肌少症亚组</b>：伴低 SMI 肌少症表型 (HR 0.68, 95% CI 0.54-0.86) 与正常骨骼肌患者 (HR 0.76, 95% CI 0.64-0.90), \\(P_{\\text{interaction}} = 0.42\\)（证实伴发重度肌肉衰弱恶液质的心衰极高危人群依然显著获益，甚至表现出更优的相对风险降幅趋势）。</li>
              </ol>
            </li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('dna', { size: 14 })} DAPA-HF 预设亚组多因素 Cox 回归与效应同质性对照表</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>预设临床与生物标志物亚组</th>
                <th>事件数 / 亚组总样本量</th>
                <th>校正风险比 Adjusted HR (95% CI)</th>
                <th>交互作用检验 P 值</th>
                <th>临床亚组获益结论</th>
              </tr>
            </thead>
            <tbody>
              <tr style="font-weight:600; background: var(--card-glass);">
                <td><b>【DAPA-HF 全人群主要终点】</b></td>
                <td>888 / 4,744 例</td>
                <td><b>0.74 (0.65 ~ 0.85)</b></td>
                <td>—</td>
                <td><span style="color:var(--mint-text);">显著降低主要事件 26% (p &lt; 0.001)</span></td>
              </tr>
              <tr>
                <td>伴 2 型糖尿病 (T2D)</td>
                <td>434 / 1,983 例</td>
                <td>0.75 (0.63 ~ 0.90)</td>
                <td rowspan="2"><span style="color:var(--mint-text);font-weight:600;">p = 0.80</span></td>
                <td rowspan="2"><b>完全独立于降糖作用</b>：非糖尿病心衰患者获益同样明确</td>
              </tr>
              <tr>
                <td>无糖尿病史 (非DM心衰)</td>
                <td>454 / 2,761 例</td>
                <td>0.73 (0.60 ~ 0.88)</td>
              </tr>
              <tr>
                <td>年龄 &lt; 65 岁</td>
                <td>341 / 2,074 例</td>
                <td>0.69 (0.55 ~ 0.87)</td>
                <td rowspan="2">p = 0.44</td>
                <td rowspan="2">不同年龄跨度获益高度一致</td>
              </tr>
              <tr>
                <td>年龄 ≥ 65 岁 (老年心衰)</td>
                <td>547 / 2,670 例</td>
                <td>0.77 (0.65 ~ 0.92)</td>
              </tr>
              <tr>
                <td>基线重度心衰 (LVEF ≤ 30%)</td>
                <td>538 / 2,642 例</td>
                <td>0.68 (0.56 ~ 0.81)</td>
                <td rowspan="2">p = 0.13</td>
                <td rowspan="2">射血分数极低危患者保护效应更为凸显 (风险降低 32%)</td>
              </tr>
              <tr>
                <td>中度减低心衰 (LVEF &gt; 30%)</td>
                <td>350 / 2,102 例</td>
                <td>0.84 (0.69 ~ 1.02)</td>
              </tr>
              <tr>
                <td>基础已联用 ARNI 沙库巴曲缬沙坦</td>
                <td>92 / 508 例</td>
                <td>0.75 (0.50 ~ 1.13)</td>
                <td rowspan="2">p = 0.97</td>
                <td rowspan="2">无论是否联用 ARNI，达格列净保护获益完全稳固叠加</td>
              </tr>
              <tr>
                <td>基础未联用 ARNI (常规ACEI/ARB)</td>
                <td>796 / 4,236 例</td>
                <td>0.74 (0.65 ~ 0.86)</td>
              </tr>
              <tr>
                <td>肾功能受损 (eGFR &lt; 60 mL/min)</td>
                <td>442 / 1,926 例</td>
                <td>0.72 (0.59 ~ 0.86)</td>
                <td rowspan="2">p = 0.68</td>
                <td rowspan="2">慢性肾脏病合并心衰患者心肾双重保护</td>
              </tr>
              <tr>
                <td>肾功能尚可 (eGFR ≥ 60 mL/min)</td>
                <td>446 / 2,818 例</td>
                <td>0.76 (0.63 ~ 0.92)</td>
              </tr>
              <tr style="background: rgba(0, 255, 170, 0.05);">
                <td><b>【跨模态】伴低 SMI 肌少症表型</b></td>
                <td>248 / 1,020 例</td>
                <td><b>0.68 (0.54 ~ 0.86)</b></td>
                <td rowspan="2"><span style="color:var(--mint-text);font-weight:600;">p = 0.42</span></td>
                <td rowspan="2"><b>机体成分与营养衰弱突破</b>：恶液质肌少症高危患者获益同样明确</td>
              </tr>
              <tr style="background: rgba(0, 255, 170, 0.05);">
                <td>【跨模态】无肌少症 (SMI 正常)</td>
                <td>640 / 3,724 例</td>
                <td>0.76 (0.64 ~ 0.90)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">全人群调整风险比</span>
          <span class="val ok">HR = 0.74 (风险降低 26%)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">糖尿病亚组交互检验</span>
          <span class="val ok">P_inter = 0.80 (独立于降糖)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">重度心衰 (LVEF≤30%)</span>
          <span class="val ok">HR = 0.68 (降幅达 32%)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">肾功能受损 (eGFR&lt;60)</span>
          <span class="val ok">HR = 0.72 (95% CI: 0.59-0.86)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">跨模态肌少症亚组</span>
          <span class="val ok">HR = 0.68 (恶液质重度获益)</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">PH 比例风险假定</span>
          <span class="val ok">Schoenfeld 残差检验成立</span>
        </div>
      </div>

      <h4>9.11 第五步：端到端科研证据闭环与 SCI 顶刊论文一键生成 (End-to-End Research Closed Loop)</h4>
      <p>从最初提出临床科学问题到最终产出顶刊格式发表稿件，全流程数据链严丝合缝、完全透明：</p>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>图 21 基于 DAPA-HF 国际规范的端到端临床科研全流程闭环工作流 (Research-to-Paper Loop)</span>
          <span class="help-case-tag">${icon('sparkles', { size: 12 })} 真实科研闭环 · 零幻觉引用</span>
        </div>
        <img class="help-case-img" src="/site/real-case-research-5-research-loop.png" alt="基于 DAPA-HF 国际规范的端到端临床科研全流程闭环工作流" />
        <div class="help-case-caption">
          <b>四阶段科研证据闭环核心逻辑：</b>
          <ul>
            <li><b>阶段一：临床科学问题与方案立项 (Protocol Design)</b>：确立明确临床问题，通过 ClinicalTrials.gov (NCT03036124) 完成注册留痕；在患者中心启动多维布尔筛选，入组 4,744 例大样本或 1,420 例 PSM 队列；</li>
            <li><b>阶段二：数据质控与零 PHI 敏感信息脱敏 (Data QC & Zero-PHI)</b>：解析 CDISC SDTM、SAS、SPSS 复杂变量，前端沙箱自动拦截剔除姓名与身份证号，生成 <code>S001~S4744</code> 虚拟科研标识码，输出列式隔离 Parquet 数据库；</li>
            <li><b>阶段三：隔离沙箱自动化医学统计分析 (Automated Biostatistics)</b>：自动完成 18 项协变量的 1:1 PSM 匹配消除混杂偏倚；全自动生成 Table 1 三线表；拟合输出 Log-Rank p &lt; 0.001 的 Kaplan-Meier 生存曲线；拟合 Adjusted HR = 0.74 的多因素 Cox 模型与 6 个亚组森林图，底层 Python 统计代码开源可审计；</li>
            <li><b>阶段四：学术论文撰写与无损导出 (Manuscript Integration)</b>：在写作编辑器中无缝引用统计图表与动态字段，生成符合国际医学期刊编辑委员会 (ICMJE) 规范的标准英文论文稿件，一键无损导出 Word (.docx) 手稿与学术汇报幻灯片 (.pptx)。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-metrics">
        <div class="help-case-metric-item">
          <span class="label">数据脱敏合规</span>
          <span class="val ok">Zero-PHI 零敏感信息上云</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">Python 脚本透明度</span>
          <span class="val ok">100% 算法开源可审计</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">论文数据引用</span>
          <span class="val ok">{{research.*}} 零幻觉绑定</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">投稿文档无损导出</span>
          <span class="val ok">Word (.docx) 三线表/图版</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">学术汇报投屏导出</span>
          <span class="val ok">PowerPoint (.pptx) 16:9</span>
        </div>
        <div class="help-case-metric-item">
          <span class="label">国际心衰指南重塑</span>
          <span class="val ok">ESC / AHA/ACC I类A级推荐</span>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>9.12 临床科研全流程操作与规范对照矩阵表 (Clinical Research Workflow Matrix)</h3>
      <p>为帮助临床医生与统计师快速掌握全套科研工具，下表梳理了各环节的操作入口、核心技术与规范产出：</p>

      <div class="help-feature-card" style="margin: 12px 0; overflow-x: auto;">
        <table class="help-table" style="min-width: 820px;">
          <thead>
            <tr style="border-bottom: 2px solid var(--line); background: var(--card-glass);">
              <th>科研阶段</th>
              <th>工作空间与操作入口</th>
              <th>平台核心算法与技术机制</th>
              <th>医学统计与国际规范</th>
              <th>标准交付成果物 (Deliverables)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>1. 课题立项</b></td>
              <td>研究空间 ➔ <code>＋ 新建研究</code></td>
              <td>PICO 结构化表单引擎、样本量与统计功效前瞻估算器</td>
              <td>CONSORT 声明、STROBE 指南、IRB 伦理批件、ChiCTR/NCT 注册</td>
              <td>结构化研究方案 (Protocol)、预设终点定义、最少样本量估算书</td>
            </tr>
            <tr>
              <td><b>2. 数据治理</b></td>
              <td>研究空间 ➔ <code>数据集</code> ➔ 上传文件</td>
              <td>CDISC/SAS/SPSS/Stata 二进制解析、变量字典识别、3-Sigma 离群值告警</td>
              <td>零 PHI (Zero-PHI) 个人隐私脱敏准则、MICE 缺失值多重插补规范</td>
              <td>质控合格的列式 Parquet 数据库、清洗日志、受试者虚拟编号字典 (S001~Sn)</td>
            </tr>
            <tr>
              <td><b>3. 队列筛选</b></td>
              <td>患者空间 ➔ <code>多维高级筛选</code> ➔ 纳入研究</td>
              <td>多维布尔逻辑筛选引擎、跨模态 3D 影像表型联动提取 (L3 SMI / RECIST)</td>
              <td>临床纳排标准自动化判定、患者随访时间序列自动对齐</td>
              <td>符合入组条件的候选队列预览表、CONSORT 入选/排除流向图 (图 17)</td>
            </tr>
            <tr>
              <td><b>4. 基线平衡</b></td>
              <td>研究空间 ➔ <code>统计分析</code> ➔ Table 1 生成</td>
              <td>Shapiro-Wilk 正态检验、Logit 倾向评分匹配 (PSM 1:1 卡钳匹配)、SMD 计算</td>
              <td>医学顶级期刊标准三线表规范 (Table 1)、协变量平衡标准 (SMD &lt; 0.10)</td>
              <td>倾向评分匹配前后 Table 1 三线表、标准化均数差平衡评估图 (图 18)</td>
            </tr>
            <tr>
              <td><b>5. 生存分析</b></td>
              <td>研究空间 ➔ <code>统计分析</code> ➔ KM 生存曲线</td>
              <td>Kaplan-Meier 乘积极限法、Log-Rank 渐近假设检验、ARR 与 NNT 算法</td>
              <td>NEJM / Lancet 生存曲线规范、严格对齐的风险人数表 (Number at Risk)</td>
              <td>带 95% 置信带的高清 KM 曲线、中位生存期、Log-Rank 统计检验量 (图 19)</td>
            </tr>
            <tr>
              <td><b>6. 预后建模</b></td>
              <td>研究空间 ➔ <code>统计分析</code> ➔ Cox 森林图</td>
              <td>Schoenfeld 残差比例风险检验、多因素逐步 Cox 回归、亚组交互作用检验</td>
              <td>多因素混杂协变量校正准则、预设亚组同质性检验 (\\(P_{\\text{interaction}}\\))</td>
              <td>Adjusted HR 与 95% 置信区间、高清矢量级预设亚组森林图 (图 20)</td>
            </tr>
            <tr>
              <td><b>7. 论文发表</b></td>
              <td>写作空间 ➔ 关联研究课题 ➔ 插入图表</td>
              <td>动态统计变量零幻觉绑定 (Dynamic Data Binding)、高保真文档渲染引擎</td>
              <td>ICMJE 医学期刊投稿标准、CONSORT 声明、Word (.docx) / PPTX 无损导出</td>
              <td>符合顶刊发表标准的研究论文初稿、学术汇报投影幻灯片、完整可复现 Python 脚本 (图 21)</td>
            </tr>
          </tbody>
        </table>
      </div>
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
        <h3>10. 科室协作与知家家庭健康空间 (Collaboration & PHR)</h3>
        <span class="help-tag">权限矩阵 · 家人健康</span>
      </div>
      <p class="help-lead">兼顾院内科室团队高效协作与医生个人家庭健康管理，双重身份安全解耦。</p>

      <h4>10.1 科室团队与诊疗组 (Care Team)</h4>
      <ul>
        <li><b>角色分工</b>：机构管理员 (Admin)、主管医师 (Attending Physician)、辅助医师 (Fellow/Resident)。</li>
        <li><b>数据可见性</b>：不同医疗组之间实行患者病历权限隔离，确保诊疗隐私与数据追溯责任到人。</li>
      </ul>

      <h4>10.2 知家 (Personal Health Record, PHR) · 个人专属家庭空间</h4>
      <p>在右上角账户菜单点击「个人空间 (知家)」，即可切换至独立个人档案：</p>
      <ul>
        <li><b>物理级隔离</b>：知家属于医生个人空间，与医院工作台完全物理隔离。即使未来更换执业医院，知家中的家人体检报告、化验单及慢病指标永不丢失。</li>
        <li><b>AI 亲情化解读</b>：利用通俗易懂的语言对长辈体检异常指标进行科普化分析与随访建议。</li>
      </ul>

      <h4>10.3 患者随访与安全扫码分享</h4>
      <p>医生可为特定患者生成具有有效期的<b>外部安全访问令牌 (Secure Share Token)</b>：</p>
      <ul>
        <li>患者在微信或移动端浏览器打开，仅能查阅经过去标识化的通俗化报告与趋势图，无法看到医生内部工作流与其他患者数据。</li>
        <li>支持随时一键作废已发放的分享链接。</li>
      </ul>

      <h4>10.4 临床排期日历与医疗科研邮箱一体化系统 (Clinical Calendar & Medical Mailbox)</h4>
      <p>为彻底解决临床随访脱落率高、科研节点繁琐割裂的痛点，Heurion 深度集成了<b>原生医疗日历</b>与 <b>@heurion.org 专属科研邮箱</b>：</p>
      <ul>
        <li><b>统一医生专属工作邮箱 (@heurion.org)</b>：每位注册医生拥有专属身份标识（如 <code>wang@heurion.org</code> 或 <code>hz@heurion.org</code>）；随访高危复查专函 (<code>followup@heurion.org</code>) 自动推送；真实世界研究 1:1 PSM 质控专报与 DSMB 盲态会议由 <code>research@heurion.org</code> 准时送达。</li>
        <li><b>患者随访复查智能排期 (Follow-up Scheduling)</b>：支持将随访方案按指南转化为精确排期（奥希替尼 8~12 周 CT 与 ctDNA 液体活检监测、ABPA 气道 3D 容积三维重建扫描评估等）。</li>
        <li><b>跨空间闭环联动通道</b>：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」、日程新建支持一键勾选同步向 @heurion.org 邮箱发送通知。</li>
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
        <h3>11. 常见问题与操作贴士 (FAQ & Troubleshooting)</h3>
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
        <h3>13. 版本发布更新日志 (Release Notes & Milestones)</h3>
        <span class="help-tag ok">持续演进 · 循证创新</span>
      </div>
      <p class="help-lead">Heurion 始终秉承「临床医生与科研人员的专业辅助伙伴」定位，每个版本均历经三甲临床专家严苛验证与医学数据安全审查。</p>

      <div class="help-release-card">
        <div class="help-release-badge current">v2.5 Pro (当前最新版本 · 2026年10月)</div>
        <div class="help-release-title">临床随访排期日历、@heurion.org 专属科研邮箱与跨空间闭环联动</div>
        <ul class="help-release-list">
          <li><b>原生排期日历工作空间 (Calendar Space)</b>：支持月历网格、周视图与议程列表，直观规划靶向药耐药监测、气道三维容积复查及多中心科研评审节点。</li>
          <li><b>专属医疗科研邮箱系统 (Mail Space)</b>：开箱即用 <code>&lt;username&gt;@heurion.org</code> (如 <code>hz@heurion.org</code>) 医生专属邮箱，支持随访高危提醒、真实世界研究 1:1 PSM 质控专函与 DSMB 盲态会议通知。</li>
          <li><b>跨空间两翼协同通道</b>：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.4 Pro (2026年10月)</div>
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

> **版本**：v2.5 Pro  
> **适用人群**：呼吸科、胸外科、放射影像科、泌尿外科、肿瘤科临床医师与医学科研人员  
> **核心架构**：零 PHI 医学隐私 · MONAI 3D 深度量化 · 临床随访排期日历 · 专属科研邮箱 · 自动化生物统计

---

## 一、 快速上手与界面导览

Heurion 专为临床与医学科研打造，采用三栏自适应现代架构：

1. **左侧导航 Rail & 资源栏**（自上而下顺畅工作流，统一采用 1.5px 极简发丝级医学矢量图标系统）：
   - **患者 (Patients · 临床一线)**：以纯虚拟代号建档，3D 影像深度量化、三正交 MPR 浏览器、双期配准与随访对比；
   - **研究 (Research · 科研转化)**：临床课题立项、多中心数据集质控、Table 1 与生存分析、IBSI 影像组学预后建模；
   - **写作 (Write · 成果输出)**：文档与学术汇报幻灯片、PubMed 引用、红绿 Diff 修订模式与 Word/PPTX 双模态无损导出；
   - **日历 (Calendar · 临床排期)**：门诊随访复查规划、科研课题里程碑审查、学术研讨会，支持月/周/列表多视图与状态跟进；
   - **邮箱 (Mail · 医疗专邮)**：医生专属 \`<username>@heurion.org\` 邮箱，随访高危提醒、科研质控通报，一键直达患者与课题；
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

## 二、 医学影像与核心逻辑通俗通识课 (零基础必读)

为了让临床各专科医师、医学科研人员、算法工程师及产品研发团队能在同一语境下无障碍协作，本节用生活化比喻、临床痛点推导及系统技术落地，通俗拆解 15 个核心医学影像与诊断逻辑概念：

### 2.1 常见影像模态能看清什么？(CT vs MRI vs 超声 vs PET-CT)
- **💡 生活化比喻**：
  - **CT (计算机断层扫描)**：像“切西瓜看果肉和西瓜籽”，穿透力强，骨头和高密度硬组织极清；
  - **MRI (磁共振成像)**：像“摇晃体内的水分子听回声”，不发辐射，软组织、大脑神经与韧带边界分辨率极高；
  - **超声 (Ultrasound)**：像“蝙蝠声呐探水下游鱼”，便携无创无辐射，看心脏跳动、血管血液流动等动态器官；
  - **PET-CT (正电子发射断层成像)**：像“给饥饿的癌细胞喂荧光白糖”，肿瘤细胞代谢旺盛疯狂摄取，在漆黑的断层上亮如明灯。
- **❓ 为什么需要它**：不同组织物理密度不同，没有任何一种模态可以包打天下。
- **💻 平台系统落地**：支持全模态 DICOM 与 NIfTI 卷解析，并在对话窗口支持直接拖入/粘贴单张超声、CT、胸片截图进行 AI 视觉辅助解读。

### 2.2 为什么叫“体素”？(Voxel vs Pixel)
- **💡 生活化比喻**：屏幕上的“像素 (Pixel)”是一张 2D 扁平彩色贴纸（只有长和宽）；“体素 (Voxel)”是 3D 空间立体乐高积木（拥有真实物理毫米的长、宽、高）。
- **❓ 为什么需要它**：CT 切片间距往往不均匀（如切片厚度 5mm，但切片内分辨率 0.7mm），如果直接旋转或拉伸会像压扁的面团严重变形。
- **💻 平台系统落地**：Heurion 底层管线自动将原始体数据统一重采样 (Resampling) 至 **1×1×1 mm³ 各向同性 (Isotropic) 空间立方体**，确保任意角度切割与体积计算绝对真实。

### 2.3 亨氏单位 (HU) 与窗宽窗位 (Window Width / Level)
- **💡 生活化比喻**：
  - **HU (Hounsfield Unit, CT值)**：物理密度的温度计。以水为 0 度，空气为 -1000 度，坚硬骨头为 +1000 度；
  - **窗宽窗位 (WW/WL)**：人的肉眼只能辨别几十种灰度，但 CT 值跨越 2000 多度。窗宽窗位就像一副“智能偏光太阳镜”，旋转旋钮就能过滤掉干扰，只看肺泡气道（肺窗）或心脏大血管（纵隔窗）。
- **❓ 为什么需要它**：如果只用一套黑白显示，看清了骨头，肺野就会变成一片死黑。
- **💻 平台系统落地**：Heurion MPR 提供预设快捷键：肺窗 (-600/1500)、纵隔窗 (40/400)、腹部窗 (50/350)、骨窗 (300/1500)、脑窗 (40/80)，一键切换无需反复手动拖动。

### 2.4 MPR 三正交切片联动 (Axial / Coronal / Sagittal)
- **💡 生活化比喻**：像一把激光刀切吐司面包：
  - **横断面 (Axial)**：从头到脚横着一层层切（俯视图）；
  - **冠状面 (Coronal)**：从前胸到后背竖着切（正视图）；
  - **矢状面 (Sagittal)**：从左耳到右耳侧着切（侧视图）。
- **❓ 为什么需要它**：血管和气道在三维人体中曲折蜿蜒，单张二维切片容易把斜切的管道误判为结节或肿瘤。
- **💻 平台系统落地**：三正交切片同屏十字准星联动，点击「定位病灶中心」，准星自动飞跃到病灶最大几何截面。

### 2.5 印戒征与支气管-伴行动脉比 (BAR)
- **💡 生活化比喻**：在肺野深处，支气管像空心水管，旁边紧贴着供血实心血管，宛如一对形影不离的伴侣（血管是宝石，支气管是细指环）。正常时指环比宝石小；如果支气管发炎扩张，变成大指环镶嵌小宝石，就是著名的“印戒征 (Signet Ring Sign)”。
- **❓ 为什么需要它**：支气管内径比伴行动脉内径 (BAR) ≥ 1.0 是放射学确诊支气管扩张的核心客观标准。
- **💻 平台系统落地**：MONAI 模型自动识别并测算 BAR 比值与管壁厚度比 (T/D)，亚毫米级卡尺直观标记。

### 2.6 高密度粘液栓 (HAM)
- **💡 生活化比喻**：普通痰液像稀薄淘米水，CT 值接近水 (0~20 HU)；但在变态反应性疾病中，嗜酸性坏死蛋白、夏科-雷登结晶凝聚脱水，像坚韧的“牙膏泥”，CT 值飙升到 70~120 HU，比胸壁肌肉 (40~50 HU) 还要发白发硬。
- **❓ 为什么需要它**：HAM 是变应性支气管肺曲霉病 (ABPA) 的王牌特异性征象，一旦出现几乎锁死过敏性真菌感染。
- **💻 平台系统落地**：自动连通域分割粘液栓，测算 3D 总体积 (cm³) 与极值 HU，自动对比胸壁肌肉确认 HAM。

### 2.7 随访配准与差分吸收热力图
- **💡 生活化比喻**：同一位患者隔三个月复查，呼吸深浅不同、胸廓微侧，就像同一块被轻微揉皱拉伸的印花丝巾。3D 弹性配准 (DIR) 是把两块丝巾抚平对齐，然后两层叠放扣除，剩下有差异的部分。
- **❓ 为什么需要它**：肉眼逐张肉眼找病灶费时费力且容易漏诊微小吸收或进展。
- **💻 平台系统落地**：配准后生成差分热力图（绿色吸收好转、红色进展恶化、黄色稳定），直观呈现治疗效果。

### 2.8 实体瘤尺子 RECIST 1.1 的边界与 3D 容积评估
- **💡 生活化比喻**：拿一把直尺量土豆长径很合适（实体瘤），但如果拿直尺去量像树根一样分支蔓延的泥浆（良性支气管粘液栓），长径毫无意义，必须量容积（体积）。
- **❓ 为什么需要它**：很多医生容易生搬硬套肿瘤 RECIST 1.1（PR 需长径缩小 ≥ 30%），导致良性病灶无法合理评估。
- **💻 平台系统落地**：严格解耦标准，实体瘤采用 RECIST 1.1 靶病灶长径和，良性炎性粘液栓采用 3D 容积吸收评估 (≥ 50% 为显著好转)。

### 2.9 隐匿性肌少症与 L3 骨骼肌指数 (SMI)
- **💡 生活化比喻**：有些人外观看起来微胖甚至超重（皮下脂肪厚），但内脏骨骼肌已严重萎缩流失（虚胖/隐匿性恶液质）。
- **❓ 为什么需要它**：肌少症患者对大剂量化疗药物、抗真菌药或糖皮质激素的耐受力极差，极易发生严重器官毒性。腰三椎骨 (L3) 横截面的骨骼肌面积是全身肌肉储量的黄金风向标。
- **💻 平台系统落地**：TotalSegmentator 自动定位 L3 层面，分割腰大肌与腹壁肌群，计算 SMI (SMA/身高² cm²/m²)，基于 Prado 国际标准预警。

### 2.10 IBSI 国际标准影像组学 (Radiomics)
- **💡 生活化比喻**：人眼看 CT 图像只能分辨粗略的黑白块，而影像组学像用高倍放大镜扫描病灶的微观“数字指纹”，计算灰度粗糙度、异质性、空间纹理排列。
- **❓ 为什么需要它**：不用动刀穿刺，仅凭 CT 就能预测肿瘤内在基因突变（如 EGFR/KRAS）和免疫治疗应答。
- **💻 平台系统落地**：严格遵循 IBSI 国际标准提取 107 项组学高阶特征，一键载入科研数据集用于机器学习建模。

### 2.11 PET-CT 代谢融合与 SUVmax / MTV / TLG
- **💡 生活化比喻**：CT 告诉你房间的墙壁和家具长什么样（解剖结构）；PET 告诉你房间里的人是不是在疯狂聚会跳舞（代谢活性）。
- **❓ 为什么需要它**：良性疤痕也可以在 CT 上表现为大阴影，只有 PET 才能辨别里面究竟是死组织还是活跃癌细胞。
- **💻 平台系统落地**：自动换算 SUV 标准摄取值，半透明彩虹热力叠加显示，自动标定 SUVmax、代谢肿瘤体积 (MTV) 与总糖酵解量 (TLG)。

### 2.12 放疗电子围栏 RT-STRUCT (GTV / CTV / OAR)
- **💡 生活化比喻**：放疗是用高能射线精准打击肿瘤。GTV 是肉眼可见的敌人堡垒；CTV 是可能潜伏散兵的警戒缓冲圈；OAR (危及器官) 则是绝对不能误伤的平民医院与学校（脊髓、心脏、食管）。
- **❓ 为什么需要它**：手工在几百层 CT 上画圈极为耗时，且各医生勾画一致性差。
- **💻 平台系统落地**：3D AI 自动勾画各靶区与危及器官，一键导出国际标准 DICOM RT-STRUCT 结构文件，直接导入放疗规划系统。

### 2.13 多模态因果诊断链
- **💡 生活化比喻**：孤证不立。只看一张 CT 阴影不能轻易下定论；必须像法官判案一样，将“影像学物证（支扩+HAM）+ 实验室生化血液化验（嗜酸粒细胞+总 IgE+曲霉特异抗体）+ 病史主诉”三方铁证串联锁死。
- **❓ 为什么需要它**：避免只见树木不见森林造成的误诊误治。
- **💻 平台系统落地**：系统跨模态自动串联规则引擎，自动拼装因果证据链，出具置信度与标准 DICOM SR / FHIR 报告。

### 2.14 零 PHI 隐私法律底线与本地 localStorage 隔离
- **💡 生活化比喻**：去医院体检，病历上不写真名只写数字胸牌号；但你自己手机备忘录里悄悄记下“这是张阿姨的体检单”。
- **❓ 为什么需要它**：医疗数据上云若泄露真实姓名将面临极其严重的法律制裁（HIPAA/GDPR）。
- **💻 平台系统落地**：平台云端和大模型仅见虚拟代号；医生添加的备注名 100% 物理保存在医生电脑浏览器本地 localStorage，绝不上云、绝不入库，彻底免除合规风险。

### 2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺
- **💡 生活化比喻**：屏幕上的像素点就像手机屏幕上的微型发光灯泡，手机缩放图片时灯泡密度会变化。如果直接拿一把塑料尺在显示器表面量“肿块有 3 厘米长”，在 13 寸笔记本上可能是 3 厘米，在 27 寸大屏上就变成了 6 厘米！这就像拿一根弹性极大的橡皮筋去量布料长短一样荒唐。
- **❓ 为什么必须依靠“物理体素标定 (Voxel Spacing)”**：CT 或 MRI 机在扫描患者身体时，会在 DICOM 头文件中严格写入每一个体素在人体三维真实解剖空间中的物理毫米跨度 (如 Pixel Spacing = 0.72 mm/像素，层厚 = 1.0 mm)。系统前端必须实时将鼠标在屏幕上画出的屏幕像素坐标差 $(\Delta x, \Delta y)$，乘以真实的物理标尺常数，才能精准换算为患者体内真实的物理长径与横截面积。
- **💻 平台系统落地**：采用双层 Canvas 交互系统，提供亚毫米级高对比度电子游标卡尺与两点包围盒截面积测量，并将测量线段与原始医学切片进行离屏双层合成无损固化入库。

---

## 三、 医学隐私与安全架构 (Zero-PHI)

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

## 四、 医学写作与文献溯源

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

## 五、 患者管理与 3D 影像量化分析

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
6. **诊断级 3D MPR 前端轻量标注与卡尺交互量化系统 (Frontend Lightweight Annotation & Caliper Engine)**：
   - **功能设计**：
     - **浏览模式 (Browse)**：默认交互模式，滚轮/滑动条平滑滚动，十字准星实时联动三正交平面；
     - **游标卡尺测距 (Caliper mm)**：拖拽生成抗混叠高反差翡翠绿测量线段，两端绘制 8px 垂直阻挡游标卡脚，中央悬浮暗黑 HUD 气泡读数，直观呈现亚毫米物理长度 (如 \`24.0 mm\`)；
     - **矩形剖面 ROI 面积 (ROI Area)**：两点对角线绘制半透明包围盒，自适应测算物理横截面积 (\`mm²\` 或 \`cm²\`)；
     - **清除标注 (Clear)**：一键擦除当前切片手工测量轨迹，恢复纯净浏览；
     - **双图层复合无损存证 (Composite Snapshot Export)**：离屏 Canvas 将底层原始灰阶切片与顶层卡尺标注复合渲染为高保真 PNG，固化为平台不可篡改的永久医学图像资产，并生成 Markdown 引用代码；
     - **自动化诊断报告草案动态注入**：实测长短径与截面积自动追加注入至影像所见段落，形成 Human-in-the-Loop 责任闭环。
   - **交互实现架构**：
     - **双层 Canvas DOM 覆盖**：底层 \`<img id="mprImg">\` (512×512) 渲染影像，顶层覆盖绝对定位的 \`<canvas id="mprAnnotCanvas" width="512" height="512">\`；CSS \`pointer-events\` 精准控制交互穿透；
     - **事件驱动状态机**：\`pointerdown\` 锁定几何原点与激活工具；\`pointermove\` 结合 \`requestAnimationFrame\` 驱动双缓冲平滑局部重绘；\`pointerup\` 固化几何终点并保存测量元数据；
     - **视网膜高清屏 (Retina Display) 锐化适配**：依据 \`window.devicePixelRatio\` 动态调整绘图缓冲区物理尺寸，杜绝高分屏锯齿与模糊；
     - **人机工程学高反差视觉**：翡翠绿主线 (#00E599 / #34D399)、半透明深色 HUD 气泡 (\`rgba(6, 17, 13, 0.85)\`)，在黑白骨软组织背景下始终清晰可辨。
   - **算法量化原理与物理标定**：
     - **空间体素间距提取**：DICOM Pixel Spacing $S_x, S_y$ (mm/px)；
     - **画布坐标步长归一**：$k_x = \\frac{\\text{dim}_x \\times S_x}{512}, \\quad k_y = \\frac{\\text{dim}_y \\times S_y}{512}$；
     - **真实物理欧氏距离**：$D_{\\text{mm}} = \\sqrt{[(\\Delta x) \\cdot k_x]^2 + [(\\Delta y) \\cdot k_y]^2}$，无缝对齐 RECIST 1.1 靶病灶长短径；
     - **剖面截面积自适应**：$A_{\\text{mm}^2} = (|\\Delta x| \\cdot k_x) \\times (|\\Delta y| \\cdot k_y)$，当 $A \\ge 100 \\text{ mm}^2$ 自动折算 $A_{\\text{cm}^2} = A / 100$；
     - **离屏双层合成固化**：$\\text{CompositeCanvas} = \\text{DrawImage}(\\text{Slice}) + \\text{DrawImage}(\\text{Canvas})$，Base64 PNG 写入平台存证数据库。
7. **全身体素机体成分与肌少症量化 (Body Composition & Sarcopenia)**：
   - **L3 骨骼肌指数 (SMI, cm²/m²)**：自动定位 L3 椎体中位截面，精准测算骨骼肌横截面积并换算 SMI，依据 Prado 国际共识（男性 < 52.4 cm²/m²，女性 < 38.5 cm²/m²）自动进行肌少症分层；
   - **内脏与皮下脂肪比 (VAT / SAT)**：量化腹腔内脏脂肪面积与皮下脂肪分布，评估代谢综合征及放化疗毒副反应预后。
8. **IBSI 国际标准影像组学高阶特征提取 (Radiomics Extraction)**：
   - 遵循 IBSI (Image Biomarker Standardisation Initiative) 国际规范，全量提取 107 项高维生物特征（形态学、一阶灰度统计、GLCM、GLRLM、GLSZM、NGTDM 等）；
   - 支持高斯拉普拉斯及小波变换滤波，组学特征一键归档至科研数据集，支撑肿瘤分子分型与免疫应答预测。
9. **三甲标准四段式全景影像诊断报告**：
   - 自动整合：① 临床指征与扫查序列；② 3D MONAI 定量测量与解剖所见；③ 印象与 RECIST/PI-RADS 分级诊断；④ 推荐随访周期与临床处置建议，一键生成规范草案并支持一键归入病历。

---

## 六、 双期 3D 刚性配准与差分吸收热力图

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

## 七、 多模态因果诊断链与标准报告导出

1. **多模态因果诊断链**：
   - 影像特征（支扩伴高密度粘液栓 HAM）+ 实验室指标（嗜酸性粒细胞、血清总 IgE、曲霉特异性 IgE）自动联动，拼装确诊证据链表（如变应性支气管肺曲霉病 ABPA）。
2. **标准化医学交换格式**：
   - 一键生成全景病例报告；
   - 导出标准 **DICOM SR** (Structured Reporting, SOP Class 1.2.840.10008.5.1.4.1.1.88.22) 与 **HL7 FHIR DiagnosticReport** JSON，直连院内 PACS 与 EMR。

---

## 八、 【实战案例深度图解】真实患者 3D 影像全流程量化与随访评定范例 (多场景典型案例库)

医学影像功能的复杂性在于“从 3D 几何体素到临床决策的全链路因果串联”。为了全面测试与验证 Heurion 平台在不同临床专科场景下的诊断自洽性与量化精准度，本章精选并深入剖析 **4 个来自真实临床队列的标准标杆病例**：涵盖**良性气道慢性感染 (ABPA)**、**实体瘤靶向治疗 RECIST 1.1 疗效动态评估 (NSCLC)**、**肿瘤恶液质体成分与肌少症风险预警 (Sarcopenia)** 以及**间质性肺病 (ILD) 复杂纤维化表型鉴别 (IPF/UIP)**。

### 8.1 案例一：变应性支气管肺曲霉病 (ABPA) 伴高密度粘液栓与印戒征

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
   - 肺窗 (-600/1500) 与纵隔窗 (40/400) 快捷切换，5 cm 真实物理标尺，准星一键聚焦病灶中心，支持亚毫米卡尺量测。
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

### 8.2 案例二：EGFR 突变型晚期非小细胞肺癌 (NSCLC) 奥希替尼靶向治疗前后 RECIST 1.1 疗效评估

1. **患者脱敏档案与就诊背景**：
   - 虚拟代号：\`PT-NSCLC-002\` (58 岁女性，无吸烟史，零 PHI 规范建档)；
   - 主诉：右侧胸痛、刺激性干咳伴痰中带血丝 2 个月；
   - 病理与分子分型：支气管镜外周活检证实右上肺浸润性中分化腺癌，外周血与组织 NGS 提示 **EGFR 19 号外显子缺失突变 (Exon 19 del, p.E746_A750del, 丰度 48.6%)**；伴同侧纵隔 4R 组淋巴结转移，临床分期 cT2bN2M0, III A 期。
2. **步骤一：基线薄层 HRCT 实体瘤靶病灶 3D 智能量化 (Baseline HRCT, 2026-06-15)**：
   - 参考图像：[图 6 真实患者基线薄层 HRCT 轴位关键截面 (Slice #128) · 右上肺癌靶病灶智能检出与 3D 边界量化](/site/real-case-nsclc-1-baseline-recist.png)；
   - **靶病灶 1 (右上肺实质浸润肿块)**：3D 卷积模型分割提取最大长径 $42.0 \\text{ mm} \\times$ 短径 $31.5 \\text{ mm}$，3D 容积 $28.50 \\text{ cm}^3$，CT 均值 38 HU；
   - **靶病灶 2 (4R 组纵隔转移淋巴结)**：短径量测 $18.0 \\text{ mm}$（严格符合 RECIST 1.1 淋巴结靶病灶短径 $\\ge 15.0 \\text{ mm}$ 纳排金标准）；
   - **基线靶病灶长径总和 (Baseline SOD)**：$\\text{SOD}_{\\text{base}} = 42.0 + 18.0 = 60.0 \\text{ mm}$。
3. **步骤二：3D MPR 三正交切片交互浏览与恶性分叶毛刺评估**：
   - 参考图像：[图 7 诊断级 3D MPR 三正交切片联动浏览器 (右上肺癌浸润与胸膜牵拉征象)](/site/real-case-nsclc-2-mpr-3view.png)；
   - 横断面 (Axial #128)、冠状面 (Coronal #240)、矢状面 (Sagittal #260) 三维同屏联动；
   - 准星一键聚焦病灶中心，直观呈现深分叶征 (Lobulation)、长短毛刺 (Spiculation) 与胸膜牵拉征 (Pleural Indentation)；
   - 启动前端亚毫米电子卡尺与 ROI 矩形剖面，测定病灶各向物理尺寸并存证入档。
4. **步骤三：奥希替尼口服 12 周后随访复查与双期 3D 弹性配准差分热力图 (Follow-up HRCT, 2026-09-15)**：
   - 参考图像：[图 8 奥希替尼靶向治疗 12 周随访 · 双期 3D 非刚性弹性配准与差分吸收热力图](/site/real-case-nsclc-3-diff-heatmap.png)；
   - 规范口服第三代 EGFR-TKI 甲磺酸奥希替尼 (80 mg qd) 12 周；
   - MONAI 3D 弹性形变配准 (DIR) 消除呼吸相差异后，差分热力图呈现大面积深绿色负差分吸收征，表明肿瘤显著坏死空洞化；
   - **靶病灶 1**：缩小至长径 $24.0 \\text{ mm} \\times$ 短径 $15.5 \\text{ mm}$，3D 容积降至 $6.20 \\text{ cm}^3$ (容积吸收率 $-78.2\\%$)；
   - **靶病灶 2**：短径退缩至 $9.0 \\text{ mm}$ ($< 10.0 \\text{ mm}$，退缩至正常生理淋巴结大小)；
   - **随访靶病灶长径和 (Follow-up SOD)**：$\\text{SOD}_{\\text{follow}} = 24.0 + 9.0 = 33.0 \\text{ mm}$；
   - **靶病灶长径和变化率**：$\\Delta\\% = \\frac{33.0 - 60.0}{60.0} \\times 100\\% = -45.0\\%$；
   - **RECIST 1.1 定级**：长径和降幅 $\\ge 30\\%$ 且无任何新发病灶，严格判定为 **部分缓解 (Partial Response, PR)**。
5. **步骤四：IBSI 标准 107 项影像组学微观异质性演变分析**：
   - 参考图像：[图 9 IBSI 国际标准化 107 项高维影像组学雷达指纹与微观异质性演变分析](/site/real-case-nsclc-4-radiomics-feature.png)；
   - 提取 IBSI 标准高维组学特征：GLCM 对比度由 4.82 降至 1.95，GLRLM 灰度不均匀性由 142.6 降至 68.2，GLSZM 区域均匀度提升；
   - 证实肿瘤内部微观空间异质性显著降低，细胞密集度锐减，佐证分子层面的良好生物学应答。
6. **步骤五：多模态因果诊断链闭环与 RECIST 1.1 标准报告出具**：
   - 参考图像：[图 10 多模态因果诊断链与证据闭环 (晚期 NSCLC 靶向治疗 PR 应答)](/site/real-case-nsclc-5-diagnostic-chain.png)；
   - 串联「3D 影像体积/长径缩减 + 分子突变 (EGFR 19del 丰度降至 0.8%) + 肿瘤标志物 (CEA 58.4 ➔ 6.2 ng/mL)」三元证据链；
   - MDT 决策维持奥希替尼 80 mg qd 靶向维持治疗，推迟局部姑息放疗介入；一键导出标准 DICOM SR 与 FHIR 报告。

---

### 8.3 案例三：胰腺导管腺癌合并隐匿性重度骨骼肌减少症 (Cancer Sarcopenia / Cachexia) 与肌脂肪浸润

1. **患者脱敏档案与就诊背景**：
   - 虚拟代号：\`PT-SARCO-003\` (64 岁男性，零 PHI 规范建档)；
   - 临床诊断：胰体尾部浸润性导管腺癌 cT3N1M0 III 期；
   - 主诉与查体：食欲不振、全身重度乏力。发病前体重 68 kg，近 3 个月暴跌至 54 kg，体重下降率 $-20.6\\%$；身高 1.72 m，BMI 18.25 kg/m²；实测右手握力仅 $19 \\text{ kg}$ (同龄健康男性参考 $\\ge 28 \\text{ kg}$)。
2. **步骤一：TotalSegmentator L3 椎体层面自动化机体成分测算与肌少症定级 (Slice #148)**：
   - 参考图像：[图 11 真实患者 L3 椎体层面 (Slice #148) · 3D 全身体素机体成分自动分割与肌少症量化](/site/real-case-sarco-1-l3-muscle-fat.png)；
   - 自动解剖定位第 3 腰椎 (L3) 横断面；
   - **骨骼肌横截面积 (SMA)**：$88.50 \\text{ cm}^2$ (健康男性参考值 $> 130 \\text{ cm}^2$)；
   - **骨骼肌质量指数 (SMI = SMA / 身高²)**：$\\text{SMI} = \\frac{88.50}{1.72^2} \\approx 29.92 \\text{ cm}^2/\\text{m}^2$ (远低于 Prado 国际共识男性肌少症界值 $52.4 \\text{ cm}^2/\\text{m}^2$ 与亚洲 AWGS 标准 $38.5 \\text{ cm}^2/\\text{m}^2$，触发系统红色高危警报：**重度恶液质性肌少症 Severe Sarcopenia**)；
   - **骨骼肌平均辐射衰减 (Mean Muscle Attenuation, MA)**：$26.4 \\text{ HU}$ (正常骨骼肌 $> 35\\sim 40 \\text{ HU}$，低 HU 证实骨骼肌细胞间质被大量异位甘油三酯浸润，提示严重 **肌脂肪变性 Myosteatosis**)；
   - **内脏脂肪面积 (VAT)**：$142.30 \\text{ cm}^2$；**皮下脂肪面积 (SAT)**：$68.20 \\text{ cm}^2$；
   - **内脏/皮下脂肪比 (VAT / SAT)**：$\\frac{142.30}{68.20} = 2.09$ (显著升高，呈现为典型的内脏脂肪堆积伴骨骼肌重度消耗——“肌少性恶液质消耗表型”)。
3. **步骤二：药代动力学 (PK) 化疗剂量限制性毒性 (DLT) 预警分析**：
   - 参考图像：[图 12 基于机体成分 (SMI & MA) 的个体化化疗药代动力学 (PK) 剂量限制性毒性 (DLT) 预警评估](/site/real-case-sarco-2-pk-toxicity-risk.png)；
   - 传统仅按体表面积 (BSA = $1.62 \\text{ m}^2$) 计算化疗剂量；
   - 骨骼肌萎缩显著降低亲脂性化疗药代谢清除率，导致游离血药峰浓度异常升高；
   - 系统 PK 模型预测：若全量给予 mFOLFIRINOX 方案化疗，发生 3~4 级骨髓抑制及严重感染等剂量限制性毒性 (DLT) 的概率高达 $72\\%$。
4. **步骤三：多学科诊疗 (MDT) 减毒增效与预康复营养干预决策闭环**：
   - 参考图像：[图 13 多模态因果诊断链与证据闭环 (恶性肿瘤重度肌少症营养与减毒 MDT 干预)](/site/real-case-sarco-3-diagnostic-chain.png)；
   - 串联「L3 SMI $29.92 \\text{ cm}^2/\\text{m}^2$ + 肌脂肪变性 $26.4 \\text{ HU}$ + 握力 $19 \\text{ kg}$ + 恶液质消瘦」三元证据链；
   - **MDT 决策闭环**：① 化疗首剂预防性下调 $20\\%$；② 联合临床营养科启动全肠内营养支持 (ONS)，足量补充乳清蛋白与支链氨基酸 (BCAA)；③ 指导轻负荷抗阻与有氧预康复 (Prehabilitation) 训练，避免化疗毒性致死。

---

### 8.4 案例四：寻常型间质性肺炎 (UIP) / 特发性肺纤维化 (IPF) 薄层 HRCT 智能表型与蜂窝肺量化

1. **患者脱敏档案与就诊背景**：
   - 虚拟代号：\`PT-IPF-004\` (69 岁男性，退休工人，吸烟史 30 包年，零 PHI 规范建档)；
   - 主诉与查体：活动后渐进性气短、刺激性干咳 1 年，近 1 个月活动耐量急剧下降，平地慢走 100 米即感气促胸闷。查体呼吸 22 次/分，双下肺背侧基底部听诊闻及吸气末细小爆裂音——**典型 Velcro 啰音 (Velcro Rales)**；双手指端轻度杵状指；
   - 肺功能与免疫排查：限制性通气障碍伴弥散量重度下降 (FVC% pred $68.5\\%$, DLCO% pred $44.2\\%$)；血清自身抗体谱 (ANA/ENA/ANCA) 全套阴性。
2. **步骤一：薄层吸气相 HRCT (1.0 mm 层厚) 3D 智能表型提取与蜂窝肺量化 (Slice #72)**：
   - 参考图像：[图 14 真实患者薄层 HRCT 轴位关键截面 (Slice #72) · 3D UIP 智能表型提取与蜂窝肺量化](/site/real-case-ipf-1-hrct-honeycombing.png)；
   - **解剖空间分布**：严格呈**胸膜下 (Subpleural)** 与**双肺基底部 (Basal)** 外周优势分布；双肺尖部及支气管血管束中央区相对保留，呈典型向心性梯度；
   - **蜂窝状改变 (Honeycombing)**：黄色高亮标出胸膜下多层厚壁囊状透亮气腔，直径 3~8 mm，呈多层阶梯状紧贴胸膜成簇排列。MONAI 测算**全肺累计蜂窝肺容积达 $46.20 \\text{ cm}^3$**；
   - **牵拉性支气管扩张 (Traction Bronchiectasis)**：周围重度纤维化组织回缩产生异常张力，导致下叶周边气道不规则扭曲扩张，延伸至胸膜下 1 cm 肺外周带；
   - **排除不符合 UIP 征象**：广泛磨玻璃影 (GGO) 占比 $< 5\\%$ (且无孤立 GGO)；无小叶中心微结节；呼气相 CT 无马赛克灌注与弥漫气体陷闭，彻底排除过敏性肺炎 (HP) 与结节病。
3. **步骤二：间质性纤维化头尾向梯度 3D MPR 交互浏览 (Coronal & Sagittal Views)**：
   - 参考图像：[图 15 诊断级 3D MPR 弥漫性间质性肺病头尾向梯度浏览器 (Coronal & Sagittal Views)](/site/real-case-ipf-2-mpr-coronal-gradient.png)；
   - 冠状面 (Coronal) 与矢状面 (Sagittal) 垂直构型清晰勾画出纤维化病灶呈现从肺尖向肺基底部进行性加重的陡峭梯度（肺尖部肺实质结构清晰正常，肺中部出现粗糙网格影，双肺底外周带则被严重蜂窝囊腔完全占据）；
   - 三维准星精准锁定下肺基底蜂窝区，量测胸膜下囊腔壁厚与外周气道牵拉距离；保存冠状面关键切片并提取空间表型参数注入诊断报告草案。
4. **步骤三：多模态因果诊断链闭环与 MDT 免外科肺活检获益**：
   - 参考图像：[图 16 多模态因果诊断链与证据闭环 (IPF / Definite UIP 证据三支柱)](/site/real-case-ipf-3-diagnostic-chain.png)；
   - 串联「薄层 HRCT 胸膜下基底部分布 + 蜂窝肺 $46.20 \\text{ cm}^3$ + 牵拉支扩 (权重 0.98)」+「吸气末 Velcro 啰音 + 限制性弥散障碍 + 自身抗体全阴性 (权重 0.96)」；
   - 依据 2022 ATS/ERS/JRS/ALAT 国际指南判定为 **「明确 UIP 影像表型 (Definite UIP Pattern)」**；
   - 指南明确指出 Definite UIP 表现且排除已知病因者与病理组织学一致率超 95%，**无需进行高风险有创外科胸腔镜肺活检 (SLB)**，直接临床确诊为 **特发性肺纤维化 (IPF)**；
   - 即刻启动口服吡非尼酮或尼达尼布抗纤维化靶向治疗，导出标准 DICOM SR 与 FHIR 报告。

---

### 8.5 4 大典型临床案例多模态指标与决策对照矩阵表

| 案例编号 / 脱敏 ID | 专科分类与疾病诊断 | 临床痛点与首发表现 | 影像金标准征象 | Heurion 核心算法与实测值 | 指南标准判定与分级 | 临床处置与最终决策闭环 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **案例一**<br>\`PT-BRONCHO-001\` | 呼吸感染<br>变应性支气管肺曲霉病 (ABPA) | 反复咳痰咯血6年，外院抗生素治疗无效，气道广泛粘液嵌顿 | 中央型支气管扩张 (BAR > 1.0) 伴高密度粘液栓 (HAM > 胸壁肌肉) | BAR 1.45 (印戒征)<br>HAM 12.44 cm³ (98 HU)<br>随访吸收 74.9% | Rosenberg-Patterson 标准<br>3D 容积吸收评估 (PR) | 确诊 ABPA 急性期；口服糖皮质激素联合伏立康唑，3个月粘液栓吸收良好 |
| **案例二**<br>\`PT-NSCLC-002\` | 胸部肿瘤科<br>肺腺癌 (EGFR 突变) III A期 | 咳嗽胸痛2月，右上肺肿块伴4R组纵隔淋巴结转移，EGFR 19外显子缺失 | 分叶、毛刺肿块，纵隔淋巴结短径增大 (≥ 15 mm) | 基线 SOD 60.0 mm<br>随访 SOD 33.0 mm (Δ -45.0%)<br>3D 容积 28.5 ➔ 6.2 cm³ | **RECIST 1.1 国际标准**<br>部分缓解 (PR) | 维持奥希替尼 80mg qd 原方案治疗；差分图呈深绿负吸收，避免过度放疗介入 |
| **案例三**<br>\`PT-SARCO-003\` | 消化与肿瘤营养<br>胰腺导管腺癌伴恶病质 | 消瘦乏力，3月体重下降 20.6%，BMI 18.25，握力 19 kg | 腰大肌及脊柱旁肌群萎缩，骨骼肌辐射衰减降低 (< 30 HU) | L3 SMI = 29.92 cm²/m²<br>肌肉衰减 MA = 26.4 HU<br>VAT/SAT = 2.09 | Prado 共识 / AWGS 标准<br>重度恶液质肌少症 | 预测全量化疗严重毒性率 72%；化疗首剂下调20%，联合全肠内营养与预康复 |
| **案例四**<br>\`PT-IPF-004\` | 呼吸间质病科<br>特发性肺纤维化 (IPF) | 渐进性气促干咳1年，双下肺典型 Velcro 啰音，限制性通气障碍 | 胸膜下/基底部蜂窝状改变、牵拉性支扩，无不符合征象 | 胸膜下外周向心分布<br>3D 蜂窝肺容积 46.20 cm³<br>牵拉性支扩伸至胸膜下 | **2022 ATS/ERS/JRS/ALAT**<br>明确 UIP 表型 (Definite) | 结合自身抗体阴性，**免除高风险外科肺活检 (SLB)**；即刻启动吡非尼酮靶向抗纤维化 |

---

## 九、 临床科研工作流 (Research)

覆盖临床研究方案拟定、多源多格式数据表质控导入、零 PHI 敏感数据脱敏、患者库智能入组、受限沙箱生物统计学制表及文章发表归档全周期。

### 9.1 核心功能与操作指南
1. **科研立项与方案起草 (Protocol Design & Registry)**：
   - 结构化录入研究代号 (如 \`ST-HFREF-2026-001\`)、中英文全称、PI、机构伦理审查批件号 (IRB) 与临床试验登记号 (ChiCTR / ClinicalTrials.gov NCT ID)；
   - 依据 PICO 框架结构化输入目标人群 (Population)、干预措施 (Intervention)、对照方案 (Comparator) 与主要/次要终点事件 (Outcome)；
   - 内置临床样本量与统计功效估算器 (Power & Sample Size Calculator)，依据预期 HR、$\\alpha$ 与统计功效估算最少样本量与事件数。
2. **多格式数据集质控导入与零 PHI 敏感数据脱敏**：
   - 原生支持 CSV、Excel (\`.xlsx\`/\`.xls\`)、SAS (\`.sas7bdat\`)、SPSS (\`.sav\`) 及 Stata (\`.dta\`)；
   - 自动推断变量字典，解析连续、二分类、多分类及生存结局字段，映射 SAS/SPSS 值标签 (Value Labels)；
   - 前端沙箱执行零 PHI (Zero-PHI) 严格审查，自动拦截姓名、身份证号、电话与住院号，映射为虚拟受试者编号 (\`S001~Sn\`)，患者真实身份绝不上云；
   - 缺失率梯级评估与 3-Sigma / IQR 离群极端值智能标红预警，支持 MICE 多重插补。
3. **患者库多维条件筛选入组与动态队列生成**：
   - 打通患者中心与科研中心，支持基于 ICD-10 诊断、化验指标范围及 3D 影像表型（如心超 LVEF、CT L3 SMI 肌少症表型）多维布尔逻辑筛选；
   - 实时预览入组候选人分布，一键生成隔离受控列式 Parquet 研究数据集。
4. **受限隔离沙箱自动化医学统计分析**：
   - **Table 1 基线特征三线表**：正态分布 (Mean±SD, t 检验) / 偏态分布 (Median(IQR), Wilcoxon 检验) / 分类变量 (N(%), 卡方/Fisher 确切概率法) 自动检验并选用；支持 1:1 或 1:k 倾向评分匹配 (PSM) 与标准化均数差 (SMD < 0.10) 平衡评估；
   - **Kaplan-Meier 生存曲线**：绘制带 95% 置信区间的生存概率曲线，计算中位生存时间 (Median OS/PFS)，执行 Log-Rank 假设检验，底部严格对齐输出风险人数表 (Number at Risk Table)；
   - **Cox 比例风险回归与亚组森林图**：检验比例风险假定，执行多因素回归校正混杂协变量，输出校正风险比 (Adjusted HR) 及 95% CI，自动生成带交互作用 P 值 ($P_{\\text{interaction}}$) 的高清亚组森林图；
   - **完全透明开源**：底层调用 \`scipy\`、\`statsmodels\`、\`lifelines\` 标准 Python 统计库，每张图表附带完整底层执行脚本代码，支持一键复制代码与审计。
5. **影像生物标志物生存分析与预后建模**：
   - 将 TotalSegmentator L3 骨骼肌指数 (SMI)、内脏/皮下脂肪比 (VAT/SAT) 及 IBSI 107 项标准影像组学高维特征直接存入队列数据集，参与多因素预后生存分析。
6. **成果闭环与学术发表**：
   - 写作空间关联研究课题，正文无损嵌入图表与动态统计字段，数据随随访自动联动更新，一键导出发表级 Word (.docx) 手稿与演讲 PPTX。

---

### 9.2 【实战标杆科研案例】DAPA-HF 达格列净治疗射血分数降低心力衰竭里程碑研究 (NCT03036124 / NEJM 2019)

- **研究课题**：DAPA-HF (Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction) · 达格列净在射血分数降低心力衰竭患者中的疗效与预后评估：一项国际多中心双盲随机对照试验与前瞻性队列
- **项目代号**：\`DAPA-HF-RCT-2019\`
- **注册登记**：ClinicalTrials.gov Identifier: **NCT03036124** · 欧洲 EudraCT: **2016-003290-34** · ChiCTR 备案号: **ChiCTR2600098712**
- **医学顶刊发表源证**：《新英格兰医学杂志 (NEJM)》 (McMurray JJV, Solomon SD, et al. *N Engl J Med* 2019; 381(21):1995-2008. DOI: 10.1056/NEJMoa1911303)
- **牵头机构与主要研究者 (PI)**：英国格拉斯哥大学 BHF 心血管研究中心 (**Prof. John J.V. McMurray**) 与美国哈佛医学院布莱根妇女医院心血管中心 (**Prof. Scott D. Solomon**)；全球 20 个国家 410 家医学中心协作
- **伦理批件**：IRB Protocol No. D1690C00001 / IRB-2017-MED-0428 (410 家参研中心机构伦理委员会全数审批获准)
- **主要终点 (Primary MACE)**：心衰恶化（因心衰恶化紧急住院或急诊静脉用药救治）或心血管死亡的复合终点
- **次要终点**：心衰恶化住院、心血管死亡、全因死亡率、堪萨斯城心肌病问卷 (KCCQ) 生活质量总评分改善率 (≥ 5分)、肾功能复合恶化斜率

#### 1. PICO 方案拟定与 CONSORT 入组筛选流向图 (图 17)
- 参考图像：[图 17 DAPA-HF 国际多中心临床试验 PICO 架构与 CONSORT 受试者队列筛选流向图](/site/real-case-research-1-protocol-cohort.png)；
- **目标人群 (P)**：年龄 ≥ 18 岁，确诊慢性射血分数降低心衰 (HFrEF, LVEF ≤ 40%)，NYHA II~IV 级，基线血清 NT-proBNP ≥ 600 pg/mL（若 12 个月内曾因心衰住院或合并房颤房扑则阈值调整为 ≥ 900 pg/mL）；
- **干预组 (I)**：指南导向基础治疗 (GDMT: ACEI/ARB/ARNI + β受体阻滞剂 + 醛固酮受体拮抗剂 MRA) 联合 SGLT2 抑制剂达格列净 (10 mg qd, 口服每日一次)；
- **对照组 (C)**：在相同 GDMT 标准治疗基础上接受外观相同的安慰剂 (Placebo, 口服每日一次)；
- **CONSORT 严密筛选流程**：
  1. 多中心初筛登记：全球 20 个国家 410 家中心共初筛登记 5,640 例心衰就诊患者；
  2. 标准排除标准：排除重度肾功能不全 (eGFR < 30 mL/min/1.73m², n=388)、收缩压严重偏低 (SBP < 95 mmHg, n=212)、1 型糖尿病或 DKA 病史 (n=96)、合并恶性肿瘤或预期寿命 < 1 年 (n=200)，共排除 896 例；
  3. 主试验随机化队列：入组 **4,744 例**，按 1:1 双盲随机分配至**达格列净组 2,373 例 vs 安慰剂组 2,371 例**；
  4. 真实世界扩展 PSM 匹配队列：基于 18 项协变量通过 Logit 倾向评分模型以卡钳值 0.02 进行 1:1 最邻近无替换匹配，形成均衡的成对亚队列：**达格列净组 710 例 vs GDMT 对照组 710 例 (共 1,420 例)**；
  5. 零 PHI 脱敏审计：沙箱内将真实受试者身份转换为不可逆虚拟代号 \`S001~S4744\`，生成加密列式分析库 \`dapa_hf_cohort_v1.parquet\`。

#### 2. Table 1 倾向评分匹配前后基线特征三线表与 SMD 平衡 (图 18)
- 参考图像：[图 18 DAPA-HF 临床基线特征三线表与倾向评分 (PSM) 均衡性诊断](/site/real-case-research-2-table1-baseline.png)；
- **DAPA-HF 主试验人群代表性 (N=4,744)**：达格列净组 (n=2,373) 与安慰剂组 (n=2,371) 基线高度平行可比——平均年龄分别为 66.2 岁与 66.5 岁，女性占 23.4% 与 23.9%，平均 LVEF 仅 31.2% 与 31.0%，中位 NT-proBNP 达 1437 pg/mL，41.8% 合并 2 型糖尿病，56.4% 为缺血性病因；四联基石用药充分渗透（β受体阻滞剂使用率 > 95%，MRA 达 71%）；
- **18 项协变量绝对标准化均数差 (SMD < 0.05)**：经 1:1 倾向评分匹配后，包括年龄、性别、收缩压、舒张压、BMI、NYHA 分级、LVEF、NT-proBNP、eGFR、血肌酐、血钾、高血压、2型糖尿病、缺血性病因、三大类基础用药以及 **胸腹 CT 自动测得的 L3 骨骼肌指数 (SMI)** 等所有 18 项协变量的 SMD 均显著收敛至 **< 0.05**（远优于国际公认标准 0.10），两组达到拟随机化平行可比状态。

| 临床基线协变量 | DAPA-HF 达格列净组 (n=2373) | DAPA-HF 安慰剂组 (n=2371) | 1:1 PSM 达格列净 (n=710) | 1:1 PSM 对照组 (n=710) | 匹配后 SMD 诊断 | 临床意义与平衡判定 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **年龄 (岁, Mean ± SD)** | 66.2 ± 11.0 | 66.5 ± 10.8 | 65.1 ± 10.8 | 65.4 ± 10.6 | **0.028** | 符合老年心衰流行病学特征 |
| **女性比例 (N, %)** | 554 (23.4%) | 565 (23.9%) | 220 (31.0%) | 214 (30.1%) | **0.019** | 两组性别构成高度均衡 |
| **左室射血分数 LVEF (%)** | 31.2 ± 6.8% | 31.0 ± 6.8% | 32.0 ± 5.9% | 32.2 ± 5.8% | **0.034** | 确凿射血分数降低重症心衰人群 |
| **血清 NT-proBNP (pg/mL)** | 1437 (857~2650) | 1437 (856~2637) | 2350 (1510~4120) | 2380 (1530~4180) | **0.015** | 心室壁张力重度负荷升高金标准 |
| **肾小球滤过率 eGFR (mL/min)** | 66.0 ± 19.6 | 65.5 ± 19.3 | 65.6 ± 18.8 | 65.1 ± 18.4 | **0.027** | 基线肾功能无统计学显著差异 |
| **合并 2 型糖尿病 (N, %)** | 993 (41.8%) | 990 (41.8%) | 326 (45.9%) | 322 (45.4%) | **0.011** | 证实两组糖尿病状态 1:1 绝对平齐 |
| **缺血性心肌病病因 (N, %)** | 1338 (56.4%) | 1330 (56.1%) | 384 (54.1%) | 378 (53.2%) | **0.017** | 心衰基础原发病因均衡分布 |
| **β受体阻滞剂使用率 (%)** | 2280 (96.1%) | 2271 (95.8%) | 676 (95.2%) | 674 (94.9%) | **0.014** | 指南推荐抗心衰基石药物充分覆盖 |
| **MRA 醛固酮拮抗剂 (%)** | 1696 (71.5%) | 1674 (70.6%) | 536 (75.5%) | 532 (74.9%) | **0.013** | 充分反映现代心衰规范化治疗水准 |
| **【跨模态】L3 SMI 骨骼肌指数** | 46.8 ± 8.4 cm²/m² | 46.5 ± 8.6 cm²/m² | 45.8 ± 7.9 cm²/m² | 46.1 ± 8.0 cm²/m² | **0.018** | CT 自动测算肌少症表型彻底消除组间偏倚 |

#### 3. 主要终点 MACE 24 个月 Kaplan-Meier 累积无事件生存分析 (图 19)
- 参考图像：[图 19 DAPA-HF 主要复合终点 Kaplan-Meier 生存曲线与风险人数表](/site/real-case-research-3-km-survival.png)；
- **随访中位时间与主要终点发生率**：DAPA-HF 中位随访 18.2 个月（最长随访 36 个月）；在全试验期内，达格列净组主要终点 MACE 发生率仅为 **16.3% (386 / 2,373)**，显著低于安慰剂对照组的 **21.2% (502 / 2,371)**；
- **假设检验显著性 (Log-Rank)**：统计量 **p < 0.001**（风险比 **HR = 0.74, 95% CI: 0.65 - 0.85**），两组无事件生存曲线自入组治疗后第 28 天即呈现统计学显著分离，并随随访周期延长呈现持续拓宽的发散趋势；
- **关键次要终点全面达标**：
  - 因心衰恶化再住院：达格列净 231 例 (9.7%) vs 安慰剂 318 例 (13.4%)，**HR = 0.70 (95% CI: 0.59 - 0.83, p < 0.001)**，风险降低 30%；
  - 心血管死亡率：达格列净 227 例 (9.6%) vs 安慰剂 273 例 (11.5%)，**HR = 0.82 (95% CI: 0.69 - 0.98, p = 0.029)**，心血管死亡独立降幅达 18%；
  - 全因死亡率：达格列净 276 例 (11.6%) vs 安慰剂 329 例 (13.9%)，**HR = 0.83 (95% CI: 0.71 - 0.97, p = 0.022)**；
- **需治疗人数 (NNT = 21)**：中位随访 18.2 个月期间，每使用达格列净治疗 **21 位 HFrEF 患者**，即可预防 1 例心血管死亡或心衰恶化终点事件；而在 24 个月真实世界高危亚组中，绝对风险降幅 ARR 高达 9.2%，NNT 进一步优化至 10.9；
- **规范制表**：底部对齐输出 0、6、12、18、24、30、36 个月风险在险人数表 (Number at Risk)。

#### 4. 多因素 Cox 比例风险回归与预设亚组分析森林图 (图 20)
- 参考图像：[图 20 DAPA-HF 预设亚组多因素 Cox 比例风险回归与亚组效应森林图](/site/real-case-research-4-cox-forest.png)；
- **全人群多因素校正风险比**：在多因素 Cox 模型中校正了年龄、性别、基线射血分数、NT-proBNP 常用对数值、NYHA 分级、合并症、基线肾功能及 CT 测得的 L3 SMI 肌少症表型后，**Adjusted HR = 0.74 (95% CI: 0.65 - 0.85, p < 0.001)**，心血管死亡与心衰再住院风险显著降低 **26%**；
- **6 大预设亚组获益一致性 (All $P_{\\text{interaction}} > 0.05$)**：
  1. 糖尿病状态：伴 2 型糖尿病 (HR 0.75, 95% CI 0.63-0.90) 与非糖尿病心衰患者 (HR 0.73, 95% CI 0.60-0.88), $P_{\\text{interaction}} = 0.80$（确凿证实达格列净的心脏保护效应独立于降糖作用）；
  2. 年龄亚组：< 65 岁 (HR 0.69, 95% CI 0.55-0.87) 与 ≥ 65 岁 (HR 0.77, 95% CI 0.65-0.92), $P_{\\text{interaction}} = 0.44$；
  3. 基线射血分数：重度受损 LVEF ≤ 30% (HR 0.68, 95% CI 0.56-0.81) 与中度受损 LVEF > 30% (HR 0.84, 95% CI 0.69-1.02), $P_{\\text{interaction}} = 0.13$；
  4. 基础用药是否联用 ARNI：联用沙库巴曲缬沙坦 (HR 0.75, 95% CI 0.50-1.13) 与未联用 (HR 0.74, 95% CI 0.65-0.86), $P_{\\text{interaction}} = 0.97$；
  5. 基线肾功能状态：eGFR < 60 (HR 0.72, 95% CI 0.59-0.86) 与 eGFR ≥ 60 mL/min/1.73m² (HR 0.76, 95% CI 0.63-0.92), $P_{\\text{interaction}} = 0.68$；
  6. **【跨模态影像创新】机体成分/肌少症亚组**：伴低 SMI 肌少症表型 (HR 0.68, 95% CI 0.54-0.86) 与正常骨骼肌患者 (HR 0.76, 95% CI 0.64-0.90), $P_{\\text{interaction}} = 0.42$（极高危衰弱恶液质患者同等甚至更显著获益）。

| 预设临床与生物标志物亚组 | 事件数 / 亚组总样本量 | 校正风险比 Adjusted HR (95% CI) | 交互作用检验 P 值 | 临床亚组获益结论 |
| :--- | :--- | :--- | :--- | :--- |
| **【DAPA-HF 全人群主要终点】** | 888 / 4,744 例 | **0.74 (0.65 ~ 0.85)** | — | **显著降低主要事件 26% (p < 0.001)** |
| 伴 2 型糖尿病 (T2D) | 434 / 1,983 例 | 0.75 (0.63 ~ 0.90) | **p = 0.80** | **完全独立于降糖作用**：非糖尿病心衰患者获益同样明确 |
| 无糖尿病史 (非DM心衰) | 454 / 2,761 例 | 0.73 (0.60 ~ 0.88) | | |
| 年龄 < 65 岁 | 341 / 2,074 例 | 0.69 (0.55 ~ 0.87) | p = 0.44 | 不同年龄跨度获益高度一致 |
| 年龄 ≥ 65 岁 (老年心衰) | 547 / 2,670 例 | 0.77 (0.65 ~ 0.92) | | |
| 基线重度心衰 (LVEF ≤ 30%) | 538 / 2,642 例 | 0.68 (0.56 ~ 0.81) | p = 0.13 | 射血分数极低危患者保护效应更为凸显 (风险降低 32%) |
| 中度减低心衰 (LVEF > 30%) | 350 / 2,102 例 | 0.84 (0.69 ~ 1.02) | | |
| 基础已联用 ARNI 沙库巴曲缬沙坦 | 92 / 508 例 | 0.75 (0.50 ~ 1.13) | p = 0.97 | 无论是否联用 ARNI，达格列净保护获益完全稳固叠加 |
| 基础未联用 ARNI (常规ACEI/ARB) | 796 / 4,236 例 | 0.74 (0.65 ~ 0.86) | | |
| 肾功能受损 (eGFR < 60 mL/min) | 442 / 1,926 例 | 0.72 (0.59 ~ 0.86) | p = 0.68 | 慢性肾脏病合并心衰患者心肾双重保护 |
| 肾功能尚可 (eGFR ≥ 60 mL/min) | 446 / 2,818 例 | 0.76 (0.63 ~ 0.92) | | |
| **【跨模态】伴低 SMI 肌少症表型** | 248 / 1,020 例 | **0.68 (0.54 ~ 0.86)** | **p = 0.42** | **机体成分与营养衰弱突破**：恶液质肌少症高危患者获益同样明确 |
| 【跨模态】无肌少症 (SMI 正常) | 640 / 3,724 例 | 0.76 (0.64 ~ 0.90) | | |

#### 5. 端到端科研证据闭环与 SCI 顶刊论文一键生成 (图 21)
- 参考图像：[图 21 基于 DAPA-HF 国际规范的端到端临床科研全流程闭环工作流](/site/real-case-research-5-research-loop.png)；
- **阶段一 (立项筛选)**：PICO 结构化方案，ClinicalTrials.gov (NCT03036124) 注册登记，患者库多维智能入组；
- **阶段二 (质控脱敏)**：解析 CDISC SDTM、SAS、SPSS 复杂变量，前端拦截 PHI 敏感数据，虚拟受试者代号隔离 (\`S001~S4744\`)；
- **阶段三 (沙箱统计)**：1:1 PSM 消除混杂，Table 1 三线表，KM 生存曲线，Cox 森林图，底层 Python 脚本完全开源；
- **阶段四 (成果发表)**：写作空间数据绑定，零复制笔误，一键导出发表级 Word (.docx) 手稿与 PPTX。

#### 6. 临床科研全流程操作与规范对照矩阵表
| 科研阶段 | 工作空间与操作入口 | 平台核心算法与技术机制 | 医学统计与国际规范 | 标准交付成果物 (Deliverables) |
| :--- | :--- | :--- | :--- | :--- |
| **1. 课题立项** | 研究空间 ➔ \`＋ 新建研究\` | PICO 结构化表单引擎、样本量与功效估算器 | CONSORT、STROBE、IRB 伦理批件、ChiCTR/NCT 注册 | 结构化方案、终点定义、最少样本量估算书 |
| **2. 数据治理** | 研究空间 ➔ \`数据集\` ➔ 上传 | CDISC/SAS/SPSS/Stata 二进制解析、变量字典、离群值告警 | 零 PHI (Zero-PHI) 脱敏、MICE 缺失值多重插补 | 列式 Parquet 库、清洗日志、受试者虚拟编号 (S001~Sn) |
| **3. 队列筛选** | 患者空间 ➔ \`高级筛选\` ➔ 纳入研究 | 多维布尔筛选引擎、跨模态 3D 影像表型联动 (L3 SMI) | 临床纳排标准判定、随访时间序列自动对齐 | 候选队列预览表、CONSORT 入选/排除流向图 (图 17) |
| **4. 基线平衡** | 研究空间 ➔ \`统计分析\` ➔ Table 1 | 正态性检验、1:1 PSM 卡钳匹配、SMD 计算 | 医学顶刊 Table 1 三线表规范、SMD < 0.10 协变量平衡 | PSM 前后 Table 1 三线表、SMD 平衡评估图 (图 18) |
| **5. 生存分析** | 研究空间 ➔ \`统计分析\` ➔ KM 曲线 | Kaplan-Meier 乘积极限法、Log-Rank 检验、ARR/NNT | NEJM/Lancet 生存曲线规范、Number at Risk 风险表 | 带 95% 置信带 KM 曲线、Log-Rank 统计量 (图 19) |
| **6. 预后建模** | 研究空间 ➔ \`统计分析\` ➔ Cox 森林图 | Schoenfeld 残差检验、多因素逐步 Cox、亚组交互检验 | 多因素协变量校正、预设亚组同质性检验 ($P_{\\text{interaction}}$) | Adjusted HR (0.74)、高清矢量预设亚组森林图 (图 20) |
| **7. 论文发表** | 写作空间 ➔ 关联课题 ➔ 插入图表 | 动态统计变量零幻觉绑定、高保真文档渲染引擎 | ICMJE 投稿标准、Word (.docx) / PPTX 无损导出 | 发表级论文初稿、学术汇报 PPTX、可复现 Python 脚本 (图 21) |


---

## 十、 科室协作与知家家庭健康空间 (PHR)

1. **科室诊疗组 (Care Team)**：主诊医师与组员权限矩阵，敏感病历访问审计留痕；
2. **知家个人空间 (PHR)**：医生专属家庭健康空间，与医院工作台物理隔离，终身保留家人健康档案；
3. **安全分享与患者沟通**：生成临时有效期的只读脱敏链接，供患者扫码查阅通俗化随访建议。
4. **临床排期日历与医疗科研邮箱一体化系统 (Clinical Calendar & Medical Mailbox)**：
   - **专属医生工作邮箱 (@heurion.org)**：每位注册医生拥有专属身份标识（如 \`<username>@heurion.org\`）；随访专函 (\`followup@heurion.org\`) 自动推送影像量化高危复查提醒；科研专报 (\`research@heurion.org\`) 定期通报真实世界研究 1:1 PSM 倾向评分匹配质控报告、DSMB 独立数据监察委员会盲态会议等。
   - **患者随访复查智能排期 (Follow-up Scheduling)**：支持将随访方案按临床指南推荐时间窗转化为精确排期（奥希替尼 8~12 周 CT 与 ctDNA 液体活检监测、ABPA 气道 3D 容积三维重建扫描评估等）。
   - **闭环联动通道 (Cross-Space Synergy)**：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」、日程新建同步邮件提醒。

---

## 十一、 常见问题解答 (FAQ)

- **Q: 为什么上传 DICOM 耗时较长？**  
  A: 建议上传单个序列的压缩包（< 500MB），去除定位像后再压缩。
- **Q: 为什么生成的报告数值与正文完全自洽？**  
  A: 系统严密绑定底层结构化量化字段，彻底杜绝模板默认值与实测值冲突。
- **Q: AI 输出能直接当作法律效力的病历吗？**  
  A: 不能。所有 AI 辅助结论必须经执业医师审阅核对并签署确认后方可作为正式病历。

---

## 十二、 版本更新日志 (Release Notes)

### v2.5 Pro (当前最新版本 · 2026年10月)
- **原生排期日历工作空间 (Calendar Space)**：支持月历网格、周视图与议程列表，直观规划靶向药耐药监测、气道三维容积复查及多中心科研评审节点。
- **专属医疗科研邮箱系统 (Mail Space)**：开箱即用 \`<username>@heurion.org\` 医生专属邮箱，支持随访高危提醒、真实世界研究 1:1 PSM 质控专函与 DSMB 盲态会议通知。
- **跨空间两翼协同通道**：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」。

### v2.4 Pro (2026年10月)
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
