import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(
  new Agent({
    connect: { timeout: 30000, family: 4 },
  })
);
