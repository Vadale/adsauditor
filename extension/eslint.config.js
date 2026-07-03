// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['.wxt/**', '.output/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // WXT auto-imports (defineContentScript, defineBackground, browser, ...) are
      // declared as ambient globals in .wxt/types/*.d.ts for tsc, but ESLint's scope
      // analysis doesn't see cross-file ambient declarations. `no-undef` on TS files is
      // redundant with tsc anyway (typescript-eslint's own recommendation), so it's off
      // here rather than hand-maintaining a globals list that duplicates WXT's codegen.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  eslintConfigPrettier,
);
