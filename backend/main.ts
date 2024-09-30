type Message = [Date, any];

const channels: Map<string, Channel> = new Map();

function attemptSend(socket: WebSocket, data: string) {
  if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

class Channel {
  topic: string;
  listeners: Set<WebSocket> = new Set();
  messages: Message[] = [];

  constructor(topic: string) {
    this.topic = topic;
  }

  post(payload: any) {
    let msg = [new Date(), payload];
    this.messages.push(msg);
    if (this.messages.length > 10) this.messages.shift();
    const json = JSON.stringify([msg]);
    this.listeners.forEach((l) => attemptSend(l, json));
  }

  clear() {
    this.messages = [];
    this.listeners.forEach((l) => attemptSend(l, JSON.stringify({ cl: true })));
  }

  onOpen(socket: WebSocket) {
    this.listeners.add(socket);
    attemptSend(socket, JSON.stringify(this.messages));
    this._sendCounts();
  }

  onClose(socket: WebSocket) {
    this.listeners.delete(socket);
    if (this.listeners.size === 0) channels.delete(this.url);
    else this._sendCounts();
  }

  _sendCounts() {
    const json = JSON.stringify({ ct: this.listeners.size });
    this.listeners.forEach((l) => attemptSend(l, json));
  }
}

setInterval(() => {
    channels.forEach((channel) => channel._sendCounts());
}, 15000);

Deno.serve({ port: 8084 }, (req) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const channel = channels.get(req.url) || new Channel(req.url);
  channels.set(req.url, channel);
  socket.addEventListener("open", () => channel.onOpen(socket));
  socket.addEventListener("close", () => channel.onClose(socket));
  socket.addEventListener("message", (evt) => {
    if (evt.data.length > 1048576) socket.close(1009, "Message too long");
    try {
      let payload = evt.data;
      if (typeof payload === "string") {
        const json = JSON.parse(payload);
        if (json.clear) channel.clear();
        else channel.post(json);
      } else {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(payload)));
          channel.post(b64);
      }
    } catch (err) {
      socket.close(1007, "Failure: " + err.message);
    }
  });
  return response;
});
