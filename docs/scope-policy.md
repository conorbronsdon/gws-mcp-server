# What belongs in this server

**Status:** decided 2026-09-24. Option A (curated set), with separate companion
MCP servers as the extension path instead of an in-repo loader. The proposal and
its [cross-model review](https://github.com/conorbronsdon/gws-mcp-server/pull/64#issuecomment-5724551349)
are preserved in #64.

## Why this exists

The server went from 41 tools to 63 service definitions in fourteen days, all of
it good work from one contributor. No individual merge was wrong, but the
inclusion rule lived in the maintainer's head, so every PR was a judgment call and
the aggregate drifted. This document writes the rule down.

## The rule

This server is curated. Tools are chosen, not generated, and every tool added is
one the maintainer commits to supporting indefinitely.

A service belongs here when all of these hold:

- It is on the critical path of an agent doing real work in a Workspace: reading
  and writing the documents, mail, calendar, files and tasks people actually live in.
- It works within the default scope grant, or the case for an extra scope is strong
  enough to justify the setup cost for every user who enables it.
- Its tools have side effects that can be declared precisely.

A service does not belong here merely because the API exists, because coverage
looks incomplete, or because the tools could be kept off the default profile.

These are judgments, not tests. Writing them down doesn't make them mechanical;
it puts the judgment somewhere it can be argued with.

## How to propose a new service

Open an issue describing the use case before writing a PR: what an agent needs to
do, which scopes it requires, and the side effects of each tool. A service PR
without a prior issue will be pointed back here.

## Everything else: companion servers

MCP clients already run several servers side by side, so the long tail does not
need to live in this repository. A service outside the curated set can ship as its
own MCP server, owned and released by its author, running next to this one with its
own scope grant. The README links community companion servers that follow the same
conventions: declared side effects on every tool and no freestanding send action.

This replaces an earlier idea of an in-repo loader for external modules. A loader
would have been a new interface to maintain (module compatibility, loading
diagnostics, a boundary between core guarantees and third-party annotations) from
a maintainer who is already the bottleneck. A separate server needs none of that.

## Options considered

- **B, a profile system:** generate services from `gws schema` and stop
  hand-reviewing them. Rejected: generation reduces typing, not trust review. A
  schema can't say whether a scope is appropriate, whether setup preserves an
  existing credential, or whether a side-effect annotation is honest, and that
  review is what this server exists to do.
- **C, contributor-owned service layer:** scoped commit rights for the contributor
  generating the review load. Rejected for two reasons. The maintainer would still
  review side-effect annotations, which is most of the review cost, so the
  bottleneck would not move. And `CODEOWNERS` assigns reviewers; it does not limit
  write access, so a real boundary would need rulesets and release hardening on a
  server whose pitch is being the permissions layer.

## Revisiting

A service can move into the core when real demand appears. Open an issue, ideally
pointing at a companion server people already use.
