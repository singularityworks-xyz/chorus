export type AutocompleteItemType = "command" | "file" | "skill";

export type AutocompleteType = AutocompleteItemType | null;

export interface AutocompleteItem {
  description?: string;
  id: string;
  isDirectory?: boolean;
  label: string;
  path?: string;
  type: AutocompleteItemType;
}

export interface ComposerPart {
  filename?: string;
  id: string;
  isDirectory?: boolean;
  lineRange?: { end: number; start: number };
  mime?: string;
  name?: string;
  path?: string;
  type: "file" | "command" | "skill";
}
