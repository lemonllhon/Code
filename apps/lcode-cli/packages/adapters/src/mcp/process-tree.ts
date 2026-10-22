// MCP 与供应商授权复用同一 Node 进程树清理，原入口保留兼容。
export { terminateNodeProcessTree as terminateMcpStdioProcessTree } from "@lcode/provider-node";
