import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 账号总数上限（10 个）——单独成文件，**最后执行**。
 *
 * 为什么独立：这个用例会故意把账号数补齐到 10 个，之后任何需要
 * "再创建账号"的用例都会撞上上限。Playwright 按文件名字母序执行，
 * 因此本文件命名为 z- 前缀，确保它在其它用例之后跑。
 *
 * 前置：admin-flow.spec.ts 已经完成管理员首次登录与改密，
 * 并把改密后的口令写入共享文件（见 e2e/shared-credentials.ts）。
 */

import { ADMIN_EMAIL, ORIGIN, readAdminPassword } from './shared-credentials.js';

// 延迟读取（模块顶层读取会在测试收集阶段失败）
let password = '';

test('第 11 个账号：页面与服务端都拒绝', async ({ browser }) => {
  const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = await context.newPage();

  password = readAdminPassword();

  // 用改密后的口令登录管理员
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/admin\/users/);

  // 通过接口快速补齐到 10 个账号（管理员 + 作者 + 若干）
  const listResponse = await page.request.get('/api/admin/users');
  const list = (await listResponse.json()) as { users: { email: string }[] };
  const missing = 10 - list.users.length;
  for (let index = 0; index < missing; index += 1) {
    const response = await page.request.post('/api/admin/users', {
      headers: { origin: ORIGIN },
      data: { email: `e2e-bulk-${index}-${Date.now().toString(36)}@example.test` },
    });
    expect(response.status()).toBe(201);
  }

  await page.reload();
  await expect(page.getByTestId('users-table')).toBeVisible();

  // 页面出现上限提示
  await expect(page.getByText('账号数量已达上限（10 个），无法继续创建。')).toBeVisible();

  // 仍尝试第 11 个：服务端返回稳定错误码，页面显示中文提示
  await page.getByTestId('create-email').fill(`e2e-over-${Date.now().toString(36)}@example.test`);
  await page.getByTestId('create-submit').click();
  await expect(page.getByTestId('action-error')).toHaveText('账号数量已达上限（10 个）');

  const overLimit = await page.request.post('/api/admin/users', {
    headers: { origin: ORIGIN },
    data: { email: `e2e-over-api-${Date.now().toString(36)}@example.test` },
  });
  expect(overLimit.status()).toBe(409);
  const overLimitBody = (await overLimit.json()) as { error: { code: string } };
  expect(overLimitBody.error.code).toBe('USER_LIMIT_REACHED');

  await context.close();
});
