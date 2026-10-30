import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'AI 小说写作平台',
  description: '封闭源码、限定用户使用的中文 AI 小说写作系统',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body>
        {/* 弹窗通过 Portal 渲染到 body，并把 #app-root 设为 inert 实现模态隔离 */}
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
