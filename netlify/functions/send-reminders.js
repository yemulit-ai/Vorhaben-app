import { getStore } from "@netlify/blobs";
import webpush from "web-push";

webpush.setVapidDetails(
  "mailto:" + (process.env.VAPID_CONTACT_EMAIL || "example@example.com"),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hm: `${get("hour")}:${get("minute")}`,
  };
}

export default async () => {
  const store = getStore("vorhaben");
  const subscription = await store.get("subscription", { type: "json" });
  const data = await store.get("app-data", { type: "json" });

  if (!subscription || !data) {
    return new Response("nothing to do");
  }

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nowParts = berlinParts(now);
  const laterParts = berlinParts(in24h);

  const notified = (await store.get("notified", { type: "json" })) || {};
  const notifiedSet = (dk) => new Set(notified[dk] || []);
  const dueNow = notifiedSet(nowParts.dateKey);
  const due24h = notifiedSet(laterParts.dateKey);

  const jobs = [];

  const dayNow = data.days?.[nowParts.dateKey];
  if (dayNow?.items) {
    dayNow.items
      .filter((item) => item.time === nowParts.hm && !item.done && !dueNow.has(item.id + ":now"))
      .forEach((item) => jobs.push({ item, dateKey: nowParts.dateKey, tag: item.id + ":now", title: "Termin", body: `${item.title} · ${item.time}` }));
  }

  const dayLater = data.days?.[laterParts.dateKey];
  if (dayLater?.items) {
    dayLater.items
      .filter((item) => item.time === laterParts.hm && !item.done && !due24h.has(item.id + ":24h"))
      .forEach((item) => jobs.push({ item, dateKey: laterParts.dateKey, tag: item.id + ":24h", title: "In 24 Stunden", body: `${item.title} · morgen ${item.time}` }));
  }

  if (jobs.length === 0) {
    return new Response("nothing due");
  }

  for (const job of jobs) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title: job.title, body: job.body, tag: job.tag })
      );
      const set = notifiedSet(job.dateKey);
      set.add(job.tag);
      notified[job.dateKey] = Array.from(set);
    } catch (err) {
      console.error("push failed", err);
    }
  }

  // keep only the last 3 days of notified-ids so the store doesn't grow forever
  const keepDates = Object.keys(notified).sort().slice(-3);
  const trimmed = {};
  keepDates.forEach((d) => (trimmed[d] = notified[d]));
  await store.setJSON("notified", trimmed);

  return new Response("sent " + jobs.length);
};

export const config = { schedule: "* * * * *" };
