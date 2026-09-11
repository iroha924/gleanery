import "client-only";

import { getToken } from "@clerk/nextjs";

// Hono は Cookie を認証経路にせず、全 /api/* で Clerk の Bearer token を要求する。
export async function authed(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: await authed() });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return res.json() as Promise<T>;
}

export async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: await authed(body ? { "content-type": "application/json" } : undefined),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path} が ${res.status}`);
  return json;
}
