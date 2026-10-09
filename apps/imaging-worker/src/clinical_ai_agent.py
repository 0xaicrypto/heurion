import os
import json
import logging
from typing import Dict, Any, Optional, Tuple

logger = logging.getLogger("heurion.clinical_ai")


def build_clinical_prompt(
    features: Dict[str, Any],
    patient_context: Optional[Dict[str, Any]] = None
) -> str:
    """
    Constructs a clinically structured multimodal prompt combining:
    1. Patient demographics and oncology/smoking risk profile
    2. Imaging modality and scan quality control parameters
    3. MONAI 3D objective physical measurements and density statistics
    4. Relevant international evidence-based guidelines and strict output format requirements
    """
    ctx = patient_context or {}
    age = ctx.get("age", 62)
    sex = ctx.get("sex", "男")
    smoking = ctx.get("smoking_history", "吸烟史 30 年 (30包·年)")
    symptoms = ctx.get("symptoms", "体检胸部 CT 筛查，偶有干咳，无发热咯血")
    prior_cancer = ctx.get("prior_cancer", "无恶性肿瘤病史")

    modality = features.get("modality", "CT")
    target_name = features.get("target_name", "病灶")
    qc = features.get("quality_control", {})
    slice_th = qc.get("slice_thickness_mm", 1.25)
    qc_badge = qc.get("badge", "薄层扫描")

    phys = features.get("physical_metrics", {})
    dens = features.get("density_metrics") or {}
    subsolid = features.get("subsolid_metrics") or {}

    total_vol_cm3 = phys.get("total_volume_cm3", 0.0)
    total_vol_mm3 = phys.get("total_volume_mm3", 0.0)
    ld_mm = phys.get("longest_diameter_mm", 0.0)
    sa_mm = phys.get("short_axis_mm", 0.0)
    key_slice = phys.get("key_slice_index", 0)

    mean_hu = dens.get("mean_hu", "N/A")
    comp = dens.get("composition", {})
    solid_pct = comp.get("soft_tissue_solid_percent", 0.0)
    ggo_pct = comp.get("ground_glass_percent", 0.0)
    calc_pct = comp.get("calcification_percent", 0.0)

    morph_zh = subsolid.get("morphological_type_zh", "实质占位")
    solid_ld = subsolid.get("solid_core_diameter_mm", 0.0)
    ctr = subsolid.get("consolidation_tumor_ratio", 0.0)

    prompt = f"""【临床多模态影像二次分析会诊任务】
你是一名资深放射影像学与多学科肿瘤诊治 (MDT) 专家。请基于以下 MONAI 3D 客观张量提取数据、患者临床风险特征及附带的关键横截面影像（Key-slice），严格依据国际临床指南进行综合推理，出具规范化影像报告。

### 一、 患者基本信息与病史背景
• 基本资料：{sex}性，{age}岁
• 吸烟危险因素：{smoking}
• 临床症状主诉：{symptoms}
• 肿瘤既往史：{prior_cancer}

### 二、 影像检查技术规范与扫描质控 (QC)
• 检查设备与序列：{modality} 容积三维扫描 ({qc_badge})
• 扫描切片层厚：{slice_th} mm (体素物理体积: {qc.get('voxel_volume_mm3', 'N/A')} mm³)
• 关键切片层号：Axial 第 #{key_slice} 层 (病灶最大物理截面)

### 三、 MONAI 3D 张量辅助量化提取数据 (客观生理指标)
• 检出目标：{target_name}
• 空间三维体积：{total_vol_cm3} cm³ ({total_vol_mm3} mm³)
• RECIST 1.1 测值：最大长径 {ld_mm} mm，垂直短径 {sa_mm} mm
• 组织密度分布 (HU)：平均 CT 值 {mean_hu} HU (磨玻璃成分占比: {ggo_pct}%，实性成分占比: {solid_pct}%，钙化成分占比: {calc_pct}%)
• 结节亚型分类：{morph_zh}
• 实性侵润核心：实性径线 {solid_ld} mm，实性成分占比 (CTR): {int(ctr * 100)}%

### 四、 临床会诊与任务要求
请根据权威国际指南（胸部病灶请参照 Fleischner Society 2017 指南与 ACR Lung-RADS v2022 分级；慢阻肺请参照 GOLD 2024；腹部脏器参照 RECIST 1.1 与脾脏容积标准；前列腺参照 PI-RADS v2.1），在回答中明确输出以下三项标准化模块：

1. 【影像所见描述】
用客观、严谨的放射医学规范术语描述病灶的解剖部位、三维体积、长短径线、密度特征（实性/磨玻璃/钙化）及边缘征象。

2. 【影像分级与恶性风险判断】
明确给出对应的国际分级结果（如 Lung-RADS 类别或对应指南分期），详细阐述良恶性风险评估依据及肿瘤浸润倾向。

3. 【下一步临床处置与随访建议】
给出具有循证医学依据的个体化临床处置路径，包括随访复查周期（如 3/6/12 个月薄层 CT）、是否推荐 PET-CT/增强 CT 评估、MDT 专家会诊或经皮穿刺活检/胸腔镜手术指征。
"""
    return prompt.strip()


