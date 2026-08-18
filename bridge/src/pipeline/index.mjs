import { TonePipeline } from "./tone-pipeline.mjs";
import { assertPipeline } from "./interface.mjs";

/** Factory: PIPELINE env selects the AI. Phase 1 only knows `tone`. */
export function createPipeline(kind, opts) {
  let p;
  switch (kind) {
    case "tone":
      p = new TonePipeline(opts);
      break;
    default:
      throw new Error(`Unknown PIPELINE '${kind}' (Phase 1 supports: tone)`);
  }
  assertPipeline(p);
  return p;
}
