import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dados/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // why: a extensão roda no navegador como JavaScript sem build; o contrato tipado dela fica em url.d.ts.
    files: ['apps/extensao/src/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: { chrome: 'readonly', document: 'readonly', HTMLInputElement: 'readonly', URL: 'readonly' },
    },
  },
);
