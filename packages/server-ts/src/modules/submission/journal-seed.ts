/**
 * #849/D1 — JournalRepository seed 快照:~200 本核心医学刊(全科室)+ 中文核心刊目录(Tier J4 目录版)。
 *
 * 数据诚实性(D2):
 * - IF/JCR 为年度快照(SEED_META.impactFactorAsOf),来源标 'jcr_snapshot',人工维护
 * - 中科院分区为年度快照(SEED_META.casZoneAsOf),来源标 'cas_snapshot'
 * - 接受率/一审周期为人工维护估计值(SEED_META.estimateAsOf),source 标 'curated_estimate'
 * - APC 为 DOAJ 快照(source 'doaj_snapshot'),#852 动态层可覆盖为实时 DOAJ 值
 * 原 journals.ts 的 18 本肿瘤刊已零丢失迁移(keywords/description/IF/接受率/审稿周/分区原样保留)。
 */

export const SEED_META = {
  impactFactorAsOf: '2025-06',
  casZoneAsOf: '2025-12',
  estimateAsOf: '2025-06',
  apcAsOf: '2025-06',
} as const

export interface SeedEntry {
  id: string
  name: string
  issn?: string
  publisher?: string
  zh?: string
  /** 学科标签(受控词表) */
  scope: string[]
  /** 匹配关键词(存量 18 本原样保留) */
  keywords?: string[]
  /** IF(JCR 年度快照) */
  if?: number
  /** 中科院分区(年度快照) */
  cas?: string
  /** 接受率 %(估计值) */
  acc?: number
  /** 一审中位周期(周,估计值) */
  wk?: number
  /** APC(USD,DOAJ 快照) */
  apc?: number
  /** 全 OA 刊 */
  oa?: boolean
  /** 历史接收研究类型分布 */
  types?: string[]
  desc?: string
  guideUrl?: string
}

const CLIN = ['rct', 'cohort', 'review', 'meta']
const CLIN_RW = ['cohort', 'real_world', 'review']
const RW_CASE = ['cohort', 'real_world', 'case_report']

