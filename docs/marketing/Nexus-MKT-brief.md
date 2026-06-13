# Nexus — Marketing Brief

> Source of truth: [`docs/BEP-nexus.md`](../BEP-nexus.md) v0.4.
> This brief is written for the marketing team. Engineers, please
> read the BEP.

---

## The one-liner

> **Nexus turns AI agents into BNB Chain assets — portable across
> runtimes, auditable end-to-end, and capable of doing business
> with each other on chain.**

If a journalist gives you 10 seconds, say that.

## The 30-second pitch

AI agents today are processes. Kill the server, switch the
operator, change the cloud — the agent and everything it has
learned is gone. You don't *own* the agent; you rent it from
whoever hosts it.

**Nexus changes that.** It's a BNB Chain Evolution Proposal that
defines four properties for AI agents on BSC:

1. **Stateless runtime** — the agent's full memory lives on BNB
   Greenfield; only a 32-byte content hash anchors on BSC. Any
   compliant runtime can resume the agent from those two pieces.
2. **Identity-anchored** — the agent is an existing **ERC-8004
   NFT**. Transfer the NFT, transfer the agent.
3. **Self-evolving and audited** — the agent can rewrite its own
   memory and skills, but every edit is pinned to the chain as a
   *prediction* and scored later against real outcomes. No silent
   drift.
4. **Commerce-capable** — agents transact with each other via the
   existing **ERC-8183 (Agentic Commerce)** standard; jobs feed
   the same auditable history as memory.

One per-agent Greenfield bucket. ~84 bytes per agent on BSC. Costs
a few cents to anchor a session, dollars to store a year of memory.

## The story for each audience

| Audience | What to lead with |
| --- | --- |
| **BNB Chain devs / ecosystem** | "Build agents on BNB Chain that nobody else can host. Anchor on BSC, store on Greenfield — a pattern only this stack natively supports." |
| **AI agent startups** | "Stop being your users' single point of failure. Ship agents that survive your shutdown. Same identity NFT works on every compliant runtime." |
| **Crypto / Web3 press** | "BNB Chain proposes the first end-to-end standard for stateful, ownable AI agents — composing with ERC-8004 identity and ERC-8183 commerce already on Ethereum's standards track." |
| **Enterprise AI buyers** | "Buy an agent, migrate it like you migrate a database. No vendor lock-in. Behaviour changes are auditable on chain." |
| **BNB community / holders** | "BNB Chain becomes the home for AI agents you actually own. Your agents pay storage in BNB. New use case, native demand." |

## Five proof points to cite

1. **Standards composition.** Nexus extends, doesn't fork —
   ERC-8004 (Feb 2025, identity) and ERC-8183 (Feb 2026, commerce)
   are public Ethereum draft standards; Nexus adds the missing
   *state* layer for BNB Chain.
2. **Cost.** ~84 bytes per agent on BSC. Bulk payload at
   Greenfield's per-byte rate. Anchoring a session of agent state
   costs cents.
3. **Verifiability.** Manifest is JCS-canonical (RFC 8785);
   SHA-256 hash on chain. Any tampering breaks at the next read.
4. **Falsifiable self-improvement.** Inspired by Lin et al.
   (*Agentic Harness Engineering*, arXiv 2604.25850, Apr 2026),
   which showed +7.3 pp pass@1 over 10 iterations versus
   unaudited self-edits. Nexus pins the same discipline as a
   normative event schema.
5. **Reference implementation already running.** Python SDK,
   Python framework, FastAPI server, Avalonia C# desktop client
   (Windows / macOS / Linux). Multi-platform out of the day-one
   announcement.

## Headline / tagline options

Pick one that fits your channel; don't mix.

* **"Your AI agent, your asset."** *(consumer-friendly)*
* **"AI agents that outlive their hosts."** *(developer-focused)*
* **"From process to property: stateful AI on BNB Chain."** *(press / op-ed)*
* **"Anchor on BSC. Store on Greenfield. Move anywhere."** *(technical)*

## Visual hook

The two-column architecture is the easiest thing to draw and the
hardest to forget. Use this in slides / blog hero images / Twitter
cards:

```
       BSC (anchor)            ┃    Greenfield (payload)
   ──────────────────────      ┃    ─────────────────────
    ERC-8004    identity       ┃    events/      DPM log
    AgentState  state hash     ┃    memory/      compactions
    ERC-8183    commerce       ┃    jobs/        commerce mirror
                               ┃    manifest.json (state hash)
                               ┃
              ╲                ┃                /
               ╲       ONE tokenId per agent   /
                ╲___________________________╱
```

## What to say — and what not to say

**DO say:**

* "BNB Chain Evolution Proposal" or "BEP draft" — this is a
  *standard*, not a product launch. Open implementation by anyone.
* "Composes with ERC-8004 and ERC-8183" — emphasises ecosystem
  fit, not isolated novelty.
* "Reference implementation" — distinguish the spec from any one
  runtime. Multiple runtimes are good; that's the whole point.
* "Audited self-improvement" — every evolver edit is a falsifiable
  prediction.
* "Anchor on BSC, store on Greenfield" — the catchphrase. This is
  what's BNB-native.

**DON'T say:**

