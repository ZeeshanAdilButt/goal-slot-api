module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/'],
  rules: {
    // This codebase consistently prefixes a deliberately-unused binding with
    // `_` (e.g. `const { id: _id, ...updateData } = dto`) and destructures
    // to drop a field before persisting/returning the rest (e.g.
    // `const { password, ...sanitized } = user`). Both are intentional,
    // pervasive patterns predating this config, not oversights.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
  overrides: [
    {
      // Unit/e2e specs lean on `any` throughout for jest mock factories
      // (e.g. mocking individual Prisma methods) and for asserting on
      // supertest response bodies, whose shape isn't worth modelling twice.
      // This is standard test-only practice; it's scoped to spec files only
      // so production code under src/ still gets full type checking.
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
