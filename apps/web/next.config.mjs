import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // An unrelated package-lock.json in the user's home directory (outside
  // this repo) confuses Next's automatic workspace-root inference. Pin it
  // explicitly rather than relying on that inference.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Standalone output for the production Docker image: a self-contained
  // server.js with only the deps actually used, instead of shipping the
  // full node_modules tree onto a ~1GB-RAM VM.
  output: "standalone",
};
export default nextConfig;
