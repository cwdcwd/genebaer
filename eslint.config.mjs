// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Shared flat config for the genebaer monorepo.
 *
 * Each package runs `eslint . --config ../../eslint.config.mjs`, so this file is
 * resolved from the package's own cwd — keep every pattern below relative, not
 * anchored to the repo root.
 *
 * Type-aware rules are enabled via `projectService`, which resolves the nearest
 * tsconfig.json for each linted file — so this one config serves all four
 * packages without naming any of their tsconfigs.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Config files (eslint.config.mjs, vitest.config.ts, next.config.*) are not
  // part of any package's tsconfig `include`, so type-aware rules have no type
  // information for them and would error on that alone.
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.{ts,mts,cts}'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Underscore prefix is the escape hatch for intentionally unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-else-return': 'error',
      'object-shorthand': 'error',
    },
  },

  // React components: registers the rules that inline `eslint-disable
  // react-hooks/exhaustive-deps` comments in apps/web refer to. Without the
  // plugin loaded, those comments are themselves lint errors.
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Fastify route handlers are conventionally declared `async` whether or not
  // they await — the framework keys off the returned promise. require-await is
  // a style rule, and enforcing it here would mean rewriting idiomatic handlers
  // to satisfy the linter. The rules that actually catch async bugs
  // (no-floating-promises, no-misused-promises, await-thenable) stay on.
  {
    files: ['packages/server/**/*.ts', 'src/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Test files lean on fixtures and deliberate edge cases.
  //
  // Type-aware rules are disabled here because core's and server's tsconfigs
  // deliberately `exclude` test files from the build, so the project service
  // has no type information for them. See genebaer-uyf: that exclusion also
  // means `pnpm typecheck` does not cover test files at all.
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.test-d.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
