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
      <body>{children}</body>
    </html>
  );
}
