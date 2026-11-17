import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import type { DiffFloatingWindowProps } from "../types";

type DiffEditorModels = NonNullable<
  ReturnType<editor.IStandaloneDiffEditor["getModel"]>
>;

function disposeDiffModels(models: DiffEditorModels | null): void {
  if (!models) {
    return;
  }

  models.original.dispose();
  models.modified.dispose();
}

const DIFF_THEME: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d0d0d",
    "diffEditor.insertedTextBackground": "#2ea04333",
    "diffEditor.removedTextBackground": "#f8514933",
    "diffEditor.insertedLineBackground": "#2ea04322",
    "diffEditor.removedLineBackground": "#f8514922",
    "diffEditorGutter.insertedLineBackground": "#2ea04344",
    "diffEditorGutter.removedLineBackground": "#f8514944",
    "diffEditorOverview.insertedForeground": "#2ea04388",
    "diffEditorOverview.removedForeground": "#f8514988",
  },
};

let diffThemeInitialized = false;

export function DiffFloatingWindow({
  original,
  modified,
  language,
  visible,
  onClose,
  className,
}: DiffFloatingWindowProps) {
  const diffModelsRef = useRef<DiffEditorModels | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      return;
    }

    const models = diffModelsRef.current;
    diffModelsRef.current = null;
    disposeDiffModels(models);
  }, [visible]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      const models = diffModelsRef.current;
      diffModelsRef.current = null;

      // The wrapper disposes its editor during the child unmount. Dispose the
      // retained models after that cleanup has reset the diff editor's model.
      queueMicrotask(() => {
        if (!mountedRef.current) {
          disposeDiffModels(models);
        }
      });
    };
  }, []);

  if (!visible) {
    return null;
  }

  const handleDiffMount: DiffOnMount = (diffEditor, monacoInstance) => {
    if (!diffThemeInitialized) {
      monacoInstance.editor.defineTheme("chorus-diff", DIFF_THEME);
      diffThemeInitialized = true;
    }
    monacoInstance.editor.setTheme("chorus-diff");
    diffModelsRef.current = diffEditor.getModel();
  };

  return (
    <div
      className={className}
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "80vw",
        maxWidth: 1200,
        height: "70vh",
        background: "#0d0d0d",
        border: "1px solid #333",
        borderRadius: 8,
        boxShadow: "0 16px 48px rgba(0, 0, 0, 0.6)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid #333",
          background: "#1a1a1a",
        }}
      >
        <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
          <span style={{ color: "#f87171" }}>
            <span style={{ marginRight: 4 }}>−</span> Original
          </span>
          <span style={{ color: "#4ade80" }}>
            <span style={{ marginRight: 4 }}>+</span> Modified
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "1px solid #444",
            color: "#aaa",
            cursor: "pointer",
            padding: "4px 12px",
            borderRadius: 4,
            fontSize: 12,
          }}
          type="button"
        >
          Close
        </button>
      </div>

      <div style={{ flex: 1 }}>
        <DiffEditor
          height="100%"
          keepCurrentModifiedModel
          keepCurrentOriginalModel
          language={language}
          modified={modified}
          onMount={handleDiffMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily:
              "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            useInlineViewWhenSpaceIsLimited: false,
          }}
          original={original}
          theme="chorus-diff"
        />
      </div>
    </div>
  );
}
