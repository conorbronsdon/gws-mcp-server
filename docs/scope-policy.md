# What belongs in this server: a decision, not yet made

**Status:** proposal, 2026-09-17. Pick option A or B, delete the other, merge.

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

## The fork in the road

Opt-in does not settle this. `index.ts` only registers services named in
`DEFAULT_SERVICES` or passed via `--services`, so a service kept out of the
defaults costs a default user exactly nothing at runtime. It still costs the
maintainer full price: permanent compatibility surface, support load when a
scope or API-enablement step goes wrong, accurate side-effect annotations, and
review time. Opt-in protects the default profile, not the project.

So "add it but keep it off the default route" is not a middle path. It is
option B with extra steps.

### Option A — stay a curated set

The pitch stays "N focused tools instead of 400." Inclusion means *we think you
need this*. The long tail lives outside the repo.

- Forms (#63) is declined, with the work pointed at an extension path.
- Contacts (#62) was already at the edge of the envelope.
- Next build: a documented way to load an external service module by path, so
  contributors ship and support their own.

**Cost:** you turn away good work and a productive contributor may leave.

### Option B — become a profile system

The pitch becomes "gws, with safe defaults and declared side effects." Breadth
is a feature; the default profile is the curation.

- Forms merges. So does most of what follows.
- Next build: generate service definitions from `gws schema` with a contract
  test, so adding a service is mechanical rather than a 250-line hand review.
- Hand-reviewing service PRs stops. The generator is the reviewer.

**Cost:** the "instead of 400" line stops being the differentiator, and the
README needs rewriting around defaults and declared side effects instead.

**Recommendation: A.** The curated set is what makes this the permissions leg of
trust infrastructure rather than another API wrapper. But B is a real product and
an honest one; what does not work is accepting contributions on B's logic while
keeping A's pitch, which is what has been happening.

---

## Draft scope rule — if A

> ### What belongs here
>
> This server is curated. Tools are chosen, not generated, and every tool added
> is one the maintainers commit to supporting indefinitely.
>
> A service belongs here when all of these hold:
>
> - It is on the critical path of an agent doing real work in a Workspace: reading and writing the documents, mail, calendar, files and tasks people actually live in.
> - It works within the default scope grant, or the case for an extra scope is strong enough to justify the setup cost for every user who enables it.
> - Its tools have side effects that can be declared precisely.
>
> A service does not belong here merely because the API exists, because the
> coverage looks incomplete, or because the tools can be kept off the default
> profile. Off-by-default still costs maintenance, support and review.
>
> For anything outside that line, see [extending the server](#extending)
> — external service modules load by path and stay under their author's
> ownership, which is usually what a niche integration wants anyway.

## Draft scope rule — if B

> ### What belongs here
>
> This server aims to cover the Workspace surface `gws` exposes, with two
> constraints that make breadth safe: a small default profile, and declared side
> effects on every tool.
>
> New services are generated from `gws schema` and must ship with a contract
> test that exercises every tool against the real CLI. Hand-written service
> definitions are not accepted, because they drift.
>
> A service is added to `DEFAULT_SERVICES` only when it works within the default
> scope grant and is on the critical path of everyday Workspace work. Everything
> else ships opt-in via `--services`.

---

## If A: the reply to #63

> Thanks for this, and for the care in it — live-testing through the CLI caught
> the `forms forms responses` nesting before it shipped, and deferring
> `forms_forms_watches` was the right call without being asked.
>
> I'm not going to merge it, and the reason isn't the PR. This server went from
> 41 tools to 63 in two weeks, and Forms would make it 69. That's faster than I
> can think about what the server is supposed to be, and the answer has to come
> from a rule rather than from me reacting to each PR. I've written the rule
> down in `docs/scope-policy.md`: curated set, critical-path services, no new
> scopes without a strong case. Forms doesn't clear it — mostly on the extra
> scope and the separate API enablement, which your own self-review showed can
> silently clobber a user's credential.
>
> What I'd rather do than waste the work: I want a documented way to load an
> external service module by path, so Forms can live in your repo, with your
> name on it, and work with this server without going through me. If that's
> interesting, I'll build the loader and Forms can be the first one.
>
> Separately — you've written a real share of this server. If you want more
> ownership than "contributor," say so and let's talk about what that looks
> like.

## Housekeeping spotted along the way

- The README says 67 tools. Main has 63.
