interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}
const files =
  /(?:[a-zA-Z]:[\\/]|\.\.?[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.(?:md|markdown|tsx?|jsx?|json|py|css|html|ya?ml|sh|ps1|rs|go|cs|java|cpp|sql|toml|txt|xml)(?::\d+)?\b/g;
export function remarkFileLinks(): (tree: Node) => void {
  return function transform(tree: Node): void {
    if (["link", "linkReference", "code", "inlineCode"].includes(tree.type)) return;
    if (!tree.children) return;
    tree.children = tree.children.flatMap((node) => {
      if (node.type !== "text" || !node.value) {
        transform(node);
        return [node];
      }
      const result: Node[] = [];
      let end = 0;
      for (const match of node.value.matchAll(files)) {
        const start = match.index;
        if (start > end) result.push({ type: "text", value: node.value.slice(end, start) });
        result.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0] }] });
        end = start + match[0].length;
      }
      if (!result.length) return [node];
      if (end < node.value.length) result.push({ type: "text", value: node.value.slice(end) });
      return result;
    });
  };
}
