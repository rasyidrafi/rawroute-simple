import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  plugins: [tailwind],
  target: "bun",
  splitting: true,
  minify: true,
});

if (!result.success) {
  console.error("Build failed:");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
