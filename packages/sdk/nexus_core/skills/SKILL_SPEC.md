# Nexus SKILL.md spec — agentskills.io–compatible

Nexus loads skills (sub-agent role definitions) from `.nexus/skills/`.
The format is intentionally compatible with the cross-vendor
[agentskills.io](https://agentskills.io) standard + Anthropic's Claude
Code `.claude/agents/` convention, so a skill authored for one
ecosystem drops in unchanged.

## Two on-disk layouts (both supported)

### Layout A — folder per skill (recommended for marketplace distribution)

```
.nexus/skills/
└── content-strategist/
    ├── SKILL.md              # YAML frontmatter + markdown body
    ├── references/           # optional — additional context the
    │   ├── style-guide.md    # skill can pull in on demand
    │   └── examples.md
    └── .local.md             # optional — local user overrides
                              #   (not distributed)
```

### Layout B — flat single file (drop-in `.claude/agents/` compatibility)

```
.nexus/skills/
└── content-strategist.md     # frontmatter + body, single file
```

The loader auto-detects which layout a skill is in. Folder layout wins
on name collision (richer content).

## Frontmatter fields

| Field          | Required | Type        | Notes |
| -------------- | -------- | ----------- | ----- |
| `name`         | yes      | string      | kebab-case identifier. Used as the addressable handle in workflows and `delegate(skill_name=…)`. Must match the folder / filename. |
| `description`  | yes      | string      | One-line trigger description. Shown to the orchestrating agent so it knows when to invoke this skill. |
| `license`      | rec.     | SPDX string | e.g. `MIT`, `Apache-2.0`. Required for marketplace distribution. |
| `version`      | rec.     | semver      | e.g. `1.0`, `2.3.1`. Defaults to `0.0.0` if absent. |
| `author`       | opt.     | string      | Display name or handle. |
| `model`        | opt.     | string      | Per-skill model pin — either a tier hint (`strong` / `fast` / `cheap`) or an explicit model id (`claude-sonnet-4-6`). Workflow runner honours this unless explicitly overridden. |
| `tools`        | opt.     | list[str]   | Allow-list of tool names this skill may invoke (`web_search`, `read_url`, …). Empty = no restriction. `allowed-tools` is accepted as a synonym (agentskills.io shape). |
| `title`        | opt.     | string      | Human-readable display name. Falls back to `name`. |

Unknown fields are preserved verbatim under `InstalledSkill.metadata`,
so marketplaces can attach their own metadata (`homepage`, `category`,
`tags`, etc.) without spec churn.

## Example

```markdown
---
name: content-strategist
description: Returns angle, hook and brief. Doesn't write the article.
license: Apache-2.0
version: 1.0
author: BNB Chain
model: claude-sonnet-4-6
tools: [web_search, read_url]
---

You are a content strategist. Your job is the BRIEF. Not the article.

Read the WORKFLOW INPUTS above (topic, audience, platform). Then:
1. Identify the saturated angle — what everyone is already saying.
2. Find the contrarian angle — what the data shows.
3. Write the HOOK — the first line of the eventual piece.
...
```

## Naming conventions

* **Folder / file name** must equal `name` frontmatter — the loader
  uses one or the other as a default, and a mismatch is a load-time
  warning.
* **kebab-case** for all skill names. `content-strategist`, not
  `ContentStrategist` or `content_strategist`. Cross-ecosystem
  parity demands it.

## Programmatic access

```python
from nexus_core.skills.manager import SkillManager

mgr = SkillManager(base_dir=".nexus")
skill = mgr.get("content-strategist")
print(skill.name, skill.description, skill.license, skill.version)
print(skill.instructions)   # the body, after frontmatter
print(skill.tools)          # allow-list, if any
```

`InstalledSkill` fields: `name`, `title`, `description`, `version`,
`author`, `license`, `model`, `tools`, `instructions`, `references`,
`metadata`, `layout`.
