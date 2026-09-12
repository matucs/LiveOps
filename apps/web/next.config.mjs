import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // An unrelated package-lock.json in the user's home directory (outside
  // this repo) confuses Next's automatic workspace-root inference. Pin it
  // explicitly rather than relying on that inference.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};
export default nextConfig;
