import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['build/**', 'coverage/**', 'node_modules/**', '*.config.*'],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // keep signal high, noise low
      '@typescript-eslint/no-unused-vars': ['warn'],
      // Warn, don't fail: CDA/CMA responses are loosely-typed JSON and several functions here
      // deliberately type them as `any` rather than hand-maintaining a shadow interface.
      '@typescript-eslint/no-explicit-any': ['warn'],
      'react/react-in-jsx-scope': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
];
