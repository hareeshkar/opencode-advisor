# Contributing

PRs welcome. Ground rules that keep this plugin trustworthy:

1. **Zero runtime dependencies.** Type-only SDK imports, Node builtins, nothing else. The bundle must stay a single copy-into-place file.
2. **Tests before merge.** `npm test` must pass; new engine/pruner behavior needs a test (the suites run against the built bundle — run `npm run build` first).
3. **Token efficiency is a feature.** Any change that adds tokens to the hot path (prompts, injections, transcript forwarding) must justify them.
4. **Fail loud, degrade safe.** Config errors throw at load; hook bodies never break the host's model call; error codes stay aligned with the native advisor contract.
5. **Respect the research dossier.** Design changes that contradict `research/` findings need either new evidence or an update to the dossier — not silent divergence.

House style: TypeScript strict, named exports, no default-exported magic beyond the required dual plugin entrypoint.
