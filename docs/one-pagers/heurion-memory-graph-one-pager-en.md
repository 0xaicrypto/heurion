# Heurion Clinical AI Workstation

> **Turn every encounter, file, and confirmation into auditable, evolving, exportable clinical memory.**

---

## One-sentence positioning

Heurion is a **self-evolving AI workstation** for oncology research and clinical teams. It distills fragmented conversations, medical records, and documents into a structured, unified Memory Graph; automatically extracts facts, synthesizes knowledge, surfaces unknowns, and recalls them in later encounters and reports — so the AI truly remembers your patients and your team's knowledge, and grows with you.

---

## Who is it for

- **Oncology researchers**: managing enrolled patients, protocols, follow-up data, and adverse events.
- **Clinicians / MDT teams**: who need longitudinal patient context, fewer repetitive questions, and lower hallucination risk.
- **Medical research assistants**: who produce case summaries, academic slides, Table 1, and statistical charts.
- **Hospital / department IT**: who need AI that is explainable, auditable, and deployable on premises.

---

## Three big pain points in clinical AI

| Pain point | Traditional chatbots | Cost |
|---|---|---|
| **Stateless** | They “forget” after every conversation; doctors repeat the background | Wasted time, poor UX |
| **Un-auditable** | No traceability for where a conclusion came from or whether evidence is stale | Medical risk, compliance risk |
| **Knowledge & workflow silos** | Chat, records, and reports are disconnected; nothing accumulates | Rework, information islands |

---

## System architecture: from input to memory loop

```
Clinical input      EventLog          Evolution Engine      Memory Graph        Smart output
Chat / Files / Records → Immutable & auditable → Extract · Link · Synthesize → Facts / Articles / Gaps → Search / Reports / Decisions
```

**Key design**: all clinical inputs are first written to an immutable EventLog, then refined into a unified Memory Graph by an async evolution engine. Every confirmation or edit from the clinician feeds back into the EventLog, driving continuous evolution. This is what sets Heurion apart from ordinary chatbots: it doesn't just answer questions — it turns your team's knowledge into auditable, reusable assets.

---

## Three core capabilities

### 1. Unified Memory Graph

Facts, Articles, Gaps, Skills, Entities, and Documents live as nodes on the same graph, connected by relations such as depends-on, derives-from, supersedes, and answers.

- **Versioned**: every edit to a Fact or Article creates a new version; old versions remain traceable.
- **Impact analysis**: change a Fact and instantly see which Articles are affected.
- **Patient subgraph**: focus on nodes related to a specific patient to support MDT decisions.
- **Exportable**: full archives in `.hma` (Heurion Memory Archive) format.

### 2. Evolving Knowledge Base

Knowledge is not configured once; it grows and self-corrects through use.

- **Auto-extract**: structured Facts are extracted from chat and files.
- **Auto-synthesize**: when enough related Facts accumulate, an Article is generated.
- **Auto-propagation**: when an underlying Fact changes, dependent Articles are marked stale and can be regenerated in one click.
- **Knowledge Gap**: the system explicitly records “I don't know,” waiting for an answer or validation instead of hallucinating.

### 3. Smart Report Assistant

Turn a clinical discussion into a deliverable document with one sentence — without blocking the chat stream.

- Generate DOCX (case summaries, follow-up notes), PPTX (academic presentations), tables (Table 1, AE summaries), and plots (KM curves, forest plots).
- File links are persisted; refresh the page and the download link still works.
- Generated content can be added to the knowledge base with one click, closing the loop from report → fact → article.

---

## Typical use cases

**Longitudinal patient management**  
A lung-cancer patient's CTs, pathology, and treatment history are stored as Facts. When the doctor asks "What's next?", the system recalls the patient subgraph instead of giving generic advice detached from the history.

**Protocol writing**  
A research team uploads protocols, inclusion criteria, and literature. The system extracts key Facts and synthesizes Articles. When it's time to present, one sentence generates the academic PPT and Table 1.

**Knowledge maintenance & audit**  
A medical manager edits a Fact; the system immediately warns that 3 Articles will be affected. After confirmation, those Articles are marked stale and can be regenerated in one click, keeping externally shared content consistent.

---

## Security & compliance

- **Tenant isolation**: each user's EventLog, facts, knowledge, and files are stored in a separate workspace.
- **Two-plane isolation**: the Control Plane (auth, patients, knowledge base, plugins) is separated from the Execution Plane (report rendering, plugin sandbox).
- **Auditable**: an immutable EventLog records every chat, file generation, and fact change, and supports export.
- **Self-host friendly**: run everything via Docker Compose on premises or in a private cloud; API keys and database connections are configured via environment variables so data never leaves your infrastructure.

---

## Business value

| Dimension | Benefit |
|---|---|
| **Efficiency** | Less time spent re-supplying patient background; faster case summaries and report generation. |
| **Quality** | Structured, versioned memory reduces AI hallucinations and outdated recommendations. |
| **Compliance** | Every conclusion traces back to source Facts and versions, satisfying medical audit requirements. |
| **Assetization** | Team conversations and files become exportable, migratable knowledge assets. |

---

## Next steps

- **Try online**: visit [heurion.ai](https://heurion.ai) or [GitHub](https://github.com/0xaicrypto/heurion) to self-host.
- **Business inquiry**: contact our BD team for a POC proposal, deployment guide, and compliance white paper.

> **Runtime is temporary. Evolution is eternal.**
