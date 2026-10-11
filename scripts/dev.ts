// Runs the server (restarting on change) and the Vite dev server together.
import { spawn, type ChildProcess } from "node:child_process";

const serverPort = process.env.PORT ?? "4800";
const children: ChildProcess[] = [
  spawn(
    process.execPath,
    ["--watch", "--disable-warning=ExperimentalWarning", "server/src/main.ts"],
    { stdio: "inherit", env: { ...process.env, PORT: serverPort } },
  ),
  spawn("pnpm", ["--filter", "web", "dev"], {
    stdio: "inherit",
    env: { ...process.env, BORKCODE_SERVER_PORT: serverPort },
  }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
