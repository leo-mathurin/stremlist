import baseConfig from '@hono/eslint-config'

export default [
  { ignores: ['dist/**', 'eslint.config.mjs'] },
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      curly: ['error', 'multi-line'],
    },
  },
]
