# Third-party content attribution

Heurion embeds third-party scientific illustration content. This file is
the single record of sources, licenses and modifications — required by the
CC BY 4.0 license terms.

## Reactome pathway diagrams

| Field | Value |
|---|---|
| Content | Pathway diagrams (SVG) used by `render_scene` (template_source=reactome) |
| Source | [Reactome Pathway Database](https://reactome.org) — diagrams.svg.tgz |
| License | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| License page | https://reactome.org/license |
| Attribution text | `Reactome pathway diagrams, CC BY 4.0` |
| Where | catalog `packages/server-ts/data/reactome-pathways.json`; full diagram library provisioned at `/opt/heurion/reactome-diagrams` by the deploy pipeline; optionally uploaded to object storage via `scripts/upload-reactome-diagrams.js` |
| Modifications | None (diagrams embedded as-is) |
| On-screen credit | Rendered below every Reactome diagram in chat (markdown caption) and in the Settings → Credits page |

## NIH BioArt icons

| Field | Value |
|---|---|
| Content | Icon SVGs used by the BioScene icon catalog (`render_scene` bioscene mode) |
| Source | [Wikimedia Commons — Category:NIH BioArt](https://commons.wikimedia.org/wiki/Category:NIH_BioArt) |
| License | Public domain (U.S. National Institutes of Health works) |
| Where | `packages/server-ts/data/icons/` + `icons.json` manifest |
| Modifications | Outer `<svg>` wrapper stripped; inner content embedded as-is |
| Fetch script | `scripts/fetch-bioart-icons.py` (re-producible; PD license gate) |
| On-screen credit | Settings → Credits page |

## Regeneration policy

- Re-running `scripts/fetch-bioart-icons.py` refreshes the icon set from
  Commons (public domain gate).
- Re-running the Reactome provisioning job refreshes the diagram library
  from https://reactome.org/download/current/diagrams.svg.tgz.
- Any newly added third-party icon/diagram source MUST be recorded here
  before merging.
