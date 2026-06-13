# M3-Agent Attribution

Portions of `nexus_server/clinical_graph.py` are adapted from the
M3-Agent project by ByteDance Seed:

* Repository: https://github.com/ByteDance-Seed/m3-agent
* License: Apache License, Version 2.0
* Paper: Long et al., "Seeing, Listening, Remembering, and Reasoning:
  A Multimodal Agent with Long-Term Memory", ICLR 2026
  https://arxiv.org/abs/2508.09736

The original M3-Agent code is copyright © 2025 Bytedance Ltd.
and/or its affiliates, licensed under Apache 2.0.

## Adapted algorithms

The following algorithms were ported from `mmagent/videograph.py`
and `mmagent/retrieve.py` of the M3-Agent repository:

* Entity-centric graph traversal (`get_entity_info`,
  `get_connected_nodes`)
* Weight-based node reinforcement / weakening primitives
* Text-node cosine similarity search structure (stub in M0;
  real impl in M4)
* Disjoint-set entity-equivalence merging (planned for M2)
* Algorithm 1 iterative retrieval control loop (planned vendor;
  not yet ported as of M0)

## Medical adaptations (per ADR-002 Rev-1..Rev-9)

* Entity types replaced: face/voice anchors removed; medical anchors
  added (patient, study, series, key_image, anatomical_region,
  finding, measurement, med, lab, ddx, episodic_event, semantic_fact).
* `clip_id` semantics removed (30-second video segment) and replaced
  by `encounter_id` (study/chat/lab).
* Pickle persistence replaced with event-sourced SQL projection tables.
* Cross-modal equivalence detection rewritten for clinical entity
  identity rather than biometric face↔voice matching.

A copy of the Apache License 2.0 is available at:
https://www.apache.org/licenses/LICENSE-2.0
