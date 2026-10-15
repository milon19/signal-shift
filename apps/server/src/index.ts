import { createServer } from "node:http";
import { loadDefaultScenario } from "./game/scenario.js";
import { RoomManager } from "./rooms/roomManager.js";
import { attachSocketServer } from "./socket.js";

const port = Number(process.env.PORT ?? 3001);
const corsOrigin = process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173";

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});

attachSocketServer(httpServer, { rooms: new RoomManager({ scenario: loadDefaultScenario() }), corsOrigin });

httpServer.listen(port, () => {
  console.log(`Signal Shift server listening on :${port}`);
});
