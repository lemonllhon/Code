/** 仅在当前媒体消费者结束后调用；URL/远端 preview 的释放仍由原 owner 负责。 */
export function releaseMediaDecoder(element: HTMLMediaElement): void {
  // 只移除 React 节点不保证立刻结束媒体网络/解码资源；与壁纸的既有释放顺序一致。
  element.pause();
  element.removeAttribute("src");
  element.load();
}
