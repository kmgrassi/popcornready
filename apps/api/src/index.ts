// Must be first: loads the repo-root env files before anything reads process.env.
import "./env.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT || 4000);

const app = createServer();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] Express listening on :${port} (${process.env.NODE_ENV || "development"})`);
});
