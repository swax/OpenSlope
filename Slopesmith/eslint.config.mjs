// The lint gate: `npm run lint`, zero findings, run by tools/verify.mjs and CI right after the type-check.
//
// Two stock presets and a short list of decisions, each stated where it is made. The typescript-eslint preset
// is the plain `recommended`, not the type-aware one: type-aware rules re-load the whole program per run,
// which would put this step at the type-check's cost again, and `tsc --noEmit` already owns the type questions.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Build output, local user data (workspace, .slopesmith, Maps, courses, demos, temp), static assets, the
  // deploy tree, and the parts of the tree that are not this project's TypeScript: Blender-side Python under
  // blender/, browser fixtures. Declaration files are the compiler's business, not the linter's.
  globalIgnores([
    'node_modules/**', 'dist/**', 'dist-server/**', 'coverage/**', '.coverage-tmp/**',
    'workspace/**', '.slopesmith/**', 'Maps/**', 'courses/**', 'demos/**', 'temp/**',
    'public/**', 'deploy/**', 'blender/**', 'fixtures/**',
    '**/*.d.ts', '**/*.d.mts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The .mjs and .js files are Node scripts (build, coverage, notice inventory, this file); without these
    // globals `process` and `console` are undefined names.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // A binding that has to exist but is never read - a destructuring slot, a callback parameter before one
      // that is used, a catch clause that keeps the error for shape - is spelt with a leading `_`. Anything
      // else unused is dead code and comes out rather than being renamed around the rule.
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Tests and offline tooling cast freely by design (reaching into private state, shaping fixtures); 152
    // sites are not worth the churn. src/ and scripts/ keep the rule.
    files: ['test/**', 'tools/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
