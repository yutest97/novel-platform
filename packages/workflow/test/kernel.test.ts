/**
 * 确定性工作流内核（A1-1）。
 *
 * 证明：固定步骤顺序、检查点回调、取消语义、错误分类、租约丢失不被吞。
 * 这些用例不连数据库。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NonRetryableTaskError,
  RetryableTaskError,
  TaskLeaseLostError,
  WorkflowError,
} from '../src/errors.js';
import {
  WorkflowKernel,
  WorkflowRegistry,
  WorkflowStepError,
  type WorkflowStep,
  type WorkflowTaskEnvelope,
} from '../src/kernel.js';

const task: WorkflowTaskEnvelope = {
  taskId: 'task-1',
  workId: 'work-1',
  chapterId: null,
  requestId: 'req-1',
  taskType: 'test.flow',
  input: { value: 1 },
};

function registryWith(steps: readonly WorkflowStep[]): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.register({ taskType: 'test.flow', steps });
  return registry;
}

function options(
  overrides: {
    cancelled?: boolean[];
    onStep?: (step: string) => Promise<void>;
    signal?: AbortSignal;
  } = {},
) {
  const queue = [...(overrides.cancelled ?? [])];
  return {
    signal: overrides.signal ?? new AbortController().signal,
    isCancelled: vi.fn(async () => queue.shift() ?? false),
    onStepCompleted: vi.fn(overrides.onStep ?? (async () => undefined)),
  };
}

describe('WorkflowRegistry', () => {
  it('拒绝重复 taskType / 空步骤 / 重复步骤名', () => {
    const registry = new WorkflowRegistry();
    registry.register({
      taskType: 'test.flow',
      steps: [{ name: 'a', run: async () => undefined }],
    });
    expect(() =>
      registry.register({
        taskType: 'test.flow',
        steps: [{ name: 'b', run: async () => undefined }],
      }),
    ).toThrow(WorkflowError);
    expect(() => registry.register({ taskType: 'test.empty', steps: [] })).toThrow(WorkflowError);
    expect(() =>
      registry.register({
        taskType: 'test.dup',
        steps: [
          { name: 'x', run: async () => undefined },
          { name: 'x', run: async () => undefined },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('未注册的 taskType 直接报错', () => {
    const kernel = new WorkflowKernel(new WorkflowRegistry());
    return expect(
      kernel.execute({ ...task, taskType: 'missing.flow' }, options()),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_REGISTERED' });
  });
});

describe('WorkflowKernel', () => {
  it('按注册顺序执行，每步后写检查点', async () => {
    const calls: string[] = [];
    const registry = registryWith([
      {
        name: 'first',
        run: async (context) => {
          calls.push(`first:${context.stepName}`);
        },
      },
      {
        name: 'second',
        run: async (context) => {
          calls.push(`second:${context.task.taskId}`);
        },
      },
    ]);
    const kernel = new WorkflowKernel(registry);
    const opts = options();

    const result = await kernel.execute(task, opts);

    expect(calls).toEqual(['first:first', 'second:task-1']);
    expect(result).toEqual({ status: 'succeeded', completedSteps: ['first', 'second'] });
    expect(opts.onStepCompleted.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
  });

  it('步骤之间检测到取消：停止后续步骤并返回 cancelled', async () => {
    const second = vi.fn(async () => undefined);
    const registry = registryWith([
      { name: 'first', run: async () => undefined },
      { name: 'second', run: second },
    ]);
    const kernel = new WorkflowKernel(registry);
    // 第 1 次（第一步前）false；第 2 次（第二步前）true
    const result = await kernel.execute(task, options({ cancelled: [false, true] }));

    expect(second).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'cancelled', completedSteps: ['first'] });
  });

  it('全部步骤完成后再次检查取消：取消优先于成功', async () => {
    const registry = registryWith([{ name: 'only', run: async () => undefined }]);
    const kernel = new WorkflowKernel(registry);
    // 第一步前 false，最后再检查一次 true
    const result = await kernel.execute(task, options({ cancelled: [false, true] }));
    expect(result.status).toBe('cancelled');
  });

  it('可重试错误：包装为 retryable=true，保留稳定 code', async () => {
    const registry = registryWith([
      {
        name: 'flaky',
        run: async () => {
          throw new RetryableTaskError('MODEL_TIMEOUT', '模型服务超时');
        },
      },
    ]);
    const kernel = new WorkflowKernel(registry);
    await expect(kernel.execute(task, options())).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      retryable: true,
      stepName: 'flaky',
    });
  });

  it('不可重试错误：retryable=false', async () => {
    const registry = registryWith([
      {
        name: 'reject',
        run: async () => {
          throw new NonRetryableTaskError('TASK_INPUT_INVALID', '输入不合法');
        },
      },
    ]);
    const kernel = new WorkflowKernel(registry);
    await expect(kernel.execute(task, options())).rejects.toMatchObject({
      code: 'TASK_INPUT_INVALID',
      retryable: false,
    });
  });

  it('未知异常按可重试处理，但消息被脱敏', async () => {
    const registry = registryWith([
      {
        name: 'crash',
        run: async () => {
          throw new Error('sk-live-SECRET prompt 正文');
        },
      },
    ]);
    const kernel = new WorkflowKernel(registry);
    try {
      await kernel.execute(task, options());
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowStepError);
      const stepError = error as WorkflowStepError;
      expect(stepError.retryable).toBe(true);
      expect(stepError.code).toBe('WORKFLOW_INTERNAL_ERROR');
      expect(stepError.message).toBe('步骤 crash 执行失败');
      expect(JSON.stringify(stepError)).not.toContain('sk-live-SECRET');
      expect(JSON.stringify(stepError)).not.toContain('正文');
    }
  });

  it('租约丢失不会被包装成普通步骤失败', async () => {
    const registry = registryWith([
      {
        name: 'lease',
        run: async () => {
          throw new TaskLeaseLostError();
        },
      },
    ]);
    const kernel = new WorkflowKernel(registry);
    await expect(kernel.execute(task, options())).rejects.toBeInstanceOf(TaskLeaseLostError);
  });

  it('中止信号：立即停止，不写成功', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => undefined);
    const registry = registryWith([{ name: 'never', run }]);
    const kernel = new WorkflowKernel(registry);
    await expect(
      kernel.execute(task, options({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(TaskLeaseLostError);
    expect(run).not.toHaveBeenCalled();
  });

  it('检查点写入失败：向上抛，不继续下一步', async () => {
    const second = vi.fn(async () => undefined);
    const registry = registryWith([
      { name: 'first', run: async () => undefined },
      { name: 'second', run: second },
    ]);
    const kernel = new WorkflowKernel(registry);
    await expect(
      kernel.execute(
        task,
        options({
          onStep: async () => {
            throw new TaskLeaseLostError();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TaskLeaseLostError);
    expect(second).not.toHaveBeenCalled();
  });
});
