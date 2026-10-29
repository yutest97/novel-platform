import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 说明：不使用 `output: 'standalone'`。
  // standalone 的 outputFileTracing 在 pnpm monorepo 下无法追踪到 workspace 依赖
  // （@novel/shared、@novel/db 不在 standalone 内），且 Next 16 的 `next start`
  // 与 standalone 配置不兼容（会告警且路由返回 500）。
  //
  // 构建使用 Webpack（见 package.json 的 build 脚本 `next build --webpack`）：
  // Next 16 默认的 Turbopack 会对 pnpm 布局的外部包生成**带 hash 的引用**
  // （如 pg-<hash>），并把实体放在 .next/node_modules/ —— 该目录会被 pnpm deploy
  // 跳过，导致容器内运行时 "Cannot find module 'pg-<hash>'"。
  // Webpack 构建使用普通包名引用，可从扁平 node_modules 正常解析。
  //
  // 容器镜像另用 `pnpm deploy --config.node-linker=hoisted` 生成
  // 扁平的生产依赖目录，可随镜像移动（符号链接由 build-deploy.sh 逐条校验）。
  //
  // serverExternalPackages：`@node-rs/argon2` 是原生模块（.node 二进制），
  // 不能被打包器内联，必须保持为运行时 require。该包经 @novel/auth 传递，
  // 属 web 的生产依赖；hoisted deploy 后位于 node_modules/@node-rs/argon2，
  // 容器内可正常解析。
  //
  // 注意：仅设置 serverExternalPackages 不足以覆盖"经由 workspace 包
  // （@novel/auth）间接引入"的场景（webpack 仍会尝试解析 .node 文件而报错），
  // 因此下方 webpack 配置再显式把该包声明为 commonjs external。
  serverExternalPackages: ['@node-rs/argon2'],

  // Next 的 webpack 回调参数类型为 any，这里显式标注最小结构，
  // 既满足类型安全（避免 unsafe-member-access），又不引入 webpack 类型依赖。
  webpack: (config: { externals: unknown[] }, context: { isServer: boolean }) => {
    if (context.isServer) {
      config.externals.push({ '@node-rs/argon2': 'commonjs @node-rs/argon2' });
    }
    return config;
  },

  // 遥测通过 NEXT_TELEMETRY_DISABLED=1 环境变量关闭（见 Dockerfile）。
  reactStrictMode: true,
};

export default nextConfig;
