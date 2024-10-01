import "preact/debug";

import { render } from "preact";
import { signal } from "@preact/signals";
import "./index.css";
import Sockette from "sockette";
import * as nacl from "tweetnacl";
import { decode, encode } from "cbor-x";
import { parse } from "marked";
import { useEffect, useRef } from "preact/hooks";
import QRCode from "qrcode";

const state = signal<State>({
  msgs: [],
  pending: [
    localStorage.getItem("nick") ||
      ([
        localStorage.setItem("nick", Math.random().toString(36).substring(4)),
        localStorage.getItem("nick"),
      ][1] as string),
    "",
  ],
  zoomCanvas: false,
});

addEventListener("hashchange", reconnect);
reconnect().catch(console.error);

function randomChannelName() {
  return btoa(String.fromCharCode(...nacl.randomBytes(64))).replace(/=/g, "");
}

async function reconnect() {
  const pass = location.hash.slice(1);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode("offrecord.ca"),
      iterations: 100000,
    },
    key,
    256,
  );
  const seed = new Uint8Array(bits);
  const boxKP = nacl.box.keyPair.fromSecretKey(seed);
  const chan = btoa(String.fromCharCode(...boxKP.publicKey));

  const previous = state.value.chan;
  if (previous !== chan) {
    state.value.sock?.close();
    const sock = new Sockette(`wss://${window.location.host}/ws/${chan}`, {
      onreconnect: () => {
        state.value = { ...state.value, msgs: [], count: undefined };
      },
      onmessage: (evt) => {
        const payload = JSON.parse(evt.data);
        if (payload.cl) {
          state.value = { ...state.value, msgs: [] };
        } else if (payload.ct) {
          state.value = { ...state.value, count: payload.ct };
        } else {
          state.value = {
            ...state.value,
            msgs: [...state.value.msgs, ...payload],
          };
        }
      },
    });
    state.value = {
      ...state.value,
      pass,
      boxKP,
      chan,
      sock,
      msgs: [],
      count: undefined,
    };
  }
}

interface State {
  pass?: string;
  boxKP?: nacl.BoxKeyPair;
  chan?: string;
  count?: number;
  sock?: Sockette;
  msgs: [string, string][];
  pending: [string, string];
  zoomCanvas: boolean;
}

const App = () => {
  const qr = useRef<HTMLCanvasElement>(null);
  const s = state.value;
  if (location.href.indexOf("#") == -1) {
    return (
      <div id="intro">
        <h1>⚠️ Warning</h1>
        <p>You're about to join a secure chat system.</p>
        <p>
          The confidentiality of your messages relies on your channel name being
          terribly hard to guess and only exchanged securely.
        </p>
        <p>
          <button onClick={() => (location.hash = "#lobby")}>
            Lobby <em class="red">(public)</em>
          </button>{" "}
          <button onClick={() => (location.hash = randomChannelName())}>
            Random channel
          </button>
        </p>
      </div>
    );
  }

  // Load QR into canvas when ref not undefined
  useEffect(() => {
    if (qr)
      QRCode.toCanvas(qr.current, location.href, {
        errorCorrectionLevel: "L",
        scale: s.zoomCanvas ? 8 : 1,
      });
  }, [qr, s.zoomCanvas, location.href]);

  const messageView = s.msgs.map((msg) => {
    if (!s.boxKP) return <></>;
    const [nonce, payload] = decode(
      Uint8Array.from(atob(msg[1]), (c) => c.charCodeAt(0)),
    );
    const raw = nacl.box.open(
      payload,
      nonce,
      s.boxKP.publicKey,
      s.boxKP.secretKey,
    );
    if (raw === null) {
      return (
        <>
          <dt>{new Date(msg[0]).toLocaleString()}</dt>
          <dd>
            <em class="red">bad message</em>
          </dd>
        </>
      );
    }
    let json = JSON.parse(new TextDecoder().decode(raw));
    return (
      <>
        <dt>
          {new Date(msg[0]).toLocaleString()} <b>{json[0]}:</b>
        </dt>
        <dd
          dangerouslySetInnerHTML={{
            __html: parse(json[1], {
              async: false,
              pedantic: false,
              gfm: true,
              breaks: true,
            }),
          }}
        />
      </>
    );
  });

  return (
    <>
      <header>
        <h1>
          Channel{" "}
          <input
            id="channel"
            type="text"
            value={s.pass}
            onInput={async (evt) => {
              location.hash = `#${(evt.target as HTMLInputElement).value}`;
              await reconnect();
            }}
          />
        </h1>
        <p>
          <button
            onClick={() => {
              navigator
                .share({
                  text: "Join my off-the-record chat",
                  url: location.href,
                })
                .catch(console.error);
            }}
          >
            share
          </button>
          <button onClick={() => state.value.sock?.json({ clear: true })}>
            wipe
          </button>
          <button onClick={() => (location.hash = "#lobby")}>lobby</button>{" "}
          <button onClick={() => (location.hash = randomChannelName())}>
            random
          </button>
        </p>
        {s.count !== undefined && <p id="count">{s.count} online</p>}
        <canvas
          id="qr"
          ref={qr}
          onClick={() => {
            state.value = { ...state.value, zoomCanvas: !s.zoomCanvas };
          }}
        />
      </header>
      <main>
        <dl>{messageView}</dl>
        <article>
          <p>
            Select a channel name above; it is only visible to its participants,
            and used as the encryption key for every message. Nobody can read
            messages without it. It is not transmitted to the server.
          </p>
          <p>
            At most 10 timestamped encrypted messages are kept on the server. No
            IP or identifiable information, not even the nickname, are kept in
            clear.
          </p>
          <p>
            Anybody can wipe channels whenever they'd like. Server restarts wipe
            everything as history is only in-memory.
          </p>
          <p>
            You do not have to trust me and can run your own instance if you
            prefer.{" "}
            <a href="https://github.com/pcarrier/offrecord.ca" target="_blank">
              Sources.
            </a>
          </p>
        </article>
      </main>
      <footer>
        <form
          onSubmit={(evt) => {
            if (!s.boxKP) {
              return;
            }
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const payload = nacl.box(
              new TextEncoder().encode(JSON.stringify(s.pending)),
              nonce,
              s.boxKP.publicKey,
              s.boxKP.secretKey,
            );
            state.value.sock?.send(encode([nonce, payload]));
            state.value = {
              ...state.value,
              pending: [state.value.pending[0], ""],
            };
            evt.preventDefault();
            document.getElementById("msg")?.focus();
          }}
        >
          <input
            id="nick"
            type="text"
            value={s.pending[0]}
            onInput={(evt) => {
              let nick = (evt.target as HTMLInputElement).value;
              localStorage.setItem("nick", nick);
              state.value = {
                ...state.value,
                pending: [nick, s.pending[1]],
              };
            }}
          />
          <textarea
            id="msg"
            value={s.pending[1]}
            placeholder="Write your messages here. Enter to send, Shift+Enter for multiple lines."
            onInput={(evt) => {
              let tgt = evt.target as HTMLTextAreaElement;
              state.value = {
                ...state.value,
                pending: [s.pending[0], tgt.value],
              };
            }}
            onKeyDown={(evt) => {
              if (evt.key === "Enter" && !evt.shiftKey) {
                evt.preventDefault();
                (evt.target as HTMLTextAreaElement).form?.requestSubmit();
              }
            }}
            style={s.pending[1].split("\n").length > 1 ? { height: "5em" } : {}}
          />{" "}
          <input type="submit" value="send" />
        </form>
      </footer>
    </>
  );
};

render(<App />, document.getElementById("app")!);
