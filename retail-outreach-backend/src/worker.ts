import { Worker } from "bullmq";
import { redis } from "./queue.js";
import { query } from "./db/pool.js";
import { sendMessage } from "./services/messaging.js";

const worker = new Worker("message-delivery", async job => {
  const r = await query<any>(`
    SELECT d.*, dr.message, dr.subject
    FROM message_deliveries d
    JOIN outreach_drafts dr ON dr.id=d.draft_id AND dr.tenant_id=d.tenant_id
    WHERE d.id=$1
  `, [job.data.deliveryId]);
  const delivery = r.rows[0];
  if (!delivery) throw new Error("Delivery record not found");
  if (["sent", "delivered"].includes(delivery.status)) return;

  await query(`UPDATE message_deliveries SET status='sending',updated_at=NOW() WHERE id=$1`, [delivery.id]);
  try {
    const sent = await sendMessage({
      channel: delivery.channel, recipient: delivery.recipient,
      message: delivery.message, subject: delivery.subject
    });
    await query(`UPDATE message_deliveries SET status='sent',provider_message_id=$2,updated_at=NOW()
      WHERE id=$1`, [delivery.id, sent.providerMessageId]);
    await query(`UPDATE outreach_opportunities SET status='sent',updated_at=NOW() WHERE id=$1`,
      [delivery.opportunity_id]);
    await query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type,details)
      VALUES ($1,$2,'system','message_sent',$3)`,
      [delivery.tenant_id, delivery.opportunity_id, JSON.stringify({ deliveryId: delivery.id })]);
  } catch (err) {
    await query(`UPDATE message_deliveries SET status='failed',error=$2,updated_at=NOW() WHERE id=$1`,
      [delivery.id, err instanceof Error ? err.message.slice(0, 1000) : "Unknown send error"]);
    await query(`UPDATE outreach_opportunities SET status='failed',updated_at=NOW() WHERE id=$1`,
      [delivery.opportunity_id]);
    throw err;
  }
}, { connection: redis, concurrency: 5 });

worker.on("completed", job => console.log(`Delivery job ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`Delivery job ${job?.id} failed`, err));
console.log("Message delivery worker started");
