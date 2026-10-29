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
  // 扁平、无符号链接的生产依赖目录（deploy 产物 0 个符号链接），可随镜像移动。
  // 遥测通过 NEXT_TELEMETRY_DISABLED=1 环境变量关闭（见 Dockerfile）。
  reactStrictMode: true,
};

export default nextConfig;