export const JOURNAL_SEED: SeedEntry[] = [
  /* ── 肿瘤(原 18 本零丢失迁移 + 扩容)────────────────────────── */
  { id: 'lancet-oncol', name: 'Lancet Oncology', issn: '1470-2045', publisher: 'Elsevier', scope: ['oncology'], keywords: ['lung', 'cancer', 'oncology', 'trial', 'immunotherapy'], if: 51.1, cas: '1区', acc: 8, wk: 6, types: CLIN, desc: '顶级肿瘤学期刊，适合重大临床突破', guideUrl: 'https://authorguides.thelancet.com/' },
  { id: 'jco', name: 'Journal of Clinical Oncology', issn: '0732-183X', publisher: 'Wolters Kluwer', scope: ['oncology'], keywords: ['cancer', 'clinical', 'trial', 'chemotherapy', 'survival'], if: 45.3, cas: '1区', acc: 12, wk: 8, types: CLIN, desc: '临床肿瘤学旗舰刊' },
  { id: 'jama-oncol', name: 'JAMA Oncology', issn: '2374-8038', publisher: 'American Medical Association', scope: ['oncology'], keywords: ['cancer', 'clinical', 'oncology', 'trial'], if: 28.4, cas: '1区', acc: 15, wk: 7, types: CLIN, desc: 'JAMA 子刊，临床研究影响力高', guideUrl: 'https://jamanetwork.com/journals/jamaoncology/pages/instructions-for-authors' },
  { id: 'cancer-cell', name: 'Cancer Cell', issn: '1535-6108', publisher: 'Cell Press', scope: ['oncology', 'translational'], keywords: ['mechanism', 'molecular', 'drug', 'resistance'], if: 48.8, cas: '1区', acc: 10, wk: 6, types: ['translational', 'cohort', 'review'], desc: '基础转化研究向' },
  { id: 'ann-oncol', name: 'Annals of Oncology', issn: '0923-7534', publisher: 'Oxford University Press', scope: ['oncology'], keywords: ['cancer', 'immunotherapy', 'biomarker', 'esmo'], if: 50.5, cas: '1区', acc: 14, wk: 5, types: CLIN, desc: 'ESMO 官方期刊' },
  { id: 'nat-rev-clin', name: 'Nature Reviews Clinical Oncology', publisher: 'Nature Portfolio', scope: ['oncology'], keywords: ['review', 'perspective', 'landscape'], if: 81.1, cas: '1区', acc: 5, wk: 10, types: ['review'], desc: '顶级综述刊，仅邀稿为主' },
  { id: 'jto', name: 'Journal of Thoracic Oncology', issn: '1556-0864', publisher: 'Elsevier', scope: ['oncology', 'respiratory'], keywords: ['lung', 'thoracic', 'nsclc', 'egfr', 'immunotherapy'], if: 21.0, cas: '1区', acc: 20, wk: 5, types: CLIN_RW, desc: '胸部肿瘤专科旗舰刊' },
  { id: 'ccr', name: 'Clinical Cancer Research', issn: '1078-0432', publisher: 'AACR', scope: ['oncology', 'translational'], keywords: ['cancer', 'biomarker', 'targeted', 'phase'], if: 11.5, cas: '1区', acc: 25, wk: 6, types: ['translational', 'rct', 'cohort'], desc: '转化研究向' },
  { id: 'cancer-res', name: 'Cancer Research', issn: '0008-5472', publisher: 'AACR', scope: ['oncology', 'translational'], keywords: ['cancer', 'molecular', 'mechanism', 'preclinical'], if: 11.2, cas: '1区', acc: 22, wk: 7, types: ['translational', 'review'], desc: 'AACR 旗舰刊' },
  { id: 'jnci', name: 'JNCI: Journal of the National Cancer Institute', issn: '0027-8874', publisher: 'Oxford University Press', scope: ['oncology', 'epidemiology'], keywords: ['cancer', 'epidemiology', 'outcome'], if: 10.0, cas: '1区', acc: 20, wk: 8, types: ['cohort', 'review', 'meta'], desc: '肿瘤流行病学/预后向' },
  { id: 'npj-precis-oncol', name: 'npj Precision Oncology', publisher: 'Nature Portfolio', scope: ['oncology'], keywords: ['precision', 'genomic', 'mutation', 'biomarker'], if: 6.8, cas: '1区', acc: 28, wk: 6, oa: true, apc: 3290, types: ['translational', 'cohort'], desc: '精准肿瘤学开放获取' },
  { id: 'lung-cancer', name: 'Lung Cancer', issn: '0169-5002', publisher: 'Elsevier', scope: ['oncology', 'respiratory'], keywords: ['lung', 'nsclc', 'sclc', 'egfr', 'chemotherapy'], if: 5.3, cas: '2区', acc: 32, wk: 6, types: CLIN_RW, desc: '肺癌专科刊，接收率较高' },
  { id: 'ther-adv-med-oncol', name: 'Therapeutic Advances in Medical Oncology', publisher: 'SAGE', scope: ['oncology'], keywords: ['cancer', 'immunotherapy', 'targeted', 'retrospective'], if: 4.9, cas: '2区', acc: 35, wk: 5, oa: true, apc: 2850, types: RW_CASE, desc: '开放获取，接受回顾性研究' },
  { id: 'front-oncol', name: 'Frontiers in Oncology', publisher: 'Frontiers', scope: ['oncology'], keywords: ['cancer', 'retrospective', 'real-world', 'immunotherapy'], if: 4.7, cas: '2区', acc: 30, wk: 4, oa: true, apc: 2950, types: RW_CASE, desc: '接受真实世界数据/回顾性研究' },
  { id: 'bmc-cancer', name: 'BMC Cancer', publisher: 'Springer Nature', scope: ['oncology'], keywords: ['cancer', 'retrospective', 'cohort'], if: 3.4, cas: '3区', acc: 38, wk: 5, oa: true, apc: 2790, types: RW_CASE, desc: '审稿快，接受率高' },
  { id: 'cancers', name: 'Cancers', publisher: 'MDPI', scope: ['oncology'], keywords: ['cancer', 'tumor', 'molecular'], if: 4.5, cas: '2区', acc: 45, wk: 3, oa: true, apc: 2600, types: RW_CASE, desc: 'MDPI 快速发表' },
  { id: 'tlcr', name: 'Translational Lung Cancer Research', publisher: 'AME', scope: ['oncology', 'respiratory'], keywords: ['lung', 'nsclc', 'sclc', 'translational'], if: 4.0, cas: '2区', acc: 36, wk: 4, oa: true, apc: 2580, types: CLIN_RW, desc: 'AME 出版肺癌转化刊' },
  { id: 'world-j-surg-oncol', name: 'World Journal of Surgical Oncology', publisher: 'Springer Nature', scope: ['oncology', 'surgery'], keywords: ['surgical', 'cancer', 'retrospective'], if: 2.5, cas: '3区', acc: 45, wk: 4, oa: true, apc: 2390, types: RW_CASE, desc: '外科肿瘤向，接受率高' },
  { id: 'ca-clinicians', name: 'CA: A Cancer Journal for Clinicians', publisher: 'Wiley', scope: ['oncology'], keywords: ['cancer', 'statistics', 'review'], if: 254.7, cas: '1区Top', acc: 5, wk: 10, types: ['review'], desc: '癌症统计/综述顶刊，邀稿为主' },
  { id: 'mol-cancer', name: 'Molecular Cancer', publisher: 'Springer Nature', scope: ['oncology', 'translational'], keywords: ['molecular', 'mechanism', 'oncology'], if: 27.7, cas: '1区Top', acc: 15, wk: 8, oa: true, apc: 2990, types: ['translational', 'review'], desc: '肿瘤分子机制 OA 刊' },
  { id: 'jho', name: 'Journal of Hematology & Oncology', publisher: 'Springer Nature', scope: ['oncology', 'hematology'], keywords: ['hematologic', 'leukemia', 'lymphoma', 'carcinoma'], if: 28.5, cas: '1区Top', acc: 15, wk: 8, oa: true, apc: 2990, types: ['translational', 'review', 'cohort'], desc: '血液肿瘤 OA 顶刊' },
  { id: 'eur-j-cancer', name: 'European Journal of Cancer', publisher: 'Elsevier', scope: ['oncology'], keywords: ['cancer', 'oncology', 'clinical'], if: 9.0, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: '欧洲肿瘤综合刊' },
  { id: 'cancer-lett', name: 'Cancer Letters', publisher: 'Elsevier', scope: ['oncology', 'translational'], keywords: ['cancer', 'mechanism', 'molecular'], if: 8.7, cas: '1区', acc: 22, wk: 8, types: ['translational'], desc: '肿瘤基础与转化研究' },
  { id: 'cancer-treat-rev', name: 'Cancer Treatment Reviews', publisher: 'Elsevier', scope: ['oncology'], keywords: ['cancer', 'treatment', 'review', 'meta'], if: 16.0, cas: '1区Top', acc: 18, wk: 8, types: ['review', 'meta'], desc: '肿瘤治疗综述/Meta 向' },
  { id: 'jnccn', name: 'JNCCN: Journal of the National Comprehensive Cancer Network', publisher: 'JNCCN', scope: ['oncology'], keywords: ['cancer', 'guideline', 'clinical', 'outcome'], if: 10.7, cas: '1区', acc: 20, wk: 8, types: ['cohort', 'review', 'rct'], desc: 'NCCN 官方刊,临床决策/结局向' },
  { id: 'br-j-cancer', name: 'British Journal of Cancer', publisher: 'Springer Nature', scope: ['oncology', 'epidemiology'], keywords: ['cancer', 'risk', 'survival', 'cohort'], if: 6.8, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: '英国癌症研究综合刊' },
  { id: 'int-j-cancer', name: 'International Journal of Cancer', publisher: 'Wiley', scope: ['oncology', 'epidemiology'], keywords: ['cancer', 'epidemiology', 'risk'], if: 5.4, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'translational'], desc: 'UICC 官方刊,流行病学与实验肿瘤' },
  { id: 'oncogene', name: 'Oncogene', publisher: 'Nature Portfolio', scope: ['oncology', 'translational'], keywords: ['oncogene', 'mechanism', 'signaling'], if: 6.9, cas: '2区', acc: 22, wk: 10, types: ['translational'], desc: '肿瘤分子机制经典刊' },
  { id: 'radiother-oncol', name: 'Radiotherapy and Oncology', publisher: 'Elsevier', scope: ['oncology', 'radiology'], keywords: ['radiotherapy', 'radiation', 'immunotherapy', 'cancer'], if: 6.9, cas: '1区', acc: 25, wk: 8, types: ['rct', 'cohort', 'review'], desc: 'ESTRO 官方刊,放疗肿瘤学' },
  { id: 'red-journal', name: 'International Journal of Radiation Oncology Biology Physics', publisher: 'Elsevier', scope: ['oncology', 'radiology'], keywords: ['radiotherapy', 'radiation', 'cancer', 'dose'], if: 7.0, cas: '1区', acc: 25, wk: 8, types: ['rct', 'cohort'], desc: '放疗红皮杂志' },
  { id: 'breast-cancer-res', name: 'Breast Cancer Research', publisher: 'Springer Nature', scope: ['oncology'], keywords: ['breast', 'cancer', 'hormone', 'her2'], if: 7.4, cas: '2区', acc: 28, wk: 8, oa: true, apc: 2790, types: ['translational', 'cohort'], desc: '乳腺癌研究 OA 刊' },
  { id: 'gastric-cancer', name: 'Gastric Cancer', publisher: 'Springer Nature', scope: ['oncology', 'gastro'], keywords: ['gastric', 'cancer', 'gastrectomy', 'her2'], if: 6.0, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: 'IGCA 官方刊,胃癌专科' },
  { id: 'gynecol-oncol', name: 'Gynecologic Oncology', publisher: 'Elsevier', scope: ['oncology', 'obgyn'], keywords: ['ovarian', 'cervical', 'endometrial', 'cancer'], if: 6.0, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: '妇科肿瘤专科刊' },
  { id: 'ann-surg-oncol', name: 'Annals of Surgical Oncology', publisher: 'Springer Nature', scope: ['oncology', 'surgery'], keywords: ['surgical', 'cancer', 'resection', 'lymph'], if: 4.5, cas: '2区', acc: 30, wk: 8, types: CLIN_RW, desc: '外科肿瘤学会官方刊' },
  { id: 'esmo-open', name: 'ESMO Open', publisher: 'Elsevier', scope: ['oncology'], keywords: ['cancer', 'oncology', 'esmo', 'clinical'], if: 6.9, cas: '2区', acc: 30, wk: 6, oa: true, types: CLIN_RW, desc: 'ESMO 开放获取刊' },

  /* ── 预警期刊收录(红线防护用,数据仅目录级)──────────────────── */
  { id: 'j-oncol-hindawi', name: 'Journal of Oncology', publisher: 'Hindawi', scope: ['oncology'], keywords: ['cancer'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'oxmed-cell-longev', name: 'Oxidative Medicine and Cellular Longevity', publisher: 'Hindawi', scope: ['oncology'], keywords: ['oxidative'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'biomed-res-int', name: 'BioMed Research International', publisher: 'Hindawi', scope: ['general-medicine'], keywords: ['research'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'disease-markers', name: 'Disease Markers', publisher: 'Hindawi', scope: ['laboratory'], keywords: ['biomarker'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'contrast-media-mi', name: 'Contrast Media & Molecular Imaging', publisher: 'Hindawi', scope: ['radiology'], keywords: ['contrast'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'j-healthcare-eng', name: 'Journal of Healthcare Engineering', publisher: 'Hindawi', scope: ['public-health'], keywords: ['healthcare'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'comp-intell-neurosci', name: 'Computational Intelligence and Neuroscience', publisher: 'Hindawi', scope: ['neurology'], keywords: ['neural'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'j-env-public-health', name: 'Journal of Environmental and Public Health', publisher: 'Hindawi', scope: ['public-health'], keywords: ['environment'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'scanning-j', name: 'Scanning', publisher: 'Hindawi', scope: ['radiology'], keywords: ['microscopy'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'j-nanomaterials', name: 'Journal of Nanomaterials', publisher: 'Hindawi', scope: ['translational'], keywords: ['nanoparticle'], cas: '4区', desc: '已停刊(原 Hindawi),中科院预警名单收录' },
  { id: 'bioengineered', name: 'Bioengineered', publisher: 'Taylor & Francis', scope: ['translational'], keywords: ['bioengineering'], if: 2.5, cas: '4区', acc: 40, wk: 6, desc: '中科院预警名单(2024 版)收录' },
  { id: 'j-nanobiotechnology', name: 'Journal of Nanobiotechnology', publisher: 'Springer Nature', scope: ['translational'], keywords: ['nanoparticle', 'delivery'], if: 10.4, cas: '1区', acc: 25, wk: 8, oa: true, apc: 2790, desc: '中科院预警名单(2024 版)收录' },
  { id: 'medicine-baltimore', name: 'Medicine', publisher: 'Wolters Kluwer', scope: ['general-medicine'], keywords: ['case', 'clinical'], if: 1.4, cas: '4区', acc: 50, wk: 12, desc: '中科院预警名单(2023 版)历史预警,建议人工复核' },

  /* ── 综合大刊 ──────────────────────────────────────────────── */
  { id: 'nejm', name: 'New England Journal of Medicine', issn: '0028-4793', publisher: 'Massachusetts Medical Society', scope: ['general-medicine'], keywords: ['clinical', 'trial', 'randomized', 'outcome'], if: 158.4, cas: '1区Top', acc: 5, wk: 8, types: CLIN, desc: '顶级综合医学刊', guideUrl: 'https://authors.nejm.org/' },
  { id: 'lancet', name: 'The Lancet', issn: '0140-6736', publisher: 'Elsevier', scope: ['general-medicine'], keywords: ['clinical', 'trial', 'randomized', 'global'], if: 98.4, cas: '1区Top', acc: 6, wk: 8, types: CLIN, desc: '顶级综合医学刊', guideUrl: 'https://authorguides.thelancet.com/' },
  { id: 'jama', name: 'JAMA', issn: '0098-7484', publisher: 'American Medical Association', scope: ['general-medicine'], keywords: ['clinical', 'trial', 'cohort', 'outcome'], if: 120.7, cas: '1区Top', acc: 7, wk: 8, types: CLIN, desc: '顶级综合医学刊', guideUrl: 'https://jamanetwork.com/journals/jama/pages/instructions-for-authors' },
  { id: 'bmj', name: 'BMJ', issn: '0959-8138', publisher: 'BMJ Group', scope: ['general-medicine'], keywords: ['clinical', 'research', 'cohort', 'practice'], if: 107.7, cas: '1区Top', acc: 8, wk: 8, types: CLIN, desc: '英国医学杂志,临床研究与循证', guideUrl: 'https://www.bmj.com/about-bmj/resources-authors' },
  { id: 'nat-med', name: 'Nature Medicine', issn: '1078-8956', publisher: 'Nature Portfolio', scope: ['general-medicine', 'translational'], keywords: ['translational', 'mechanism', 'clinical'], if: 58.7, cas: '1区Top', acc: 8, wk: 10, types: CLIN, desc: '医学转化顶刊' },
  { id: 'ann-intern-med', name: 'Annals of Internal Medicine', issn: '0003-4819', publisher: 'American College of Physicians', scope: ['general-medicine'], keywords: ['internal', 'cohort', 'trial', 'guideline'], if: 19.6, cas: '1区Top', acc: 8, wk: 8, types: CLIN, desc: '内科旗舰刊' },
  { id: 'jama-intern-med', name: 'JAMA Internal Medicine', publisher: 'American Medical Association', scope: ['general-medicine'], keywords: ['internal', 'cohort', 'outcome', 'trial'], if: 22.8, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: 'JAMA 内科子刊' },
  { id: 'jama-netw-open', name: 'JAMA Network Open', publisher: 'American Medical Association', scope: ['general-medicine'], keywords: ['clinical', 'cohort', 'outcome'], if: 10.5, cas: '1区', acc: 25, wk: 6, oa: true, apc: 3000, types: CLIN_RW, desc: 'JAMA 开放获取综合刊', guideUrl: 'https://jamanetwork.com/journals/jamanetworkopen/pages/instructions-for-authors' },
  { id: 'eclinm', name: 'eClinicalMedicine', publisher: 'Elsevier', scope: ['general-medicine'], keywords: ['clinical', 'trial', 'cohort'], if: 13.2, cas: '1区', acc: 25, wk: 6, oa: true, apc: 5000, types: CLIN, desc: 'The Lancet 系开放获取综合刊' },
  { id: 'plos-med', name: 'PLOS Medicine', publisher: 'PLOS', scope: ['general-medicine', 'public-health'], keywords: ['clinical', 'trial', 'public health'], if: 10.5, cas: '1区', acc: 12, wk: 10, oa: true, apc: 5000, types: CLIN, desc: 'PLOS 医学旗舰刊' },

  /* ── 心血管 ───────────────────────────────────────────────── */
  { id: 'circulation', name: 'Circulation', issn: '0009-7322', publisher: 'Wolters Kluwer', scope: ['cardiology'], keywords: ['cardiac', 'heart', 'myocardial', 'atherosclerotic'], if: 35.5, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: '心血管旗舰刊(AHA)' },
  { id: 'eur-heart-j', name: 'European Heart Journal', publisher: 'Oxford University Press', scope: ['cardiology'], keywords: ['cardiac', 'heart', 'coronary', 'echocardiography'], if: 38.1, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: 'ESC 旗舰刊' },
  { id: 'jacc', name: 'Journal of the American College of Cardiology', issn: '0735-1097', publisher: 'Elsevier', scope: ['cardiology'], keywords: ['cardiac', 'coronary', 'heart failure', 'stent'], if: 24.0, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'ACC 旗舰刊' },
  { id: 'circ-res', name: 'Circulation Research', issn: '0009-7330', publisher: 'Wolters Kluwer', scope: ['cardiology', 'translational'], keywords: ['myocardial', 'mechanism', 'cardiac'], if: 20.8, cas: '1区Top', acc: 15, wk: 10, types: ['translational', 'review'], desc: '心血管基础/转化旗舰' },
  { id: 'nat-rev-cardiol', name: 'Nature Reviews Cardiology', publisher: 'Nature Portfolio', scope: ['cardiology'], keywords: ['review', 'cardiology'], if: 35.0, cas: '1区Top', acc: 5, wk: 10, types: ['review'], desc: '心血管综述顶刊(邀稿为主)' },
  { id: 'jama-cardiol', name: 'JAMA Cardiology', issn: '2470-7465', publisher: 'American Medical Association', scope: ['cardiology'], keywords: ['cardiac', 'cohort', 'outcome'], if: 14.8, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'JAMA 心脏子刊' },
  { id: 'eur-j-heart-fail', name: 'European Journal of Heart Failure', publisher: 'Oxford University Press', scope: ['cardiology'], keywords: ['heart failure', 'cardiac', 'sodium'], if: 16.9, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'HFA/ESC 心衰官方刊' },
  { id: 'jacc-cvi', name: 'JACC: Cardiovascular Interventions', publisher: 'Elsevier', scope: ['cardiology'], keywords: ['pci', 'stent', 'coronary', 'tavr'], if: 11.7, cas: '1区', acc: 18, wk: 8, types: ['rct', 'cohort'], desc: '介入心脏病学旗舰' },
  { id: 'jacc-img', name: 'JACC: Cardiovascular Imaging', publisher: 'Elsevier', scope: ['cardiology', 'radiology'], keywords: ['echocardiography', 'imaging', 'cardiac', 'mri'], if: 8.9, cas: '1区', acc: 18, wk: 8, types: ['cohort', 'review'], desc: '心血管影像旗舰' },
  { id: 'circ-hf', name: 'Circulation: Heart Failure', publisher: 'Wolters Kluwer', scope: ['cardiology'], keywords: ['heart failure', 'cardiac'], if: 8.5, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: 'AHA 心衰子刊' },
  { id: 'hypertension-j', name: 'Hypertension', issn: '0194-911X', publisher: 'Wolters Kluwer', scope: ['cardiology'], keywords: ['hypertension', 'blood pressure', 'sodium'], if: 8.3, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: 'AHA 高血压官方刊' },
  { id: 'heart-j', name: 'Heart', publisher: 'BMJ Group', scope: ['cardiology'], keywords: ['cardiac', 'heart', 'clinical'], if: 7.2, cas: '2区', acc: 22, wk: 8, types: CLIN_RW, desc: 'BCS 官方刊' },
  { id: 'cardiovasc-res', name: 'Cardiovascular Research', publisher: 'Oxford University Press', scope: ['cardiology', 'translational'], keywords: ['cardiac', 'mechanism', 'myocardial'], if: 8.0, cas: '1区', acc: 20, wk: 10, types: ['translational'], desc: 'ESC 基础/转化刊' },
  { id: 'europace', name: 'Europace', issn: '1099-5129', publisher: 'Oxford University Press', scope: ['cardiology'], keywords: ['arrhythmia', 'pacing', 'atrial fibrillation', 'ablation'], if: 6.1, cas: '1区', acc: 25, wk: 8, types: CLIN_RW, desc: 'EHRA/ESC 电生理官方刊' },
  { id: 'heart-rhythm', name: 'Heart Rhythm', publisher: 'Elsevier', scope: ['cardiology'], keywords: ['arrhythmia', 'atrial fibrillation', 'ablation', 'pacemaker'], if: 5.6, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'HRS 官方刊' },
  { id: 'circ-arrhythm', name: 'Circulation: Arrhythmia and Electrophysiology', publisher: 'Wolters Kluwer', scope: ['cardiology'], keywords: ['arrhythmia', 'atrial fibrillation', 'electrophysiology'], if: 6.0, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'AHA 电生理子刊' },
  { id: 'esc-heart-fail', name: 'ESC Heart Failure', publisher: 'Wiley', scope: ['cardiology'], keywords: ['heart failure', 'cardiac'], if: 8.5, cas: '2区', acc: 30, wk: 6, oa: true, apc: 2500, types: RW_CASE, desc: 'ESC 心衰开放获取刊' },
  { id: 'ehj-ci', name: 'European Heart Journal - Cardiovascular Imaging', publisher: 'Oxford University Press', scope: ['cardiology', 'radiology'], keywords: ['echocardiography', 'imaging', 'cardiac'], if: 6.5, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: 'EACVI 官方影像刊' },
  { id: 'int-j-cardiol', name: 'International Journal of Cardiology', publisher: 'Elsevier', scope: ['cardiology'], keywords: ['cardiac', 'coronary', 'heart'], if: 4.6, cas: '2区', acc: 30, wk: 8, types: RW_CASE, desc: '心血管综合刊,接受率较高' },
  { id: 'am-j-cardiol', name: 'American Journal of Cardiology', publisher: 'Elsevier', scope: ['cardiology'], keywords: ['cardiac', 'coronary', 'clinical'], if: 3.6, cas: '3区', acc: 32, wk: 6, types: RW_CASE, desc: '临床心脏综合刊' },
  { id: 'cath-interv', name: 'Catheterization and Cardiovascular Interventions', publisher: 'Wiley', scope: ['cardiology'], keywords: ['pci', 'stent', 'coronary'], if: 2.6, cas: '3区', acc: 35, wk: 6, types: RW_CASE, desc: '介入操作向,接受率较高' },

  /* ── 呼吸 ─────────────────────────────────────────────────── */
  { id: 'ajrccm', name: 'American Journal of Respiratory and Critical Care Medicine', issn: '1073-449X', publisher: 'American Thoracic Society', scope: ['respiratory', 'critical-care'], keywords: ['copd', 'asthma', 'ards', 'pulmonary', 'ventilation'], if: 24.7, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: '呼吸/重症旗舰刊(ATS)' },
  { id: 'lancet-resp-med', name: 'Lancet Respiratory Medicine', publisher: 'Elsevier', scope: ['respiratory'], keywords: ['pulmonary', 'copd', 'asthma', 'pneumonia'], if: 35.8, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: '呼吸顶刊' },
  { id: 'erj', name: 'European Respiratory Journal', issn: '0903-1936', publisher: 'European Respiratory Society', scope: ['respiratory'], keywords: ['copd', 'asthma', 'pulmonary', 'lung'], if: 16.6, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'ERS 旗舰刊' },
  { id: 'chest-j', name: 'CHEST', issn: '0012-3692', publisher: 'Elsevier', scope: ['respiratory', 'critical-care'], keywords: ['pulmonary', 'ards', 'ventilation', 'sleep'], if: 9.6, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: 'ACCP 官方刊,呼吸与重症' },
  { id: 'thorax-j', name: 'Thorax', issn: '0040-6376', publisher: 'BMJ Group', scope: ['respiratory'], keywords: ['copd', 'asthma', 'pulmonary', 'lung'], if: 9.9, cas: '1区', acc: 18, wk: 8, types: CLIN, desc: 'BMJ 呼吸旗舰刊' },
  { id: 'resp-research', name: 'Respiratory Research', publisher: 'Springer Nature', scope: ['respiratory'], keywords: ['copd', 'asthma', 'pulmonary', 'mechanism'], if: 5.9, cas: '2区', acc: 30, wk: 6, oa: true, apc: 2890, types: ['translational', 'cohort', 'case_report'], desc: '呼吸研究 OA 刊' },
  { id: 'int-j-copd', name: 'International Journal of Chronic Obstructive Pulmonary Disease', publisher: 'Dove Press', scope: ['respiratory'], keywords: ['copd', 'pulmonary', 'smoking'], if: 3.0, cas: '3区', acc: 35, wk: 6, oa: true, apc: 3200, types: RW_CASE, desc: 'COPD 专科 OA 刊,接受率较高' },
  { id: 'j-thoracic-dis', name: 'Journal of Thoracic Disease', publisher: 'AME', scope: ['respiratory', 'surgery'], keywords: ['lung', 'thoracic', 'surgery', 'pulmonary'], if: 2.1, cas: '3区', acc: 38, wk: 5, oa: true, apc: 1980, types: RW_CASE, desc: 'AME 胸科综合刊,审稿快' },
  { id: 'thoracic-cancer', name: 'Thoracic Cancer', publisher: 'Wiley', scope: ['oncology', 'respiratory'], keywords: ['lung', 'cancer', 'thoracic'], if: 3.0, cas: '3区', acc: 38, wk: 6, oa: true, apc: 2500, types: RW_CASE, desc: '胸部肿瘤 OA 刊,接受率较高' },

  /* ── 消化/肝病 ────────────────────────────────────────────── */
  { id: 'gastro', name: 'Gastroenterology', issn: '0016-5085', publisher: 'Elsevier', scope: ['gastro'], keywords: ['colon', 'colitis', 'hepatic', 'pancreas', 'gerd'], if: 25.7, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: '消化旗舰刊(AGA)' },
  { id: 'gut-j', name: 'Gut', publisher: 'BMJ Group', scope: ['gastro'], keywords: ['colon', 'ibd', 'hepatic', 'pancreas'], if: 23.0, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: '消化旗舰刊(BMJ Group)' },
  { id: 'j-hepatol', name: 'Journal of Hepatology', issn: '0168-8278', publisher: 'Elsevier', scope: ['hepatology'], keywords: ['hepatic', 'cirrhosis', 'liver', 'hbv', 'hcv'], if: 26.8, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'EASL 旗舰刊' },
  { id: 'hepatology-j', name: 'Hepatology', issn: '0270-9139', publisher: 'Wiley', scope: ['hepatology'], keywords: ['liver', 'cirrhosis', 'hbv', 'hcc'], if: 13.5, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: 'AASLD 旗舰刊' },
  { id: 'am-j-gastro', name: 'American Journal of Gastroenterology', publisher: 'Wolters Kluwer', scope: ['gastro'], keywords: ['colon', 'gerd', 'ibd', 'clinical'], if: 9.8, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: 'ACG 官方刊' },
  { id: 'clin-gastro-hep', name: 'Clinical Gastroenterology and Hepatology', publisher: 'Elsevier', scope: ['gastro'], keywords: ['colon', 'ibd', 'clinical', 'endoscopy'], if: 11.3, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'AGA 临床子刊' },
  { id: 'apt-j', name: 'Alimentary Pharmacology & Therapeutics', publisher: 'Wiley', scope: ['gastro'], keywords: ['ibd', 'gerd', 'therapy', 'colon'], if: 6.7, cas: '2区', acc: 22, wk: 8, types: ['meta', 'review', 'cohort'], desc: '消化药理与治疗' },
  { id: 'endoscopy-j', name: 'Endoscopy', publisher: 'Thieme', scope: ['gastro'], keywords: ['endoscopy', 'polyp', 'colonoscopy', 'egd'], if: 11.5, cas: '1区Top', acc: 20, wk: 8, types: ['cohort', 'rct'], desc: 'ESGE/消化内镜旗舰' },
  { id: 'gi-endoscopy', name: 'Gastrointestinal Endoscopy', publisher: 'Elsevier', scope: ['gastro'], keywords: ['endoscopy', 'colonoscopy', 'polyp', 'eus'], if: 8.4, cas: '1区', acc: 22, wk: 8, types: ['cohort', 'review'], desc: 'ASGE 官方刊' },
  { id: 'liver-int', name: 'Liver International', publisher: 'Wiley', scope: ['hepatology'], keywords: ['liver', 'cirrhosis', 'hepatic'], if: 6.0, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'IASL 官方刊' },
  { id: 'jcc-ibd', name: "Journal of Crohn's and Colitis", publisher: 'Oxford University Press', scope: ['gastro'], keywords: ['ibd', 'crohn', 'colitis', 'uc'], if: 6.8, cas: '1区', acc: 22, wk: 8, types: CLIN, desc: 'ECCO 官方刊,IBD 专科' },
  { id: 'ibd-j', name: 'Inflammatory Bowel Diseases', publisher: 'Oxford University Press', scope: ['gastro'], keywords: ['ibd', 'crohn', 'colitis'], if: 4.0, cas: '3区', acc: 30, wk: 8, types: CLIN_RW, desc: 'CCFA 官方 IBD 刊' },
  { id: 'wjg-j', name: 'World Journal of Gastroenterology', publisher: 'Baishideng', scope: ['gastro'], keywords: ['gastro', 'liver', 'colon'], if: 4.3, cas: '2区', acc: 30, wk: 5, oa: true, apc: 2280, types: RW_CASE, desc: '消化综合 OA 刊,审稿快' },
  { id: 'colorectal-dis', name: 'Colorectal Disease', publisher: 'Wiley', scope: ['gastro', 'surgery'], keywords: ['colorectal', 'rectal', 'colon', 'surgery'], if: 3.0, cas: '3区', acc: 32, wk: 6, types: RW_CASE, desc: 'ESCP 官方刊,结直肠外科' },

  /* ── 内分泌/代谢 ──────────────────────────────────────────── */
  { id: 'lancet-diab-endo', name: 'Lancet Diabetes & Endocrinology', publisher: 'Elsevier', scope: ['endocrine'], keywords: ['diabetes', 'thyroid', 'obesity', 'endocrine'], if: 35.5, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: '内分泌顶刊' },
  { id: 'diab-care', name: 'Diabetes Care', issn: '0149-5992', publisher: 'American Diabetes Association', scope: ['endocrine'], keywords: ['diabetes', 'hba1c', 'insulin', 'glycemic'], if: 16.2, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: 'ADA 临床旗舰刊' },
  { id: 'diabetes-j', name: 'Diabetes', issn: '0012-1797', publisher: 'American Diabetes Association', scope: ['endocrine', 'translational'], keywords: ['diabetes', 'insulin', 'beta cell'], if: 7.7, cas: '1区Top', acc: 20, wk: 10, types: ['translational', 'cohort'], desc: 'ADA 基础/转化旗舰' },
  { id: 'diabetologia', name: 'Diabetologia', issn: '0012-186X', publisher: 'Springer Nature', scope: ['endocrine'], keywords: ['diabetes', 'insulin', 'glycemic'], if: 8.4, cas: '1区Top', acc: 20, wk: 10, types: CLIN, desc: 'EASD 官方刊' },
  { id: 'endocr-rev', name: 'Endocrine Reviews', publisher: 'Endocrine Society', scope: ['endocrine'], keywords: ['review', 'endocrine', 'hormone'], if: 22.0, cas: '1区Top', acc: 10, wk: 10, types: ['review'], desc: '内分泌综述顶刊(邀稿为主)' },
  { id: 'mol-metab', name: 'Molecular Metabolism', publisher: 'Elsevier', scope: ['endocrine', 'translational'], keywords: ['metabolism', 'insulin', 'mechanism'], if: 9.0, cas: '1区', acc: 22, wk: 8, types: ['translational'], desc: '代谢机制研究' },
  { id: 'metabolism-j', name: 'Metabolism', publisher: 'Elsevier', scope: ['endocrine'], keywords: ['metabolism', 'diabetes', 'obesity', 'nash'], if: 10.8, cas: '1区Top', acc: 20, wk: 8, types: ['translational', 'cohort'], desc: '临床与转化代谢研究' },
  { id: 'jcem', name: 'Journal of Clinical Endocrinology & Metabolism', issn: '0021-972X', publisher: 'Endocrine Society', scope: ['endocrine'], keywords: ['thyroid', 'endocrine', 'diabetes', 'hormone'], if: 5.8, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: 'Endocrine Society 临床刊' },
  { id: 'thyroid-j', name: 'Thyroid', publisher: 'Mary Ann Liebert', scope: ['endocrine'], keywords: ['thyroid', 'tsh', 'nodule', 'hashimoto'], if: 6.0, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ATA 官方甲状腺专科刊' },
  { id: 'obesity-j', name: 'Obesity', publisher: 'Wiley', scope: ['endocrine'], keywords: ['obesity', 'bariatric', 'weight'], if: 6.9, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: 'Obesity Society 官方刊' },
  { id: 'drcp', name: 'Diabetes Research and Clinical Practice', publisher: 'Elsevier', scope: ['endocrine'], keywords: ['diabetes', 'clinical', 'hba1c'], if: 5.1, cas: '2区', acc: 30, wk: 6, types: RW_CASE, desc: 'IDF 官方刊,接受率较高' },
  { id: 'bmj-open-diab', name: 'BMJ Open Diabetes Research & Care', publisher: 'BMJ Group', scope: ['endocrine'], keywords: ['diabetes', 'clinical'], if: 4.0, cas: '3区', acc: 35, wk: 6, oa: true, apc: 2500, types: RW_CASE, desc: '糖尿病 OA 刊,审稿快' },
  { id: 'jbmr', name: 'Journal of Bone and Mineral Research', publisher: 'Wiley', scope: ['endocrine'], keywords: ['bone', 'osteoporosis', 'mineral'], if: 6.2, cas: '2区', acc: 25, wk: 8, types: ['translational', 'cohort'], desc: 'ASBMR 骨代谢官方刊' },

  /* ── 肾内 ─────────────────────────────────────────────────── */
  { id: 'kidney-int', name: 'Kidney International', issn: '0085-2538', publisher: 'Elsevier', scope: ['nephrology'], keywords: ['kidney', 'renal', 'dialysis', 'ckd'], if: 14.8, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'ISN 旗舰刊' },
  { id: 'jasn', name: 'Journal of the American Society of Nephrology', issn: '1046-6673', publisher: 'American Society of Nephrology', scope: ['nephrology'], keywords: ['kidney', 'renal', 'dialysis', 'glomerulonephritis'], if: 10.3, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: 'ASN 旗舰刊' },
  { id: 'ajkd', name: 'American Journal of Kidney Diseases', issn: '0272-6386', publisher: 'Elsevier', scope: ['nephrology'], keywords: ['kidney', 'dialysis', 'ckd', 'clinical'], if: 8.7, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'NKF 官方临床刊' },
  { id: 'cjasn', name: 'Clinical Journal of the American Society of Nephrology', publisher: 'American Society of Nephrology', scope: ['nephrology'], keywords: ['kidney', 'renal', 'dialysis'], if: 6.3, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ASN 临床子刊' },
  { id: 'ndt', name: 'Nephrology Dialysis Transplantation', publisher: 'Oxford University Press', scope: ['nephrology'], keywords: ['dialysis', 'transplant', 'ckd', 'renal'], if: 5.5, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ERA 官方刊' },

  /* ── 神经 ─────────────────────────────────────────────────── */
  { id: 'lancet-neurol', name: 'Lancet Neurology', publisher: 'Elsevier', scope: ['neurology'], keywords: ['stroke', 'epilepsy', 'parkinson', 'alzheimer', 'multiple sclerosis'], if: 46.5, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: '神经顶刊' },
  { id: 'jama-neurol', name: 'JAMA Neurology', publisher: 'American Medical Association', scope: ['neurology'], keywords: ['stroke', 'dementia', 'parkinson', 'cohort'], if: 20.1, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'JAMA 神经子刊' },
  { id: 'neurology-j', name: 'Neurology', issn: '0028-3878', publisher: 'Wolters Kluwer', scope: ['neurology'], keywords: ['stroke', 'epilepsy', 'migraine', 'neuropathy'], if: 7.7, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'AAN 官方旗舰刊' },
  { id: 'stroke-j', name: 'Stroke', issn: '0039-2499', publisher: 'Wolters Kluwer', scope: ['neurology'], keywords: ['stroke', 'thrombolysis', 'cerebral', 'tia'], if: 8.3, cas: '1区Top', acc: 22, wk: 8, types: CLIN, desc: 'AHA 卒中官方刊' },
  { id: 'ann-neurol', name: 'Annals of Neurology', issn: '0364-5134', publisher: 'Wiley', scope: ['neurology'], keywords: ['neurology', 'mechanism', 'neurodegener'], if: 11.2, cas: '1区Top', acc: 18, wk: 10, types: ['translational', 'cohort'], desc: 'ANA 官方刊' },
  { id: 'brain-j', name: 'Brain', issn: '0006-8950', publisher: 'Oxford University Press', scope: ['neurology', 'translational'], keywords: ['neurology', 'mechanism', 'neurodegener'], if: 14.5, cas: '1区Top', acc: 15, wk: 10, types: ['translational', 'cohort'], desc: '神经经典旗舰刊' },
  { id: 'nat-rev-neurol', name: 'Nature Reviews Neurology', publisher: 'Nature Portfolio', scope: ['neurology'], keywords: ['review', 'neurology'], if: 34.0, cas: '1区Top', acc: 5, wk: 10, types: ['review'], desc: '神经综述顶刊(邀稿为主)' },
  { id: 'mov-disord', name: 'Movement Disorders', issn: '0885-3185', publisher: 'Wiley', scope: ['neurology'], keywords: ['parkinson', 'dystonia', 'tremor', 'movement'], if: 8.9, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: 'MDS 官方刊' },
  { id: 'epilepsia', name: 'Epilepsia', issn: '0013-9580', publisher: 'Wiley', scope: ['neurology'], keywords: ['epilepsy', 'seizure', 'antiepileptic'], if: 6.6, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ILAE 官方刊' },
  { id: 'jnnp', name: 'Journal of Neurology, Neurosurgery & Psychiatry', publisher: 'BMJ Group', scope: ['neurology'], keywords: ['neurology', 'stroke', 'clinical'], if: 8.9, cas: '2区', acc: 22, wk: 8, types: CLIN_RW, desc: '神经/精神综合 BMJ 刊' },

  /* ── 精神 ─────────────────────────────────────────────────── */
  { id: 'world-psychiatry', name: 'World Psychiatry', publisher: 'Wiley', scope: ['psychiatry'], keywords: ['psychiatry', 'mental'], if: 60.5, cas: '1区Top', acc: 5, wk: 10, types: ['review'], desc: 'WPA 旗舰刊(邀稿为主)' },
  { id: 'jama-psychiatry', name: 'JAMA Psychiatry', publisher: 'American Medical Association', scope: ['psychiatry'], keywords: ['depression', 'schizophrenia', 'cohort'], if: 22.0, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'JAMA 精神子刊' },
  { id: 'lancet-psychiatry', name: 'Lancet Psychiatry', publisher: 'Elsevier', scope: ['psychiatry'], keywords: ['depression', 'psychiatry', 'mental'], if: 14.5, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'Lancet 精神子刊' },
  { id: 'am-j-psychiatry', name: 'American Journal of Psychiatry', publisher: 'American Psychiatric Association Publishing', scope: ['psychiatry'], keywords: ['psychiatry', 'depression', 'clinical'], if: 17.7, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'APA 旗舰刊' },
  { id: 'mol-psychiatry', name: 'Molecular Psychiatry', publisher: 'Nature Portfolio', scope: ['psychiatry', 'translational'], keywords: ['depression', 'mechanism', 'genetic'], if: 11.0, cas: '1区Top', acc: 18, wk: 10, types: ['translational', 'review'], desc: '精神转化研究旗舰' },
  { id: 'j-affe-dis', name: 'Journal of Affective Disorders', publisher: 'Elsevier', scope: ['psychiatry'], keywords: ['depression', 'anxiety', 'bipolar'], if: 4.9, cas: '2区', acc: 30, wk: 6, types: RW_CASE, desc: '情感障碍综合刊,接受率较高' },

  /* ── 感染 ─────────────────────────────────────────────────── */
  { id: 'lancet-id', name: 'Lancet Infectious Diseases', publisher: 'Elsevier', scope: ['infectious'], keywords: ['infection', 'antibiotic', 'sepsis', 'covid'], if: 35.8, cas: '1区Top', acc: 10, wk: 8, types: CLIN, desc: '感染顶刊' },
  { id: 'cid-j', name: 'Clinical Infectious Diseases', issn: '1058-4838', publisher: 'Oxford University Press', scope: ['infectious'], keywords: ['infection', 'antibiotic', 'sepsis', 'hiv'], if: 8.0, cas: '1区', acc: 22, wk: 8, types: CLIN_RW, desc: 'IDSA 官方临床刊' },
  { id: 'clin-microbiol-rev', name: 'Clinical Microbiology Reviews', publisher: 'American Society for Microbiology', scope: ['infectious', 'microbiology'], keywords: ['review', 'microbiology', 'mechanism'], if: 26.4, cas: '1区Top', acc: 10, wk: 10, types: ['review'], desc: 'ASM 综述旗舰(邀稿为主)' },
  { id: 'cmi-j', name: 'Clinical Microbiology and Infection', publisher: 'Oxford University Press', scope: ['infectious'], keywords: ['infection', 'antibiotic', 'microbiology'], if: 7.0, cas: '1区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ESCMID 官方刊' },
  { id: 'j-infect', name: 'Journal of Infection', publisher: 'Elsevier', scope: ['infectious'], keywords: ['infection', 'sepsis', 'covid', 'antibiotic'], if: 14.3, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'BSAC 官方刊' },
  { id: 'aac-j', name: 'Antimicrobial Agents and Chemotherapy', issn: '0066-4804', publisher: 'American Society for Microbiology', scope: ['infectious', 'pharmacology'], keywords: ['antibiotic', 'resistance', 'antimicrobial'], if: 4.9, cas: '2区', acc: 30, wk: 6, types: ['translational', 'cohort'], desc: 'ASM 抗菌药研究' },
  { id: 'jac-j', name: 'Journal of Antimicrobial Chemotherapy', issn: '0305-7453', publisher: 'Oxford University Press', scope: ['infectious', 'pharmacology'], keywords: ['antibiotic', 'resistance', 'stewardship'], if: 4.8, cas: '2区', acc: 30, wk: 6, types: CLIN_RW, desc: 'BSAC 抗菌化疗官方刊' },
  { id: 'eid-j', name: 'Emerging Infectious Diseases', publisher: 'CDC', scope: ['infectious', 'public-health'], keywords: ['outbreak', 'emerging', 'infection', 'surveillance'], if: 7.2, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: 'CDC 新发感染刊' },
  { id: 'lancet-hiv', name: 'Lancet HIV', publisher: 'Elsevier', scope: ['infectious'], keywords: ['hiv', 'antiretroviral', 'aids'], if: 12.8, cas: '1区', acc: 15, wk: 8, types: CLIN, desc: 'Lancet HIV 子刊' },

  /* ── 血液 ─────────────────────────────────────────────────── */
  { id: 'blood-j', name: 'Blood', issn: '0006-4971', publisher: 'American Society of Hematology', scope: ['hematology'], keywords: ['leukemia', 'lymphoma', 'anemia', 'thrombosis', 'myeloma'], if: 21.0, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: '血液旗舰刊(ASH)' },
  { id: 'lancet-hae', name: 'Lancet Haematology', publisher: 'Elsevier', scope: ['hematology'], keywords: ['leukemia', 'lymphoma', 'anemia', 'thrombosis'], if: 11.4, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'Lancet 血液子刊' },
  { id: 'am-j-hematol', name: 'American Journal of Hematology', publisher: 'Wiley', scope: ['hematology'], keywords: ['leukemia', 'anemia', 'myeloma', 'clinical'], if: 10.2, cas: '1区Top', acc: 22, wk: 8, types: CLIN, desc: '血液临床综合刊' },
  { id: 'leukemia-j', name: 'Leukemia', issn: '0887-6924', publisher: 'Springer Nature', scope: ['hematology', 'translational'], keywords: ['leukemia', 'aml', 'cml', 'car-t'], if: 11.4, cas: '1区Top', acc: 20, wk: 10, types: ['translational', 'cohort'], desc: '白血病转化研究旗舰' },
  { id: 'haematologica', name: 'Haematologica', issn: '0390-6078', publisher: 'Ferrata Storti Foundation', scope: ['hematology'], keywords: ['leukemia', 'lymphoma', 'anemia', 'thrombosis'], if: 8.1, cas: '1区', acc: 25, wk: 8, types: CLIN_RW, desc: '欧洲血液学官方刊' },
  { id: 'blood-adv', name: 'Blood Advances', publisher: 'American Society of Hematology', scope: ['hematology'], keywords: ['leukemia', 'anemia', 'thrombosis', 'clinical'], if: 7.4, cas: '2区', acc: 28, wk: 6, oa: true, apc: 3000, types: CLIN_RW, desc: 'ASH 开放获取子刊' },
  { id: 'bjh', name: 'British Journal of Haematology', publisher: 'Wiley', scope: ['hematology'], keywords: ['leukemia', 'lymphoma', 'anemia', 'clinical'], if: 5.8, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: '英国血液学会官方刊' },
  { id: 'thromb-haemost', name: 'Thrombosis and Haemostasis', publisher: 'Thieme', scope: ['hematology'], keywords: ['thrombosis', 'coagulation', 'anticoagulation'], if: 5.0, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: '血栓与止血专科刊' },

  /* ── 外科/麻醉/重症 ───────────────────────────────────────── */
  { id: 'ann-surg', name: 'Annals of Surgery', issn: '0003-4932', publisher: 'Wolters Kluwer', scope: ['surgery'], keywords: ['surgical', 'resection', 'outcome', 'operative'], if: 10.1, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: '外科旗舰刊' },
  { id: 'jama-surg', name: 'JAMA Surgery', publisher: 'American Medical Association', scope: ['surgery'], keywords: ['surgical', 'outcome', 'cohort'], if: 16.8, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'JAMA 外科子刊' },
  { id: 'bjs', name: 'British Journal of Surgery', issn: '0007-1323', publisher: 'Oxford University Press', scope: ['surgery'], keywords: ['surgical', 'operative', 'outcome'], if: 6.8, cas: '2区', acc: 20, wk: 8, types: CLIN, desc: '欧洲外科旗舰' },
  { id: 'int-j-surg', name: 'International Journal of Surgery', publisher: 'Wolters Kluwer', scope: ['surgery'], keywords: ['surgical', 'operative', 'meta'], if: 12.5, cas: '2区', acc: 30, wk: 5, oa: true, apc: 3000, types: ['meta', 'cohort', 'case_report'], desc: '外科 OA 综合刊,接受 Meta' },
  { id: 'ann-thorac-surg', name: 'Annals of Thoracic Surgery', publisher: 'Elsevier', scope: ['surgery'], keywords: ['thoracic', 'cardiac surgery', 'lung resection'], if: 4.0, cas: '2区', acc: 30, wk: 6, types: RW_CASE, desc: '胸外科专科刊' },
  { id: 'jtcs', name: 'Journal of Thoracic and Cardiovascular Surgery', publisher: 'Elsevier', scope: ['surgery', 'cardiology'], keywords: ['cardiac surgery', 'thoracic', 'valve', 'cabg'], if: 5.0, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: 'AATS 官方刊' },
  { id: 'anesthesiology-j', name: 'Anesthesiology', issn: '0003-3022', publisher: 'Wolters Kluwer', scope: ['anesthesia'], keywords: ['anesthesia', 'analgesia', 'perioperative'], if: 7.5, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'ASA 旗舰刊' },
  { id: 'bja-j', name: 'British Journal of Anaesthesia', issn: '0007-0912', publisher: 'Oxford University Press', scope: ['anesthesia'], keywords: ['anaesthesia', 'perioperative', 'analgesia'], if: 11.1, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: 'RCoA 旗舰刊' },
  { id: 'anaesthesia-j', name: 'Anaesthesia', publisher: 'Wiley', scope: ['anesthesia'], keywords: ['anaesthesia', 'perioperative', 'airway'], if: 8.9, cas: '1区', acc: 22, wk: 8, types: CLIN, desc: 'AAGBI 官方刊' },
  { id: 'ccm-j', name: 'Critical Care Medicine', issn: '0090-3493', publisher: 'Wolters Kluwer', scope: ['critical-care'], keywords: ['sepsis', 'icu', 'ventilation', 'ards'], if: 8.8, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'SCCM 旗舰刊' },
  { id: 'icm-j', name: 'Intensive Care Medicine', issn: '0342-4642', publisher: 'Springer Nature', scope: ['critical-care'], keywords: ['sepsis', 'icu', 'ventilation', 'ards'], if: 38.1, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'ESICM 旗舰刊' },
  { id: 'critical-care', name: 'Critical Care', issn: '1364-8535', publisher: 'Springer Nature', scope: ['critical-care'], keywords: ['sepsis', 'icu', 'ventilation'], if: 15.0, cas: '1区Top', acc: 25, wk: 6, oa: true, apc: 2990, types: CLIN_RW, desc: '重症 OA 旗舰刊' },

  /* ── 妇产 ─────────────────────────────────────────────────── */
  { id: 'obstet-gynecol', name: 'Obstetrics & Gynecology', issn: '0029-7844', publisher: 'Wolters Kluwer', scope: ['obgyn'], keywords: ['pregnancy', 'prenatal', 'delivery', 'cesarean'], if: 7.0, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'ACOG 绿皮旗舰刊' },
  { id: 'ajog', name: 'American Journal of Obstetrics and Gynecology', issn: '0002-9378', publisher: 'Elsevier', scope: ['obgyn'], keywords: ['pregnancy', 'prenatal', 'gynecologic', 'fetal'], if: 8.0, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: '妇产旗舰刊' },
  { id: 'bjog', name: 'BJOG: An International Journal of Obstetrics & Gynaecology', publisher: 'Wiley', scope: ['obgyn'], keywords: ['pregnancy', 'gynecologic', 'delivery'], if: 6.5, cas: '2区', acc: 22, wk: 8, types: CLIN, desc: 'RCOG 官方刊' },
  { id: 'hum-reprod', name: 'Human Reproduction', issn: '0268-1161', publisher: 'Oxford University Press', scope: ['obgyn', 'endocrine'], keywords: ['ivf', 'infertility', 'ovarian', 'embryo'], if: 8.7, cas: '1区Top', acc: 20, wk: 8, types: CLIN, desc: 'ESHRE 旗舰刊' },
  { id: 'fert-steril', name: 'Fertility and Sterility', issn: '0015-0282', publisher: 'Elsevier', scope: ['obgyn', 'endocrine'], keywords: ['ivf', 'infertility', 'ovarian', 'endometriosis'], if: 6.5, cas: '2区', acc: 22, wk: 8, types: CLIN_RW, desc: 'ASRM 官方刊' },
  { id: 'uog', name: 'Ultrasound in Obstetrics & Gynecology', issn: '0960-7692', publisher: 'Wiley', scope: ['obgyn', 'radiology'], keywords: ['ultrasound', 'fetal', 'prenatal'], if: 7.1, cas: '1区', acc: 22, wk: 8, types: ['cohort', 'review'], desc: 'ISUOG 官方刊' },

  /* ── 儿科/老年 ─────────────────────────────────────────────── */
  { id: 'pediatrics', name: 'Pediatrics', issn: '0031-4005', publisher: 'American Academy of Pediatrics', scope: ['pediatrics'], keywords: ['children', 'infant', 'adolescent', 'newborn'], if: 6.2, cas: '1区', acc: 22, wk: 8, types: CLIN, desc: 'AAP 官方旗舰刊' },
  { id: 'jama-pediatr', name: 'JAMA Pediatrics', publisher: 'American Medical Association', scope: ['pediatrics'], keywords: ['children', 'infant', 'cohort'], if: 26.1, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'JAMA 儿科子刊' },
  { id: 'arch-dis-child', name: 'Archives of Disease in Childhood', publisher: 'BMJ Group', scope: ['pediatrics'], keywords: ['children', 'infant', 'clinical'], if: 5.2, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'RCPCH 官方刊' },
  { id: 'j-pediatr', name: 'The Journal of Pediatrics', publisher: 'Elsevier', scope: ['pediatrics'], keywords: ['children', 'clinical', 'infant'], if: 4.3, cas: '2区', acc: 28, wk: 6, types: CLIN_RW, desc: '儿科综合临床刊' },
  { id: 'eur-j-pediatr', name: 'European Journal of Pediatrics', publisher: 'Springer Nature', scope: ['pediatrics'], keywords: ['children', 'clinical'], if: 3.0, cas: '3区', acc: 32, wk: 6, types: RW_CASE, desc: '欧洲儿科综合刊,接受率较高' },
  { id: 'age-ageing', name: 'Age and Ageing', issn: '0002-0729', publisher: 'Oxford University Press', scope: ['geriatrics'], keywords: ['elderly', 'geriatric', 'frailty', 'dementia'], if: 10.0, cas: '1区Top', acc: 18, wk: 8, types: CLIN, desc: 'BGS 官方刊,老年医学旗舰' },
  { id: 'jags', name: 'Journal of the American Geriatrics Society', issn: '0002-8614', publisher: 'Wiley', scope: ['geriatrics'], keywords: ['elderly', 'geriatric', 'falls', 'dementia'], if: 5.4, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'AGS 官方刊' },

  /* ── 影像 ─────────────────────────────────────────────────── */
  { id: 'radiology', name: 'Radiology', issn: '0033-8419', publisher: 'Radiological Society of North America', scope: ['radiology'], keywords: ['imaging', 'ct', 'mri', 'ultrasound', 'radiomics'], if: 12.1, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'RSNA 旗舰刊' },
  { id: 'radiographics', name: 'RadioGraphics', publisher: 'Radiological Society of North America', scope: ['radiology'], keywords: ['imaging', 'review', 'ct', 'mri'], if: 8.8, cas: '1区', acc: 20, wk: 8, types: ['review'], desc: 'RSNA 教育综述刊' },
  { id: 'eur-radiol', name: 'European Radiology', publisher: 'Springer Nature', scope: ['radiology'], keywords: ['imaging', 'ct', 'mri'], if: 6.6, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'ESR 官方刊' },
  { id: 'invest-radiol', name: 'Investigative Radiology', publisher: 'Wolters Kluwer', scope: ['radiology'], keywords: ['imaging', 'mri', 'contrast'], if: 9.8, cas: '1区', acc: 20, wk: 8, types: ['translational', 'cohort'], desc: '影像研究前沿' },
  { id: 'jnm', name: 'Journal of Nuclear Medicine', issn: '0161-5505', publisher: 'Society of Nuclear Medicine and Molecular Imaging', scope: ['radiology'], keywords: ['pet', 'spect', 'nuclear'], if: 8.1, cas: '1区', acc: 22, wk: 8, types: CLIN, desc: 'SNMMI 官方刊' },
  { id: 'ejnmmi', name: 'European Journal of Nuclear Medicine and Molecular Imaging', publisher: 'Springer Nature', scope: ['radiology'], keywords: ['pet', 'nuclear', 'molecular imaging'], if: 8.6, cas: '1区', acc: 22, wk: 8, types: CLIN, desc: 'EANM 官方刊' },
  { id: 'insights-imaging', name: 'Insights into Imaging', publisher: 'Springer Nature', scope: ['radiology'], keywords: ['imaging', 'review'], if: 5.3, cas: '2区', acc: 30, wk: 6, oa: true, apc: 2190, types: ['review', 'case_report'], desc: '影像综述 OA 刊' },
  { id: 'eur-j-radiol', name: 'European Journal of Radiology', publisher: 'Elsevier', scope: ['radiology'], keywords: ['imaging', 'ct', 'mri'], if: 3.0, cas: '3区', acc: 32, wk: 6, types: RW_CASE, desc: '欧洲影像综合刊,接受率较高' },

  /* ── 检验/病理 ────────────────────────────────────────────── */
  { id: 'clin-chem', name: 'Clinical Chemistry', issn: '0009-9147', publisher: 'Oxford University Press', scope: ['laboratory'], keywords: ['biomarker', 'assay', 'laboratory', 'immunoassay'], if: 9.3, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'ADLM(原 AACC)旗舰刊' },
  { id: 'cclm', name: 'Clinical Chemistry and Laboratory Medicine', publisher: 'De Gruyter', scope: ['laboratory'], keywords: ['laboratory', 'biomarker', 'assay'], if: 5.9, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'EFLM 官方刊' },
  { id: 'mod-pathol', name: 'Modern Pathology', publisher: 'Springer Nature', scope: ['pathology'], keywords: ['pathology', 'histology', 'biomarker'], if: 7.5, cas: '2区', acc: 25, wk: 8, types: ['translational', 'case_report'], desc: 'USCAP 官方刊' },
  { id: 'histopathology', name: 'Histopathology', publisher: 'Wiley', scope: ['pathology'], keywords: ['pathology', 'histology'], if: 6.0, cas: '2区', acc: 25, wk: 8, types: ['case_report', 'cohort'], desc: '欧洲病理旗舰' },
  { id: 'arch-pathol-lab-med', name: 'Archives of Pathology & Laboratory Medicine', publisher: 'College of American Pathologists', scope: ['pathology', 'laboratory'], keywords: ['pathology', 'laboratory'], if: 5.5, cas: '2区', acc: 25, wk: 8, types: ['case_report', 'review'], desc: 'CAP 官方刊' },
  { id: 'am-j-clin-pathol', name: 'American Journal of Clinical Pathology', publisher: 'Oxford University Press', scope: ['pathology', 'laboratory'], keywords: ['pathology', 'laboratory'], if: 3.0, cas: '3区', acc: 30, wk: 6, types: ['case_report', 'cohort'], desc: 'ASCP 官方刊' },
  { id: 'j-clin-lab-anal', name: 'Journal of Clinical Laboratory Analysis', publisher: 'Wiley', scope: ['laboratory'], keywords: ['laboratory', 'biomarker'], if: 3.0, cas: '3区', acc: 32, wk: 6, oa: true, apc: 2500, types: RW_CASE, desc: '检验分析 OA 刊,接受率较高' },

  /* ── 公卫/流行病/方法学 ───────────────────────────────────── */
  { id: 'lancet-pubhealth', name: 'The Lancet Public Health', publisher: 'Elsevier', scope: ['public-health'], keywords: ['public health', 'surveillance', 'epidemic'], if: 25.4, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'Lancet 公卫子刊' },
  { id: 'int-j-epidemiol', name: 'International Journal of Epidemiology', publisher: 'Oxford University Press', scope: ['epidemiology'], keywords: ['cohort', 'risk', 'epidemiology'], if: 7.7, cas: '1区Top', acc: 20, wk: 8, types: ['cohort', 'meta'], desc: 'IEA 官方流行病学刊' },
  { id: 'am-j-epidemiol', name: 'American Journal of Epidemiology', publisher: 'Oxford University Press', scope: ['epidemiology'], keywords: ['cohort', 'risk', 'epidemiology'], if: 5.0, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: '流行病学经典刊' },
  { id: 'ajph', name: 'American Journal of Public Health', publisher: 'American Public Health Association', scope: ['public-health'], keywords: ['public health', 'policy', 'surveillance'], if: 7.9, cas: '2区', acc: 22, wk: 8, types: ['cohort', 'review'], desc: 'APHA 官方刊' },
  { id: 'bull-who', name: 'Bulletin of the World Health Organization', publisher: 'WHO', scope: ['public-health'], keywords: ['public health', 'global', 'policy'], if: 8.4, cas: '2区', acc: 22, wk: 8, types: ['cohort', 'review'], desc: 'WHO 官方刊' },
  { id: 'jech', name: 'Journal of Epidemiology and Community Health', publisher: 'BMJ Group', scope: ['public-health', 'epidemiology'], keywords: ['epidemiology', 'public health', 'cohort'], if: 5.9, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: '公卫/流行病学综合刊' },
  { id: 'bmc-public-health', name: 'BMC Public Health', publisher: 'Springer Nature', scope: ['public-health'], keywords: ['public health', 'survey', 'cross-sectional'], if: 3.5, cas: '3区', acc: 35, wk: 6, oa: true, apc: 2790, types: RW_CASE, desc: '公卫 OA 综合刊,审稿快' },
  { id: 'j-clin-epidemiol', name: 'Journal of Clinical Epidemiology', publisher: 'Elsevier', scope: ['epidemiology', 'general-medicine'], keywords: ['methodology', 'meta', 'cohort', 'bias'], if: 7.9, cas: '2区', acc: 22, wk: 8, types: ['meta', 'review', 'cohort'], desc: '临床流行病学方法学旗舰' },
  { id: 'systematic-reviews', name: 'Systematic Reviews', publisher: 'Springer Nature', scope: ['epidemiology'], keywords: ['systematic review', 'meta', 'protocol'], if: 4.7, cas: '2区', acc: 40, wk: 5, oa: true, apc: 1890, types: ['meta', 'review'], desc: '系统综述 OA 专刊,接受率高' },
  { id: 'trials', name: 'Trials', publisher: 'Springer Nature', scope: ['epidemiology'], keywords: ['trial', 'protocol', 'randomized'], if: 2.3, cas: '3区', acc: 42, wk: 5, oa: true, apc: 1890, types: ['rct', 'meta'], desc: '试验方案/结果 OA 专刊' },
  { id: 'bmc-med-res-methodol', name: 'BMC Medical Research Methodology', publisher: 'Springer Nature', scope: ['epidemiology'], keywords: ['methodology', 'statistics', 'study design'], if: 3.9, cas: '3区', acc: 38, wk: 6, oa: true, apc: 2790, types: ['review', 'cohort'], desc: '研究方法学 OA 刊' },

  /* ── 护理 ─────────────────────────────────────────────────── */
  { id: 'int-j-nurs-stud', name: 'International Journal of Nursing Studies', publisher: 'Elsevier', scope: ['nursing'], keywords: ['nursing', 'patient', 'care'], if: 8.1, cas: '1区', acc: 20, wk: 8, types: CLIN_RW, desc: '护理旗舰刊' },
  { id: 'j-adv-nurs', name: 'Journal of Advanced Nursing', publisher: 'Wiley', scope: ['nursing'], keywords: ['nursing', 'care', 'patient'], if: 3.8, cas: '2区', acc: 28, wk: 8, types: CLIN_RW, desc: '护理综合刊' },
  { id: 'nurse-educ-today', name: 'Nurse Education Today', publisher: 'Elsevier', scope: ['nursing'], keywords: ['nursing', 'education'], if: 4.0, cas: '2区', acc: 30, wk: 6, types: RW_CASE, desc: '护理教育刊' },

  /* ── 药理 ─────────────────────────────────────────────────── */
  { id: 'bjcp', name: 'British Journal of Clinical Pharmacology', publisher: 'Wiley', scope: ['pharmacology'], keywords: ['pharmacology', 'drug', 'therapy'], if: 4.8, cas: '2区', acc: 28, wk: 6, types: CLIN_RW, desc: 'BPS 官方刊' },
  { id: 'cpt', name: 'Clinical Pharmacology & Therapeutics', publisher: 'Wiley', scope: ['pharmacology'], keywords: ['pharmacology', 'drug', 'pharmacokinetics'], if: 5.6, cas: '1区', acc: 22, wk: 8, types: ['translational', 'rct'], desc: 'ASCPT 官方刊' },
  { id: 'pharm-res', name: 'Pharmacological Research', publisher: 'Elsevier', scope: ['pharmacology', 'translational'], keywords: ['pharmacology', 'mechanism', 'drug'], if: 9.1, cas: '1区', acc: 25, wk: 6, types: ['translational', 'review'], desc: '药理机制研究' },

  /* ── 全科/其他专科 ────────────────────────────────────────── */
  { id: 'ann-fam-med', name: 'Annals of Family Medicine', publisher: 'American Academy of Family Physicians', scope: ['primary-care'], keywords: ['primary care', 'family', 'practice'], if: 5.4, cas: '2区', acc: 22, wk: 8, types: CLIN_RW, desc: '家庭医学旗舰刊' },
  { id: 'bjgp', name: 'British Journal of General Practice', publisher: 'Royal College of General Practitioners', scope: ['primary-care'], keywords: ['primary care', 'general practice', 'family'], if: 4.9, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: 'RCGP 官方刊' },
  { id: 'jgim', name: 'Journal of General Internal Medicine', publisher: 'Springer Nature', scope: ['primary-care', 'general-medicine'], keywords: ['internal', 'primary care', 'practice'], if: 4.6, cas: '2区', acc: 28, wk: 6, types: CLIN_RW, desc: 'SGIM 官方刊' },
  { id: 'bmj-qual-saf', name: 'BMJ Quality & Safety', publisher: 'BMJ Group', scope: ['public-health', 'primary-care'], keywords: ['quality', 'safety', 'improvement'], if: 6.9, cas: '2区', acc: 25, wk: 8, types: ['cohort', 'review'], desc: '医疗质量与安全旗舰' },
  { id: 'bjd', name: 'British Journal of Dermatology', publisher: 'Oxford University Press', scope: ['dermatology'], keywords: ['dermatology', 'psoriasis', 'eczema', 'skin'], if: 11.0, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'BAD 官方旗舰刊' },
  { id: 'jama-derm', name: 'JAMA Dermatology', publisher: 'American Medical Association', scope: ['dermatology'], keywords: ['dermatology', 'skin'], if: 11.5, cas: '1区', acc: 18, wk: 8, types: CLIN, desc: 'JAMA 皮肤子刊' },
  { id: 'ophthalmology-j', name: 'Ophthalmology', publisher: 'Elsevier', scope: ['ophthalmology'], keywords: ['eye', 'retina', 'glaucoma', 'cataract'], if: 9.1, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'AAO 官方旗舰刊' },
  { id: 'jama-ophthalmol', name: 'JAMA Ophthalmology', publisher: 'American Medical Association', scope: ['ophthalmology'], keywords: ['eye', 'retina', 'vision'], if: 8.1, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'JAMA 眼科子刊' },
  { id: 'eur-urology', name: 'European Urology', publisher: 'Elsevier', scope: ['urology'], keywords: ['prostate', 'bladder', 'kidney', 'urology'], if: 18.4, cas: '1区Top', acc: 12, wk: 8, types: CLIN, desc: 'EAU 旗舰刊' },
  { id: 'j-urology', name: 'The Journal of Urology', publisher: 'Elsevier', scope: ['urology'], keywords: ['prostate', 'bladder', 'urology'], if: 3.9, cas: '2区', acc: 28, wk: 6, types: CLIN_RW, desc: 'AUA 官方刊' },
  { id: 'jbjs', name: 'Journal of Bone and Joint Surgery', publisher: 'Wolters Kluwer', scope: ['orthopedics'], keywords: ['orthopaedic', 'fracture', 'arthroplasty', 'joint'], if: 4.7, cas: '2区', acc: 25, wk: 8, types: CLIN_RW, desc: '骨科旗舰刊' },
  { id: 'ard', name: 'Annals of the Rheumatic Diseases', publisher: 'BMJ Group', scope: ['rheumatology'], keywords: ['rheumatoid', 'lupus', 'arthritis', 'autoimmune'], if: 20.3, cas: '1区Top', acc: 15, wk: 8, types: CLIN, desc: 'EULAR 旗舰刊' },
  { id: 'jaci', name: 'Journal of Allergy and Clinical Immunology', publisher: 'Elsevier', scope: ['immunology'], keywords: ['allergy', 'asthma', 'immunology', 'igE'], if: 12.2, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'AAAAI 旗舰刊' },
  { id: 'ajt', name: 'American Journal of Transplantation', publisher: 'Wiley', scope: ['transplant'], keywords: ['transplant', 'graft', 'rejection', 'donor'], if: 8.0, cas: '1区', acc: 20, wk: 8, types: CLIN, desc: 'AST 官方刊' },
  { id: 'ajcn', name: 'American Journal of Clinical Nutrition', publisher: 'Oxford University Press', scope: ['nutrition'], keywords: ['nutrition', 'diet', 'obesity', 'micronutrient'], if: 7.1, cas: '1区', acc: 22, wk: 8, types: ['rct', 'cohort', 'meta'], desc: 'ASN 营养旗舰刊' },
  { id: 'pain-j', name: 'Pain', publisher: 'Wolters Kluwer', scope: ['neurology'], keywords: ['pain', 'analgesia', 'chronic pain', 'opioid'], if: 6.0, cas: '2区', acc: 25, wk: 8, types: CLIN, desc: 'IASP 疼痛官方刊' },

  /* ── 中文核心刊目录(Tier J4 目录版,不含指标)────────────────── */
  { id: 'zh-zonghe', name: '中华医学杂志', zh: '中华医学杂志', publisher: '中华医学会', scope: ['general-medicine', 'chinese'], keywords: ['临床', '中华'], desc: '中华医学会会刊(目录版)' },
  { id: 'zh-neike', name: '中华内科杂志', zh: '中华内科杂志', publisher: '中华医学会', scope: ['general-medicine', 'chinese'], desc: '内科旗舰(目录版)' },
  { id: 'zh-waike', name: '中华外科杂志', zh: '中华外科杂志', publisher: '中华医学会', scope: ['surgery', 'chinese'], desc: '外科旗舰(目录版)' },
  { id: 'zh-xinxueguan', name: '中华心血管病杂志', zh: '中华心血管病杂志', publisher: '中华医学会', scope: ['cardiology', 'chinese'], desc: '心血管旗舰(目录版)' },
  { id: 'zh-huxi', name: '中华结核和呼吸杂志', zh: '中华结核和呼吸杂志', publisher: '中华医学会', scope: ['respiratory', 'chinese'], desc: '呼吸旗舰(目录版)' },
  { id: 'zh-xiaohua', name: '中华消化杂志', zh: '中华消化杂志', publisher: '中华医学会', scope: ['gastro', 'chinese'], desc: '消化旗舰(目录版)' },
  { id: 'zh-neifenmi', name: '中华内分泌代谢杂志', zh: '中华内分泌代谢杂志', publisher: '中华医学会', scope: ['endocrine', 'chinese'], desc: '内分泌旗舰(目录版)' },
  { id: 'zh-zhongliu', name: '中华肿瘤杂志', zh: '中华肿瘤杂志', publisher: '中华医学会', scope: ['oncology', 'chinese'], desc: '肿瘤旗舰(目录版)' },
  { id: 'zh-fangshexue', name: '中华放射学杂志', zh: '中华放射学杂志', publisher: '中华医学会', scope: ['radiology', 'chinese'], desc: '影像旗舰(目录版)' },
  { id: 'zh-jianyan', name: '中华检验医学杂志', zh: '中华检验医学杂志', publisher: '中华医学会', scope: ['laboratory', 'chinese'], desc: '检验旗舰(目录版)' },
  { id: 'zh-huli', name: '中华护理杂志', zh: '中华护理杂志', publisher: '中华护理学会', scope: ['nursing', 'chinese'], desc: '护理旗舰(目录版)' },
  { id: 'zh-erke', name: '中华儿科杂志', zh: '中华儿科杂志', publisher: '中华医学会', scope: ['pediatrics', 'chinese'], desc: '儿科旗舰(目录版)' },
  { id: 'zh-shenjing', name: '中华神经科杂志', zh: '中华神经科杂志', publisher: '中华医学会', scope: ['neurology', 'chinese'], desc: '神经旗舰(目录版)' },
  { id: 'zh-jingshen', name: '中华精神科杂志', zh: '中华精神科杂志', publisher: '中华医学会', scope: ['psychiatry', 'chinese'], desc: '精神旗舰(目录版)' },
  { id: 'zh-quanke', name: '中华全科医师杂志', zh: '中华全科医师杂志', publisher: '中华医学会', scope: ['primary-care', 'chinese'], desc: '全科(目录版)' },
  { id: 'zh-tangniaobing', name: '中华糖尿病杂志', zh: '中华糖尿病杂志', publisher: '中华医学会', scope: ['endocrine', 'chinese'], desc: '糖尿病(目录版)' },
  { id: 'zh-shenzang', name: '中华肾脏病杂志', zh: '中华肾脏病杂志', publisher: '中华医学会', scope: ['nephrology', 'chinese'], desc: '肾内(目录版)' },
  { id: 'zh-xueye', name: '中华血液学杂志', zh: '中华血液学杂志', publisher: '中华医学会', scope: ['hematology', 'chinese'], desc: '血液(目录版)' },
  { id: 'zh-chuanran', name: '中华传染病杂志', zh: '中华传染病杂志', publisher: '中华医学会', scope: ['infectious', 'chinese'], desc: '感染(目录版)' },
  { id: 'zh-mazui', name: '中华麻醉学杂志', zh: '中华麻醉学杂志', publisher: '中华医学会', scope: ['anesthesia', 'chinese'], desc: '麻醉(目录版)' },
  { id: 'zh-bingli', name: '中华病理学杂志', zh: '中华病理学杂志', publisher: '中华医学会', scope: ['pathology', 'chinese'], desc: '病理(目录版)' },
  { id: 'zh-chaosheng', name: '中华超声影像学杂志', zh: '中华超声影像学杂志', publisher: '中华医学会', scope: ['radiology', 'chinese'], desc: '超声(目录版)' },
  { id: 'zh-hexiyixue', name: '中华核医学与分子影像杂志', zh: '中华核医学与分子影像杂志', publisher: '中华医学会', scope: ['radiology', 'chinese'], desc: '核医学(目录版)' },
  { id: 'zh-yufang', name: '中华预防医学杂志', zh: '中华预防医学杂志', publisher: '中华医学会', scope: ['public-health', 'chinese'], desc: '公卫(目录版)' },
  { id: 'zh-liuxingbing', name: '中华流行病学杂志', zh: '中华流行病学杂志', publisher: '中华医学会', scope: ['epidemiology', 'chinese'], desc: '流行病学(目录版)' },
  { id: 'zh-ganzang', name: '中华肝脏病杂志', zh: '中华肝脏病杂志', publisher: '中华医学会', scope: ['hepatology', 'chinese'], desc: '肝病(目录版)' },
  { id: 'zh-jizhen', name: '中华急诊医学杂志', zh: '中华急诊医学杂志', publisher: '中华医学会', scope: ['critical-care', 'chinese'], desc: '急诊/重症(目录版)' },
  { id: 'zh-feiai', name: '中国肺癌杂志', zh: '中国肺癌杂志', publisher: '中国抗癌协会', scope: ['oncology', 'respiratory', 'chinese'], desc: '肺癌专科(目录版)' },
  { id: 'zh-aizheng', name: '癌症(Chinese Journal of Cancer)', zh: '癌症', publisher: '中山大学肿瘤防治中心', scope: ['oncology', 'chinese'], desc: '肿瘤综合(目录版)' },
  { id: 'zh-zhongliu-linchuang', name: '中国肿瘤临床', zh: '中国肿瘤临床', publisher: '中国抗癌协会', scope: ['oncology', 'chinese'], desc: '肿瘤临床(目录版)' },
  { id: 'zh-quanke-yixue', name: '中国全科医学', zh: '中国全科医学', publisher: '中国全科医学杂志社', scope: ['primary-care', 'chinese'], desc: '全科(目录版)' },
]
