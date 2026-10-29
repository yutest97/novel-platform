import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint 扁平配置（flat config）。
 *
 * 分流说明：
 * - `sourceFiles`：工作区 TS/TSX 源码，使用**类型感知**规则（projectService）。
 * - `scriptFiles`：仓库级 .mjs 脚本（eslint 配置、许可证扫描、Prisma seed），
 *   使用**非类型感知**规则 + Node 全局变量。这些文件不属于任何 tsconfig 工程。
 */
const sourceFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];
const scriptFiles = ['**/*.mjs'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      'docs/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: sourceFiles })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: sourceFiles })),
  {
    files: sourceFiles,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['packages/db/prisma.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript 已能识别未定义标识符，关闭 ESLint 的重复检查。
      'no-undef': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-console': 'off',
    },
  },
  {
    files: scriptFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      // 脚本处理 JSON.parse 结果，any 不可避免；此处只应用基础 ESLint 规则。
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 测试文件允许宽松规则
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  prettier,
);
