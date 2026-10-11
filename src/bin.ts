import { main } from "./cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
