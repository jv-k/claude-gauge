# 1. The setup questions use Ink 5 on demand, with the readline wizard as the fallback

- Status: accepted
- Date: 2026-10-11
- Issue: #103

## Context

`claude-gauge setup` and `configure` ask their questions through readline, with the VerBump look from #102. A typed answer cannot give arrow-key choices, a list of parts to tick, or a preview that redraws as the selection moves. [Ink](https://github.com/vadimdemedes/ink) gives all three, but it has costs:

- It is the package's first runtime dependency.
- Ink 4 and later are ES modules only. The build is CommonJS, and with `module: CommonJS` TypeScript compiles a dynamic `import()` to a `require()`, which cannot load an ES module on Node 18.
- Ink needs a terminal in raw mode. Piped answers, and the CLI tests that pipe theirs, still need a reader of typed lines.
- The plugin runs `node dist/cli.js` from its own checkout, which has no `node_modules`.
- Ink 6 needs Node 20 and React 19, and `engines` allows Node 18.

## Decision

The owner chose option 1 on 2026-10-11:

- `ink` 5.x and `react` 18.x are `dependencies`. Ink 6 and React 19 wait until `engines` drops Node 18.
- The CLI loads Ink with a dynamic `import()`, and only when stdin and stdout are both a terminal. When either is not a terminal, or Ink cannot be loaded, as in the plugin's checkout, the readline wizard runs as before, with no warning.
- The build keeps CommonJS output, with `module` and `moduleResolution` set to `node16`, so the `import()` stays an `import()` in `dist/`. `esModuleInterop` stays off, so the other modules build as before.
- One wizard (`src/wizard.ts`) holds the questions, their defaults and their answers. Each question has a typed form and a choice form. The Ink front end (`src/ink-io.ts`) shows only the choice form, and a test checks that both forms give the same answers for the same choices.

## Options turned down

- **Bundle Ink into `dist/`.** The plugin's checkout would get the Ink questions too. But `dist/cli.js` would grow by Ink, React and Yoga, and the build would need a bundler step.
- **No Ink.** Keep the readline wizard with the VerBump look from #102, and close #103 as `wontfix`. This keeps the package free of dependencies, but gives no arrow keys, no list to tick, and no preview before an answer is accepted.

## Consequences

- Installing `@jv-k/claude-gauge` from npm also fetches Ink, React and their dependencies.
- The command has two front ends. A change to a question changes its typed form and its choice form, in the same place in `src/wizard.ts`.
- The plugin's checkout and piped input always get the typed questions.
- The tests drive the Ink front end with `ink-testing-library`, a dev dependency, on every Node version in the matrix and on Bun.