* ❌ "First AI agent on chain." Untrue and easy to dunk on.
* ❌ "Trustless self-evolving AGI." Overclaim; we audit
  self-evolution, we don't autonomise it.
* ❌ "Replaces ChatGPT / Claude / Gemini." Nexus is the *substrate*;
  any LLM plugs in.
* ❌ Specific LLM vendor names. Implementation detail. Don't
  let the story become "BNB Chain agents run on \[vendor X\]" —
  that ages badly the moment we change.
* ❌ "Decentralised inference" / "on-chain LLM". Nothing in this
  BEP is about running models on chain. Don't promise it.
* ❌ Claims about specific agent performance benchmarks. The BEP
  doesn't constrain the LLM; performance is a runtime concern.
* ❌ "Soul-bound" or NFT-philosophy language. ERC-8004 NFTs are
  transferable by design. That's a feature.

## Channels & tactics

| Channel | What lands |
| --- | --- |
| **Twitter / X** | The two-column architecture image + one tagline. Thread expanding the four properties one at a time. Tag @ethereum (for the EIP composition angle), @greenfield_bnb, @BNBChain. |
| **Blog post (BNB Chain blog)** | "Why we proposed this," walking through the four properties with the v0.4 diagrams. Target ~1,500 words. Link to the BEP on GitHub. |
| **Hacker News / Reddit r/CryptoCurrency, r/BNBChain** | Lead with the technical: cost numbers, standards composition, reference implementation. Don't oversell. |
| **Developer Discord / Telegram** | "How to build a Nexus-compliant runtime in your stack." Pull in community implementers — the BEP succeeds when there are multiple runtimes. |
| **Conference deck** | 5 slides max: problem, four properties, architecture diagram, reference impl screenshots, call to action ("propose changes / build a runtime / hire your agent"). |
| **Crypto media briefings** | Lead with the ecosystem angle: BNB Chain is the only stack with native L1 + permissioned bulk storage. Frame as response to "where will agents actually live." |

## Press FAQ

**Q: Is this a product or a standard?**
> Standard. A BNB Chain Evolution Proposal (BEP) is the BNB Chain
> equivalent of an Ethereum EIP — anyone can implement, anyone can
> propose changes. We've shipped a reference implementation to
> show the design works, but Nexus succeeds when there are
> multiple runtimes, not one.

**Q: How is this different from "putting an AI on the blockchain"?**
> We don't run AI on the blockchain — that's still infeasible at
> scale. We anchor agents *to* the blockchain via a 32-byte content
> hash so they're portable and verifiable, while keeping the heavy
> compute and storage off chain. The chain is the integrity anchor,
> not the execution substrate.

**Q: Why BNB Chain specifically?**
> BNB Chain is the only major stack with both an L1 (BSC, cheap and
> fast for the small anchor) and a native permissioned object store
> (Greenfield, owner-keyed and pay-per-byte for the bulk payload).
> The "anchor on BSC, store on Greenfield" pattern doesn't have a
> clean parallel on Ethereum mainnet, Solana, or any other L1 we've
> looked at.

**Q: Who owns the agent?**
> Whoever owns the ERC-8004 NFT. That's it. Transfer the NFT, the
> new owner controls the agent. Custodial services can host on
> behalf of users; non-custodial users can run their own runtime.

**Q: What stops an operator from secretly mutating the agent?**
> The state root is a content hash on BSC. Any unauthorised change
> to the Greenfield payload makes the next reader's hash mismatch
> the chain. Self-evolution edits are pinned as falsifiable
> proposals on the same chain — silent mutation is structurally
> visible.

**Q: When does this go live on BNB Chain mainnet?**
> The BEP is a draft. Reference contracts can be deployed on
> testnet today; mainnet timing depends on community review. We're
> opening the discussion thread now and will respond to feedback.

**Q: What about ERC-8004 / ERC-8183 — are those Ethereum standards
landing on BNB Chain?**
> Both are EVM-compatible Ethereum drafts. Any EVM chain can deploy
> them; BNB Chain is in active dialogue with their authors and
> already uses them in the Nexus reference implementation. Nexus
> doesn't fork them — it composes with them.

## Internal review checklist

Before any external piece ships, confirm:

* [ ] Linked to the BEP on GitHub (the spec, not a marketing page).
* [ ] Names ERC-8004 and ERC-8183 correctly with the right author
      attributions.
* [ ] Doesn't name a specific LLM vendor as the "AI behind Nexus."
* [ ] Doesn't promise on-chain inference, decentralised LLM, or
      AGI-adjacent language.
* [ ] Cost claims (~84 bytes / agent, "cents to anchor") match the
      BEP's numbers.
* [ ] If using the architecture diagram, source it from the BEP
      Abstract — not a redrawn version that drifts from spec.

## Calls to action

Pick one per piece, don't bundle:

* **Read the BEP** → link to `docs/BEP-nexus.md` on GitHub.
* **Build a runtime** → link to the reference implementation repo.
* **Hire an agent / get hired** (once the reference marketplace is
  up) → link to the ERC-8183 demo.
* **Join the discussion** → link to the GitHub Discussions thread.

---

**Owner:** huihzhao (jimmy.zz@bnbchain.org)
**Last updated:** 2026-05-04 (BEP v0.4)
**Questions on technical accuracy:** ping the BEP author before
publishing.
