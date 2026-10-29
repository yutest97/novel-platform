/**
 * 健康检查的共享类型与纯函数。
 *
 * 设计约束（M1-A）：
 * - 本模块必须是**纯函数**，不引入任何 I/O，便于在 web 与 worker 中复用并单元测试。
 * - 数据库连接失败时，健康检查必须返回**失败**（HTTP 503），不得永远返回 OK。
 */

/** 单个组件的健康状态。 */
export type HealthState = 'ok' | 'degraded' | 'error';

/** 健康检查报告中的单个组件条目。 */
export interface HealthComponent {
  /** 组件名称，例如 'app'、'database'。 */
  readonly name: string;
  /** 组件状态。 */
  readonly status: HealthState;
  /** 可选的补充说明（不含密钥等敏感信息）。 */
  readonly detail?: string;
  /** 探测耗时（毫秒）。 */
  readonly latencyMs?: number;
}

/** 完整健康检查报告。 */
export interface HealthReport {
  /** 服务名，例如 'web'、'worker'。 */
  readonly service: string;
  /** 服务版本号。 */
  readonly version: string;
  /** 聚合后的整体状态。 */
  readonly status: HealthState;
  /** 各组件明细。 */
  readonly components: readonly HealthComponent[];
  /** 进程已运行秒数。 */
  readonly uptimeSeconds: number;
  /** 报告生成时间（ISO 8601）。 */
  readonly timestamp: string;
}

/**
 * 聚合组件状态得到整体状态。
 *
 * 规则：
 * - 任一组件为 `error` → 整体 `error`（数据库不可用等必须判定为失败）。
 * - 无 error 但存在 `degraded` → 整体 `degraded`。
 * - 全部 `ok` → 整体 `ok`。
 */
export function overallStatus(components: readonly HealthComponent[]): HealthState {
  if (components.some((component) => component.status === 'error')) {
    return 'error';
  }
  if (components.some((component) => component.status === 'degraded')) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * 将健康状态映射为 HTTP 状态码。
 *
 * - `ok` / `degraded` → 200（degraded 仍可服务，仅告警）。
 * - `error` → 503（依赖不可用，必须让编排层/探针判定为失败）。
 */
export function httpStatusFor(status: HealthState): number {
  return status === 'error' ? 503 : 200;
}

/** 创建健康报告的入参。 */
export interface CreateHealthReportInput {
  readonly service: string;
  readonly version: string;
  readonly components: readonly HealthComponent[];
  readonly uptimeSeconds: number;
  /** 可注入的时钟，便于测试确定性。 */
  readonly now?: Date;
}

/** 创建一份健康报告（纯函数）。 */
export function createHealthReport(input: CreateHealthReportInput): HealthReport {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    service: input.service,
    version: input.version,
    status: overallStatus(input.components),
    components: input.components,
    uptimeSeconds: input.uptimeSeconds,
    timestamp,
  };
}

/**
 * 判断一份报告是否应被探针判定为"通过"。
 *
 * 只有整体状态不为 `error` 时才算通过 —— 数据库连接失败时必须返回 false。
 */
export function isHealthy(report: HealthReport): boolean {
  return report.status !== 'error';
}

/** 将组件探测结果转换为组件条目。 */
export function toComponent(
  name: string,
  status: HealthState,
  detail?: string,
  latencyMs?: number,
): HealthComponent {
  // 条件展开，避免在 exactOptionalPropertyTypes 下显式写入 undefined。
  return {
    name,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}
