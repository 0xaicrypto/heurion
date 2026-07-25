/**
 * GitHub Skills Marketplace — fetch Claude Skills from community repos.
 *
 * Skills format: each skill is a directory with SKILL.md containing:
 *   # Skill Name
 *   > Description
 *   ## Instructions
 *   ...
 */
import { deepseekChat, getApiKey } from '../../common/llm.js'

export interface GitHubSkill {
  identifier: string
  name: string
  description: string
  source: string
  version: string
  author: string
  repo: string
  path: string
}

const GITHUB_SKILLS_CACHE: { skills: GitHubSkill[]; fetchedAt: number } | null = null
const CACHE_TTL = 3600_000 // 1 hour

/**
 * Fetch top Claude Skills repos from GitHub and parse their SKILL.md files.
 */
export async function fetchGitHubSkills(): Promise<GitHubSkill[]> {
  if (GITHUB_SKILLS_CACHE && Date.now() - GITHUB_SKILLS_CACHE.fetchedAt < CACHE_TTL) {
    return GITHUB_SKILLS_CACHE.skills
  }

  // Use GitHub search API to find repos tagged with claude-skills
  const repos = await searchClaudeSkillsRepos()
  const skills: GitHubSkill[] = []

  for (const repo of repos) {
    try {
      const tree = await fetchRepoTree(repo.full_name, repo.default_branch)
      const skillDirs = findSkillDirectories(tree)

      for (const dir of skillDirs) {
        try {
          const md = await fetchFileContent(repo.full_name, repo.default_branch, `${dir.path}/SKILL.md`)
          const parsed = parseSkillMd(md, repo.full_name, dir.path)
          if (parsed) skills.push(parsed)
        } catch { /* skip broken skills */ }
        if (skills.length >= 50) break // limit per fetch
      }
    } catch { /* skip broken repos */ }
    if (skills.length >= 100) break
  }

  return skills
}

interface RepoInfo { full_name: string; default_branch: string; name: string; stargazers_count: number }
interface TreeItem { path: string; type: string }

async function searchClaudeSkillsRepos(): Promise<RepoInfo[]> {
  // Curated list of top clinical/medical Claude Skills repos
  return [
    { full_name: 'K-Dense-AI/scientific-agent-skills', default_branch: 'main', name: 'Scientific Agent Skills', stargazers_count: 31700 },
    { full_name: 'VoltAgent/awesome-agent-skills', default_branch: 'main', name: 'Awesome Agent Skills', stargazers_count: 28900 },
    { full_name: 'alirezarezvani/claude-skills', default_branch: 'main', name: 'Claude Skills', stargazers_count: 23200 },
    { full_name: 'Jeffallan/claude-skills', default_branch: 'main', name: 'Developer Skills', stargazers_count: 10700 },
    { full_name: 'Orchestra-Research/AI-Research-SKILLs', default_branch: 'main', name: 'AI Research Skills', stargazers_count: 11100 },
  ]
}

async function fetchRepoTree(ownerRepo: string, branch: string): Promise<TreeItem[]> {
  const [owner, repo] = ownerRepo.split('/')
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Heurion' },
  })
  if (!res.ok) throw new Error(`GitHub API: ${res.status}`)
  const data = await res.json() as any
  return data.tree || []
}

function findSkillDirectories(tree: TreeItem[]): TreeItem[] {
  // Directories containing SKILL.md are skill directories
  const skillMdPaths = tree.filter(t => t.path.endsWith('/SKILL.md') || t.path === 'SKILL.md')
  // Map back to parent directories
  const dirs: Map<string, TreeItem> = new Map()
  for (const sm of skillMdPaths) {
    const dirPath = sm.path.replace(/\/?SKILL\.md$/, '')
    if (!dirs.has(dirPath)) {
      dirs.set(dirPath, { path: dirPath || '.', type: 'tree' })
    }
  }
  return [...dirs.values()]
}

async function fetchFileContent(ownerRepo: string, branch: string, path: string): Promise<string> {
  const [owner, repo] = ownerRepo.split('/')
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Heurion' } })
  if (!res.ok) throw new Error(`Fetch ${path}: ${res.status}`)
  return res.text()
}

function parseSkillMd(md: string, repo: string, path: string): GitHubSkill | null {
  const lines = md.split('\n')
  const titleLine = lines.find(l => l.startsWith('# '))
  const descLine = lines.find(l => l.startsWith('> '))
  if (!titleLine) return null

  const name = titleLine.replace(/^#\s+/, '').trim()
  const description = descLine ? descLine.replace(/^>\s*/, '').trim() : name
  const author = repo.split('/')[0]

  return {
    identifier: `github:${repo}/${path}`,
    name,
    description: description.slice(0, 200),
    source: 'github',
    version: 'community',
    author,
    repo,
    path,
  }
}

/**
 * Auto-enrich skill descriptions using LLM (cache-bust).
 */
export async function enrichSkillDescription(skill: GitHubSkill): Promise<string> {
  try {
    const apiKey = getApiKey()
    const prompt = `You are a clinical skill classifier. Given a Claude Skill named "${skill.name}" from repo ${skill.repo}, write a 1-sentence description of what this skill does for a clinical researcher. If the skill name doesn't suggest clinical utility, say "General AI agent skill."`
    const result = await deepseekChat([{ role: 'user', content: prompt }], apiKey)
    return result.slice(0, 200)
  } catch {
    return skill.description
  }
}
