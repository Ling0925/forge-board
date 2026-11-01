import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const entryPoints = [
  ...Object.values(pkg.exports).flatMap((entry) =>
    typeof entry === "object" ? [entry.types] : [],
  ),
  ...Object.values(pkg.bin).map((entry) =>
    entry.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"),
  ),
];
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const result = await build({
  entryPoints,
  outbase: "src",
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  logLevel: "info",
});
await chmod("dist/cli.js", 0o755);
await cp("src/store/migrations", "dist/store/migrations", { recursive: true });
await writeFile(
  "dist/build-meta.json",
  `${JSON.stringify(result.metafile, null, 2)}\n`,
);
