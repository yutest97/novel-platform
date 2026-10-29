import { APP_VERSION, STAGE } from '@novel/shared';

export default function HomePage(): React.ReactElement {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '48rem',
        margin: '0 auto',
        padding: '3rem 1.5rem',
        lineHeight: 1.7,
      }}
    >
      <h1>AI 小说写作平台</h1>
      <p>当前阶段：{STAGE}（工程骨架与持续集成）。</p>
      <p>版本：{APP_VERSION}</p>
      <p>本阶段不包含注册、登录、会话、权限，也未创建任何小说业务表， 更未接入任何真实模型 API。</p>
      <p>
        健康检查：
        <a href="/api/healthz">/api/healthz</a>
      </p>
    </main>
  );
}
