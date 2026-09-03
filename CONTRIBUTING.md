# Contributing to Zoteus

Thanks for your interest in improving Zoteus! Contributions of all kinds are welcome — bug reports, docs, tests, and code.

## Getting started

```bash
git clone https://github.com/oscardvs/zoteus
cd zoteus
npm install
npm test          # vitest run
```

Zoteus targets **Node >= 20.19** and is written in TypeScript (NodeNext ESM).

## Development workflow

| Task | Command |
|---|---|
| Run the test suite | `npm test` |
| Watch tests | `npm run test:watch` |
| Type-check `src/` | `npm run typecheck` |
| Type-check the tests | `npm run typecheck:tests` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Build | `npm run build` |
| Run from source | `npm run dev` |
| Inspect with the MCP Inspector | `npm run inspector` |

## House rules

- **Tests first.** Zoteus is developed test-first with Vitest. New behavior should land with a test that fails before your change and passes after. Don't commit red tests.
- **ESM imports.** This is a NodeNext ESM project — **relative imports must end in `.js`** (e.g. `import { foo } from './foo.js'`), even though the source is `.ts`.
- **Keep the gate green.** Before opening a PR, run `npm run typecheck && npm run typecheck:tests && npm run lint && npm test` and make sure all four pass. `npm run typecheck` covers `src/` only, because the build project has to keep its `rootDir`/emit contract; `npm run typecheck:tests` compiles `src/` and `tests/` together under `tsconfig.test.json`, and it is blocking in CI.
- **Tool design.** Zoteus favors a small set of consolidated, well-described `zotero_*` tools with structured output over thin one-to-one endpoint mirrors. New tools should fit that philosophy.
- **Safety.** Writes are versioned and reversible by default; destructive operations stay opt-in and confirmation-gated. Preserve those invariants.

## Pull requests

1. Fork and create a topic branch.
2. Make your change with accompanying tests and docs.
3. Ensure `npm run typecheck && npm run typecheck:tests && npm run lint && npm test` are all green.
4. Open a PR describing the change and the motivation. Keep commits focused; conventional-commit style (`fix:`, `feat:`, `docs:`…) is appreciated.

## Reporting bugs / security

- **Bugs & features:** open a [GitHub issue](https://github.com/oscardvs/zoteus/issues) with steps to reproduce.
- **Security:** please report privately rather than in a public issue — email `support@zoteus.com`.

By contributing, you agree that your contributions are licensed under the project's [MIT License](./LICENSE).
