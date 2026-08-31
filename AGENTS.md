# Agent instructions

trellis-project: pi-openai-limits-cba8

Specs, tickets and story state for this repository live in trellis — use its
MCP tools (server "trellis"). It is the single source of truth:

- Check get_overview and search_specs before picking up work; work only on
  stories, never on ad-hoc tasks outside a story.
- Done stories are the context source: read the relevant done trees
  (get_tree) and cross-cutting specs before designing or implementing. When
  reality diverges from a done spec, correct it in place and re-approve.
- Implement only via transition(story, "start") and complete via "finish".
  Never merge to the base branch yourself.
- Test names must reference the spec ids they prove (e.g. TestFoo_UT_3).
- Check the glossary (get_overview) and reuse its exact wording in every
  spec; define new project terms with define_term, ultra short.
