// 供隔离验收驱动复用现有 OS 采集器；不会在 Main 增加定时器或外部进程探测。
export { createProcessResourceTableReader } from "./process/processResourceSampler.js";
