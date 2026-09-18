# What belongs in this server: a decision, not yet made

**Status:** proposal, revised 2026-09-17 after a [cross-model review](https://github.com/conorbronsdon/gws-mcp-server/pull/64#issuecomment-5724551349). Pick an option, delete the others, merge.

This exists because individual contributions keep being reasonable while the
aggregate keeps drifting, which is the usual sign that the inclusion rule lives
in the maintainer's head rather than in the repo.

## The numbers

Counting unique tool names in `src/services.ts`:

| Date | Tools |
|---|---:|
| Before the first community service PR (#34, Slides) | 37 |
| 2026-09-03 | 41 |
| 2026-09-10 | 47 |
| 2026-09-17 | 63 |

**41 to 63 in fourteen days**, a 50% increase, all of it from seven PRs by one
contributor between 09-08 and 09-14. PR #63 (Forms, 6 tools) would make it 69,
so the fortnight would end at +68%. Drive is now 21 tools on its own.

The contributions are good: live-tested through the real CLI, one caught a
command-path nesting bug, another deferred a marginal tool unprompted. Quality is
not the problem. Rate and direction are, and neither is the contributor's job to
manage.

## What opt-in does and doesn't solve

`index.ts` only registers services named in `DEFAULT_SERVICES` or passed via
`--services`, so a service kept out of the defaults costs a default user exactly
nothing at runtime. Three costs behave differently and are worth separating:

| Cost | Does opt-in reduce it? |
|---|---|
| Default user's tool list and scope exposure | **Yes, to zero.** |
| Ongoing support and side-effect accuracy | **Partly.** Load scales with activation, and an off-by-default service has little. |
| Initial review, and permanent compatibility surface | **No.** Paid in full at merge, then carried forever. |

An earlier draft claimed opt-in "still costs the maintainer full price." That was
too strong. The cost opt-in does not touch is **review and permanent
maintenance**, which happens to be the one the maintainer is out of. That points
at a different fix than a default-list flag.

## Three options

### Option A — stay a curated set, long tail outside the repo

Inclusion means *we think you need this*. Decline Forms, and build a documented
way to load an external service module by path so contributors ship and support
their own.

**Cost:** you turn away good work, and the loader is itself a new interface to
maintain: module compatibility, dependency failures, loading diagnostics, and a
boundary between core guarantees and third-party side-effect annotations.
Committing to build it is a second decision, not a consolation prize stapled to
the first.

### Option B — become a profile system

Breadth is the feature; the small default profile is the curation. Forms merges,
and so does most of what follows. Services are generated from `gws schema` with
contract tests, and hand-reviewing service PRs stops.

**Cost:** the "instead of 400" line stops being the differentiator and the README
needs rewriting around defaults and declared side effects. And generation cuts
typing, not trust: a schema cannot tell you whether a scope is appropriate,
whether setup preserves an existing credential, or whether a side-effect
annotation is honest. That review is the thing this project exists to do.

### Option C — curated core, contributor-owned service layer

Keep A's rule for what belongs and what ships by default. Change **who reviews**.
The contributor generating the load gets commit rights scoped to the service
layer, under the same rule, with:

- A named owner per service, recorded in the repo, who answers its issues.
- `CODEOWNERS` scoping that authority to service definitions, not the executor, auth handling, or releases.
- A required contract test per service, exercised against the real CLI.
- Side-effect annotations still reviewed by the maintainer, because that is the trust claim.
- No npm publish rights, no release authority.

**Cost, and it is the one the reviewers did not raise:** this server's whole
pitch is being the permissions leg of trust infrastructure. Granting commit
rights to a contributor with roughly six weeks of history carries a supply-chain
dimension an ordinary project doesn't. The constraints above exist for that
reason, and if they still feel insufficient, that is a legitimate reason to pick
A instead.

**Recommendation: C, with A as the fallback if shared ownership isn't wanted.**
C is the only option that addresses the actual bottleneck, which is review
capacity rather than tool count. B stays a coherent and honest product; what does
not work is accepting contributions on B's logic while keeping A's pitch, which
is what has been happening.

---

## Draft scope rule — A or C

> ### What belongs here
>
> This server is curated. Tools are chosen, not generated, and every tool added
> is one the maintainers commit to supporting indefinitely.
>
> A service belongs here when all of these hold:
>
> - It is on the critical path of an agent doing real work in a Workspace: reading and writing the documents, mail, calendar, files and tasks people actually live in.
> - It works within the default scope grant, or the case for an extra scope is strong enough to justify the setup cost for every user who enables it.
> - Its tools have side effects that can be declared precisely, and a named owner who answers issues about them.
>
> A service does not belong here merely because the API exists, because coverage
> looks incomplete, or because the tools can be kept off the default profile.
>
> These are judgments, not tests, and writing them down does not make them
> mechanical. What it does is put the judgment somewhere it can be argued with,
> rather than in a maintainer's head where it can only be guessed at.

## Draft scope rule — B

> ### What belongs here
>
> This server aims to cover the Workspace surface `gws` exposes, with two
> constraints that make breadth safe: a small default profile, and declared side
> effects on every tool.
>
> New services are generated from `gws schema` and must ship with a contract test
> that exercises every tool against the real CLI. Hand-written service definitions
> are not accepted, because they drift.
>
> Generation does not cover scope appropriateness, credential-preserving setup, or
> side-effect honesty. Those stay human review, and they are the gate.
>
> A service joins `DEFAULT_SERVICES` only when it works within the default scope
> grant and is on the critical path of everyday Workspace work. Everything else
> ships opt-in via `--services`.

---

## The reply to #63, if A or C

> You've written a real share of this server, seven PRs in a fortnight, and the
> care shows: live-testing through the CLI caught the `forms forms responses`
> nesting before it shipped, and you deferred `forms_forms_watches` without being
> asked. So let me start with the thing that matters more than this PR.
>
> Do you want ownership of the service layer? Commit rights scoped to service
> definitions, your name on the services you've written, and a say in what gets
> in. I'd keep review of side-effect annotations and anything touching auth or the
> executor, because that's the promise this server makes to the people running it.
> If that's interesting, let's set it up this week.
>
> On Forms specifically: I'm holding it, and the reason isn't the PR. This server
> went from 41 tools to 63 in two weeks, which is faster than I've been able to
> think about what it's supposed to be. That's my failure to write the rule down,
> not yours to guess it. The rule is in `docs/scope-policy.md` now: curated set,
> critical-path services, extra scopes only with a strong case. Forms sits outside
> it today, mostly on the extra scope and the separate API enablement.
>
> If you'd rather ship Forms than wait on that, I'll support an external module
> that loads by path, with your name on it. I'd want you to design the loader,
> since you'd be its first user and I don't want to hand you something that
> doesn't fit what you're building.
>
> Separately: the credential-replacement behaviour you found in `gws auth login`
> deserves its own issue. That's one login-command problem affecting every
> service, and it's worth fixing wherever Forms ends up.

## Tasks this creates

- [ ] README says 67 tools; main has 63. Fix when touching either.
- [ ] File the `gws auth login` credential-replacement issue separately from #63.
- [ ] If C: add `CODEOWNERS`, a per-service owner field, and the contract-test requirement before granting any rights.
