import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  reactCompiler: true,
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Service-Worker-Allowed", value: "/" },
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
        ],
      },
    ];
  },
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
    resolveAlias: {
      vscode: "@codingame/monaco-vscode-extension-api",
      "monaco-editor": "@codingame/monaco-vscode-editor-api",
    },
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias ??= {};
    config.resolve.alias.vscode = "@codingame/monaco-vscode-extension-api";
    config.resolve.alias["monaco-editor"] =
      "@codingame/monaco-vscode-editor-api";
    return config;
  },
};

export default nextConfig;
