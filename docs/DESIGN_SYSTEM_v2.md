# Nexus — Design System v2 (Editorial / HIG)

> 状态：草案 v0.1，待医生审。  
> 触发：#182。基础参考：design-taste-frontend / high-end-visual-design / brandkit skills。  
> 范围：Avalonia 11.3 desktop（macOS 优先），全 surface 应用。

---

## 0. Design Read（先把案子读清楚）

> **Reading this as:** A clinical decision-support workstation for radiologists & hospitalists, with an **Editorial × Apple HIG** language, leaning toward Apple system fonts + bone-paper light surfaces + restrained ink-dark accents + heavy macro-whitespace.

**核心矛盾**：医疗工具要"可信、克制、读得快"，但 v1 的 dark-slate + cyan-accent 让它读起来像 dev tool / dashboard。Editorial × HIG 把它拉回"医生案头的高级临床手册"，既有读医学期刊的安静感，又保留 macOS 系统体验的熟悉度。

---

## 1. Three Dials（设计变量配置）

依据 design-taste-frontend §1：

| Dial | 值 | 含义 |
|---|---|---|
| `DESIGN_VARIANCE` | **4** | 1=对称 / 10=艺术混沌。临床工具偏对称、可预测。 |
| `MOTION_INTENSITY` | **3** | 1=静态 / 10=电影感。微 motion，绝不喧宾夺主。 |
| `VISUAL_DENSITY` | **3** | 1=画廊 / 10=飞行驾驶舱。Editorial 偏 airy，但医生信息密度不能太低，3 是平衡点。 |

这套配置定下了整个系统的"音量"。所有 token + component 决策都从这里推。

---

## 2. Color Tokens（颜色）

放弃 v1 的"冷蓝 dark mode"，换成 **Light-first / paper-tone** 系统。Dark mode v2 作为 follow-up（医生临床偏好 light mode 居多，便于读片之外的文本）。

### Surface Layer Stack

```
Tone:   bone-paper → cool-paper → warm-stone → graphite
Use:    base bg   → card        → raised     → inverse
```

| Token | Hex | 用法 |
|---|---|---|
| `Surface/Paper`     | `#FAF7F2` | 主窗口底色。象牙白带 2° 暖偏移，不刺眼但有质感。 |
| `Surface/Card`      | `#FFFFFF` | 卡片 / sheet。纯白让卡片"浮"在 paper 上。 |
| `Surface/Raised`    | `#F4EFE7` | 输入框 / hover / segmented control 选中。比 Paper 深 2 点。 |
| `Surface/Muted`     | `#EDE6DA` | 二级容器 / divider 区域。 |
| `Surface/Ink`       | `#1A1A1A` | 反相区 / dark CTA / 顶栏选中。**不**用纯黑。 |
| `Border/Hairline`   | `#E5DDD0` | 主分割线。比 macOS 默认 hairline 稍暖。 |
| `Border/Strong`     | `#CFC4B0` | 强分割（很少用）。 |

### Text Layer Stack

| Token | Hex | 用法 |
|---|---|---|
| `Text/Primary`   | `#15130F` | 主文本。墨色但带极淡褐 — 比纯黑柔，readability 高。 |
| `Text/Secondary` | `#5C564B` | 标签 / 描述 / inactive。 |
| `Text/Tertiary`  | `#928975` | 时间戳 / hint / meta。 |
| `Text/OnInk`     | `#FAF7F2` | 反相按钮内的文字。 |

### Accent — **One Accent Per Project**（design-taste-frontend §4.2 强制）

放弃 v1 的 cyan-500。Editorial 临床调性的标准 accent：

- **Primary accent:** `#2F4F47` — "Apothecary Green"，深森林绿带蓝灰。读起来是"医院 visual identity 但不烂大街"。<80% saturation 合规。
- **Accent variants:**
  - `Accent/Hover`:  `#3A5E55` (lift 5°L)
  - `Accent/Press`:  `#243C36`
  - `Accent/Tint`:   `#E3EAE6` (background tint for selected rows / chips)

### Semantic — **小心使用**

| Token | Hex | 用法（只用在 status / warning，不用作主色） |
|---|---|---|
| `Success` | `#3F6F4F` | 完成 / rendered |
| `Warning` | `#A0691B` | 待处理 / prerendering |
| `Error`   | `#9A3232` | 失败 |
| `Info`    | `#3D5A80` | 中性提示 |

⚠️ **PHI-sensitive 区域不用 success/error 色高亮**。患者数据本身是中性的，不该用绿/红色暗示判断。

### Banned in This Project

