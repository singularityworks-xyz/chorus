export function inferDiffLanguage(path?: string): string {
  if (!path) {
    return "plaintext";
  }
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    bash: "shell",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    javascript: "javascript",
    js: "javascript",
    jsx: "javascript",
    markdown: "markdown",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "shell",
    sql: "sql",
    toml: "toml",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return extension ? (languages[extension] ?? "plaintext") : "plaintext";
}
