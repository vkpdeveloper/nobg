export const MODEL_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_MODEL_CDN_URL = "https://nobg-models.ordinity.com";
export const DESKTOP_MODEL = {
  id: "onnx-community/BEN2-ONNX",
  revision: "c552aa82688edce09f0ac9d2e31ad53d9d629010",
  filename: "onnx/model_fp16.onnx",
  size: 219_121_675,
  sha256: "dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1",
} as const;

// Version the encoding and chunk boundaries as well as the original model.
export const DESKTOP_ASSET_PATH = `/models/ben2/${DESKTOP_MODEL.sha256}/gzip-8m-v1`;

export interface CompressedModelManifest {
  version: 1;
  sha256: string;
  size: number;
  chunkSize: number;
  parts: { size: number; compressedSize: number; sha256: string }[];
}
