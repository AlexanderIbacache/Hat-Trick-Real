import os from "node:os";
import path from "node:path";

// Keep runtime assets outside the workspace so development servers do not
// reload the frontend whenever a preview or mesh is written.
export const GENERATED_DIR = process.env.GENERATED_DIR || path.join(os.tmpdir(), "address-to-3d-generated");
