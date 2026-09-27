import tailwind from "bun-plugin-tailwind";
import * as fs from "node:fs";

const maintenanceOutdir = "./.maintenance-dist";
fs.rmSync(maintenanceOutdir, { recursive: true, force: true });

const app = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  plugins: [tailwind],
  target: "bun",
  splitting: true,
  minify: true,
});

const maintenance = await Bun.build({
  entrypoints: ["./scripts/maintenance.ts"],
  outdir: maintenanceOutdir,
  target: "bun",
  minify: true,
  naming: "[name].[ext]",
});

if (!app.success || !maintenance.success) {
  console.error("Build failed:");
  for (const message of [...app.logs, ...maintenance.logs]) console.error(message);
  process.exit(1);
}

fs.renameSync(`${maintenanceOutdir}/maintenance.js`, "./dist/maintenance.js");
fs.rmSync(maintenanceOutdir, { recursive: true, force: true });
