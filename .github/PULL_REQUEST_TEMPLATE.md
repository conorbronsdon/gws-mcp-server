## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `npm run lint` and `npm test` pass (tests mock the executor, no real `gws` calls)
- [ ] New tools are narrowly scoped and map to a single `gws` CLI command (keep the curated contract)
- [ ] No shell-injection surface: args go through `src/executor.ts`, never string-concatenated commands
- [ ] README service/tool list and total count updated if tools were added or changed
