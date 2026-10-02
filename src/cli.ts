import { runCli } from "./core/cli.ts";

const output = await runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exitCode = output;
