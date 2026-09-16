import type { Point } from "./mask";

export type EditorRequest =
  | { type: "init"; blob: Blob; base: Blob }
  | { type: "select"; points: Point[] }
  | { type: "resize"; width: number; height: number }
  | {
      type: "brush";
      points: Point[];
      radius: number;
      restore: boolean;
      hardness: number;
    }
  | {
      type:
        | "begin"
        | "commit"
        | "cancel"
        | "remove"
        | "clear"
        | "undo"
        | "redo"
        | "export";
    };
export type EditorResponse =
  | {
      type: "frame";
      bitmap: ImageBitmap;
      width: number;
      height: number;
      canUndo: boolean;
      canRedo: boolean;
      selection: { components: number; pixels: number; ambiguous: boolean };
      elapsed: number;
      operation: EditorRequest["type"];
    }
  | { type: "export"; blob: Blob }
  | { type: "error"; message: string };
