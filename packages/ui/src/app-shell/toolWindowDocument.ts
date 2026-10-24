/** 独立工具窗口只复制展示资源，业务代码和连接仍由 opener 持有。 */
export function synchronizeToolWindowDocument(source: Document, target: Document) {
  const base = target.createElement("base");
  base.href = source.baseURI;
  target.head.append(base);
  const styleNodes: Node[] = [];
  const copyStyles = () => {
    for (const node of styleNodes) node.parentNode?.removeChild(node);
    styleNodes.length = 0;
    for (const node of source.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const clone = node.cloneNode(true) as HTMLElement;
      if (node.tagName === "LINK") clone.setAttribute("href", (node as HTMLLinkElement).href);
      styleNodes.push(clone);
      target.head.append(clone);
    }
  };
  const copyTheme = () => {
    for (const name of ["class", "style", "lang", "dir"]) {
      const value = source.documentElement.getAttribute(name);
      if (value === null) target.documentElement.removeAttribute(name);
      else target.documentElement.setAttribute(name, value);
    }
    target.body.style.cssText = "margin:0;height:100vh;overflow:hidden";
  };
  copyStyles();
  copyTheme();
  const styles = new MutationObserver(copyStyles);
  const theme = new MutationObserver(copyTheme);
  styles.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  theme.observe(source.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "lang", "dir"],
  });
  return () => {
    styles.disconnect();
    theme.disconnect();
  };
}
