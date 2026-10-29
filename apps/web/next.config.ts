import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // standalone 产物体积更小，供 Docker 镜像使用。
  output: 'standalone',
  // 遥测通过 NEXT_TELEMETRY_DISABLED=1 环境变量关闭（见 Dockerfile 与 package.json）。
  reactStrictMode: true,
};

export default nextConfig;
