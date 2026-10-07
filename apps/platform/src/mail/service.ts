import type { Store, MailMessageRow } from '../store/db.ts'
import { randomUUID } from 'node:crypto'

export interface SendMailInput {
  userId: string
  tenantId?: string | null
  sender?: string
  senderName?: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'notification' | 'general'
  patientId?: string | null
  patientCode?: string | null
  studyId?: string | null
  studyTitle?: string | null
  calendarEventId?: string | null
}

export class MailService {
  constructor(private readonly store: Store) {}

  /** 用户的工作邮箱地址 (默认使用 heurion.com 域名) */
  userEmail(username: string): string {
    const cleanUser = username.toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'doctor'
    return `dr.${cleanUser}@heurion.com`
  }

  /** 获取邮件列表（若首次访问则自动载入临床与科研示范邮件） */
  list(userId: string, username: string, category?: string): MailMessageRow[] {
    this.ensureSeed(userId, username)
    return this.store.listMailMessages(userId, category)
  }

  /** 获取单封邮件 */
  get(userId: string, id: string): MailMessageRow | undefined {
    return this.store.getMailMessage(userId, id)
  }

  /** 发送新邮件 */
  send(input: SendMailInput): MailMessageRow {
    const sender = input.sender || 'Heurion 临床工作站 <notify@heurion.com>'
    const senderName = input.senderName || 'Heurion 协作网络'
    return this.store.createMailMessage({
      user_id: input.userId,
      tenant_id: input.tenantId ?? null,
      sender,
      sender_name: senderName,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      category: input.category,
      patient_id: input.patientId ?? null,
      patient_code: input.patientCode ?? null,
      study_id: input.studyId ?? null,
      study_title: input.studyTitle ?? null,
      read: 0,
      starred: 0,
      calendar_event_id: input.calendarEventId ?? null,
    })
  }

  /** 标为已读/未读 */
  markRead(userId: string, id: string, read = true): void {
    this.store.markMailRead(userId, id, read)
  }

  /** 全部标为已读 */
  markAllRead(userId: string): void {
    this.store.markAllMailsRead(userId)
  }

  /** 删除邮件 */
  delete(userId: string, id: string): void {
    this.store.deleteMailMessage(userId, id)
  }