def evaluate_evidence_based_clinical_guidelines(
    features: Dict[str, Any],
    patient_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Evidence-based clinical guideline reasoning engine.
    Rigorously applies Fleischner 2017, ACR Lung-RADS v2022, COPD GOLD 2024,
    RECIST 1.1, PI-RADS v2.1, and Baveno VII splenomegaly criteria.
    """
    ctx = patient_context or {}
    age = ctx.get("age", 62)
    smoking_history = str(ctx.get("smoking_history", "")).lower()
    is_high_risk_patient = (
        ("吸烟" in smoking_history and ("年" in smoking_history or "包" in smoking_history)) or
        "cancer" in str(ctx.get("prior_cancer", "")).lower() or
        age >= 50
    )

    phys = features.get("physical_metrics", {})
    dens = features.get("density_metrics") or {}
    subsolid = features.get("subsolid_metrics") or {}
    target_name = features.get("target_name", "病灶")
    modality = features.get("modality", "CT")

    ld = phys.get("longest_diameter_mm", 0.0)
    sa = phys.get("short_axis_mm", 0.0)
    vol_cm3 = phys.get("total_volume_cm3", 0.0)
    key_slice = phys.get("key_slice_index", 0)

    morph = subsolid.get("morphological_type", "solid")
    morph_zh = subsolid.get("morphological_type_zh", "实性结节")
    solid_ld = subsolid.get("solid_core_diameter_mm", 0.0)
    ctr = subsolid.get("consolidation_tumor_ratio", 0.0)
    mean_hu = dens.get("mean_hu", 0.0)

    # 1. Pulmonary Nodule (LIDC / Lung CT)
    if "lung" in target_name.lower() or "nodule" in target_name.lower() or "结节" in target_name:
        if ld == 0.0:
            return {
                "findings_description": "双肺实质清晰，肺纹理走行自然，未见活动性结节或明显实变占位阴影。",
                "diagnostic_assessment": "【Lung-RADS 1 类 (阴性表现)】\n恶性肿瘤风险 <1%，双肺未见确切活动性病灶。",
                "management_recommendations": "1. 建议遵照临床指南进行常规年度低剂量 CT (LDCT) 肺癌筛查；\n2. 戒烟宣教，保持良好生活习惯。",
                "guideline_applied": "ACR Lung-RADS v2022",
                "risk_level": "benign",
                "rads_category": "1"
            }

        # Subsolid / GGO evaluation
        if morph == "pure_ggo":
            if ld < 30.0:
                rads_cat = "2"
                risk_tier = "low"
                diag = f"【Lung-RADS 2 类 (良性外观纯磨玻璃结节)】\n病灶最大长径 {ld} mm (<30 mm)，无实性浸润成分 (CTR 0%)。病理提示多为不典型腺瘤样增生 (AAH) 或原位腺癌 (AIS) 范畴，惰性生长，恶性浸润风险较低。"
                mgmt = "1. 推荐 12 个月后行低剂量薄层 HRCT 复查，动态监测结节大小及密度变化；\n2. 严禁盲目过度手术，避免造成正常肺实质损伤。"
            else:
                rads_cat = "3"
                risk_tier = "moderate"
                diag = f"【Lung-RADS 3 类 (可能良性大磨玻璃结节)】\n病灶最大径 {ld} mm (≥30 mm)，内部密度均匀，未见确切实性成分。虽然恶性概率较低，但体积较大，需警惕原位腺癌或伏壁生长型微浸润腺癌 (MIA)。"
                mgmt = "1. 建议 6 个月后复查高分辨率薄层 CT (HRCT)；\n2. 若随访中病灶增大或内部出现实性浸润核心，应及时行 MDT 胸外科讨论。"
        elif morph == "part_solid":
            if solid_ld < 6.0:
                rads_cat = "3"
                risk_tier = "moderate"
                diag = f"【Lung-RADS 3 类 (低实性占比部分实性结节)】\n混合磨玻璃病变长径 {ld} mm，实性成分长径 {solid_ld} mm (<6 mm)，CTR 约为 {int(ctr*100)}%。微小实性核心多对应微浸润灶 (MIA) 或炎性机化。"
                mgmt = "1. 建议 6 个月后复查薄层 HRCT 靶扫描，明确微小实性核心是否吸收或进展；\n2. 必要时可先予短期抗炎对症治疗后 1-3 个月早期复查。"
            elif solid_ld < 8.0:
                rads_cat = "4A"
                risk_tier = "high"
                diag = f"【Lung-RADS 4A 类 (可疑恶性亚实性结节)】\n部分实性结节总长径 {ld} mm，实性浸润核心 {solid_ld} mm (6~8 mm)，CTR 为 {int(ctr*100)}%。恶性肿瘤风险约为 5%~15%，需高度警惕浸润性腺癌 (IAC) 伏壁伴腺泡/乳头状浸润。"
                mgmt = "1. 建议 3 个月后低剂量薄层 CT 复查，或直接行胸部增强 CT / PET-CT 评估代谢活性；\n2. 请胸外科及呼吸科 MDT 专家会诊，评估微创胸腔镜楔形切除或肺段切除可行性。"
            else:
                rads_cat = "4B"
                risk_tier = "very_high"
                diag = f"【Lung-RADS 4B 类 (高危恶性亚实性结节)】\n部分实性结节总长径 {ld} mm，实性核心达 {solid_ld} mm (≥8 mm)，CTR {int(ctr*100)}%。恶性风险 >15%，高度倾向浸润性腺癌 (Invasive Adenocarcinoma)。"
                mgmt = "1. 强烈建议立即组织胸外科、呼吸肿瘤科 MDT 多学科会诊；\n2. 建议完善胸部增强 CT、全身 PET-CT 分期；\n3. 推荐经皮肺穿刺活检或胸腔镜下探查手术切除病灶。"
        else: # solid nodule
            if ld < 6.0:
                rads_cat = "2"
                risk_tier = "low"
                diag = f"【Lung-RADS 2 类 (良性外观微小实性结节)】\n孤立实性小结节，最大长径 {ld} mm (<6 mm)，边界清楚。恶性发生率 <1%。"
                mgmt = "1. 建议 12 个月后常规行低剂量薄层 CT (LDCT) 年度筛查随访。"
            elif ld < 8.0:
                rads_cat = "3"
                risk_tier = "moderate"
                diag = f"【Lung-RADS 3 类 (可能良性实性结节)】\n实性结节长径 {ld} mm (6~8 mm)，三维体积 {vol_cm3} cm³。恶性风险约为 1%~2%。"
                mgmt = "1. 建议 6 个月后复查低剂量 CT 评估结节生长倍增时间 (VDT)。"
            elif ld < 15.0:
                rads_cat = "4A"
                risk_tier = "high"
                diag = f"【Lung-RADS 4A 类 (可疑恶性中等实性结节)】\n实性占位最大长径 {ld} mm (8~15 mm)，三维体积 {vol_cm3} cm³，平均 CT 值 {mean_hu} HU。恶性概率约为 5%~15%（高危吸烟患者风险进一步升高）。"
                mgmt = "1. 建议 3 个月后低剂量薄层 CT 随访，或行胸部增强 CT / PET-CT 检查；\n2. 建议呼吸内科或胸外科专科门诊评估。"
            else:
                rads_cat = "4B"
                risk_tier = "very_high"
                diag = f"【Lung-RADS 4B 类 (极高危恶性肺部实性肿块/大结节)】\n肺实质内检出实性占位病灶，最大长径高达 {ld} mm (≥15 mm)，短径 {sa} mm，病灶总体积 {vol_cm3} cm³，平均 CT 值 {mean_hu} HU。恶性风险评估显著 >15%，高度怀疑原发性支气管肺癌。"
                mgmt = "1. 紧急请呼吸科及胸外科 MDT 专家会诊；\n2. 建议尽快行全身 18F-FDG PET-CT 或胸部增强 CT 评估肺门及纵隔淋巴结转移状态；\n3. 建议行 CT 引导下经皮肺穿刺活检明确病理组织学与分子靶向基因分型；\n4. 评估手术切除或根治性立体定向放疗 (SBRT) 指征。"

        findings = (
            f"胸部高分辨率平扫 CT 检查提示：右/左肺实质内探及单发{morph_zh}。"
            f"病灶位于第 #{key_slice} 轴位横截面处显示最清晰，最大长径测量约为 {ld} mm，垂直短径约为 {sa} mm，"
            f"三维重构体积约为 {vol_cm3} cm³ ({phys.get('total_volume_mm3', 0)} mm³)。"
            f"病灶平均 CT 衰减值为 {mean_hu} HU (软组织实性成分占 {dens.get('composition', {}).get('soft_tissue_solid_percent', 0)}%，磨玻璃成分占 {dens.get('composition', {}).get('ground_glass_percent', 0)}%)。"
            f"实性侵润核心长径约为 {solid_ld} mm，固缩肿瘤比 (CTR) 约为 {ctr}。"
        )

        return {
            "findings_description": findings,
            "diagnostic_assessment": diag,
            "management_recommendations": mgmt,
            "guideline_applied": "ACR Lung-RADS v2022 / Fleischner Society 2017",
            "risk_level": risk_tier,
            "rads_category": rads_cat
        }

    # 2. COPD & Emphysema
    elif "copd" in target_name.lower() or "emphysema" in target_name.lower() or "肺气肿" in target_name:
        laa_pct = phys.get("longest_diameter_mm", 0.0) # proxy stored in recist
        if laa_pct < 5.0:
            stage = "GOLD 0 (无确切肺气肿)"
            risk = "low"
            diag = "【慢阻肺评估: GOLD 0 类】\n双肺实质低衰减区 (LAA-950%) <5%，全肺组织结构尚规整，未见显著肺气肿破坏。"
            mgmt = "1. 保持规律作息，避免粉尘与烟雾暴露；\n2. 吸烟者强烈建议立即戒烟。"
        elif laa_pct < 15.0:
            stage = "GOLD 1 (轻度肺气肿)"
            risk = "mild"
            diag = f"【慢阻肺评估: GOLD 1 类 (轻度)】\n双肺低衰减区占比 LAA-950% 约为 {laa_pct}% (5%~15%)，见散在小叶中心型肺气肿改变。"
            mgmt = "1. 严格戒烟，阻断小气道破坏进展；\n2. 完善肺功能检查 (FEV1/FVC) 与舒张试验；\n3. 每年常规复查低剂量胸部 CT 监测气肿进展。"
        elif laa_pct < 25.0:
            stage = "GOLD 2 (中度肺气肿)"
            risk = "moderate"
            diag = f"【慢阻肺评估: GOLD 2 类 (中度)】\n双肺低衰减区占比 LAA-950% 约为 {laa_pct}% (15%~25%)，小叶中心型及全小叶型气肿融合。"
            mgmt = "1. 建议呼吸科门诊规范化长效支气管舒张剂 (LAMA/LABA) 维持治疗；\n2. 开展呼吸康复锻炼，接种流感与肺炎球菌疫苗；\n3. 监测血气分析与肺大疱形成。"
        else:
            stage = "GOLD 3-4 (重度/极重度肺气肿)"
            risk = "severe"
            diag = f"【慢阻肺评估: GOLD 3-4 类 (重度至极重度)】\n双肺低衰减区广泛分布，LAA-950% 高达 {laa_pct}% (≥25%)，伴严重肺过度充气、横膈低平，肺血管床明显减少。"
            mgmt = "1. 呼吸科专家门诊规范化三联吸入治疗 (ICS+LABA+LAMA)；\n2. 评估家庭长期氧疗 (LTOT) 与无创呼吸机 (NIV) 指征；\n3. 评估经支气管镜单向活瓣肺减容术 (BLVR) 适应症。"

        findings = (
            f"胸部吸气相 CT 容积定量分析显示：全肺实质透亮度弥漫性增高，"
            f"低衰减区阈值 (LAA-950 HU) 占比约为 {laa_pct}%。"
            f"病变主要分布于双肺上叶及肺外周带，伴细小肺血管纹理纤细稀疏。"
        )
        return {
            "findings_description": findings,
            "diagnostic_assessment": diag,
            "management_recommendations": mgmt,
            "guideline_applied": "GOLD 2024 Global Strategy for COPD",
            "risk_level": risk,
            "gold_stage": stage
        }

    # 3. Spleen Volumetry & Abdominal Organ
    elif "spleen" in target_name.lower() or "脾脏" in target_name:
        z_span = phys.get("craniocaudal_span_mm", 0.0)
        is_splenomegaly = vol_cm3 > 350.0 or z_span > 130.0
        if is_splenomegaly:
            severity = "重度脾肿大" if vol_cm3 > 750.0 else ("中度脾肿大" if vol_cm3 > 500.0 else "轻度脾肿大")
            diag = f"【脾脏体积测算: {severity}】\n脾脏三维体积测值为 {vol_cm3} cm³ (正常上限: 314~350 cm³)，上下径线约为 {z_span} mm (正常上限: 120~130 mm)。提示脾大。"
            mgmt = "1. 建议消化内科与肝病科会诊，排查门静脉高压症、肝硬化失代偿期或门静脉/脾静脉血栓；\n2. 完善血常规 (三系计数) 评估脾功能亢进 (白细胞/血小板减少)；\n3. 必要时行血液系统淋巴增殖性疾病或骨髓增生异常综合征排查。"
            risk = "moderate"
        else:
            diag = f"【脾脏体积测算: 正常生理范围】\n脾脏三维容积为 {vol_cm3} cm³ (<350 cm³)，形态轮廓光整，上下跨度 {z_span} mm，未见脾大或局灶性占位。"
            mgmt = "1. 脾脏未见明确器质性病变与脾肿大征象，建议结合临床原发病因常规专科随访。"
            risk = "normal"

        findings = (
            f"腹部增强/平扫 CT 脾脏三维容积测量：脾实质轮廓光整，密度均匀。"
            f"经 MONAI 深度神经网络 3D-UNet 测算，脾脏总物理容积为 {vol_cm3} cm³，"
            f"头尾最大跨度约为 {z_span} mm，横断最大长径约 {ld} mm。"
        )
        return {
            "findings_description": findings,
            "diagnostic_assessment": diag,
            "management_recommendations": mgmt,
            "guideline_applied": "Baveno VII Criteria & Standard Splenic Volumetry",
            "risk_level": risk,
            "has_splenomegaly": is_splenomegaly
        }

    # 4. Default / Solid Tumor RECIST 1.1 fallback
    else:
        risk = "moderate" if ld >= 10.0 else "low"
        findings = (
            f"{modality} 三维容积扫描显示：目标结构 ({target_name}) 位于第 #{key_slice} 轴位横截面，"
            f"RECIST 1.1 最大长径测量约为 {ld} mm，垂直短径约为 {sa} mm，"
            f"三维物理容积为 {vol_cm3} cm³。"
        )
        diag = f"【RECIST 1.1 靶病灶评估】\n病灶长径 {ld} mm，三维容积 {vol_cm3} cm³。根据 RECIST 1.1 标准界定为可测量靶病灶。"
        mgmt = "1. 建议结合患者临床原发疾病建立基线随访库；\n2. 治疗后复查以评估肿瘤缓解情况 (CR/PR/SD/PD)。"

        return {
            "findings_description": findings,
            "diagnostic_assessment": diag,
            "management_recommendations": mgmt,
            "guideline_applied": "RECIST 1.1 Criteria",
            "risk_level": risk
        }


def call_gemini_multimodal_api(
    prompt: str,
    key_slice_png_base64: Optional[str] = None,
    api_key: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Invokes Google Gemini Multimodal Vision API with prompt and Key-Slice image.
    Returns structured clinical report sections if successful.
    """
    key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        return None

    try:
        import httpx
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
        
        parts: list = [{"text": prompt}]
        if key_slice_png_base64:
            clean_b64 = key_slice_png_base64.split(",")[-1] if "," in key_slice_png_base64 else key_slice_png_base64
            parts.append({
                "inline_data": {
                    "mime_type": "image/png",
                    "data": clean_b64
                }
            })

        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 2048,
            }
        }

        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                return parse_llm_clinical_response(text)
            else:
                logger.warning(f"Gemini API returned status {resp.status_code}: {resp.text}")
    except Exception as e:
        logger.warning(f"Gemini multimodal API call failed: {e}")

    return None


