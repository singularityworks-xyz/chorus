// biome-ignore lint/performance/noBarrelFile: package.json exposes this file as the package API.
export { BorderlessFileView } from "./components/borderless-file-view";
export { ChorusMonaco } from "./components/chorus-monaco";
export { DiffFloatingWindow } from "./components/diff-floating-window";
export { InlineDiffView } from "./components/inline-diff-view";
export { useLsp } from "./hooks/use-lsp";
export type {
  BorderlessFileViewProps,
  ChorusMonacoProps,
  DiffFloatingWindowProps,
  DiffView,
  EditorMode,
  InlineDiffViewProps,
  LspConnectionConfig,
} from "./types";
