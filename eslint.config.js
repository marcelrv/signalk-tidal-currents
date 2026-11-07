// ESLint flat config for the plugin (src/, test/). Bug-catching only:
// no formatting/stylistic rules. The webapp has its own config in webapp/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/', 'dist-test/', 'public/', 'webapp/', 'node_modules/', 'test/data-opencpn/',
      // Vendored pdf.js-derived JPEG2000 decoder (@ts-nocheck) — kept as
      // close to upstream as possible, see src/jpx/README.md.
      'src/jpx/',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', {
        // node:test's test()/describe() return promises the runner tracks
        // itself; awaiting them at top level is not required.
        allowForKnownSafeCalls: [
          { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
        ],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // `_`-prefixed names are intentionally unused (matches tsc's
      // noUnusedParameters convention).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Tests poke at loosely-typed fakes and JSON bodies; `any` there is
    // deliberate and not a bug signal.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
