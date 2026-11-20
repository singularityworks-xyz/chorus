import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BorderlessFileViewProps } from "../types";

interface LspClientWrapper {
  dispose(): void;
  start(): Promise<void>;
}

const BORDERLESS_THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d0d0d",
    "editor.foreground": "#e0e0e0",
    "editorLineNumber.foreground": "#444",
    "editorLineNumber.activeForeground": "#777",
    "editor.lineHighlightBackground": "#161616",
    "editor.selectionBackground": "#264f78",
    "editorCursor.foreground": "#aeafad",
    "scrollbar.shadow": "#000000",
    "scrollbarSlider.background": "#44444460",
    "scrollbarSlider.hoverBackground": "#66666660",
  },
} satisfies Parameters<Parameters<OnMount>[1]["editor"]["defineTheme"]>[1];

let themeInitialized = false;

export function BorderlessFileView({
  value,
  language,
  filePath: _filePath,
  lspConfig,
  onChange,
  className,
  height = "100%",
}: BorderlessFileViewProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const lcWrapperRef = useRef<LspClientWrapper | null>(null);
  const [lspError, setLspError] = useState<string | null>(null);
  const lspConfigRef = useRef(lspConfig);
  lspConfigRef.current = lspConfig;

  const startLsp = useCallback(async () => {
    const config = lspConfigRef.current;
    if (!(config && monacoRef.current && editorRef.current)) {
      return;
    }

    try {
      const { LanguageClientWrapper } = await import(
        "monaco-languageclient/lcwrapper"
      );
      const lcWrapper = new LanguageClientWrapper({
        languageId: config.languageId,
        connection: {
          options: {
            $type: "WebSocketUrl",
            url: config.wsUrl,
          },
        },
        clientOptions: {
          documentSelector: config.documentSelector ?? [config.languageId],
          workspaceFolder: config.workspaceFolder
            ? {
                index: 0,
                name: config.workspaceFolder.split("/").pop() ?? "workspace",
                uri: monacoRef.current.Uri.file(config.workspaceFolder),
              }
            : undefined,
        },
      });

      lcWrapperRef.current = lcWrapper;
      await lcWrapper.start();
      setLspError(null);
    } catch (err) {
      setLspError(
        err instanceof Error ? err.message : "Failed to connect to LSP"
      );
    }
  }, []);

  useEffect(() => {
    if (monacoRef.current && editorRef.current) {
      startLsp();
    }

    return () => {
      lcWrapperRef.current?.dispose();
      lcWrapperRef.current = null;
    };
  }, [startLsp]);

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;

    if (themeInitialized) {
      monacoInstance.editor.setTheme("chorus-borderless");
    } else {
      monacoInstance.editor.defineTheme("chorus-borderless", BORDERLESS_THEME);
      monacoInstance.editor.setTheme("chorus-borderless");
      themeInitialized = true;
    }

    if (lspConfigRef.current?.wsUrl) {
      startLsp();
    }
  };

  function handleChange(val: string | undefined) {
    if (val !== undefined) {
      onChange?.(val);
    }
  }

  const editorOptions = {
    minimap: { enabled: false },
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    wordWrap: "on" as const,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    lineNumbers: "off" as const,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    renderLineHighlight: "none" as const,
    hideCursorInOverviewRuler: true,
    overviewRulerLanes: 0,
    bracketPairColorization: { enabled: true },
    smoothScrolling: true,
    cursorBlinking: "smooth" as const,
    cursorSmoothCaretAnimation: "on" as const,
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
    padding: { top: 0, bottom: 0 },
  };

  return (
    <div
      className={className}
      style={{
        height,
        width: "100%",
        position: "relative",
        background: "#0d0d0d",
      }}
    >
      <MonacoEditor
        height="100%"
        language={language}
        onChange={handleChange}
        onMount={handleEditorMount}
        options={editorOptions}
        theme="chorus-borderless"
        value={value}
      />

      {lspError && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            background: "#3d1f1fcc",
            color: "#f87171",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 11,
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          LSP error
        </div>
      )}
    </div>
  );
}
