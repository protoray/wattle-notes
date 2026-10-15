import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
export default ts.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri/target',
      'playwright-report',
      'test-results',
      'website/dist/**',
      'release/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': hooks },
    rules: { ...hooks.configs.recommended.rules },
  },
  { files: ['**/*.{js,mjs}'], languageOptions: { globals: globals.node } },
  { files: ['website/**/*.js'], languageOptions: { globals: globals.browser } },
);