  /** 首次访问用户种子数据初始化：涵盖随访计划与科研项目进度两大核心类别 */
  private ensureSeed(userId: string, username: string): void {
    const existing = this.store.listMailMessages(userId)
    if (existing.length > 0) return

    const myEmail = this.userEmail(username)
    const now = new Date()
    const isoHoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString()

    const seedMails: Array<Omit<MailMessageRow, 'id'>> = [
      {
        user_id: userId,
        tenant_id: null,
        sender: 'followup@heurion.com',
        sender_name: 'Heurion 智能随访中心',
        recipient: myEmail,
        subject: '【随访计划】PT-BRONCHO-001 气道高密度粘液栓 (HAM) 与支气管扩张 3 个月影像复查与肺功能随访',
        category: 'followup',
        patient_id: 'PT-BRONCHO-001',
        patient_code: 'PT-BRONCHO-001',
        study_id: null,
        study_title: null,
        read: 0,
        starred: 1,
        calendar_event_id: null,
        created_at: isoHoursAgo(2),
        body: `### 患者复查随访通知 · PT-BRONCHO-001 (变应性支气管肺曲霉病 ABPA)

尊敬的主诊医师：

根据您为患者 **PT-BRONCHO-001** 制定的诊疗随访路径，患者已规律口服糖皮质激素（泼尼松 30mg qd）联合伏立康唑（200mg bid）治疗满 **12 周**。系统智能随访调度引擎已自动为您生成近期的随访复查计划：

- **患者代号**：\`PT-BRONCHO-001\` (52岁女性，零 PHI 规范建档)
- **基线量化基准**：
  - 支气管伴行动脉比 **BAR = 1.45** (双肺多发印戒征)
  - 高密度粘液栓容积 **HAM = 12.44 cm³ (98 HU)**
  - 血清总 IgE 1,840 IU/mL，曲霉特异性 IgE 24.6 kUA/L
- **本轮随访复查目标 (Follow-up Targets)**：
  1. **全胸部薄层吸气相 HRCT (1.0 mm)**：运行 \`airway_mucus_segmenter\` 自动对比高密度粘液栓 3D 容积吸收率及气道树再通程度；
  2. **肺功能测定 (PFT)**：评估 FEV1、FVC 及小气道阻塞通气功能改善率；
  3. **实验室生化及免疫**：血常规嗜酸性粒细胞绝对计数 (EOS)、血清总 IgE、肝功能监测（伏立康唑肝代谢监测）。
- **建议预约时间**：**2026年10月12日 (周一) 上午 09:30 - 10:30**
- **检查地点**：门诊综合二区呼吸专科诊室 / 影像中心 CT 3 号机房

您可直接在下方点击**「添加到日历」**以锁定门诊日程，或点击**「查看患者档案」**查阅基线 3D 影像切片与化验趋势。`,
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'research.dapa-hf@heurion.com',
        sender_name: 'DAPA-HF 国际多中心课题组',
        recipient: myEmail,
        subject: '【科研进度周报】DAPA-HF 里程碑前瞻性队列研究 · 第 3 阶段入组达标与倾向评分匹配 (PSM) 质控完成',
        category: 'research',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        read: 0,
        starred: 1,
        calendar_event_id: null,
        created_at: isoHoursAgo(5),
        body: `### 国际多中心临床科研项目进度简报 (Study Progress Report)

**课题编号**：ClinicalTrials.gov Identifier: **NCT03036124** · EudraCT: **2016-003290-34**  
**课题名称**：DAPA-HF 达格列净在射血分数降低心衰患者中的疗效与预后评估前瞻性队列  
**牵头研究者**：Prof. John J.V. McMurray & Prof. Scott D. Solomon (全球 20 国 410 家参研中心)

尊敬的参研学者与课题组成员：

平台沙箱生物统计引擎已自动完成全中心数据治理与第 3 阶段入组质控，核心进度汇报如下：

1. **队列样本入组进度 (Accrual & Screening)**：
   - 国际多中心初筛累计 **5,640 例**，严格执行排除标准后合格入组 **4,744 例**；
   - 真实世界 18 项协变量 1:1 倾向评分匹配 (PSM) 成功收敛：**达格列净组 710 例 vs GDMT 对照组 710 例 (共 1,420 例)**。
2. **基线协变量平衡性诊断 (SMD Balance)**：
   - 年龄、LVEF、NT-proBNP、eGFR 及 **CT 测得的 L3 SMI 骨骼肌指数**等全部 18 项协变量的绝对标准化均数差 **SMD 均已收敛至 < 0.05**，完全达到拟随机化平行平衡。
3. **关键下步日程安排 (Upcoming Milestones)**：
   - **课题组统计评审会**：**2026年10月15日 (周四) 14:00 - 16:00**（审议 Table 1 三线表与 Kaplan-Meier 累积无事件生存分析初稿）；
   - **论文稿件撰写与图表联动**：在写作工作区绑定 \`{{research.table1}}\` 与 \`{{research.km_curve}}\`，准备投稿手稿排版。

请查收随附附件，并点击下方**「同步到日历」**记录下周四统计评审会日程。`,
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'oncology.followup@heurion.com',
        sender_name: '胸部肿瘤随访监护组',
        recipient: myEmail,
        subject: '【随访提醒】PT-NSCLC-002 奥希替尼靶向治疗第 8 周 RECIST 1.1 疗效评估与耐药监测',
        category: 'followup',
        patient_id: 'PT-NSCLC-002',
        patient_code: 'PT-NSCLC-002',
        study_id: null,
        study_title: null,
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(24),
        body: `### 肺癌靶向治疗周期性随访 · PT-NSCLC-002

- **患者信息**：58岁女性，右上肺腺癌伴纵隔淋巴结转移 (cT3N2M0, IIIA 期)，携带高丰度 EGFR Exon 19 del (42.6%)；
- **当前治疗**：甲磺酸奥希替尼片 80mg 口服 qd，当前完成第 8 周；
- **随访重点**：
  1. 胸部增强 CT 随访并启动 **RECIST 1.1 自动比对引擎**，计算靶病灶长径和 (SOD) 变化率；
  2. 外周血 ctDNA 游离肿瘤 DNA 液体活检（重点监测 C797S / MET 扩增等继发耐药突变）；
  3. 间质性肺炎 (ILD) 罕见毒副反应筛查。
- **推荐门诊随访时间**：**2026年10月13日 (周二) 下午 14:00 - 15:00**。`,
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'irb.research@heurion.com',
        sender_name: '临床医学伦理与科研办公室',
        recipient: myEmail,
        subject: '【科研日程】国际多中心临床试验 DSMB 独立数据监查委员会中期审查会日程',
        category: 'research',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(36),
        body: `### 独立数据监查委员会 (DSMB) 中期审查会议通知

各参研中心主要研究者 (PI) 及统计师：

经伦理委员会审批准许（批件号：IRB-2017-MED-0428），DAPA-HF 试验 DSMB 委员会定于近期召开中期安全性与统计终点闭门审查研讨会：

- **会议日期**：**2026年10月16日 (周五) 19:00 - 21:00**
- **参会形式**：国际多中心加密远程视频研讨
- **审议事项**：
  - 核心复合终点 Primary MACE（心血管死亡或心衰恶化再住院）盲态事件裁定进度；
  - 预设亚组（伴 2 型糖尿病 vs 非糖尿病患者）心肾终点保护效应的同质性检验 ($P_{\\text{interaction}} = 0.80$)；
  - 临床严重不良事件 (SAE) 独立监查审查。`,
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'nutrition.prehab@heurion.com',
        sender_name: '临床营养与药学监护组',
        recipient: myEmail,
        subject: '【营养随访】PT-SARCO-003 恶液质重度肌少症全肠内营养支持 (ONS) 与首剂化疗耐受随访',
        category: 'followup',
        patient_id: 'PT-SARCO-003',
        patient_code: 'PT-SARCO-003',
        study_id: null,
        study_title: null,
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(48),
        body: `### 恶性肿瘤重度肌少症多学科随访 · PT-SARCO-003

- **患者信息**：64岁男性，胰腺癌局部进展期，L3 骨骼肌质量指数 **SMI = 29.92 cm²/m²**，肌肉辐射衰减 **MA = 26.4 HU**，实测握力 19 kg；
- **干预措施**：化疗首剂下调 20%，联合高蛋白全肠内营养支持 (ONS) 8 周；
- **随访目标**：评估化疗耐受性，复查右上肢握力、白蛋白、前白蛋白，测定是否发生 3~4 级血液学毒副反应；
- **建议门诊时间**：**2026年10月14日 (周三) 上午 10:00 - 11:00**。`,
      },
    ]

    for (const item of seedMails) {
      this.store.createMailMessage(item)
    }
  }
}
