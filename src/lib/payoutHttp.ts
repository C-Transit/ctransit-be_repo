import axios, { type AxiosInstance } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

export function parsePayoutProxyUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("INVALID_PAYOUT_PROXY_URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol) || !url.hostname) {
    throw new Error("INVALID_PAYOUT_PROXY_URL");
  }

  return url;
}

export function createPayoutHttpClient(
  proxyUrl: string | undefined = process.env.KORA_PAYOUT_PROXY_URL,
  onProxyHost?: (host: string) => void
): AxiosInstance {
  const parsedUrl = parsePayoutProxyUrl(proxyUrl);
  if (!parsedUrl) throw new Error("PAYOUT_PROXY_NOT_CONFIGURED");

  const agent =
    parsedUrl.protocol === "socks5:"
      ? new SocksProxyAgent(parsedUrl)
      : new HttpsProxyAgent(parsedUrl);

  onProxyHost?.(parsedUrl.host);

  return axios.create({
    httpsAgent: agent,
    proxy: false,
    timeout: 20_000,
    validateStatus: () => true,
  });
}
