import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI 小说写作平台',
  description: '封闭源码、限定用户使用的中文 AI 小说写作系统（M1-A 工程骨架）',
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
