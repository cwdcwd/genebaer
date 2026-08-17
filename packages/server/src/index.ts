import { createServer } from "./server.js";
import { threadsFromEnv } from "./eval/pool-bootstrap.js";

const port = Number(process.env.PORT ?? 4040);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DB_PATH ?? "./data/genebaer.db";

const app = createServer({ dbPath, logger: true, workerThreads: threadsFromEnv() });

app
  .listen({ port, host })
  .then(() => {
    console.log(`genebaer server listening on http://${host}:${port}`);
    console.log(`websocket at ws://${host}:${port}/ws`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