- ❌ Pure black `#000` 作为文本或边框（用 `#15130F`）
- ❌ Pure white `#FFF` 作为窗口主底色（用 `#FAF7F2`）
- ❌ 任何 cyan / electric blue 作为 primary accent
- ❌ Gradient backgrounds（大色块除外，仅 Login welcome 一次）
- ❌ 红色 alert badges（医生看片够紧张了，不要持续闪烁）

---

## 3. Typography（字体）

依据 design-taste-frontend §4.1 + HIG。**禁用 Inter**（v1 用错了）。

### Font Stack

```
UiFontFamily      = "SF Pro Text, -apple-system, BlinkMacSystemFont,
                     Helvetica Neue, sans-serif"
UiFontDisplay     = "SF Pro Display, -apple-system, BlinkMacSystemFont,
                     Helvetica Neue, sans-serif"
UiFontMono        = "SF Mono, Menlo, Monaco, monospace"
UiFontSerif       = "New York, Georgia, 'Times New Roman', serif"
                    -- 极少用，only patient hash / chart title 偶尔点缀
```

`SF Pro` 在 macOS 系统自带，不用 bundle。HIG 原生用法。

### Scale

苹果 HIG 节奏 + Editorial 稍微放大显示号：

| Token | Size / LineHeight | Weight | 用法 |
|---|---|---|---|
| `Caption`   | 11 / 14 | Regular  | timestamps, footnotes |
| `Small`     | 12 / 16 | Regular  | chips, status pills |
| `Body`      | 13 / 18 | Regular  | 默认正文 |
| `Callout`   | 14 / 20 | Medium   | 行内 emphasis label |
| `Subhead`   | 15 / 22 | Semibold | section titles |
| `Headline`  | 17 / 24 | Semibold | card titles, page heads |
| `Title3`    | 20 / 26 | Semibold | 子页标题 |
| `Title2`    | 24 / 30 | Semibold | 患者名 / 病例名 |
| `Title1`    | 32 / 38 | Bold     | hero 标题（用得很少） |
| `LargeTitle`| 40 / 46 | Bold     | 患者主视图 hero |

### Tracking（字间距）

- Display (Title2+): `tracking-tight` 实际值 `-0.02em`
- Body / Small: `tracking-normal` `0`
- Eyebrow tags (uppercase pills): `tracking-[0.18em]`

### Special — Mono for Identifiers

PHI hash / MRN / file ID 一律走 `UiFontMono`，并降 1 号 + 调淡。让医生大脑识别"这是识别码不是人名"。

---

## 4. Spacing & Radii（间距 + 圆角）

### Spacing — 8pt Grid（HIG 标准）

```
Space/0  = 0
Space/1  = 4
Space/2  = 8
Space/3  = 12
Space/4  = 16   ← default gap
Space/5  = 20
Space/6  = 24
Space/8  = 32
Space/10 = 40
Space/12 = 48
Space/16 = 64   ← section padding
Space/20 = 80
Space/24 = 96   ← hero macro-whitespace
```

**Macro-whitespace mandate**（high-end-visual-design §4C）：
- Section vertical padding: **64px 起步**（不是 16/24）
- 卡片之间留 16-24 px，**不要**用 6/8
- Editorial 关键 — 让医生眼睛有地方"歇"

### Radii — Concentric

```
Radius/Sharp = 0     -- 不用
Radius/Sm    = 6     -- 小 chip / status pill
Radius/Md    = 10    -- 输入框, 按钮
Radius/Lg    = 14    -- 卡片
Radius/Xl    = 20    -- sheet / modal
Radius/Pill  = 999   -- pill button, eyebrow tag
```

**Double-Bezel rule**（high-end-visual-design §4A）：
- 卡片外壳用 Radius/Xl + 1.5 px padding
- 内核用 `Radius/Xl - 1.5 = ~18`（concentric！）
- 不可在外壳 14 内嵌 14 的内核，会"撞角"

---

## 5. Shadows & Borders（深度 + 边界）

不用 `box-shadow` 那种粗笨的 dark drop shadow，用 ambient soft shadow。Avalonia 中通过 BoxShadow 模拟。

| Token | 值 | 用法 |
|---|---|---|
| `Shadow/None`    | — | 默认 |
| `Shadow/Hairline`| `0 1 0 rgba(0,0,0,0.04)` | 卡片底部"贴桌面"感 |
| `Shadow/Card`    | `0 2 8 rgba(20,16,10,0.05)` | 静态卡片 |
| `Shadow/Raised`  | `0 8 24 rgba(20,16,10,0.07)` | hover / sheet |
| `Shadow/Modal`   | `0 24 48 rgba(20,16,10,0.12)` | dialog |

**Hairline border 默认值**: `1px solid #E5DDD0`。绝不用纯灰 `#CCCCCC` 那种 stock 颜色。

---

## 6. Motion（动效）

