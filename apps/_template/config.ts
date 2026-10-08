import { resolve } from "node:path";
import APP from "./app.json";

export const PORT = Number(process.env.APP_PORT ?? {{PORT}});
export const PUBLIC_URL = (process.env.APP_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
export const BASE_PATH = new URL(PUBLIC_URL).pathname.replace(/\/$/, "");
export const DATA = resolve(process.env.APP_DATA_DIR ?? `${import.meta.dir}/../../data/{{ID}}`);
export const PUBLIC_DIR = resolve(import.meta.dir, "public");
export const PRICE_USD: number = APP.products.main.usd;
// Behind Caddy the client address is the last X-Forwarded-For entry.
export const BEHIND_PROXY = process.env.APP_BEHIND_PROXY === "1";
// APP_FAKE_PAY=1: the checkout link marks the order paid on the spot (local development).
export const FAKE_PAY = process.env.APP_FAKE_PAY === "1";
