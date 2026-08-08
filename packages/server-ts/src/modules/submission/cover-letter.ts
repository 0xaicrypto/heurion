/**
 * #362: cover letter generation + journal format templates.
 * LLM draft is always a starting point — the doctor edits and owns the
 * final version (issue requirement).
 */
import { deepseekChat, getApiKey } from '../../common/llm.js'

export async function generateCoverLetter(input: {
  title: string
  abstract: string
  authors?: string[]
  journalName?: string
  highlights?: string[]
  correspondingAuthor?: string
}): Promise<{ coverLetter: string; highlights: string[] }> {
  const journal = input.journalName || '[目标期刊]'
  const authors = (input.authors || []).filter(Boolean)
  const highlights = input.highlights || []

  const prompt = `You are a scientific writing assistant. Write a submission cover letter for the following manuscript.

Manuscript title: ${input.title}
Abstract: ${input.abstract.slice(0, 3000)}
Target journal: ${journal}
${authors.length ? `Authors: ${authors.join(', ')}` : ''}
${input.correspondingAuthor ? `Corresponding author: ${input.correspondingAuthor}` : ''}
${highlights.length ? `Study highlights (3):
${highlights.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : 'Extract the 3 most important study highlights from the abstract yourself.'}

Write in English, formal but not stiff. Include:
1. A polite opening addressed to the Editor-in-Chief of ${journal}
2. Why this study matters (2-3 sentences) and why it fits ${journal}
3. The three key highlights (numbered)
4. An originality statement: "This manuscript has not been published previously and is not under consideration for publication elsewhere."
5. Closing with the corresponding author and "Yours sincerely"

Return ONLY the letter text (no preamble).`

  const apiKey = getApiKey()
  const result = await deepseekChat([{ role: 'user', content: prompt }], apiKey, {
    model: 'deepseek-chat',
    maxTokens: 1200,
    telemetryContext: { userId: 'submission', workspaceId: 'submission', action: 'submission.cover_letter' },
  })
  return { coverLetter: result.trim(), highlights }
}

export interface FormatTemplate {
  id: string
  journalName: string
  journalId: string
  sections: string[]
  referenceStyle: string
  wordLimit: string
  notes: string[]
}

export const FORMAT_TEMPLATES: FormatTemplate[] = [
  {
    id: 'jto-template',
    journalName: 'Journal of Thoracic Oncology',
    journalId: 'jto',
    sections: ['Title page', 'Structured abstract (Background/Methods/Results/Conclusion)', 'Introduction', 'Methods', 'Results', 'Discussion', 'References (AMA style, numbered)', 'Figures and tables'],
    referenceStyle: 'AMA (numbered, citation in order of appearance)',
    wordLimit: 'Abstract ≤ 250 words; Main text ≤ 4000 words',
    notes: ['Lay summary required', 'CONSORT for trials / STROBE for observational studies'],
  },
  {
    id: 'lancet-oncol-template',
    journalName: 'Lancet Oncology',
    journalId: 'lancet-oncol',
    sections: ['Title page', 'Summary (structured, 300 words)', 'Introduction', 'Methods', 'Results', 'Discussion', 'References (Vancouver)', 'Declaration of interests'],
    referenceStyle: 'Vancouver (numbered)',
    wordLimit: 'Summary ≤ 300 words; Main text ≤ 4500 words',
    notes: ['CONSORT flow diagram required for trials', 'Patient consent / IRB statement mandatory'],
  },
  {
    id: 'ann-oncol-template',
    journalName: 'Annals of Oncology',
    journalId: 'ann-oncol',
    sections: ['Title page', 'Abstract (structured)', 'Introduction', 'Patients and methods', 'Results', 'Discussion', 'References', 'Supplementary material'],
    referenceStyle: 'Vancouver (numbered)',
    wordLimit: 'Abstract ≤ 250 words; Main text ≤ 4000 words',
    notes: ['ESMO guidelines compliance', 'Statistical methods section detailed'],
  },
  {
    id: 'front-oncol-template',
    journalName: 'Frontiers in Oncology',
    journalId: 'front-oncol',
    sections: ['Title page', 'Abstract (unstructured, ≤ 350 words)', 'Introduction', 'Methods', 'Results', 'Discussion', 'References (Vancouver)', 'Data availability statement'],
    referenceStyle: 'Vancouver',
    wordLimit: 'Main text ≤ 12000 words (incl. references)',
    notes: ['STROBE checklist for retrospective studies', 'Author contributions + funding statements required'],
  },
  {
    id: 'bmc-cancer-template',
    journalName: 'BMC Cancer',
    journalId: 'bmc-cancer',
    sections: ['Title page', 'Abstract (structured, ≤ 350 words)', 'Background', 'Methods', 'Results', 'Discussion', 'Conclusions', 'References (Vancouver)', 'Declarations'],
    referenceStyle: 'Vancouver (numbered)',
    wordLimit: 'Main text ≤ 8000 words',
    notes: ['STROBE checklist mandatory', 'Ethics approval statement required'],
  },
]

export function buildPrefilledTemplate(
  template: FormatTemplate,
  paper: { title: string; abstract?: string; authors?: string[] },
): string {
  const authors = (paper.authors || []).filter(Boolean).join(', ') || '[作者列表]'
  const abstract = paper.abstract || '[摘要待填写]'
  return `# ${paper.title}

**Authors:** ${authors}

## Abstract
${abstract}

## Sections
${template.sections.map((s) => `- ${s}`).join('\n')}

## Reference style
${template.referenceStyle}

## Length limits
${template.wordLimit}

## Editor notes
${template.notes.map((n) => `- ${n}`).join('\n')}

## References
[按 ${template.referenceStyle} 格式整理文献]`
}
