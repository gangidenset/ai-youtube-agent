import { buildServer } from "./server";

const port = Number(process.env.API_PORT ?? 4000);
const app = buildServer({ logger: true });

app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
