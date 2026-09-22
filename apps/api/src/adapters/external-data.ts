/**
 * Large ONNX exports (over the 2 GB protobuf limit, e.g. fp32 of
 * snowflake-arctic-embed-l-v2.0 and bge-reranker-v2-m3) keep their weights in
 * a separate model.onnx_data file. transformers.js fetches it only when told
 * to, and telling it for a model without one fails the load. So load plainly
 * first and retry with external data only when ONNX Runtime asks for it.
 */
export async function withExternalDataFallback<T>(
  load: (options: { use_external_data_format?: boolean }) => Promise<T>,
): Promise<T> {
  try {
    return await load({});
  } catch (err) {
    if (!/external data/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return load({ use_external_data_format: true });
  }
}