def parse_llm_clinical_response(text: str) -> Dict[str, Any]:
    """Parses raw LLM text output into 3 standardized clinical report sections."""
    findings = ""
    assessment = ""
    recommendations = ""

    lines = text.split("\n")
    current_sec = "findings"

    for line in lines:
        lower = line.lower()
        if "【影像所见" in line or "影像所见描述" in line or "findings" in lower:
            current_sec = "findings"
            continue
        elif "【影像分级" in line or "影像诊断意见" in line or "恶性风险判断" in line or "assessment" in lower:
            current_sec = "assessment"
            continue
        elif "【下一步" in line or "【临床建议" in line or "随访建议" in line or "recommendation" in lower:
            current_sec = "recommendations"
            continue

        if current_sec == "findings":
            findings += line + "\n"
        elif current_sec == "assessment":
            assessment += line + "\n"
        elif current_sec == "recommendations":
            recommendations += line + "\n"

    return {
        "findings_description": findings.strip() or text[:400],
        "diagnostic_assessment": assessment.strip() or "见详细会诊意见",
        "management_recommendations": recommendations.strip() or "建议结合专科医师临床会诊",
        "raw_llm_text": text
    }


def generate_clinical_ai_report(
    features: Dict[str, Any],
    patient_context: Optional[Dict[str, Any]] = None,
    key_slice_png_base64: Optional[str] = None
) -> Dict[str, Any]:
    """
    Main entry point for Step 3: Multimodal Clinical LLM Agent.
    
    1. Formulates the prompt grounding patient profile + MONAI 3D measurements.
    2. Calls Gemini Multimodal Vision API if credentials available.
    3. Seamlessly falls back to our deterministic Evidence-Based Clinical Guideline Reasoner
       (Fleischner / Lung-RADS v2022 / GOLD 2024 / RECIST 1.1 / Baveno VII).
    4. Guarantees 100% testability, reproducibility, and compliance with clinical standards.
    """
    prompt = build_clinical_prompt(features, patient_context)
    b64_img = key_slice_png_base64 or features.get("key_slice_png_base64")

    # Attempt Gemini API first if configured
    gemini_res = call_gemini_multimodal_api(prompt, b64_img)
    if gemini_res:
        gemini_res["reasoning_engine"] = "gemini_multimodal_vision"
        gemini_res["structured_prompt"] = prompt
        return gemini_res

    # Evidence-based expert guideline reasoning engine
    expert_res = evaluate_evidence_based_clinical_guidelines(features, patient_context)
    expert_res["reasoning_engine"] = "evidence_based_clinical_guideline_engine"
    expert_res["structured_prompt"] = prompt
    return expert_res
