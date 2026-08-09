'use strict';
/**
 * v2.6.0 Agent Integration Hub — 统一 AgentAdapter 接口（spec §4.3）。
 *
 * 所有 Agent 接入（Native / Codex / WorkBuddy / MCP / HTTP / CLI ...）
 * 必须实现本基类定义的方法集合，Hub 路由层只依赖这套接口，不感知
 * 具体 Agent 的传输细节。基类为纯接口：每个方法默认抛 NOT_IMPLEMENTED，
 * 子类按自身 transport 实现覆盖。
 *
 * 生命周期：
 *   detect()      → 判定 Agent 在本机是否可用（写回 availability / health）
 *   healthCheck() → 周期性探活，产出 { status, latencyMs, ... }
 *   startTask()   → 发起一次 Run，返回 runId
 *   sendMessage() → 向运行中 Run 追加消息 / 指令
 *   getStatus()   → 查询当前生命周期状态（非阻塞）
 *   getResult()   → 取终态结果（completed 后才有效）
 *   cancel()      → 取消运行中 Run
 *   dispose()     → 释放底层资源（进程 / 连接 / 句柄）
 */

/**
 * 统一 Agent 适配器基类（抽象接口）。
 * 子类通过覆盖方法接入具体 Agent；未覆盖的方法调用即抛 NOT_IMPLEMENTED。
 */
const { HEALTH_STATE } = require('../hub/types');

class BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest Agent manifest（id / displayName / source / transport / capabilities ...）
   * @param {object} [opts.config] 适配器运行配置（凭证 / 路径 / 超时等）
   */
  constructor({ manifest, config } = {}) {
    this.manifest = manifest || {};
    this.config = config || {};
    // v2.7.0 — 暴露 manifest 派生属性，满足 registry / router / healthManager 契约：
    // registry.register 要求 adapter.id；router 按 adapter.capabilities 排序；
    // listAvailable 按 adapter.disabled / adapter.available 过滤。
    this.id = this.manifest.id;
    this.transport = this.manifest.transport || null;
    this.adapterType = this.manifest.transport || null;
    this.disabled = false;
    this.available = this.manifest.availability !== false;
    this.healthStatus = HEALTH_STATE.UNKNOWN;
    this.maxConcurrency = this.manifest.maxConcurrency || 1;
    const capsObj = this.manifest.capabilities || {};
    this.capabilities = Object.keys(capsObj).filter(k => capsObj[k]);
  }

  /**
   * 返回 Agent manifest 的规范视图。
   * 字段：id, name, adapterType, capabilities, transport, availability, version, path, maxConcurrency。
   * 子类应将 manifest 归一化为本形状。
   */
  getManifest() {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 探测 Agent 在当前系统是否可用。返回 boolean 或更新后的 availability 信息。 */
  async detect() {
    throw new Error('NOT_IMPLEMENTED');
  }

  /**
   * 健康检查。
   * @returns {Promise<{ status: string, version: string|null, latencyMs: number, detail: string }>}
   */
  async healthCheck() {
    throw new Error('NOT_IMPLEMENTED');
  }

  /**
   * 启动一次任务 Run。
   * @param {object} task    任务描述（goal / steps / 约束）
   * @param {object} context 运行上下文（项目路径 / 权限 / 会话）
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context) {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 向运行中的 Run 发送消息 / 追加指令。 */
  async sendMessage(runId, message) {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 取消运行中的 Run。 */
  async cancel(runId) {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 查询 Run 当前生命周期状态（非阻塞）。 */
  async getStatus(runId) {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 取已完成的 Run 的最终结果。 */
  async getResult(runId) {
    throw new Error('NOT_IMPLEMENTED');
  }

  /** 释放底层资源（进程 / 连接 / 句柄）。 */
  async dispose() {
    throw new Error('NOT_IMPLEMENTED');
  }
}

module.exports = { BaseAgentAdapter };
