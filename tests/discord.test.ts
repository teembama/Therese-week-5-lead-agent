// Discord webhook notifications (src/lib/discord.ts)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appBaseUrl,
  leadPromotedEmbed,
  notifyLeadPromoted,
  notifyRunCompleted,
  runCompletedEmbed,
  sendDiscordEmbed,
  truncate,
} from "../src/lib/discord";

const RUN_ID = "2730a906-1385-43a0-81ae-0c02e7fecb13";

beforeEach(() => {
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.APP_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

function recordingFetch(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("the run-completed embed is green with objective, counts, owner and run link", () => {
  const embed = runCompletedEmbed({
    runId: RUN_ID,
    objective: "x".repeat(300),
    qualified: 3,
    awaitingReview: 2,
    createdBy: "researcher1",
    url: `https://app.example.com/runs/${RUN_ID}`,
  });
  assert.equal(embed.title, "Research run completed");
  assert.equal(embed.color, 0x3fa66a);
  assert.equal(embed.url, `https://app.example.com/runs/${RUN_ID}`);
  const f = Object.fromEntries(embed.fields.map((x) => [x.name, x.value]));
  assert.equal(f["Objective"].length, 200, "objective truncated to 200 characters");
  assert.ok(f["Objective"].endsWith("…"));
  assert.equal(f["Qualified leads"], "3");
  assert.equal(f["Awaiting review"], "2");
  assert.equal(f["Created by"], "researcher1");
  assert.equal(f["Run"], `[Open run](https://app.example.com/runs/${RUN_ID})`);
});

test("the lead-promoted embed is rose; the reason is included only when given", () => {
  const withReason = leadPromotedEmbed({ runId: RUN_ID, companyName: "AdeptForms", promotedBy: "reviewer1", reason: "Confirmed on the site", url: null });
  assert.equal(withReason.title, "Lead promoted to qualified");
  assert.equal(withReason.color, 0xc0647b);
  assert.deepEqual(withReason.fields.map((x) => x.name), ["Company", "Promoted by", "Reason", "Run"]);
  assert.equal(withReason.fields[3].value, `\`${RUN_ID}\``, "without a public URL the run id is shown");
  assert.equal(withReason.url, undefined);

  const noReason = leadPromotedEmbed({ runId: RUN_ID, companyName: "AdeptForms", promotedBy: "reviewer1", reason: " ", url: null });
  assert.deepEqual(noReason.fields.map((x) => x.name), ["Company", "Promoted by", "Run"]);
});

test("sendDiscordEmbed posts an embeds array with mentions disabled", async () => {
  const { fn, calls } = recordingFetch(new Response(null, { status: 204 }));
  const embed = leadPromotedEmbed({ runId: RUN_ID, companyName: "@everyone Co", promotedBy: "r", url: null });
  const ok = await sendDiscordEmbed(embed, { webhookUrl: "https://discord.test/hook", fetch: fn });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.test/hook");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.embeds, [embed]);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content, undefined, "no plain-text message");
});

test("a missing webhook URL skips silently without calling fetch", async () => {
  const { fn, calls } = recordingFetch(new Response(null, { status: 204 }));
  const embed = leadPromotedEmbed({ runId: RUN_ID, companyName: "A", promotedBy: "r", url: null });
  assert.equal(await sendDiscordEmbed(embed, { fetch: fn }), false);
  assert.equal(calls.length, 0);
  // The notifiers return immediately (no database access) when the webhook is not configured
  await notifyRunCompleted(RUN_ID);
  await notifyLeadPromoted({ runId: RUN_ID, companyName: "A", promotedBy: "r" });
});

test("webhook failures are logged and never thrown", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const embed = leadPromotedEmbed({ runId: RUN_ID, companyName: "A", promotedBy: "r", url: null });
    const http = recordingFetch(new Response("nope", { status: 500 }));
    assert.equal(await sendDiscordEmbed(embed, { webhookUrl: "https://discord.test/secret-token", fetch: http.fn }), false);
    const network = recordingFetch(new Error("connect ECONNREFUSED"));
    assert.equal(await sendDiscordEmbed(embed, { webhookUrl: "https://discord.test/secret-token", fetch: network.fn }), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
  assert.ok(!JSON.stringify(errors).includes("secret-token"), "the webhook URL is never logged");
});

test("run links use APP_URL, then Railway's public domain, then the request origin", () => {
  assert.equal(appBaseUrl(), null);
  assert.equal(appBaseUrl("http://localhost:3000/"), "http://localhost:3000");
  process.env.RAILWAY_PUBLIC_DOMAIN = "koya.up.railway.app";
  assert.equal(appBaseUrl("http://localhost:3000"), "https://koya.up.railway.app");
  process.env.APP_URL = "https://leads.example.com/";
  assert.equal(appBaseUrl(), "https://leads.example.com");
});

test("truncate keeps short text and cuts long text to the limit", () => {
  assert.equal(truncate("short", 200), "short");
  assert.equal(truncate("abcdef", 4), "abc…");
});
