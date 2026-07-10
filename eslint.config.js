// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // src/integration/** ships plain .md/.sh/.js shim artifacts (copied verbatim by `aistats
    // install`, never compiled by tsc) — not part of the strict TS project graph.
    ignores: ['dist/**', 'node_modules/**', 'src/integration/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
