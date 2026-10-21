/** Host/CLI 的 Git 子进程适配公开入口，不加载模型、OAuth 插件或会话运行时。 */
export { createGitCredentialHelper, type GitCredentialResolver } from "./git-credential-helper.js";
export { runGitCredentialHelper } from "./git-credential-helper-runner.js";