依据 high-end-visual-design §5，但 dial 3 → 收敛：

### Easings

```
Easing/Standard = cubic-bezier(0.32, 0.72, 0, 1)   -- Apple's default
Easing/Spring   = cubic-bezier(0.34, 1.56, 0.64, 1) -- with overshoot
Easing/SmoothIn = cubic-bezier(0.4, 0, 0.2, 1)     -- material-ish
```

⚠️ **禁用 `linear` / `ease-in-out` / Avalonia default**。

### Durations

| Action | Duration |
|---|---|
| Hover state | 150 ms |
| Button press | 90 ms (down) / 200 ms (up) |
| Tab switch | 280 ms |
| Modal open | 360 ms (Standard) |
| Page transition | 420 ms |
| Toast in/out | 200 / 160 ms |

### Reduced-motion fallback

如果系统设了 prefers-reduced-motion，所有 transform 改成 opacity-only fade，duration 减半。

---

## 7. Component Patterns（关键组件）

### 7.1 Card（卡片）— Double-Bezel

```
Border 外壳:
  background = Surface/Paper (背景同主底，"凹"进感)
  padding = 1.5
  cornerRadius = 14
  border = 1px Border/Hairline

  Border 内核:
    background = Surface/Card (#FFFFFF)
    cornerRadius = 12  (concentric)
    padding = Space/5 = 20
    shadow = Shadow/Card
```

⚠️ **不允许 card-in-card-in-card**（design-taste-frontend §A 禁令）。深度 ≤ 2 层。

### 7.2 Button

**Primary**（一个页面最多一个）：
```
background = Surface/Ink (#1A1A1A)
text = Text/OnInk
padding = 14px 28px
cornerRadius = Radius/Pill
hover:  background = #2A2A2A
press:  scale = 0.98
```

**Secondary (tinted)**:
```
background = Accent/Tint
text = Accent (#2F4F47)
border = none
```

**Ghost**：
```
background = transparent
text = Text/Secondary
hover: background = Surface/Raised
```

**Button-in-Button trailing icon**（high-end-visual-design §4B）：
> Primary CTA with trailing `→` icon nests the arrow in its own small circular wrapper:
```
[ Create case  ( → ) ]   <-- ( ) is its own 24x24 rounded-full inset
```

### 7.3 Eyebrow Tag

每个主 section / card 标题上方一行 microscopic 标签：

```
text = "CHIEF COMPLAINT"
fontSize = 10
weight = Semibold
letterSpacing = 0.18em
textTransform = uppercase
color = Text/Tertiary
```

### 7.4 Input Field

```
background = Surface/Raised
border = 1px Border/Hairline
focus: border = 1.5px Accent, ring = Accent/Tint 4px
padding = 12px 14px
cornerRadius = 10
font = Body
```

### 7.5 Pill / Chip

Status / source / modality badges：

```
fontSize = 10
weight = Medium
letterSpacing = 0.04em
padding = 3px 8px
cornerRadius = Radius/Pill
background = depends on semantic
```

### 7.6 List Row

PatientsView / chat history / etc.：
- 单行高 48px (compact) / 64px (regular) / 80px (rich)
- 选中态：`background = Accent/Tint`，左边 2px Accent bar
- hover: `background = Surface/Raised`
- divider：底部 1px Border/Hairline

---

## 8. Iconography（图标）

`high-end-visual-design §2` 禁用 thick Lucide。Avalonia 没有 Phosphor 库直接可用，所以方案是：

- **首选** SF Symbols（macOS 内置，可通过 Avalonia 图像资源使用）：weight = Light / Regular
- **次选** 内嵌 SVG，stroke-width 强制 1.5，size 16/20/24
- **禁用** emoji 作为功能图标（chat 的 user-typed emoji 例外，但 chrome 里没有）

---

## 9. Layout Patterns（布局原型）

依据 high-end-visual-design §3B + dial values。VARIANCE=4 排除掉 Bento 这种 chaos 布局：

### 9.A The Editorial Two-Pane (推荐 default)
- 左：narrow list / navigator (320 px)
- 右：detail / canvas (flex)
- divider：1px Border/Hairline，**不要** 6px 灰条
- 用例：PatientsView / Files / Workflows

### 9.B The Asymmetric Triptych
- 左：navigator (260)
- 中：main canvas (flex, max-width 880 for editorial readability)
- 右：activity / cognition (320)
- 中间留双边 macro-whitespace
- 用例：ChatView, Patient detail

### 9.C The Sheet (modal)
- center, max-width 560
- shadow = Shadow/Modal
- backdrop = `rgba(20,16,10,0.18)` + blur 8px（如 Avalonia 不支持 blur 退化为不透明）
- 用例：NewPatientDialog

---

## 10. Specific Surface Redesign Briefs

### Patients View（pilot — 先做这个）

Before（现状）:
- 简陋两窗格，左 list 右 detail
- 没有 visual hierarchy
- Source badge 是普通 chip
- 没有 hero / context

After（Editorial × HIG）:
```
┌────────────────────────────────────────────────────────────────┐
│  PATIENTS                              [Search]  [⊕ New]      │  ← Title2, eyebrow
│  3 active cases · last seen 2h ago                             │
├────────────┬───────────────────────────────────────────────────┤
│ J.D.       │ ─── PATIENT ──────────────────────────────────    │  ← eyebrow
│ 60-69 · M  │                                                   │
│ 2 studies  │  J.D.   `abc123def456`                            │  ← LargeTitle + mono
│ ──────     │  60-69 male · 2 studies on file                   │  ← Body Secondary
│            │                                                   │
│ K.L.       │  ─── CHIEF COMPLAINT ─────────                    │  ← eyebrow
│ 50-59 · F  │  Left-upper lobe nodule, follow-up CT             │  ← Body
│ 1 study    │                                                   │
│ ──────     │  ─── DEMOGRAPHICS ────────────                    │
│            │  ┌─────────────────────────────────────────────┐  │
│ +12 more   │  │  Initials    J.D.                            │  │  ← Double-bezel
│            │  │  MRN         00782-9914                      │  │
│            │  │  Age         66 (60-69)                      │  │
│            │  │  Sex         Male                            │  │
│            │  │  Source      both ●                          │  │
│            │  └─────────────────────────────────────────────┘  │
│            │                                                   │
│            │  ─── STUDIES (2) ─────────────                    │
│            │  • CT Chest · 2026-06-08  [Open viewer →]         │
│            │  • CT Chest · 2026-03-14  [Open viewer →]         │
└────────────┴───────────────────────────────────────────────────┘
```

关键变化：
- 巨大 hero（LargeTitle）让"现在在看哪个病人"一眼可读
- Eyebrow tags 切分 section
- Double-bezel demographics 卡 = "病例本"质感
- Studies 行单行 + trailing CTA，不再 nest 进卡

---

## 11. Migration Plan（重设计落地节奏）

| Phase | Surface | 工作量 |
|---|---|---|
| 0 | App.axaml token 系统替换（颜色、字体、间距、动效 resource keys 全换） | M |
| 1 | **PatientsView pilot** — 按 §10 重做 | M |
| 2 | NewPatientDialog 升级到 sheet + double-bezel | S |
| 3 | PatientNavigator (左栏) 升级 list row | S |
| 4 | ChatView 主对话 + 气泡 + 输入框 | L |
| 5 | ActivityPanel 右栏 | M |
| 6 | DICOM viewer chrome | M |
| 7 | LoginView + Welcome wizard | M |
| 8 | StatusBar | S |
| 9 | 全 surface QA pass | S |

每 Phase 一轮，pilot OK 后才扩散到剩余 surface。

---

## 12. Pre-Flight Checklist（每个 surface 出炉前过一遍）

依据 design-taste-frontend §"Pre-Flight Check" + high-end-visual-design §8：

- [ ] 没有使用 banned 字体（Inter / Roboto / Arial）
- [ ] 没有使用 banned color（pure black / pure white bg / cyan / AI 紫）
- [ ] Accent color 一致（整个 surface 只有 Apothecary Green，不混 cyan / blue）
- [ ] Card 用了 Double-Bezel；外壳 + 内核 radius concentric
- [ ] Section padding ≥ 48px（macro-whitespace）
- [ ] Primary CTA 全 surface 仅一个
- [ ] Transitions 用了 custom cubic-bezier，没有 default `linear`
- [ ] Eyebrow tag 出现在每个 major section / card 上方
- [ ] PHI 标识符使用 mono font
- [ ] 临床数据没有用 success/error 色错位 highlight

---

## 13. Open Questions（等医生拍板）

1. **Light vs Dark** — 我推荐 light-first（Editorial 强项 + medic 在 light env 下读 chart 更稳）。Dark mode 作为 v2.1 follow-up。OK 吗？
2. **Apothecary Green accent** — 这是我提名的，但你也可以挑别的。备选：deep indigo `#2E3D6B`、warm clay `#8B5A3C`、ink-purple `#3D2E5C`。
3. **Serif 是否完全不用** — 我倾向只用 SF Pro 系列，serif 只点缀 patient name 之类。或者激进版：用 New York serif 给"病例名"，会让产品立刻"editorial 感"上一个台阶。
4. **Motion intensity** — 我设 3，但如果你想"灵动一点"我可以拉到 5（按钮 magnetic hover、卡片 hover 微升起、tab switch slide-fade）。
